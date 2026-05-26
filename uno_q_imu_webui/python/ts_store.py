"""TimeSeriesStore Brick layer — persists every sample to the App Lab time-series DB.

Writes each IMU sample as 9 separate time-series metrics via the brick:
    from arduino.app_bricks.dbstorage_tsstore import TimeSeriesStore
    db = TimeSeriesStore(); db.start()
    db.write_sample(metric_name, value)

The dashboard reads from the in-memory SampleStore (see store.py), so the app does
not depend on the TS read API. `read_last()` is a best-effort alt path only.

`db` is injectable so the metric mapping is testable off-device (no SDK needed).
"""

from __future__ import annotations

from models import ImuSample

# Time-series metric names (spec) mapped from ImuSample fields.
#   sample-field -> metric-name
_METRIC_MAP = {
    "ax": "ax_ms2", "ay": "ay_ms2", "az": "az_ms2",
    "gx": "gx_dps", "gy": "gy_dps", "gz": "gz_dps",
    "acc_norm": "acc_norm", "gyro_norm": "gyro_norm",
    "phase": "phase",
}


class TsStore:
    def __init__(self, db=None):
        if db is None:
            from arduino.app_bricks.dbstorage_tsstore import TimeSeriesStore
            db = TimeSeriesStore()
        self.db = db
        self.db.start()

    def write(self, sample: ImuSample) -> None:
        """Write all 9 metrics of one sample to the time-series store."""
        d = sample.to_dict()
        for field, metric in _METRIC_MAP.items():
            self.db.write_sample(metric, d[field])

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
        """Cleanly stop the TimeSeriesStore service."""
        try:
            self.db.stop()
        except Exception:
            pass
