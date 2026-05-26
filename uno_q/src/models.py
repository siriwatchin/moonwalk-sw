"""Typed sample + the sensor-source interface (mock ↔ BLE swap point)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol, runtime_checkable

from .config import PHASE_LABELS


@dataclass
class ImuSample:
    """One parsed IMU payload, matching the Nano BLE line field-for-field."""

    timestamp_ms: int
    ax: float
    ay: float
    az: float
    gx: float
    gy: float
    gz: float
    acc_norm: float
    gyro_norm: float
    phase: int

    @property
    def phase_label(self) -> str:
        return PHASE_LABELS.get(self.phase, "UNKNOWN")

    def to_dict(self) -> dict:
        return {
            "timestamp_ms": self.timestamp_ms,
            "ax": self.ax, "ay": self.ay, "az": self.az,
            "gx": self.gx, "gy": self.gy, "gz": self.gz,
            "acc_norm": self.acc_norm,
            "gyro_norm": self.gyro_norm,
            "phase": self.phase,
            "phase_label": self.phase_label,
        }


@runtime_checkable
class SensorSource(Protocol):
    """A source of raw Nano CSV payload lines.

    THE SWAP POINT: `MockNanoSource` and `BleNanoSource` both implement this, so
    `main` / the runner thread, the buffer, the web server and the dashboard are
    identical regardless of where the data comes from.
    """

    def lines(self) -> Iterator[str]:
        """Yield raw CSV payload strings, one per sample (blocking is fine)."""
        ...

    def status(self) -> str:
        """Human-readable source status (e.g. MOCK / scanning / connected)."""
        ...
