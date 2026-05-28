"""Off-device unit tests for `analysis.compute_report` (pure stdlib, no bricks).

Run from `arduino_uno_q/python/`:
    python3 -m unittest test_analysis -v
"""

from __future__ import annotations

import math
import unittest

import analysis
from analysis import AnalysisParams, compute_report


# ---- synthetic-IMU generator ---------------------------------------------


def _synth_walk(
    duration_s: float = 30.0,
    step_hz: float = 1.5,
    sample_hz: float = 20.0,
    swing_axis: str = "gz",
    swing_amp_dps: float = 250.0,
    stride_m_target: float = 0.45,
    pressure_pa: float = 101325.0,
    left_interval_scale: float = 1.0,
) -> dict:
    """Generate a channel dict mimicking the Influx output: ``{field: [(ts_ms, v), ...]}``.

    Idealised gait: the swing axis is a sinusoid that crosses zero at each plant; gravity is
    parked on `az`; cadence = step_hz. `left_interval_scale > 1.0` stretches odd cycles so
    we can test the symmetry detector. We construct cycles **one at a time** so that
    irregular left-vs-right intervals stitch together correctly (a single global sinusoid
    can't render alternating intervals).
    """
    dt_ms = int(1000.0 / sample_hz)
    base_period_ms = 1000.0 / step_hz
    # Pendulum-model inverse: choose swing peak so the integrated angle θ_max ≈
    # asin(stride/L). For sample rate 20 Hz this is approximate but close enough.
    # We don't enforce a target stride here — `stride_m_target` is informational.
    _ = stride_m_target  # documented but unused

    t_ms = 0
    samples: list[tuple[int, dict[str, float]]] = []
    cycle_idx = 0
    duration_ms = int(duration_s * 1000)
    while t_ms < duration_ms:
        # Alternate left/right cycle lengths.
        scale = left_interval_scale if (cycle_idx % 2 == 0) else 1.0
        period_ms = base_period_ms * scale
        # Render one cycle: ~30% planted (low rate), ~70% swing (sinusoidal pulse).
        # Use round() (not int()) so floating-point near-misses like 199.999/50 don't
        # silently produce one fewer sample than intended — that off-by-one drops the
        # synthesised cycle by 50 ms and breaks our cadence assertion.
        n_total = max(2, round(period_ms / dt_ms))
        n_plant = max(1, round(n_total * 0.30))
        swing_ms = period_ms - (n_plant * dt_ms)  # informational; unused
        # Planted phase: |w| < threshold (≈3 dps noise).
        for _ in range(n_plant):
            if t_ms >= duration_ms:
                break
            samples.append((t_ms, _frame(swing_axis, w=2.0, az_g=1.0)))
            t_ms += dt_ms
        # Swing phase: half-sine pulse with amplitude swing_amp_dps.
        n_swing = max(1, n_total - n_plant)
        _ = swing_ms  # informational; n_swing derived from totals above
        for k in range(n_swing):
            if t_ms >= duration_ms:
                break
            phase = math.pi * (k + 0.5) / n_swing
            w = swing_amp_dps * math.sin(phase)
            # Tiny accel spike at plant entry approximation — first sample of next planted phase
            # bumps acc to ~1.2g (not used by the v1 detector; kept for future impact-check).
            az = 1.0
            samples.append((t_ms, _frame(swing_axis, w=w, az_g=az)))
            t_ms += dt_ms
        cycle_idx += 1

    # Pivot to channel dict.
    ax: list[tuple[int, float]] = []
    ay: list[tuple[int, float]] = []
    az: list[tuple[int, float]] = []
    gx: list[tuple[int, float]] = []
    gy: list[tuple[int, float]] = []
    gz: list[tuple[int, float]] = []
    pr: list[tuple[int, float]] = []
    for ts, fr in samples:
        ax.append((ts, fr["ax"])); ay.append((ts, fr["ay"])); az.append((ts, fr["az"]))
        gx.append((ts, fr["gx"])); gy.append((ts, fr["gy"])); gz.append((ts, fr["gz"]))
        pr.append((ts, pressure_pa))
    return {"ax": ax, "ay": ay, "az": az, "gx": gx, "gy": gy, "gz": gz, "pressure": pr}


def _frame(swing_axis: str, w: float, az_g: float) -> dict[str, float]:
    """One IMU sample frame with the swing on `swing_axis` and gravity parked on az.

    Returns m/s² for accels, dps for gyros (matching the brick's wire shape).
    """
    g = 9.80665
    frame = {"ax": 0.0, "ay": 0.0, "az": az_g * g, "gx": 0.0, "gy": 0.0, "gz": 0.0}
    frame[swing_axis] = w
    return frame


# ---- tests ----------------------------------------------------------------


class TestSyntheticGait(unittest.TestCase):
    """End-to-end: synth walk → compute_report → assert metric bands."""

    def setUp(self) -> None:
        self.params = AnalysisParams()

    def test_symmetric_walk_cadence_and_duty(self) -> None:
        ch = _synth_walk(duration_s=30.0, step_hz=1.5)
        rep = compute_report(ch, self.params)
        self.assertTrue(rep["ok"])
        self.assertGreaterEqual(rep["summary"]["n_cycles"], 30,
                                f"expected ≥30 cycles, got {rep['summary']['n_cycles']}")

        cad = rep["summary"]["cadence_steps_per_min"]
        self.assertIsNotNone(cad)
        # 1.5 Hz * 60 = 90 steps/min ± 2 spm
        self.assertAlmostEqual(cad["mean"], 90.0, delta=4.0,
                               msg=f"cadence mean {cad['mean']} not in 86..94")

        duty = rep["summary"]["duty_factor"]
        self.assertIsNotNone(duty)
        # Synth uses ~30% planted; duty should land in 0.25..0.45.
        self.assertGreaterEqual(duty["mean"], 0.25)
        self.assertLessEqual(duty["mean"], 0.45)

        sym = rep["summary"]["symmetry"]
        self.assertIsNotNone(sym["symmetry_ratio"])
        self.assertGreaterEqual(sym["symmetry_ratio"], 0.90,
                                f"symmetric input should yield SR ≥0.90, got {sym['symmetry_ratio']}")

    def test_asymmetric_walk_lowers_symmetry(self) -> None:
        # Left cycles 30% longer than right.
        ch = _synth_walk(duration_s=30.0, step_hz=1.5, left_interval_scale=1.30)
        rep = compute_report(ch, self.params)
        sym = rep["summary"]["symmetry"]
        self.assertIsNotNone(sym["symmetry_ratio"])
        # 1.0 / 1.3 = 0.769 → SR should land below 0.85.
        self.assertLess(sym["symmetry_ratio"], 0.85,
                        f"asymmetric input should yield SR <0.85, got {sym['symmetry_ratio']}")

    def test_swing_axis_picked_correctly(self) -> None:
        # Force the swing onto gy and confirm the detector picks it.
        ch = _synth_walk(duration_s=20.0, step_hz=1.2, swing_axis="gy")
        rep = compute_report(ch, self.params)
        self.assertEqual(rep["params"]["swing_axis"], "gy")


class TestDegenerateInputs(unittest.TestCase):
    """Edge cases — the route must never raise; it must return ``ok=true`` with warnings."""

    def setUp(self) -> None:
        self.params = AnalysisParams()

    def test_empty_channels(self) -> None:
        rep = compute_report({"ax": [], "ay": [], "az": [], "gx": [], "gy": [], "gz": [], "pressure": []}, self.params)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["summary"]["n_cycles"], 0)
        self.assertIn("insufficient_data", rep["warnings"])

    def test_constant_gyro_no_zero_cross(self) -> None:
        # Constant high gyro → never enters the still band → no plants.
        n = 200
        ch = {
            "ax": [(i * 50, 0.0) for i in range(n)],
            "ay": [(i * 50, 0.0) for i in range(n)],
            "az": [(i * 50, 9.81) for i in range(n)],
            "gx": [(i * 50, 100.0) for i in range(n)],
            "gy": [(i * 50, 100.0) for i in range(n)],
            "gz": [(i * 50, 100.0) for i in range(n)],
            "pressure": [(i * 50, 101325.0) for i in range(n)],
        }
        rep = compute_report(ch, self.params)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["summary"]["n_cycles"], 0)
        self.assertEqual(rep["summary"]["n_plants"], 0)
        self.assertIn("insufficient_plants", rep["warnings"])

    def test_single_plant_no_cycles(self) -> None:
        # Two halves: first half still, second half swinging. Yields exactly one plant
        # at t=0, no cycles.
        n = 50
        ch = {
            "ax": [(i * 50, 0.0) for i in range(n)],
            "ay": [(i * 50, 0.0) for i in range(n)],
            "az": [(i * 50, 9.81) for i in range(n)],
            "gx": [(i * 50, 0.0) for i in range(n)],
            "gy": [(i * 50, 0.0) for i in range(n)],
            # Still for the first 10 samples, then high.
            "gz": [(i * 50, 0.0 if i < 10 else 200.0) for i in range(n)],
            "pressure": [(i * 50, 101325.0) for i in range(n)],
        }
        rep = compute_report(ch, self.params)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["summary"]["n_cycles"], 0)
        self.assertEqual(rep["summary"]["n_plants"], 1)

    def test_reserved_phase2_keys_are_none(self) -> None:
        ch = _synth_walk(duration_s=10.0, step_hz=1.0)
        rep = compute_report(ch, self.params)
        self.assertIsNone(rep["summary"]["handle_load"])
        self.assertIsNone(rep["summary"]["wsfc"])
        self.assertTrue(any("phase 2" in w for w in rep["warnings"]))


class TestStatsHelpers(unittest.TestCase):
    """Light coverage of `_stats` / `_cv` / `_histogram` so refactors stay honest."""

    def test_stats_basic(self) -> None:
        s = analysis._stats([1.0, 2.0, 3.0, 4.0], ndigits=3)
        self.assertEqual(s["median"], 2.5)
        self.assertAlmostEqual(s["mean"], 2.5, places=2)

    def test_stats_empty(self) -> None:
        self.assertIsNone(analysis._stats([], ndigits=3))

    def test_cv_short_input(self) -> None:
        self.assertIsNone(analysis._cv([42.0]))   # need ≥2 samples
        self.assertIsNone(analysis._cv([0.0, 0.0]))  # zero mean

    def test_histogram_uniform(self) -> None:
        h = analysis._histogram([1, 2, 3, 4, 5, 6, 7, 8], n_bins=4)
        self.assertEqual(len(h["counts"]), 4)
        self.assertEqual(sum(h["counts"]), 8)


if __name__ == "__main__":
    unittest.main()
