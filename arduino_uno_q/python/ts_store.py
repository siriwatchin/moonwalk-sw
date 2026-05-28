"""TimeSeriesStore Brick layer — persists samples to the App Lab time-series DB in batches.

Writes each IMU sample as 9 separate time-series metrics via the brick:
    from arduino.app_bricks.dbstorage_tsstore import TimeSeriesStore
    db = TimeSeriesStore(); db.start()
    db.write_sample(metric_name, value)

This is the COLD path (history/analysis), separate from the live view: the dashboard plots
from the in-memory SampleStore (see store.py), so the app never reads back from here. To keep
the ingest hot path cheap, writes are decoupled — `enqueue()` only appends to an in-memory
queue, and a background thread flushes the queue to the DB in batches every
`TS_FLUSH_INTERVAL_S` (or sooner once `TS_BATCH_MAX` is reached).

Caveat: because writes are batched, a point lands in the DB at ~flush time, so its DB timestamp
can lag the sample's real time by up to TS_FLUSH_INTERVAL_S (~1 s). That granularity is fine for
trend analysis. (If the brick later exposes an explicit per-point timestamp or a bulk-write API,
plug it into `_write_batch` — see the TODO seam there.)

`db` is injectable so the metric mapping + batching are testable off-device (no SDK needed).
"""

from __future__ import annotations

import threading

from config import TS_BATCH_MAX, TS_FLUSH_INTERVAL_S
from models import ImuSample

# Time-series metric names (spec) mapped from ImuSample fields.
#   sample-field -> metric-name
_METRIC_MAP = {
    "ax": "ax_ms2", "ay": "ay_ms2", "az": "az_ms2",
    "gx": "gx_dps", "gy": "gy_dps", "gz": "gz_dps",
    "acc_norm": "acc_norm", "gyro_norm": "gyro_norm",
    "phase": "phase",
}

_QUEUE_CAP = TS_BATCH_MAX * 8   # drop-guard if the DB stalls (live view is unaffected)
_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    if tag not in _logged:
        _logged.add(tag)
        print(f"[tsstore] {tag} failed: {exc} (further errors suppressed)", flush=True)


class TsStore:
    def __init__(self, db=None):
        if db is None:
            from arduino.app_bricks.dbstorage_tsstore import TimeSeriesStore
            db = TimeSeriesStore()
        self.db = db
        self.db.start()
        self._lock = threading.Lock()
        self._pending: list[tuple[str | None, ImuSample]] = []
        self._dropped = 0
        self._stop = threading.Event()
        self._flush_now = threading.Event()
        self._thread = threading.Thread(target=self._flush_loop, daemon=True)
        self._thread.start()

    # ---- hot path: cheap, non-blocking ---------------------------------
    def enqueue(self, sample: ImuSample, device_key: str | None = None) -> None:
        """Queue one sample for the next batch flush. Called from the ingest loop."""
        with self._lock:
            self._pending.append((device_key, sample))
            n = len(self._pending)
            if n > _QUEUE_CAP:                       # DB stalled — shed oldest, keep newest
                drop = n - _QUEUE_CAP
                del self._pending[:drop]
                self._dropped += drop
        if n >= TS_BATCH_MAX:
            self._flush_now.set()                    # flush early instead of waiting

    # ---- cold path: background batch flush -----------------------------
    def _flush_loop(self) -> None:
        while not self._stop.is_set():
            # Wake on the interval, an early-flush signal, or stop.
            self._flush_now.wait(TS_FLUSH_INTERVAL_S)
            self._flush_now.clear()
            self._flush_once()
        self._flush_once()                           # final drain on shutdown

    def _flush_once(self) -> None:
        with self._lock:
            batch, self._pending = self._pending, []
            dropped, self._dropped = self._dropped, 0
        if dropped:
            _log_once("queue overflow (dropped oldest)", RuntimeError(f"{dropped} samples"))
        if batch:
            self._write_batch(batch)

    def _write_batch(self, batch: list[tuple[str | None, ImuSample]]) -> None:
        """Write a batch of samples to the brick (9 metrics each). One flush = one batch.

        TODO(brick): if a bulk write_points / explicit-timestamp API is confirmed on hardware,
        swap it in here; the rest of the pipeline is unaffected.
        """
        try:
            for device_key, sample in batch:
                d = sample.to_dict()
                prefix = f"{device_key}." if device_key else ""
                for field, metric in _METRIC_MAP.items():
                    self.db.write_sample(f"{prefix}{metric}", d[field])
        except Exception as exc:
            _log_once("write_sample", exc)

    # ---- read API (future analytics; the UI uses the in-memory buffer) -
    def read_last(self, metric: str):
        """Latest value for a metric from the TS store (alt/future path; UI uses the buffer)."""
        try:
            return self.db.read_last_sample(metric)
        except Exception:
            return None

    def read_range(self, metric: str, start_from: str, end_to: str):
        """Historical samples in an ISO8601 time range (for future analytics)."""
        return self.db.read_samples(metric, start_from=start_from, end_to=end_to)

    def stop(self) -> None:
        """Stop the flush thread, drain the queue once more, then stop the brick."""
        self._stop.set()
        self._flush_now.set()
        if self._thread.is_alive():
            self._thread.join(timeout=TS_FLUSH_INTERVAL_S + 2.0)
        try:
            self.db.stop()
        except Exception:
            pass

    # Retention: the App Lab TimeSeriesStore (InfluxDB-backed) manages its own on-disk
    # retention; this gateway does not delete data. If disk pressure becomes an issue on the
    # UNO Q, configure retention on the brick/DB side.
    # TODO(retention): expose/verify the brick's retention policy once confirmed on hardware.
