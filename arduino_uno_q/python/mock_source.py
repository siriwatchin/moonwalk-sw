"""Mock Nano sensor source: emits realistic-ish IMU CSV lines without hardware.

Same payload format and 50 ms cadence as the firmware, pushed through the exact
same pipeline as BLE mode. Implements the SensorSource protocol. No SDK imports.
"""

from __future__ import annotations

import random
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Optional

from config import (
    GRAVITY,
    INTERVAL_MS,
    PAYLOAD_TAG,
)


@dataclass
class StateProfile:
    name: str
    acc_std: float
    gyro_mean: float
    gyro_std: float
    samples: int


# One repeating cane cycle: 20 samples * 50 ms = 1 s per state.
DEFAULT_CYCLE = [
    StateProfile("stationary",         acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=20),
    StateProfile("swing_or_on_air",    acc_std=1.8,  gyro_mean=40.0, gyro_std=6.0, samples=20),
    StateProfile("ground_contact",     acc_std=0.05, gyro_mean=10.0, gyro_std=2.0, samples=20),
    StateProfile("swing_or_on_air",    acc_std=1.8,  gyro_mean=40.0, gyro_std=6.0, samples=20),
    StateProfile("stationary_or_zero", acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=20),
]


def cycle_for(gait: str = "normal") -> list[StateProfile]:
    """Return a cane cycle for a gait profile, so two mock devices look different.

    - "normal":  symmetric swing/stance (the default cycle).
    - "altered": shorter, weaker swing + longer stance (mimics a guarded/injured gait),
      so phase 3 (swing) appears less and acc/gyro amplitudes are lower.
    """
    if gait == "altered":
        return [
            StateProfile("stationary",         acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=30),
            StateProfile("swing_or_on_air",    acc_std=1.0,  gyro_mean=30.0, gyro_std=5.0, samples=12),
            StateProfile("ground_contact",     acc_std=0.05, gyro_mean=12.0, gyro_std=2.0, samples=30),
            StateProfile("swing_or_on_air",    acc_std=1.0,  gyro_mean=30.0, gyro_std=5.0, samples=12),
            StateProfile("stationary_or_zero", acc_std=0.03, gyro_mean=0.3,  gyro_std=0.3, samples=30),
        ]
    return DEFAULT_CYCLE


class MockNanoSource:
    def __init__(self, cycle: Optional[list[StateProfile]] = None,
                 seed: Optional[int] = None, paced: bool = True, gait: str = "normal"):
        self._cycle = cycle or cycle_for(gait)
        self._rng = random.Random(seed)
        self._paced = paced       # sleep between samples (real-time); off for tests
        self._t_ms = 0
        self._stopped = False

    def status(self) -> str:
        return "MOCK"

    def stop(self) -> None:
        """Ask lines() to end so the SourceManager can switch away cleanly."""
        self._stopped = True

    def _sample_line(self, state: StateProfile) -> str:
        r = self._rng
        ax = r.gauss(0.0, state.acc_std)
        ay = r.gauss(0.0, state.acc_std)
        az = r.gauss(GRAVITY, state.acc_std)
        gx = r.gauss(state.gyro_mean, state.gyro_std)
        gy = r.gauss(state.gyro_mean * 0.4, state.gyro_std)
        gz = r.gauss(state.gyro_mean * 0.2, state.gyro_std)
        # BME680 pressure (Pa): slow-drifting around sea-level standard, small noise.
        pressure = r.gauss(101325.0, 15.0)

        line = (
            f"{PAYLOAD_TAG},{self._t_ms},"
            f"{ax:.4f},{ay:.4f},{az:.4f},"
            f"{gx:.4f},{gy:.4f},{gz:.4f},"
            f"{pressure:.1f}"
        )
        self._t_ms += INTERVAL_MS
        return line

    def lines(self) -> Iterator[str]:
        interval_s = INTERVAL_MS / 1000.0
        while not self._stopped:
            for state in self._cycle:
                for _ in range(state.samples):
                    if self._stopped:
                        return
                    yield self._sample_line(state)
                    if self._paced:
                        time.sleep(interval_s)
