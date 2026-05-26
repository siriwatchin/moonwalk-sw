"""Mock Nano 33 BLE sensor: emits realistic-ish IMU payload lines.

Produces the exact same CSV format the firmware sends, so the rest of the
pipeline can't tell mock from real. Implements the `SensorSource` protocol.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Iterator, Optional

from .config import INTERVAL_MS, GRAVITY, PAYLOAD_TAG
from .phase_classifier import classify_phase


@dataclass
class StateProfile:
    """Gaussian targets for one cane state.

    Components are drawn so the *derived* norms land in the intended band:
    - accel: gravity sits mainly on az; (ax_std, az_std) widen during swing.
    - gyro:  gyro_mean drives gyro_norm (rotation magnitude).
    """

    name: str
    az_mean: float
    acc_std: float       # per-axis accel noise (m/s^2)
    gyro_mean: float     # per-axis gyro magnitude target (deg/s)
    gyro_std: float      # per-axis gyro noise (deg/s)
    samples: int         # how long to stay in this state


# One repeating cane movement cycle (per the spec's suggested sequence).
# 20 samples * 50 ms = 1.0 s per state.
DEFAULT_CYCLE = [
    StateProfile("stationary",          az_mean=GRAVITY, acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=20),
    StateProfile("swing_or_on_air",     az_mean=GRAVITY, acc_std=1.8,  gyro_mean=40.0, gyro_std=6.0, samples=20),
    StateProfile("ground_contact",      az_mean=GRAVITY, acc_std=0.05, gyro_mean=10.0, gyro_std=2.0, samples=20),
    StateProfile("swing_or_on_air",     az_mean=GRAVITY, acc_std=1.8,  gyro_mean=40.0, gyro_std=6.0, samples=20),
    StateProfile("stationary_or_zero",  az_mean=GRAVITY, acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=20),
]


class MockNanoSensor:
    """Emits mock IMU CSV lines, cycling through cane states with noise."""

    def __init__(self, cycle: Optional[list[StateProfile]] = None, seed: Optional[int] = None):
        self._cycle = cycle or DEFAULT_CYCLE
        self._rng = random.Random(seed)
        self._t_ms = 0   # simulated clock; advances INTERVAL_MS per sample

    def _sample_state(self, state: StateProfile) -> str:
        r = self._rng
        # Accelerometer (m/s^2): gravity on az, small bias on ax/ay; swing widens all.
        ax = r.gauss(0.0, state.acc_std)
        ay = r.gauss(0.0, state.acc_std)
        az = r.gauss(state.az_mean, state.acc_std)

        # Gyroscope (deg/s): split the rotation magnitude across axes + noise.
        gx = r.gauss(state.gyro_mean, state.gyro_std)
        gy = r.gauss(state.gyro_mean * 0.4, state.gyro_std)
        gz = r.gauss(state.gyro_mean * 0.2, state.gyro_std)

        acc_norm = math.sqrt(ax * ax + ay * ay + az * az)
        gyro_norm = math.sqrt(gx * gx + gy * gy + gz * gz)
        phase = classify_phase(acc_norm, gyro_norm)

        line = (
            f"{PAYLOAD_TAG},{self._t_ms},"
            f"{ax:.4f},{ay:.4f},{az:.4f},"
            f"{gx:.4f},{gy:.4f},{gz:.4f},"
            f"{acc_norm:.4f},{gyro_norm:.4f},{phase}"
        )
        self._t_ms += INTERVAL_MS
        return line

    def lines(self) -> Iterator[str]:
        """Yield mock CSV payload lines forever, cycling through the states."""
        while True:
            for state in self._cycle:
                for _ in range(state.samples):
                    yield self._sample_state(state)
