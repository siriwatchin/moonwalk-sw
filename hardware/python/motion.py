from __future__ import annotations

import csv
import io
import math
import time
from dataclasses import dataclass, fields
from typing import Iterable


POSTURE_UPRIGHT = "upright"
POSTURE_LEANING = "leaning"
POSTURE_MOVING = "moving"

POSTURE_LABELS = (POSTURE_UPRIGHT, POSTURE_LEANING, POSTURE_MOVING)


@dataclass(frozen=True)
class MotionSample:
    timestamp: float
    ax_g: float
    ay_g: float
    az_g: float
    roll_dps: float
    pitch_dps: float
    yaw_dps: float
    accel_magnitude_g: float
    tilt_deg: float
    posture: str
    label: str = ""
    note: str = ""


def accel_magnitude(ax_g: float, ay_g: float, az_g: float) -> float:
    return math.sqrt(ax_g * ax_g + ay_g * ay_g + az_g * az_g)


def tilt_from_accel(ax_g: float, ay_g: float, az_g: float) -> float:
    magnitude = accel_magnitude(ax_g, ay_g, az_g)
    if magnitude == 0:
        return 0.0

    vertical_component = max(-1.0, min(1.0, az_g / magnitude))
    return math.degrees(math.acos(vertical_component))


def classify_posture(
    ax_g: float,
    ay_g: float,
    az_g: float,
    roll_dps: float,
    pitch_dps: float,
    yaw_dps: float,
    *,
    upright_tilt_deg: float = 18.0,
    motion_dps: float = 35.0,
) -> str:
    angular_rate = max(abs(roll_dps), abs(pitch_dps), abs(yaw_dps))
    if angular_rate >= motion_dps:
        return POSTURE_MOVING

    if tilt_from_accel(ax_g, ay_g, az_g) <= upright_tilt_deg:
        return POSTURE_UPRIGHT

    return POSTURE_LEANING


def build_sample(
    ax_g: float,
    ay_g: float,
    az_g: float,
    roll_dps: float,
    pitch_dps: float,
    yaw_dps: float,
    *,
    timestamp: float | None = None,
    label: str = "",
    note: str = "",
) -> MotionSample:
    posture = classify_posture(ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps)
    return MotionSample(
        timestamp=time.time() if timestamp is None else float(timestamp),
        ax_g=float(ax_g),
        ay_g=float(ay_g),
        az_g=float(az_g),
        roll_dps=float(roll_dps),
        pitch_dps=float(pitch_dps),
        yaw_dps=float(yaw_dps),
        accel_magnitude_g=accel_magnitude(ax_g, ay_g, az_g),
        tilt_deg=tilt_from_accel(ax_g, ay_g, az_g),
        posture=posture,
        label=label,
        note=note,
    )


def parse_motion_values(values: Iterable[object], *, timestamp: float | None = None) -> MotionSample:
    numeric_values = [float(value) for value in values]
    if len(numeric_values) != 6:
        raise ValueError(
            "Expected 6 motion values: ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps"
        )

    return build_sample(*numeric_values, timestamp=timestamp)


def samples_to_csv(samples: Iterable[MotionSample]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=[field.name for field in fields(MotionSample)])
    writer.writeheader()
    for sample in samples:
        writer.writerow(sample.__dict__)
    return buffer.getvalue()
