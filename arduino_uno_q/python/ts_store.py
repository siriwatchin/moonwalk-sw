"""TimeSeriesStore Brick layer — persists samples to the App Lab time-series DB in batches.

Writes each IMU sample as 7 separate time-series metrics via the brick:
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
    "pressure": "pressure_pa",
}

_QUEUE_CAP = TS_BATCH_MAX * 8   # drop-guard if the DB stalls (live view is unaffected)
_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    if tag not in _logged:
        _logged.add(tag)
        print(f"[tsstore] {tag} failed: {exc} (further errors suppressed)", flush=True)


# ---- brick row-shape adapters (cold-path read) ---------------------------
# Empirically the App Lab TimeSeriesStore brick returns list[tuple(metric_name, iso_ts, value)]
# on this UNO Q build (3-tuple). These helpers also cover dict / 2-tuple / attr shapes so a
# future brick change doesn't silently break /api/export/history — instead we detect the shape
# from length/type.
def _extract_ts_ms(row, fallback) -> int:
    """Return the row's timestamp in milliseconds (epoch), or `fallback` if unavailable."""
    ts = None
    if isinstance(row, dict):
        ts = row.get("time") or row.get("timestamp") or row.get("ts")
    elif isinstance(row, (tuple, list)):
        if len(row) >= 3:           # (metric_name, ts, value) — App Lab brick shape
            ts = row[1]
        elif len(row) >= 1:         # (ts, value) — legacy 2-tuple
            ts = row[0]
    else:
        ts = getattr(row, "time", None) or getattr(row, "timestamp", None) or getattr(row, "ts", None)
    if ts is None:
        return int(fallback)
    # The brick may give a datetime, an ISO string, an epoch-seconds float, or an epoch-ms int.
    try:
        from datetime import datetime
        if isinstance(ts, datetime):
            return int(ts.timestamp() * 1000)
        if isinstance(ts, str):
            # `datetime.fromisoformat` accepts "YYYY-MM-DDTHH:MM:SS[.fff][+TZ]" — wide enough for
            # InfluxDB-style outputs. Strip a trailing "Z" first since Python's parser predates it.
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        if isinstance(ts, (int, float)):
            # Seconds vs ms heuristic: anything below year 2200 in ms is > 7e12, but a Unix-second
            # value would be < 1e10. So values above 1e12 are already ms.
            return int(ts if ts > 1e12 else ts * 1000)
    except Exception:
        pass
    return int(fallback)


def _extract_value(row):
    """Pull the numeric value out of a row, agnostic to brick shape."""
    if isinstance(row, dict):
        return row.get("value") if "value" in row else row.get("v")
    if isinstance(row, (tuple, list)):
        if len(row) >= 3:           # (metric_name, ts, value)
            return row[2]
        if len(row) >= 2:           # (ts, value)
            return row[1]
        return None
    return getattr(row, "value", None)


def _samples_csv_header() -> str:
    """Header-only CSV (matches the live store's columns) for an empty range."""
    return "timestamp_ms,ax,ay,az,gx,gy,gz,pressure\r\n"


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
        """Write a batch of samples to the brick (7 metrics each). One flush = one batch.

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

    def read_range_csv(self, start_from: str, end_to: str,
                       device_key: str | None = None) -> str:
        """Cold-path CSV export: pull every metric over [start_from, end_to] and join into
        Nano-CSV rows (timestamp_ms, ax, ay, az, gx, gy, gz, pressure).

        The brick writes 7 metrics per sample with no explicit timestamp — DB rows land at
        ~flush time (~1 s lag), and each sample's 7 metrics share a near-identical (but not
        identical) timestamp. So we join by **ordinal index**, not by exact timestamp match:
        the i-th `ax_ms2` row is the i-th `ay_ms2` row's sibling, etc. If any series is short
        (write dropped, brick partial), we truncate to `min(len)` so columns stay aligned —
        a noisy warning would be normal during the brick's settling moments, so we just log
        once per session via `_log_once`.

        The returned timestamp column is the **DB row's** ts (millisecond epoch when available)
        — not the Nano's `timestamp_ms` (which the brick never saw). For the live buffer use
        `SampleStore.to_csv_range`; this CSV is the only way to get history beyond ~30 s.

        Brick return shape is not verifiable off-device — `_extract_ts_value` accepts the
        common variants (tuple, dict, custom object with attributes), so the join keeps working
        if the brick changes its return without us updating here.
        """
        prefix = f"{device_key}." if device_key else ""
        fields = ["ax", "ay", "az", "gx", "gy", "gz", "pressure"]   # mirrors ImuSample columns
        series: dict[str, list] = {}
        for f in fields:
            metric = f"{prefix}{_METRIC_MAP[f]}"
            try:
                rows = self.db.read_samples(metric, start_from=start_from, end_to=end_to) or []
            except Exception as exc:
                _log_once(f"read_samples({metric})", exc)
                rows = []
            series[f] = rows
        # Align to the shortest series so rows stay rectangular.
        n = min((len(rows) for rows in series.values()), default=0)
        if n == 0:
            return _samples_csv_header()
        # Pick the ax series' timestamps as the row clock (any series works; ax has no special
        # meaning). Fall back to a synthetic 0..n-1 if the brick returns valueless points.
        ts_rows = series["ax"][:n]

        import csv as _csv
        import io as _io
        buf = _io.StringIO()
        w = _csv.DictWriter(buf, fieldnames=["timestamp_ms", *fields])
        w.writeheader()
        for i in range(n):
            ts_ms = _extract_ts_ms(ts_rows[i], fallback=i)
            row = {"timestamp_ms": ts_ms}
            for f in fields:
                row[f] = _extract_value(series[f][i])
            w.writerow(row)
        return buf.getvalue()

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
