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

# ---- Shared BLE contract (must match the sender) ------------------------
DEVICE_NAME = "NanoIMU"
SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"

# Total comma-separated fields in a valid payload (leading "IMU" tag + 10 values).
_FIELD_COUNT = 11

# Walking-phase codes emitted by the sender (see classifyPhase in the sketch).
PHASE_LABELS = {
    0: "UNKNOWN",
    1: "STATIONARY_OR_ZERO_VELOCITY",
    2: "GROUND_CONTACT_WITH_ROTATION",
    3: "SWING_OR_ON_AIR",
}


def parse_payload(raw: str) -> dict | None:
    """Parse one CSV payload line into the prototype's nested JSON dict.

    Returns None for anything that isn't a well-formed "IMU,..." line.
    """
    parts = raw.strip().split(",")
    if len(parts) != _FIELD_COUNT or parts[0] != "IMU":
        return None

    try:
        timestamp_ms = int(parts[1])
        # parts[2:9] = 6 accel/gyro floats + 2 norm floats; parts[10] = phase int.
        f = [float(x) for x in parts[2:10]]
        phase = int(parts[10])
    except ValueError:
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
