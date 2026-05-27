from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any

from motion import MotionSample, build_sample


PROTOCOL_VERSION = "cane-posture.motion.v1"
RAW_PREFIX = "MWALK_MOTION_RAW "
SAMPLE_PREFIX = "MWALK_MOTION_SAMPLE "


def raw_payload(
    ax_g: float,
    ay_g: float,
    az_g: float,
    roll_dps: float,
    pitch_dps: float,
    yaw_dps: float,
    *,
    timestamp_ms: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocol": PROTOCOL_VERSION,
        "kind": "raw",
        "ax_g": float(ax_g),
        "ay_g": float(ay_g),
        "az_g": float(az_g),
        "roll_dps": float(roll_dps),
        "pitch_dps": float(pitch_dps),
        "yaw_dps": float(yaw_dps),
    }
    if timestamp_ms is not None:
        payload["timestamp_ms"] = int(timestamp_ms)
    return payload


def sample_payload(sample: MotionSample) -> dict[str, Any]:
    payload = asdict(sample)
    payload["protocol"] = PROTOCOL_VERSION
    payload["kind"] = "sample"
    return payload


def encode_raw_line(
    ax_g: float,
    ay_g: float,
    az_g: float,
    roll_dps: float,
    pitch_dps: float,
    yaw_dps: float,
    *,
    timestamp_ms: int | None = None,
) -> str:
    payload = raw_payload(
        ax_g,
        ay_g,
        az_g,
        roll_dps,
        pitch_dps,
        yaw_dps,
        timestamp_ms=timestamp_ms,
    )
    return RAW_PREFIX + json.dumps(payload, separators=(",", ":"), sort_keys=True)


def encode_sample_line(sample: MotionSample) -> str:
    return SAMPLE_PREFIX + json.dumps(sample_payload(sample), separators=(",", ":"), sort_keys=True)


def decode_line(line: str) -> dict[str, Any]:
    stripped = line.strip()
    if stripped.startswith(RAW_PREFIX):
        payload = json.loads(stripped.removeprefix(RAW_PREFIX))
    elif stripped.startswith(SAMPLE_PREFIX):
        payload = json.loads(stripped.removeprefix(SAMPLE_PREFIX))
    else:
        payload = json.loads(stripped)

    if payload.get("protocol") != PROTOCOL_VERSION:
        raise ValueError(f"Unsupported protocol: {payload.get('protocol')}")

    return payload


def sample_from_payload(payload: dict[str, Any]) -> MotionSample:
    if payload.get("kind") == "sample":
        return MotionSample(
            timestamp=payload["timestamp"],
            ax_g=payload["ax_g"],
            ay_g=payload["ay_g"],
            az_g=payload["az_g"],
            roll_dps=payload["roll_dps"],
            pitch_dps=payload["pitch_dps"],
            yaw_dps=payload["yaw_dps"],
            accel_magnitude_g=payload["accel_magnitude_g"],
            tilt_deg=payload["tilt_deg"],
            posture=payload["posture"],
            label=payload.get("label", ""),
            note=payload.get("note", ""),
        )

    if payload.get("kind") != "raw":
        raise ValueError(f"Unsupported payload kind: {payload.get('kind')}")

    return build_sample(
        payload["ax_g"],
        payload["ay_g"],
        payload["az_g"],
        payload["roll_dps"],
        payload["pitch_dps"],
        payload["yaw_dps"],
    )
