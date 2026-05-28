"""Typed IMU sample + the sensor-source interface (mock ↔ BLE swap point).

No Arduino SDK imports here — this module stays testable off-device.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


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
    pressure: float   # BME680 barometric pressure, Pa

    def to_dict(self) -> dict:
        return {
            "timestamp_ms": self.timestamp_ms,
            "ax": self.ax, "ay": self.ay, "az": self.az,
            "gx": self.gx, "gy": self.gy, "gz": self.gz,
            "pressure": self.pressure,
        }


@runtime_checkable
class SensorSource(Protocol):
    """A source of raw Nano CSV payload lines (mock or BLE).

    THE SWAP POINT: both MockNanoSource and BleNanoReceiver implement this, so the
    runner thread, store, WebUI server and dashboard are identical either way.
    """

    def lines(self) -> Iterator[str]:
        """Yield raw CSV payload strings, one per sample (blocking is fine)."""
        ...

    def status(self) -> str:
        """Human-readable source status (e.g. MOCK / scanning / connected)."""
        ...
