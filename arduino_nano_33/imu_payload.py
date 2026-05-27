"""
imu_payload.py
---------------------------------------------------------------------------
Shared BLE contract + payload parsing for the NanoIMU prototype.

Both ble_receiver.py (debug printer) and ble_bridge.py (WebSocket gateway)
import from here so the UUIDs and the CSV->JSON mapping live in one place.

Source CSV line (11 comma-separated fields) from nano_imu_ble_sender.ino:
    IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
---------------------------------------------------------------------------
"""

import math

# ---- Shared BLE contract (single source of truth) -----------------------
# Generated from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT edit values
# here. Re-exported so callers can keep importing them from imu_payload.
from ble_contract_gen import (  # noqa: F401
    CHAR_UUID,
    DEVICE_NAME,
    FIELD_COUNT,
    PAYLOAD_TAG,
    PHASE_LABELS,
    SERVICE_UUID,
)


def parse_payload(raw: str) -> dict | None:
    """Parse one CSV payload line into the prototype's nested JSON dict.

    Returns None for anything that isn't a well-formed "IMU,..." line.
    """
    parts = raw.strip().split(",")
    if len(parts) != FIELD_COUNT or parts[0] != PAYLOAD_TAG:
        return None

    try:
        timestamp_ms = int(parts[1])
        # parts[2:9] = 6 accel/gyro floats + 2 norm floats; parts[10] = phase int.
        f = [float(x) for x in parts[2:10]]
        phase = int(parts[10])
    except ValueError:
        return None

    # Reject present-but-nonsensical values: non-finite floats or unknown phase codes.
    if not all(math.isfinite(v) for v in f) or phase not in PHASE_LABELS:
        return None

    return {
        "device": DEVICE_NAME,
        "timestamp_ms": timestamp_ms,
        "accel": {"x": f[0], "y": f[1], "z": f[2]},   # m/s^2
        "gyro": {"x": f[3], "y": f[4], "z": f[5]},     # deg/s
        "acc_norm": f[6],
        "gyro_norm": f[7],
        "phase": phase,
        "phase_label": PHASE_LABELS.get(phase, "UNKNOWN"),
    }


def format_human(sample: dict) -> str:
    """Short, readable one-liner for debug prints."""
    a, g = sample["accel"], sample["gyro"]
    return (
        f"t={sample['timestamp_ms']} "
        f"acc=({a['x']:.3f},{a['y']:.3f},{a['z']:.3f}) "
        f"gyro=({g['x']:.3f},{g['y']:.3f},{g['z']:.3f}) "
        f"accN={sample['acc_norm']:.3f} gyroN={sample['gyro_norm']:.3f} "
        f"phase={sample['phase']}({sample['phase_label']})"
    )
