"""Thread-safe rolling buffer of recent samples + connection status.

The source runner thread writes; the web server thread reads via snapshot().
snapshot() is also the seam for future analytics / Supabase upload.
"""

from __future__ import annotations

import threading
import time
from collections import deque

from .config import RECENT_POINTS
from .models import ImuSample


class SampleBuffer:
    def __init__(self, maxlen: int):
        self._dq: deque[ImuSample] = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._status = "starting"
        self._count = 0
        self._last_recv = 0.0

    def set_status(self, status: str) -> None:
        with self._lock:
            self._status = status

    def append(self, sample: ImuSample) -> None:
        with self._lock:
            self._dq.append(sample)
            self._count += 1
            self._last_recv = time.time()

    def snapshot(self, recent_points: int = RECENT_POINTS) -> dict:
        """Return a JSON-serializable view for the dashboard / future uploaders."""
        with self._lock:
            recent = list(self._dq)[-recent_points:]
            latest = recent[-1] if recent else None
            age_s = (time.time() - self._last_recv) if self._last_recv else None
            return {
                "status": self._status,
                # "live" = we've received a sample within the last ~1.5 s
                "live": age_s is not None and age_s < 1.5,
                "count": self._count,
                "age_s": round(age_s, 2) if age_s is not None else None,
                "latest": latest.to_dict() if latest else None,
                "recent": {
                    "t": [s.timestamp_ms for s in recent],
                    "acc_norm": [round(s.acc_norm, 4) for s in recent],
                    "gyro_norm": [round(s.gyro_norm, 4) for s in recent],
                    "phase": [s.phase for s in recent],
                },
            }
