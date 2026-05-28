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

from config import INTERVAL_MS, RECENT_POINTS, SAMPLES_LIMIT_MAX
from models import ImuSample

_CSV_FIELDS = [
    "timestamp_ms", "ax", "ay", "az", "gx", "gy", "gz", "pressure",
]


def to_csv(samples: list[ImuSample]) -> str:
    """Render IMU samples to a CSV string (header + one row per sample).

    Shared by SampleStore.to_csv (rolling buffer), DeviceRegistry.csv (per-slot export),
    and the Recorder (start→stop session capture) so the column layout stays in one place.
    """
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=_CSV_FIELDS)
    w.writeheader()
    for s in samples:
        w.writerow(s.to_dict())
    return buf.getvalue()


class SampleStore:
    def __init__(self, maxlen: int):
        self._dq: deque[ImuSample] = deque(maxlen=maxlen)
        # Gateway receive time (ms, 0-based since this store's first sample) per sample —
        # a clock common to all devices, so two Nanos can be compared on one time axis
        # (their own timestamp_ms are independent millis-since-boot).
        self._recv: deque[int] = deque(maxlen=maxlen)
        # Monotonic per-accepted-sample sequence number, parallel to _dq (one entry per sample).
        # Lets the browser fetch only samples newer than a `since_seq` (incremental realtime path)
        # and detect gaps. Kept here (not on ImuSample) so the parser/CSV/wire format stay untouched.
        self._seq: deque[int] = deque(maxlen=maxlen)
        self._seq_counter = 0      # last assigned seq (0 = nothing appended yet)
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
            self._seq_counter += 1
            self._seq.append(self._seq_counter)   # parallel to _dq; same maxlen drops oldest together
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
            self._seq.clear()
            self._seq_counter = 0    # restart the sequence; the browser detects this as a reset
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
            "pressure": [round(s.pressure, 1) for s in samples],
        }

    def samples_since(self, since_seq=None, limit: int = RECENT_POINTS) -> dict:
        """Incremental realtime read: samples with seq > since_seq (the hot path the browser polls).

        Reads the in-memory buffer only — never the TimeSeriesStore/InfluxDB. Robust to junk
        params (never raises): a non-int since_seq is treated as None, limit is clamped.

        Returns {"latest_seq", "samples":[{seq,t,ax,ay,az,gx,gy,gz,pressure}], "reset"?}:
          - since_seq is None        -> latest window (initial load)
          - since_seq >= latest_seq  -> no new samples ([])
          - since_seq ahead of us (source restarted) or older than the buffer holds
                                     -> "reset": True + latest window
          - otherwise                -> only samples newer than since_seq (up to limit)
        """
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = RECENT_POINTS
        limit = max(1, min(limit, SAMPLES_LIMIT_MAX))
        if since_seq is not None:
            try:
                since_seq = int(since_seq)
            except (TypeError, ValueError):
                since_seq = None

        with self._lock:
            seqs = list(self._seq)
            samples = list(self._dq)
            latest = self._seq_counter

        def pack(samp, sq):
            return [{
                "seq": q, "t": s.timestamp_ms,
                "ax": round(s.ax, 4), "ay": round(s.ay, 4), "az": round(s.az, 4),
                "gx": round(s.gx, 4), "gy": round(s.gy, 4), "gz": round(s.gz, 4),
                "pressure": round(s.pressure, 1),
            } for s, q in zip(samp, sq)]

        if not seqs:
            return {"latest_seq": latest, "samples": []}
        oldest = seqs[0]

        if since_seq is None:
            return {"latest_seq": latest, "samples": pack(samples[-limit:], seqs[-limit:])}
        if since_seq > latest or since_seq < oldest - 1:   # client ahead (restart) / fell behind buffer
            return {"latest_seq": latest, "reset": True,
                    "samples": pack(samples[-limit:], seqs[-limit:])}
        if since_seq >= latest:                            # caught up — nothing new
            return {"latest_seq": latest, "samples": []}
        # seqs are contiguous (one per append, oldest drops first): index of first seq > since_seq.
        start = max(0, since_seq - oldest + 1)
        return {"latest_seq": latest,
                "samples": pack(samples[start:start + limit], seqs[start:start + limit])}

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
                "latest_seq": self._seq_counter,
                "samples_received": self._count,
                "last_seen_at": self._last_recv or None,
            }

    def samples_in_range(self, from_ms: int, to_ms: int) -> list[ImuSample]:
        """Return samples whose Nano `timestamp_ms` falls in [from_ms, to_ms] (inclusive).

        Keys off the Nano's own millis-since-boot clock (`ImuSample.timestamp_ms`), not the
        gateway receive clock — so the browser can request "last 30 s" by computing the window
        end from the newest sample it has seen (which is also Nano time). Returns an empty list
        if the window is outside the buffer. Bounds are tolerant: a swapped (to, from) pair is
        normalised to keep the caller honest.
        """
        try:
            from_ms = int(from_ms); to_ms = int(to_ms)
        except (TypeError, ValueError):
            return []
        if from_ms > to_ms:
            from_ms, to_ms = to_ms, from_ms
        with self._lock:
            return [s for s in self._dq if from_ms <= s.timestamp_ms <= to_ms]

    def to_csv_range(self, from_ms: int, to_ms: int) -> str:
        """The buffer slice within [from_ms, to_ms] as CSV (header-only if empty)."""
        return to_csv(self.samples_in_range(from_ms, to_ms))

    def to_csv(self) -> str:
        with self._lock:
            rows = list(self._dq)
        return to_csv(rows)
