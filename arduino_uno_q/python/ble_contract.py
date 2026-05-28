"""AUTO-GENERATED from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT EDIT."""

DEVICE_NAME = "NanoIMU"
SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"

SEND_INTERVAL_MS = 50
GRAVITY = 9.80665
PAYLOAD_TAG = "IMU"

FIELDS = ["timestamp_ms", "ax", "ay", "az", "gx", "gy", "gz", "pressure"]
FIELD_COUNT = len(FIELDS) + 1  # +1 for the leading payload tag
