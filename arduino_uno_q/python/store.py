"""Thread-safe rolling store of recent IMU samples + status + CSV export.

The runner thread writes; WebUI API handlers read. snapshot()/to_csv() are the
seams a future analytics step or Supabase uploader would consume.
"""

from __future__ import annotations

import io
import csv
import threading
import time
from collections import deque

from config import RECENT_POINTS
from models import ImuSample

_CSV_FIELDS = [
    "timestamp_ms", "ax", "ay", "az", "gx", "gy", "gz",
    "acc_norm", "gyro_norm", "phase", "phase_label",
]


class SampleStore:
    def __init__(self, maxlen: int):
        self._dq: deque[ImuSample] = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._status = "starting"
        self._mode = "?"
        self._count = 0
        self._bad = 0
        self._last_recv = 0.0
        self._started = time.time()
        self._tsstore = False
        # Short EWMA of the inter-sample interval -> rate_hz (robust to bursts).
        self._ewma_dt = 0.0

    # ---- writers --------------------------------------------------------
    def set_mode(self, mode: str) -> None:
        with self._lock:
            self._mode = mode

    def set_tsstore(self, active: bool) -> None:
        with self._lock:
            self._tsstore = active

    def set_status(self, status: str) -> None:
        with self._lock:
            self._status = status

    def append(self, sample: ImuSample) -> None:
        with self._lock:
            now = time.time()
            if self._last_recv:
                dt = now - self._last_recv
                # EWMA so rate_hz reflects the recent stream, not the whole run.
                self._ewma_dt = dt if self._ewma_dt == 0.0 else 0.9 * self._ewma_dt + 0.1 * dt
            self._dq.append(sample)
            self._count += 1
            self._last_recv = now

    def note_bad(self) -> None:
        """Record one unparseable / dropped line (truncation, MTU, noise)."""
        with self._lock:
            self._bad += 1

    def clear(self) -> int:
        with self._lock:
            n = len(self._dq)
            self._dq.clear()
            return n

    # ---- readers --------------------------------------------------------
    def latest(self) -> dict | None:
        with self._lock:
            return self._dq[-1].to_dict() if self._dq else None

    def recent(self, n: int = RECENT_POINTS) -> list[dict]:
        with self._lock:
            return [s.to_dict() for s in list(self._dq)[-n:]]

    def series(self, n: int = RECENT_POINTS) -> dict:
        """Column arrays for the dashboard charts (last n samples)."""
        rows = self.recent(n)
        return {
            "t": [r["timestamp_ms"] for r in rows],
            "acc_norm": [r["acc_norm"] for r in rows],
            "gyro_norm": [r["gyro_norm"] for r in rows],
            "phase": [r["phase"] for r in rows],
        }

    def status(self) -> dict:
        with self._lock:
            age = (time.time() - self._last_recv) if self._last_recv else None
            rate = round(1.0 / self._ewma_dt, 1) if self._ewma_dt > 0 else 0.0
            return {
                "mode": self._mode,
                "source_status": self._status,
                "tsstore": "running" if self._tsstore else "off",
                "live": age is not None and age < 1.5,
                "count": self._count,
                "bad": self._bad,
                "rate_hz": rate,
                "buffered": len(self._dq),
                "buffer_max": self._dq.maxlen,
                "age_s": round(age, 2) if age is not None else None,
                "uptime_s": round(time.time() - self._started, 1),
            }

    def to_csv(self) -> str:
        with self._lock:
            rows = list(self._dq)
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=_CSV_FIELDS)
        w.writeheader()
        for s in rows:
            w.writerow(s.to_dict())
        return buf.getvalue()
