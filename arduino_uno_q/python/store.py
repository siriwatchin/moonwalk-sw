"""Thread-safe rolling store of recent IMU samples + status + CSV export.

The runner thread writes; WebUI API handlers read. snapshot()/to_csv() are the
seams a future analytics step or Supabase uploader would consume.
"""

from __future__ import annotations

import csv
import io
import threading
import time
from collections import deque

from config import INTERVAL_MS, RECENT_POINTS
from models import ImuSample

_CSV_FIELDS = [
    "timestamp_ms", "ax", "ay", "az", "gx", "gy", "gz",
]


class SampleStore:
    def __init__(self, maxlen: int):
        self._dq: deque[ImuSample] = deque(maxlen=maxlen)
        # Gateway receive time (ms, 0-based since this store's first sample) per sample —
        # a clock common to all devices, so two Nanos can be compared on one time axis
        # (their own timestamp_ms are independent millis-since-boot).
        self._recv: deque[int] = deque(maxlen=maxlen)
        self._t0 = None            # monotonic of first sample
        self._lock = threading.Lock()
        self._status = "starting"
        self._mode = "?"
        self._count = 0
        self._bad = 0
        self._lost = 0             # estimated dropped samples (from timestamp_ms gaps)
        self._dropped = 0          # samples the SOURCE shed before us (e.g. full BLE queue)
        self._last_ts = None       # last Nano timestamp_ms (for gap/loss detection)
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

    def set_dropped(self, dropped: int) -> None:
        """Record the source-side dropped-sample count (full-queue shedding)."""
        with self._lock:
            self._dropped = dropped

    def append(self, sample: ImuSample) -> None:
        with self._lock:
            mono = time.monotonic()
            now = time.time()
            if self._last_recv:
                dt = now - self._last_recv
                # EWMA so rate_hz reflects the recent stream, not the whole run.
                self._ewma_dt = dt if self._ewma_dt == 0.0 else 0.9 * self._ewma_dt + 0.1 * dt
            # Gateway 0-based receive clock (ms) — the common compare axis.
            if self._t0 is None:
                self._t0 = mono
            self._recv.append(int((mono - self._t0) * 1000.0))
            # Estimate dropped samples from the Nano timestamp gap (no seq number in payload).
            ts = sample.timestamp_ms
            if self._last_ts is not None:
                gap = ts - self._last_ts
                if gap > 1.8 * INTERVAL_MS:
                    self._lost += max(0, round(gap / INTERVAL_MS) - 1)
            self._last_ts = ts
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
            self._recv.clear()
            self._t0 = None
            self._last_ts = None
            self._lost = 0
            return n

    # ---- readers --------------------------------------------------------
    def latest(self) -> dict | None:
        with self._lock:
            return self._dq[-1].to_dict() if self._dq else None

    def recent(self, n: int = RECENT_POINTS) -> list[dict]:
        with self._lock:
            return [s.to_dict() for s in list(self._dq)[-n:]]

    def series(self, n: int = RECENT_POINTS) -> dict:
        """Column arrays for the dashboard charts (last n samples).

        `rel_ms` is the gateway receive clock (0-based, shared across devices) — use it as
        the x-axis to compare two Nanos. `t` is the Nano's own timestamp_ms (per-device).
        """
        with self._lock:
            samples = list(self._dq)[-n:]
            recv = list(self._recv)[-n:]
        return {
            "rel_ms": recv,
            "t": [s.timestamp_ms for s in samples],
            "ax": [round(s.ax, 4) for s in samples],
            "ay": [round(s.ay, 4) for s in samples],
            "az": [round(s.az, 4) for s in samples],
            "gx": [round(s.gx, 4) for s in samples],
            "gy": [round(s.gy, 4) for s in samples],
            "gz": [round(s.gz, 4) for s in samples],
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
                "lost": self._lost,
                "dropped": self._dropped,
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
