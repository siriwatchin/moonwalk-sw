"""Pure-stdlib gait metric computation over an IMU history window.

Reads channel dicts ``{"ax": [(ts_ms, v), ...], ...}`` (as returned by
:class:`influx_client.InfluxClient.query_range`) and computes:

    0. Plant detection  — swing-axis rate enters quasi-still band, refractory-gated.
    1. Cadence + Stick Cycle time   — plant-to-plant intervals.
    2. Stick Duty Factor            — fraction of each cycle the cane is "planted"
                                      (gyro_mag below threshold).
    3. Stride length + velocity     — pendulum model: ZUPT-integrated swing-axis rate,
                                      ``stride ≈ L·sin(θ_max)``; needs ``stick_length_m``
                                      for absolute (trend works without).
    4. Step rhythm + symmetry       — alternating odd/even cycle intervals as best-effort
                                      L/R, per-side CV, ``score = 100·(0.6·SR + 0.4·consistency)``.

Metrics 5–8 (handle load, baseline, WSFC compliance, training-load score) are out of
scope for v1: the JSON response reserves the ``handle_load`` / ``wsfc`` keys as ``None``
and adds a ``"metrics 5–8 ... are phase 2"`` warning, so the frontend can already render
the slots without a contract churn when we ship them.

No brick imports, no numpy, no pandas — importable off-device and unit-testable.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional


# Module-level constants kept here (not in config.py) because they describe the *algorithm*,
# not a deployment knob. The tunables in `AnalysisParams` are user-facing.
_GRAVITY_MS2 = 9.80665
_MIN_STILL_SAMPLES = 2           # a "still" segment must hold for this many samples to count as a plant
_MIN_SAMPLES_FOR_REPORT = 8       # below this, refuse to compute and warn instead
_DEFAULT_HIST_BINS = 8


# ---- public surface ------------------------------------------------------

@dataclass
class AnalysisParams:
    """User-facing tunables. Defaults match the cookbook (CLAUDE.md context)."""

    plant_gyro_dps: float = 20.0      # |w| below this = quasi-still
    plant_refractory_ms: int = 220    # reject double-counts within this window
    stick_length_m: float = 0.9       # cane length L for absolute stride scaling
    # Reserved for metrics 5–8 (Phase 2). Kept here so the params payload is stable.
    p_tare_pa: float = 101325.0
    wsfc_target_pct: float = 60.0


def compute_report(
    channels: dict[str, list[tuple[int, float]]],
    params: AnalysisParams,
) -> dict:
    """Compute the full Analysis report from a channel dict.

    Pure: no I/O, no module-level state. Tolerates empty / sparse input — degenerate
    windows return a report with ``n_cycles == 0`` and an "insufficient_data" warning
    rather than raising.
    """
    warnings: list[str] = ["metrics 5–8 (handle load / WSFC) are phase 2"]

    aligned = _align_channels(channels)
    n = len(aligned["t"])
    if n < _MIN_SAMPLES_FOR_REPORT:
        return _empty_report(params, warnings + ["insufficient_data"], n_samples=n)

    # -- pre-compute axis-norms and pick the swing axis ---------------------
    swing_axis, swing = _pick_swing_axis(aligned)
    gyro_mag = _vector_norm(aligned["gx"], aligned["gy"], aligned["gz"])
    # Accel is m/s² on the wire; convert to g for the impact-band reasoning.
    acc_mag_g = [m / _GRAVITY_MS2 for m in _vector_norm(aligned["ax"], aligned["ay"], aligned["az"])]

    # -- plant detection ----------------------------------------------------
    plants = _detect_plants(aligned["t"], swing, params)
    if len(plants) < 2:
        return _empty_report(
            params, warnings + ["insufficient_plants"],
            n_samples=n, swing_axis=swing_axis, n_plants=len(plants),
        )

    # -- per-cycle metrics --------------------------------------------------
    cycles = _build_cycles(plants)
    _fill_duty(cycles, aligned["t"], gyro_mag, params.plant_gyro_dps)
    _fill_stride(cycles, aligned["t"], swing, params.stick_length_m)
    _fill_side(cycles)
    planted_timeline = _planted_segments(aligned["t"], gyro_mag, params.plant_gyro_dps)

    # -- aggregates ---------------------------------------------------------
    cycle_ms_list = [c["cycle_ms"] for c in cycles]
    cadence_list = [60_000.0 / c["cycle_ms"] for c in cycles if c["cycle_ms"] > 0]
    duty_list = [c["duty"] for c in cycles if c["duty"] is not None]
    stride_list = [c["stride_m"] for c in cycles if c["stride_m"] is not None]
    velocity_list = [
        c["stride_m"] / (c["cycle_ms"] / 1000.0)
        for c in cycles
        if c["stride_m"] is not None and c["cycle_ms"] > 0
    ]

    # Acceptance note (dev-friendly): if you change the report shape, also bump the
    # frontend's render() to match. The JSON keys are the contract.
    summary = {
        "n_plants": len(plants),
        "n_cycles": len(cycles),
        "cadence_steps_per_min": _stats(cadence_list, ndigits=2),
        "stick_cycle_time_ms":   _stats(cycle_ms_list, ndigits=0),
        "duty_factor":           _stats(duty_list, ndigits=3),
        "stride_length_m":       _stats(stride_list, ndigits=3),
        "stride_velocity_mps":   _stats(velocity_list, ndigits=3),
        "symmetry":              _symmetry(cycle_ms_list),
        "handle_load":           None,
        "wsfc":                  None,
    }
    series = {
        "cycles": [
            {
                "t_plant_ms": c["t_plant_ms"],
                "cycle_ms":   c["cycle_ms"],
                "side":       c["side"],
                "duty":       _round(c["duty"], 3),
                "stride_m":   _round(c["stride_m"], 3),
            }
            for c in cycles
        ],
        "cycle_time_histogram": _histogram(cycle_ms_list, n_bins=_DEFAULT_HIST_BINS),
        "planted_timeline":     planted_timeline,
    }

    return {
        "ok": True,
        "range": {
            "from": _ms_to_iso(aligned["t"][0]),
            "to":   _ms_to_iso(aligned["t"][-1]),
            "duration_s": round((aligned["t"][-1] - aligned["t"][0]) / 1000.0, 1),
            "n_samples": n,
            # `downsample_ms` and `device_key` come from the caller via AnalysisService.
        },
        "params": _params_payload(params, swing_axis=swing_axis),
        "summary": summary,
        "series": series,
        "warnings": warnings + [
            "side = best-effort alternation, not handedness",
        ],
    }


class AnalysisService:
    """Wraps an InfluxClient + compute_report so the WebUI route is a one-liner.

    Tolerates a None client (so an unreachable InfluxDB at boot doesn't crash the dashboard
    — main.py constructs us with None in that case, and the route returns 503).
    """

    def __init__(
        self,
        client,  # influx_client.InfluxClient, kept untyped to avoid import cycles
        params: Optional[AnalysisParams] = None,
        downsample_ms: int = 50,
        default_duration_s: int = 600,
    ) -> None:
        self.client = client
        self.params = params or AnalysisParams()
        self.downsample_ms = int(downsample_ms)
        self.default_duration_s = int(default_duration_s)

    def compute(self, start_iso: str, end_iso: str, device_key: str = "A") -> dict:
        channels = self.client.query_range(
            device_key, start_iso, end_iso, downsample_ms=self.downsample_ms,
        )
        report = compute_report(channels, self.params)
        report["range"]["downsample_ms"] = self.downsample_ms
        report["range"]["device_key"] = device_key
        # If the channels are all empty (range had no data in Influx), reflect that in the
        # range bounds so the UI shows the requested window instead of garbage.
        if not channels.get("ax"):
            report["range"]["from"] = start_iso
            report["range"]["to"] = end_iso
            try:
                report["range"]["duration_s"] = round(
                    (_iso_to_ms_safe(end_iso) - _iso_to_ms_safe(start_iso)) / 1000.0, 1,
                )
            except Exception:
                pass
        return report

    def latest(self, duration_s: Optional[int] = None, device_key: str = "A") -> dict:
        dur = int(duration_s or self.default_duration_s)
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        start_ms = now_ms - dur * 1000
        return self.compute(_ms_to_iso(start_ms), _ms_to_iso(now_ms), device_key=device_key)

    def params_dict(self) -> dict:
        return _params_payload(self.params)

    def list_devices(self) -> list[str]:
        """Pass-through to the InfluxClient; returns sorted device-key prefixes (A, B, ...)."""
        return self.client.list_device_keys()

    def health(self) -> dict:
        try:
            return self.client.health()
        except Exception as exc:  # noqa: BLE001 — health is a probe, never raises to caller
            return {"reachable": False, "error": str(exc)}


# ---- algorithm internals --------------------------------------------------


def _align_channels(channels: dict) -> dict:
    """Pivot per-channel ``(ts_ms, value)`` lists to per-sample columns.

    The InfluxDB aggregateWindow / GROUP BY time() produces the same time grid for every
    measurement, so in the common case all 7 channels are the same length and aligned
    point-for-point. We still defensively truncate to the min length (so any short
    channel doesn't smear) and use the ``ax`` timestamps as the master clock.
    """
    fields = ("ax", "ay", "az", "gx", "gy", "gz", "pressure")
    series = {f: channels.get(f) or [] for f in fields}
    n = min((len(series[f]) for f in fields if series[f]), default=0)
    if n == 0:
        return {"t": [], **{f: [] for f in fields}}
    out: dict = {"t": [series["ax"][i][0] for i in range(n)]}
    for f in fields:
        out[f] = [series[f][i][1] for i in range(n)]
    return out


def _pick_swing_axis(aligned: dict) -> tuple[str, list[float]]:
    """Pick the gyro axis with the largest stdev as the swing axis (cookbook §Stage 1).

    Avoids assuming gz. Returns the axis name (``"gx"``/``"gy"``/``"gz"``) and its series.
    """
    best = "gz"
    best_std = -1.0
    for axis in ("gx", "gy", "gz"):
        series = aligned[axis]
        if len(series) < 2:
            continue
        s = statistics.pstdev(series)
        if s > best_std:
            best_std = s
            best = axis
    return best, aligned[best]


def _vector_norm(x: list[float], y: list[float], z: list[float]) -> list[float]:
    n = min(len(x), len(y), len(z))
    return [math.sqrt(x[i] * x[i] + y[i] * y[i] + z[i] * z[i]) for i in range(n)]


def _detect_plants(t_ms: list[int], swing: list[float], params: AnalysisParams) -> list[int]:
    """Return plant timestamps (ms). Plant = first sample of a still segment (|w| < threshold
    for at least ``_MIN_STILL_SAMPLES`` samples), with a refractory gate to drop double-counts.

    The cookbook's full recipe also asks for an accel impact spike to disambiguate mid-air
    turnarounds; the "stillness must last ≥N samples" gate achieves the same effect at our
    20 Hz cadence (a mid-air zero-cross is single-sample at this rate) without needing a
    rolling baseline + threshold tuning that's brittle to gravity orientation.
    """
    thr = params.plant_gyro_dps
    refractory = params.plant_refractory_ms
    n = min(len(t_ms), len(swing))
    if n == 0:
        return []
    still = [abs(swing[i]) < thr for i in range(n)]

    plants: list[int] = []
    in_segment = False
    segment_start_i = -1
    last_plant_ms = -10 ** 9
    for i in range(n):
        if still[i]:
            if not in_segment:
                in_segment = True
                segment_start_i = i
            # Once the segment has held for _MIN_STILL_SAMPLES samples, the segment_start is
            # a real plant. Emit at the moment we hit that minimum (later than the entry, but
            # the entry-time is what cycles care about, so we use segment_start_i).
            held = i - segment_start_i + 1
            if held == _MIN_STILL_SAMPLES:
                t_plant = t_ms[segment_start_i]
                if t_plant - last_plant_ms >= refractory:
                    plants.append(t_plant)
                    last_plant_ms = t_plant
        else:
            in_segment = False
            segment_start_i = -1
    return plants


def _build_cycles(plants: list[int]) -> list[dict]:
    """One cycle per consecutive plant pair: ``cycle_ms = plants[n] - plants[n-1]``."""
    cycles: list[dict] = []
    for i in range(1, len(plants)):
        cycle_ms = plants[i] - plants[i - 1]
        if cycle_ms <= 0:
            continue
        cycles.append({
            "t_plant_ms": plants[i - 1],
            "t_next_ms":  plants[i],
            "cycle_ms":   cycle_ms,
            "duty":       None,
            "stride_m":   None,
            "side":       None,
        })
    return cycles


def _fill_duty(cycles: list[dict], t_ms: list[int], gyro_mag: list[float], thr: float) -> None:
    """For each cycle, ``duty = (planted ms) / cycle_ms`` where planted = gyro_mag < thr.

    Attributes each sample's interval **forward** (sample at t_j contributes dt = t_{j+1} − t_j,
    capped at the cycle boundary). A backward-looking sum loses the first sample's contribution
    (dt = 0 at j = i), which silently undercounts every cycle by one sample's worth.
    """
    if not cycles or not t_ms:
        return
    i = 0
    n = len(t_ms)
    for c in cycles:
        # Advance i to the first sample inside [t_plant_ms, t_next_ms).
        while i < n and t_ms[i] < c["t_plant_ms"]:
            i += 1
        planted_ms = 0
        j = i
        while j < n and t_ms[j] < c["t_next_ms"]:
            t_now = t_ms[j]
            t_next_sample = t_ms[j + 1] if j + 1 < n else c["t_next_ms"]
            # Cap the last sample's interval at the cycle boundary so durations sum to cycle_ms.
            dt = min(t_next_sample, c["t_next_ms"]) - t_now
            if dt > 0 and gyro_mag[j] < thr:
                planted_ms += dt
            j += 1
        if c["cycle_ms"] > 0:
            c["duty"] = planted_ms / c["cycle_ms"]


def _fill_stride(
    cycles: list[dict], t_ms: list[int], swing_dps: list[float], stick_length_m: float,
) -> None:
    """Pendulum-model stride per cycle.

    Between two plants:
      1. Estimate gyro bias as the mean swing-rate during the trailing planted window of the
         previous cycle (cookbook ZUPT). For v1 we use the mean over the whole window as a
         cheaper proxy — accurate enough since we just need to zero out a slow DC offset.
      2. Integrate ``(w - bias)·dt`` (rad·s/s) from one plant to the next.
      3. Take ``|θ|_max`` as the swept angle. ``stride ≈ L · sin(θ_max)``.
    """
    if not cycles or not t_ms:
        return
    n = len(t_ms)

    # Global bias proxy — mean of |swing| across the window is dominated by swing peaks, so we
    # use the median of the raw signed series as a near-zero-centred bias estimate.
    bias_dps = statistics.median(swing_dps) if swing_dps else 0.0
    dps_to_rps = math.pi / 180.0

    i = 0
    for c in cycles:
        while i < n and t_ms[i] < c["t_plant_ms"]:
            i += 1
        theta_rad = 0.0
        theta_max = 0.0
        j = i
        while j < n and t_ms[j] < c["t_next_ms"]:
            # Forward-looking interval (same fix as _fill_duty): attribute the sample's
            # contribution from t_j to t_{j+1}, capped at the cycle boundary, so the integral
            # covers the full cycle duration and doesn't drop the first sample.
            t_now = t_ms[j]
            t_next_sample = t_ms[j + 1] if j + 1 < n else c["t_next_ms"]
            dt_s = (min(t_next_sample, c["t_next_ms"]) - t_now) / 1000.0
            if dt_s > 0:
                w_rps = (swing_dps[j] - bias_dps) * dps_to_rps
                theta_rad += w_rps * dt_s
                if abs(theta_rad) > theta_max:
                    theta_max = abs(theta_rad)
            j += 1
        # stride = L * sin(theta_max). Clamp θ to [-π/2, π/2] so we cap the chord at L.
        theta_max = min(theta_max, math.pi / 2.0)
        c["stride_m"] = stick_length_m * math.sin(theta_max)


def _fill_side(cycles: list[dict]) -> None:
    """Best-effort L/R alternation: odd cycles are "L", even cycles are "R".

    This is **not** handedness — the cookbook explicitly says SR is label-free; the labels
    are just for the symmetry-pair grouping. The UI footnote says so too.
    """
    for idx, c in enumerate(cycles):
        c["side"] = "L" if (idx % 2 == 0) else "R"


def _planted_segments(t_ms: list[int], gyro_mag: list[float], thr: float) -> list[dict]:
    """Group consecutive planted samples into ``{from_ms, to_ms}`` segments for the timeline.

    Trimmed to non-trivial segments (> 50 ms) so the JSON stays small at long windows.
    """
    segments: list[dict] = []
    n = min(len(t_ms), len(gyro_mag))
    start_i = -1
    for i in range(n):
        is_still = gyro_mag[i] < thr
        if is_still and start_i < 0:
            start_i = i
        elif not is_still and start_i >= 0:
            if i - start_i >= 1 and t_ms[i - 1] - t_ms[start_i] >= 50:
                segments.append({"from_ms": t_ms[start_i], "to_ms": t_ms[i - 1]})
            start_i = -1
    if start_i >= 0 and n > 0 and t_ms[n - 1] - t_ms[start_i] >= 50:
        segments.append({"from_ms": t_ms[start_i], "to_ms": t_ms[n - 1]})
    return segments


def _symmetry(cycle_ms: list[int]) -> dict:
    """Best-effort odd/even alternation → per-side mean + CV → SR + consistency → score.

    Empty / single-cycle inputs return None-valued fields.
    """
    if len(cycle_ms) < 2:
        return {
            "left_interval_ms_mean": None,
            "right_interval_ms_mean": None,
            "symmetry_ratio": None,
            "left_cv": None,
            "right_cv": None,
            "rhythm_score": None,
        }
    left = cycle_ms[0::2]
    right = cycle_ms[1::2]
    left_mean = statistics.fmean(left) if left else 0.0
    right_mean = statistics.fmean(right) if right else 0.0
    if left_mean == 0 or right_mean == 0:
        sr = None
    else:
        sr = min(left_mean, right_mean) / max(left_mean, right_mean)
    left_cv = _cv(left)
    right_cv = _cv(right)
    cv_avg = None
    if left_cv is not None and right_cv is not None:
        cv_avg = (left_cv + right_cv) / 2.0
    elif left_cv is not None:
        cv_avg = left_cv
    elif right_cv is not None:
        cv_avg = right_cv
    consistency = (1.0 - cv_avg) if cv_avg is not None else None
    if sr is None or consistency is None:
        score = None
    else:
        # score = 100·(0.6·SR + 0.4·consistency); clamp to [0, 100] so a noisy short window
        # can't show a negative score.
        score = max(0.0, min(100.0, 100.0 * (0.6 * sr + 0.4 * consistency)))
    return {
        "left_interval_ms_mean":  round(left_mean, 1) if left else None,
        "right_interval_ms_mean": round(right_mean, 1) if right else None,
        "symmetry_ratio":         _round(sr, 3),
        "left_cv":                _round(left_cv, 3),
        "right_cv":               _round(right_cv, 3),
        "rhythm_score":           _round(score, 1),
    }


def _cv(values: list[float]) -> Optional[float]:
    """Coefficient of variation (stdev / mean). Needs at least 2 samples and a non-zero mean."""
    if len(values) < 2:
        return None
    mu = statistics.fmean(values)
    if mu == 0:
        return None
    return statistics.pstdev(values) / mu


def _stats(values: list[float], ndigits: int = 2) -> Optional[dict]:
    """Compact summary used in every metric card. Returns None for empty input."""
    if not values:
        return None
    return {
        "mean":   round(statistics.fmean(values), ndigits),
        "median": round(statistics.median(values), ndigits),
        "cv":     _round(_cv(values), 3),
    }


def _histogram(values: list[float], n_bins: int = 8) -> dict:
    """Equal-width histogram over [min, max]. Returns the JSON-shape used by the UI."""
    if not values:
        return {"bin_edges_ms": [], "counts": []}
    lo = min(values)
    hi = max(values)
    if lo == hi:
        return {"bin_edges_ms": [lo, lo + 1], "counts": [len(values)]}
    width = (hi - lo) / n_bins
    edges = [lo + i * width for i in range(n_bins + 1)]
    counts = [0] * n_bins
    for v in values:
        # Last bin is closed-right so the max value lands in-bounds.
        idx = int((v - lo) / width)
        if idx >= n_bins:
            idx = n_bins - 1
        counts[idx] += 1
    return {"bin_edges_ms": [round(e, 1) for e in edges], "counts": counts}


def _params_payload(params: AnalysisParams, swing_axis: Optional[str] = None) -> dict:
    payload = asdict(params)
    if swing_axis is not None:
        payload["swing_axis"] = swing_axis
    return payload


def _empty_report(
    params: AnalysisParams,
    warnings: list[str],
    n_samples: int = 0,
    swing_axis: Optional[str] = None,
    n_plants: int = 0,
) -> dict:
    return {
        "ok": True,
        "range": {
            "from": None, "to": None, "duration_s": 0.0,
            "n_samples": n_samples,
        },
        "params": _params_payload(params, swing_axis=swing_axis),
        "summary": {
            "n_plants": n_plants,
            "n_cycles": 0,
            "cadence_steps_per_min": None,
            "stick_cycle_time_ms":   None,
            "duty_factor":           None,
            "stride_length_m":       None,
            "stride_velocity_mps":   None,
            "symmetry": {
                "left_interval_ms_mean": None,
                "right_interval_ms_mean": None,
                "symmetry_ratio": None,
                "left_cv": None, "right_cv": None,
                "rhythm_score": None,
            },
            "handle_load": None,
            "wsfc":        None,
        },
        "series": {
            "cycles": [],
            "cycle_time_histogram": {"bin_edges_ms": [], "counts": []},
            "planted_timeline": [],
        },
        "warnings": warnings,
    }


# ---- helpers --------------------------------------------------------------


def _round(v: Optional[float], ndigits: int) -> Optional[float]:
    return None if v is None else round(v, ndigits)


def _ms_to_iso(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z",
    )


def _iso_to_ms_safe(iso_str: str) -> int:
    """Best-effort ISO8601 → epoch ms. Returns 0 if unparseable."""
    s = (iso_str or "").strip()
    if not s:
        return 0
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)
