"""Typed data model + the sensor-source interface (the future BLE swap point)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol, runtime_checkable

from .config import PAYLOAD_TAG, PHASE_LABELS


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

    def to_csv_payload(self) -> str:
        """Reproduce the exact 11-field Nano payload string."""
        return (
            f"{PAYLOAD_TAG},{self.timestamp_ms},"
            f"{self.ax:.4f},{self.ay:.4f},{self.az:.4f},"
            f"{self.gx:.4f},{self.gy:.4f},{self.gz:.4f},"
            f"{self.acc_norm:.4f},{self.gyro_norm:.4f},{self.phase}"
        )

    def to_row(self) -> dict:
        """Flat dict for CSV logging (adds the human-readable phase label)."""
        return {
            "timestamp_ms": self.timestamp_ms,
            "ax_ms2": self.ax,
            "ay_ms2": self.ay,
            "az_ms2": self.az,
            "gx_dps": self.gx,
            "gy_dps": self.gy,
            "gz_dps": self.gz,
            "acc_norm": self.acc_norm,
            "gyro_norm": self.gyro_norm,
            "phase": self.phase,
            "phase_label": self.phase_label,
        }

    def format_human(self) -> str:
        return (
            f"t={self.timestamp_ms} "
            f"acc=({self.ax:.3f},{self.ay:.3f},{self.az:.3f}) "
            f"gyro=({self.gx:.3f},{self.gy:.3f},{self.gz:.3f}) "
            f"accN={self.acc_norm:.3f} gyroN={self.gyro_norm:.3f} "
            f"phase={self.phase}({self.phase_label})"
        )


@runtime_checkable
class SensorSource(Protocol):
    """A source of raw Nano CSV payload lines.

    THE SWAP POINT: `MockNanoSensor` implements this today. Later a real
    `BleNanoSensorClient` implementing the same `lines()` iterator can replace it
    without touching the parser, classifier, logger, or main loop.
    """

    def lines(self) -> Iterator[str]:
        """Yield raw CSV payload strings, one per sample."""
        ...
