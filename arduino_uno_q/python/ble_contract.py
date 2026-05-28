"""AUTO-GENERATED from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT EDIT."""

DEVICE_NAME = "NanoIMU"
SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"

SEND_INTERVAL_MS = 50
GRAVITY = 9.80665
PAYLOAD_TAG = "IMU"

FIELDS = ["timestamp_ms", "ax", "ay", "az", "gx", "gy", "gz", "acc_norm", "gyro_norm", "phase"]
FIELD_COUNT = len(FIELDS) + 1  # +1 for the leading payload tag

PHASE_LABELS = {
    0: "UNKNOWN",
    1: "STATIONARY_OR_ZERO_VELOCITY",
    2: "GROUND_CONTACT_WITH_ROTATION",
    3: "SWING_OR_ON_AIR",
}

# Phase classification thresholds (shared by firmware + mock).
ACC_NEAR_G_THRESHOLD = 0.3
GYRO_ZERO_THRESHOLD = 2.0
GYRO_SWING_THRESHOLD = 25.0
