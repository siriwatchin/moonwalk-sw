"""Stdlib-only HTTP client for the on-board InfluxDB (the same DB the TimeSeriesStore brick
writes to). Used by the Analysis page so we can do server-side aggregation
(mean per ~50 ms window) instead of paying the brick's per-metric N+1 row reads.

Why this exists (not a brick wrapper): `ts_store.py` is the only module that touches the
TimeSeriesStore *brick* (`arduino.app_bricks.dbstorage_tsstore`). This module talks to the
**underlying InfluxDB** at the HTTP wire level — a different surface, no brick import — so
the architectural rule still holds. It is brick-free and importable off-device.

Auto-detects v1.x (InfluxQL via /query, JSON) vs v2.x (Flux via /api/v2/query, CSV) on the
first call (cached via `/ping`'s X-Influxdb-Version header). v2 uses basic auth via the v1-
compat layer, which is what `admin`/`Arduino15` implies — no API token needed.

Auto-discovers the database (v1) or bucket (v2) on first query if not set in config; picks
the first non-system one. Set `INFLUX_DB` / `INFLUX_BUCKET` in `config.py` after the
on-board probe to skip the discovery round-trip and pin the name.

No third-party deps. urllib + json + csv + base64 only.
"""

from __future__ import annotations

import base64
import csv
import io
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


# The 7 IMU fields the brick writes (see ts_store._METRIC_MAP). Order is canonical: charts
# and the CSV export both expect ax,ay,az,gx,gy,gz,pressure. The InfluxDB "measurement" names
# include the device-key prefix, e.g. "A.ax_ms2".
FIELDS_LONG: tuple[str, ...] = (
    "ax_ms2", "ay_ms2", "az_ms2",
    "gx_dps", "gy_dps", "gz_dps",
    "pressure_pa",
)

# Short field names used in the JSON shape returned to the frontend (and in ImuSample).
LONG_TO_SHORT: dict[str, str] = {
    "ax_ms2": "ax", "ay_ms2": "ay", "az_ms2": "az",
    "gx_dps": "gx", "gy_dps": "gy", "gz_dps": "gz",
    "pressure_pa": "pressure",
}


class InfluxError(RuntimeError):
    """Raised for any InfluxDB failure (network, auth, malformed response).

    Caller (`AnalysisService.compute` → `webui_server`) maps these to a 503 response so
    the realtime dashboard keeps working when the cold-path DB is unavailable.
    """


@dataclass
class _Version:
    major: int   # 1 or 2
    raw: str     # raw header value, kept for diagnostics


class InfluxClient:
    """Minimal InfluxDB read client. One method matters: `query_range`.

    Lazy: nothing is sent over the wire until the first query. That keeps off-device
    `import influx_client` cheap and means an unreachable DB at boot doesn't crash the app —
    `AnalysisService` constructs us happily; the first /api/analysis/* call gets the 503.
    """

    def __init__(
        self,
        url: str,
        username: str = "",
        password: str = "",
        token: Optional[str] = None,
        db: Optional[str] = None,
        bucket: Optional[str] = None,
        org: Optional[str] = None,
        measurement: str = "arduino",
        timeout_s: float = 5.0,
    ) -> None:
        # Strip trailing slash so the URL joins below stay predictable.
        self.url = url.rstrip("/")
        self.user = username
        self.password = password
        # Token wins over basic auth. v2 /api/v2/* endpoints only accept tokens; basic auth
        # works only on v1 endpoints (and the v1-compat /write /query on a v2 server). Pass
        # the admin token from `INFLUXDB_ADMIN_TOKEN` for full v2 access.
        self.token = token
        self.db = db
        self.bucket = bucket
        self.org = org
        # The brick stores every per-device-per-channel sample inside a single measurement
        # (default "arduino") with the metric name (`A.ax_ms2`, `B.gx_dps`, …) as the
        # _field key — NOT as the _measurement. Pinning this avoids hand-guessing the
        # schema; override only if a future brick build changes it.
        self.measurement = measurement
        self.timeout = timeout_s
        self._version: Optional[_Version] = None

    # ---- public API -----------------------------------------------------

    def query_range(
        self,
        device_key: str,
        start_iso: str,
        end_iso: str,
        downsample_ms: Optional[int] = None,
    ) -> dict[str, list[tuple[int, float]]]:
        """Return the 7 IMU channels over [start_iso, end_iso].

        Output: ``{"ax": [(ts_ms, value), ...], "ay": [...], ..., "pressure": [...]}``.
        Timestamps are epoch milliseconds. If ``downsample_ms`` is given the result is
        the per-window mean — what the analysis pipeline wants (50 ms grid matches the
        Nano's 20 Hz write cadence, so it's effectively raw + light denoise from the
        flush jitter).
        """
        v = self._get_version()
        if v.major == 1:
            return self._query_v1(device_key, start_iso, end_iso, downsample_ms)
        if v.major == 2:
            return self._query_v2(device_key, start_iso, end_iso, downsample_ms)
        raise InfluxError(f"unsupported InfluxDB major version: {v.major} ({v.raw!r})")

    def list_device_keys(self) -> list[str]:
        """Return the set of device-key prefixes that have data in the bucket.

        The brick names every field as ``<device>.<metric>`` (e.g. ``A.ax_ms2`` /
        ``B.gz_dps``) under one measurement. We `schema.fieldKeys` the bucket, split each
        result on the first ``.`` and dedupe — so ``A`` + ``B`` + any future device key
        come out alphabetically sorted. Empty list ⇒ no data has been written yet (or the
        measurement name is wrong).

        Cached for the client's lifetime: new device keys are rare events (they appear when
        a new source registers), and the dashboard reloads the client on container restart
        anyway. Re-discovery costs one Flux query (~200 ms) so caching is mostly polite.
        """
        if getattr(self, "_device_keys_cache", None) is not None:
            return self._device_keys_cache
        v = self._get_version()
        if v.major == 2:
            bucket = self.bucket or self._discover_bucket_v2()
            org = self.org or "-"
            flux = (
                f'import "influxdata/influxdb/schema"\n'
                f'schema.fieldKeys(bucket: "{bucket}", '
                f'predicate: (r) => r._measurement == "{self.measurement}")\n'
            )
            url = f"{self.url}/api/v2/query?org={urllib.parse.quote(org)}"
            raw = self._http_post(
                url, data=flux.encode("utf-8"),
                headers={
                    "Authorization": self._auth_header(),
                    "Content-Type": "application/vnd.flux",
                    "Accept": "application/csv",
                },
            )
            text = raw.decode("utf-8", errors="replace")
            keys: set[str] = set()
            for row in csv.reader(io.StringIO(text)):
                if not row:
                    continue
                # The CSV emits annotations (#group / #datatype / #default), a header row
                # (with `_value`), then data rows with the field name in the last column.
                if row[0].startswith("#") or "_value" in row:
                    continue
                field_name = row[-1] if row[-1] else ""
                if not field_name or "." not in field_name:
                    continue
                keys.add(field_name.split(".", 1)[0])
        elif v.major == 1:
            db = self.db or self._discover_db_v1()
            payload = self._http_post_form(
                "/query", {"db": db, "q": f'SHOW FIELD KEYS FROM "{self.measurement}"'},
            )
            keys = set()
            for res in payload.get("results", []) or []:
                for series in res.get("series", []) or []:
                    for row in series.get("values", []) or []:
                        name = row[0] if row else ""
                        if name and "." in name:
                            keys.add(name.split(".", 1)[0])
        else:
            keys = set()
        self._device_keys_cache = sorted(keys)
        return self._device_keys_cache

    def health(self) -> dict:
        """Cheap probe used by /api/analysis/health. Returns version + DB/bucket name."""
        try:
            v = self._get_version()
            return {
                "reachable": True,
                "version": v.raw,
                "major": v.major,
                "db": self.db,
                "bucket": self.bucket,
                "org": self.org,
                "measurement": self.measurement,
                "auth": "token" if self.token else "basic",
            }
        except InfluxError as exc:
            return {"reachable": False, "error": str(exc)}

    # ---- version detection (cached) -------------------------------------

    def _get_version(self) -> _Version:
        if self._version is not None:
            return self._version
        req = urllib.request.Request(f"{self.url}/ping", method="GET")
        req.add_header("Authorization", self._auth_header())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                ver = r.headers.get("X-Influxdb-Version", "") or ""
        except urllib.error.URLError as exc:
            raise InfluxError(f"InfluxDB unreachable at {self.url}: {exc}") from exc
        # 1.x → "1.8.10"; 2.x → "v2.7.4" or "2.7.4"; cloud variants may include suffixes.
        m = re.match(r"^v?(\d+)\.", ver)
        if not m:
            raise InfluxError(f"could not parse InfluxDB version header: {ver!r}")
        self._version = _Version(major=int(m.group(1)), raw=ver)
        return self._version

    def _auth_header(self) -> str:
        """Build the right `Authorization` header for this server.

        Token wins because v2's /api/v2/* endpoints only accept tokens; basic auth here gets
        silently routed through the v1-compat layer and returns empty responses. v1 servers
        (and v1-compat endpoints on v2) accept basic auth fine.
        """
        if self.token:
            return f"Token {self.token}"
        b64 = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        return f"Basic {b64}"

    # ---- v1 InfluxQL ----------------------------------------------------

    def _query_v1(
        self,
        device_key: str,
        start_iso: str,
        end_iso: str,
        downsample_ms: Optional[int],
    ) -> dict[str, list[tuple[int, float]]]:
        db = self.db or self._discover_db_v1()
        # Schema: ONE measurement (default "arduino") with the metric name (`A.ax_ms2`) as
        # the FIELD KEY, not the measurement. One InfluxQL statement aliases each field
        # back to its short name so we can demux into the channel dict by alias name.
        time_clause = f"time >= '{start_iso}' AND time <= '{end_iso}'"
        select_parts = []
        for long_field in FIELDS_LONG:
            field_key = f'"{device_key}.{long_field}"'
            short = LONG_TO_SHORT[long_field]
            if downsample_ms:
                select_parts.append(f'mean({field_key}) AS "{short}"')
            else:
                select_parts.append(f'{field_key} AS "{short}"')
        select_clause = ", ".join(select_parts)
        q = f'SELECT {select_clause} FROM "{self.measurement}" WHERE {time_clause}'
        if downsample_ms:
            q += f" GROUP BY time({int(downsample_ms)}ms) fill(none)"
        payload = self._http_post_form(
            "/query", {"db": db, "q": q, "epoch": "ms"},
        )

        out: dict[str, list[tuple[int, float]]] = {LONG_TO_SHORT[f]: [] for f in FIELDS_LONG}
        for res in payload.get("results", []) or []:
            if "error" in res:
                raise InfluxError(f"InfluxDB query error: {res['error']}")
            for series in res.get("series", []) or []:
                # Multi-aliased select returns one row per timestamp with columns:
                # ["time", "ax", "ay", ..., "pressure"]
                columns = series.get("columns", []) or []
                idx = {c: i for i, c in enumerate(columns)}
                t_idx = idx.get("time", 0)
                for row in series.get("values", []) or []:
                    if not row:
                        continue
                    try:
                        ts_ms = int(row[t_idx])
                    except (TypeError, ValueError):
                        continue
                    for long_field in FIELDS_LONG:
                        short = LONG_TO_SHORT[long_field]
                        ci = idx.get(short)
                        if ci is None or ci >= len(row) or row[ci] is None:
                            continue
                        try:
                            out[short].append((ts_ms, float(row[ci])))
                        except (TypeError, ValueError):
                            continue
        return out

    def _discover_db_v1(self) -> str:
        """SHOW DATABASES → pick the first non-_internal one and cache it.

        The brick docs don't expose the DB name, and `docker exec env | grep INFLUX` is the
        only ground-truth source — but on most App Lab UNO Q builds there's exactly one user
        DB next to `_internal`, so picking the first non-system entry is correct in practice.
        """
        payload = self._http_post_form("/query", {"q": "SHOW DATABASES"})
        candidates: list[str] = []
        for res in payload.get("results", []) or []:
            for series in res.get("series", []) or []:
                for row in series.get("values", []) or []:
                    name = row[0] if row else None
                    if name and name != "_internal":
                        candidates.append(name)
        if not candidates:
            raise InfluxError(
                "no non-_internal InfluxDB databases found; set INFLUX_DB in config.py"
            )
        self.db = candidates[0]
        return self.db

    # ---- v2 Flux --------------------------------------------------------

    def _query_v2(
        self,
        device_key: str,
        start_iso: str,
        end_iso: str,
        downsample_ms: Optional[int],
    ) -> dict[str, list[tuple[int, float]]]:
        bucket = self.bucket or self._discover_bucket_v2()
        # `-` works as org in many v1-compat / single-org setups; let config override if needed.
        org = self.org or "-"
        agg = (
            f"  |> aggregateWindow(every: {int(downsample_ms)}ms, fn: mean, createEmpty: false)\n"
            if downsample_ms else ""
        )
        # Schema: r._measurement == "arduino" (a single measurement), r._field is the metric
        # name ("A.ax_ms2" / "A.gy_dps" / …). Build an OR-of-equality filter; using a regex
        # works too but Influx's planner is happier with explicit equality.
        field_or = " or ".join(
            f'r._field == "{device_key}.{long_field}"' for long_field in FIELDS_LONG
        )
        flux = (
            f'from(bucket: "{bucket}")\n'
            f"  |> range(start: {start_iso}, stop: {end_iso})\n"
            f'  |> filter(fn: (r) => r._measurement == "{self.measurement}" '
            f"and ({field_or}))\n"
            f"{agg}"
            f'  |> keep(columns: ["_field", "_time", "_value"])\n'
        )
        url = f"{self.url}/api/v2/query?org={urllib.parse.quote(org)}"
        raw = self._http_post(
            url,
            data=flux.encode("utf-8"),
            headers={
                "Authorization": self._auth_header(),
                "Content-Type": "application/vnd.flux",
                "Accept": "application/csv",
            },
        )
        return self._parse_flux_csv(device_key, raw.decode("utf-8", errors="replace"))

    def _discover_bucket_v2(self) -> str:
        url = f"{self.url}/api/v2/buckets"
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", self._auth_header())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                payload = json.loads(r.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise InfluxError(f"InfluxDB /api/v2/buckets {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise InfluxError(f"InfluxDB /api/v2/buckets unreachable: {exc}") from exc

        candidates: list[str] = []
        for b in payload.get("buckets", []) or []:
            name = b.get("name") or ""
            # System buckets are conventionally prefixed with "_".
            if name and not name.startswith("_"):
                candidates.append(name)
        if not candidates:
            raise InfluxError(
                "no non-system InfluxDB buckets found; set INFLUX_BUCKET in config.py"
            )
        self.bucket = candidates[0]
        return self.bucket

    def _parse_flux_csv(
        self, device_key: str, raw: str,
    ) -> dict[str, list[tuple[int, float]]]:
        """Parse Flux's annotated CSV.

        The Flux response is annotated CSV — one or more tables, each preceded by `#group` /
        `#datatype` / `#default` annotation rows and a column-name header. Tables are
        separated by blank rows. We asked Flux to `keep` only `_field`, `_time`, `_value`,
        so the data rows have an empty first column (the row index from the CSV dialect),
        then `result`, `table`, then our 3 columns.

        Demux by `_field`: the metric name is the field key (`A.ax_ms2`), not the measurement.
        """
        out: dict[str, list[tuple[int, float]]] = {LONG_TO_SHORT[f]: [] for f in FIELDS_LONG}
        if not raw.strip():
            return out
        # One header per table; re-resolve indices each time (column order is stable in
        # practice, but the protocol is what it is).
        field_idx = time_idx = value_idx = -1
        for row in csv.reader(io.StringIO(raw)):
            if not row:
                # Blank row separates tables → reset the column-index cache.
                field_idx = time_idx = value_idx = -1
                continue
            first = row[0] if row else ""
            if first.startswith("#"):
                # Annotation row (#group / #datatype / #default) — ignore.
                continue
            if "_field" in row and "_value" in row:
                field_idx = row.index("_field")
                time_idx = row.index("_time") if "_time" in row else -1
                value_idx = row.index("_value")
                continue
            if field_idx < 0 or value_idx < 0:
                continue
            try:
                field_name = row[field_idx]
                # field_name = "A.ax_ms2"; strip the device-key prefix to look up the short name.
                if not field_name.startswith(f"{device_key}."):
                    continue
                long_field = field_name.split(".", 1)[1]
                short = LONG_TO_SHORT.get(long_field)
                if short is None:
                    continue
                ts_ms = _iso_to_ms(row[time_idx]) if time_idx >= 0 else 0
                value = float(row[value_idx])
            except (IndexError, ValueError):
                continue
            out[short].append((ts_ms, value))
        return out

    # ---- low-level HTTP -------------------------------------------------

    def _http_post_form(self, path: str, params: dict) -> dict:
        body = urllib.parse.urlencode(params).encode()
        raw = self._http_post(
            f"{self.url}{path}",
            data=body,
            headers={
                "Authorization": self._auth_header(),
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
        )
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise InfluxError(f"InfluxDB returned non-JSON: {raw[:200]!r}") from exc

    def _http_post(self, url: str, data: bytes, headers: dict) -> bytes:
        req = urllib.request.Request(url, data=data, method="POST")
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise InfluxError(f"InfluxDB {url} {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise InfluxError(f"InfluxDB {url} unreachable: {exc}") from exc


# ---- helpers ------------------------------------------------------------


def _iso_to_ms(iso_str: str) -> int:
    """Parse an RFC3339/ISO8601 timestamp (with optional 'Z' and fractional seconds) → epoch ms.

    Flux emits times like "2026-05-28T10:00:00.05Z" or with nanosecond precision; Python's
    `datetime.fromisoformat` handles up to microseconds, so we trim any extra digits.
    """
    s = (iso_str or "").strip()
    if not s:
        return 0
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        # Trim trailing precision beyond microseconds, e.g. ".123456789" → ".123456"
        s2 = re.sub(r"(\.\d{6})\d+", r"\1", s)
        try:
            dt = datetime.fromisoformat(s2)
        except ValueError:
            return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)
