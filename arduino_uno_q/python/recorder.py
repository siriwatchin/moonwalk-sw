"""Single-session recorder: Start (label) → accumulate → Stop → download CSV.

Server-side capture fed from the ingest loop (source_manager._run), so a recording catches
EVERY sample from Start to Stop regardless of the rolling buffer size or whether the browser is
polling. Only one recording is active at a time, bound to the slot it was started on. After Stop
(or hitting the cap) the finished recording is retained in memory until the next Start, so the
browser can download its CSV. No SDK imports — testable off-device.
"""

from __future__ import annotations

import re
import threading
import time

from config import RECORD_MAX_SAMPLES
from models import ImuSample
from store import to_csv as _samples_to_csv


def _safe_label(label: str) -> str:
    """Filename-safe but readable label. Keeps the user's text as-is — including non-ASCII
    (e.g. Thai) and spaces — and only strips characters illegal in filenames across OSes plus
    control chars. Empty/garbage falls back to 'rec'. (The download serves it via an RFC 5987
    UTF-8 Content-Disposition, so non-ASCII names survive in the browser.)
    """
    s = re.sub(r'[/\\:*?"<>|\x00-\x1f]+', "", label or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s or "rec"


class Recorder:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._recording = False
        self._slot: str | None = None
        self._label = "rec"
        self._started_at = 0.0       # wall clock at start (for the download filename)
        self._started_mono = 0.0     # monotonic at start (for elapsed_s)
        self._samples: list[ImuSample] = []
        # Retained finished recording (survives Stop until the next Start) for download.
        self._done_label = ""
        self._done_slot: str | None = None
        self._done_at = 0.0
        self._done_samples: list[ImuSample] = []

    # ---- control (WebUI thread) ----------------------------------------
    def start(self, slot: str, label: str) -> dict:
        with self._lock:
            self._recording = True
            self._slot = slot
            self._label = _safe_label(label)
            self._started_at = time.time()
            self._started_mono = time.monotonic()
            self._samples = []
        return self.state()

    def stop(self) -> dict:
        with self._lock:
            self._finalize_locked()
        return self.state()

    def _finalize_locked(self) -> None:
        """Move the active recording into the retained 'finished' slot. Lock held."""
        if not self._recording:
            return
        self._recording = False
        self._done_label = self._label
        self._done_slot = self._slot
        self._done_at = self._started_at
        self._done_samples = self._samples
        self._samples = []

    # ---- hot path (ingest threads) -------------------------------------
    def record(self, slot: str, sample: ImuSample) -> None:
        if not self._recording:          # cheap unlocked fast-path (re-checked under lock)
            return
        with self._lock:
            if not self._recording or slot != self._slot:
                return
            self._samples.append(sample)
            if len(self._samples) >= RECORD_MAX_SAMPLES:
                self._finalize_locked()  # cap reached → finalize so RAM stays bounded

    # ---- readers (WebUI thread) ----------------------------------------
    def to_csv(self) -> str:
        with self._lock:
            rows = list(self._done_samples)
        return _samples_to_csv(rows)

    def download_filename(self) -> str:
        """The recording's label as the download filename (the label is already filesystem-safe)."""
        with self._lock:
            return f"{self._done_label or 'rec'}.csv"

    def state(self) -> dict:
        with self._lock:
            elapsed = (time.monotonic() - self._started_mono) if self._recording else 0.0
            return {
                "active": self._recording,
                "slot": self._slot if self._recording else self._done_slot,
                "label": self._label if self._recording else self._done_label,
                "count": len(self._samples) if self._recording else len(self._done_samples),
                "elapsed_s": round(elapsed, 1),
                "has_recording": len(self._done_samples) > 0,
            }
