"""Mock Nano sensor source: emits realistic-ish IMU CSV lines without hardware.

Same payload format and 50 ms cadence as the firmware, pushed through the exact
same pipeline as BLE mode. Implements the SensorSource protocol. No SDK imports.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass
from typing import Iterator, Optional

from config import GRAVITY, INTERVAL_MS, PAYLOAD_TAG


def _classify_phase(acc_norm: float, gyro_norm: float) -> int:
    """Same rules as the firmware (kept local so the mock is self-contained)."""
    acc_delta = abs(acc_norm - GRAVITY)
    near_g = acc_delta < 0.30
    if near_g and gyro_norm < 2.0:
        return 1
    if near_g and 2.0 <= gyro_norm < 25.0:
        return 2
    if acc_delta >= 0.30 or gyro_norm >= 25.0:
        return 3
    return 0


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


class MockNanoSource:
    def __init__(self, cycle: Optional[list[StateProfile]] = None,
                 seed: Optional[int] = None, paced: bool = True):
        self._cycle = cycle or DEFAULT_CYCLE
        self._rng = random.Random(seed)
        self._paced = paced       # sleep between samples (real-time); off for tests
        self._t_ms = 0

    def status(self) -> str:
        return "MOCK"

    def _sample_line(self, state: StateProfile) -> str:
        r = self._rng
        ax = r.gauss(0.0, state.acc_std)
        ay = r.gauss(0.0, state.acc_std)
        az = r.gauss(GRAVITY, state.acc_std)
        gx = r.gauss(state.gyro_mean, state.gyro_std)
        gy = r.gauss(state.gyro_mean * 0.4, state.gyro_std)
        gz = r.gauss(state.gyro_mean * 0.2, state.gyro_std)

        acc_norm = math.sqrt(ax * ax + ay * ay + az * az)
        gyro_norm = math.sqrt(gx * gx + gy * gy + gz * gz)
        phase = _classify_phase(acc_norm, gyro_norm)

        line = (
            f"{PAYLOAD_TAG},{self._t_ms},"
            f"{ax:.4f},{ay:.4f},{az:.4f},"
            f"{gx:.4f},{gy:.4f},{gz:.4f},"
            f"{acc_norm:.4f},{gyro_norm:.4f},{phase}"
        )
        self._t_ms += INTERVAL_MS
        return line

    def lines(self) -> Iterator[str]:
        interval_s = INTERVAL_MS / 1000.0
        while True:
            for state in self._cycle:
                for _ in range(state.samples):
                    yield self._sample_line(state)
                    if self._paced:
                        time.sleep(interval_s)
