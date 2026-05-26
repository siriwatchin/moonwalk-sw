"""Configuration constants for the UNO Q gateway/dashboard.

The BLE contract (device name + UUIDs + payload) must match the Nano firmware
(arduino/nano_imu_ble_sender.ino).
"""

# ---- BLE contract (must match the Nano sender) -------------------------
DEVICE_NAME = "NanoIMU"
SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214"
CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214"

# Payload: IMU,timestamp_ms,ax,ay,az,gx,gy,gz,acc_norm,gyro_norm,phase
PAYLOAD_TAG = "IMU"
FIELD_COUNT = 11

GRAVITY = 9.80665

# ---- Walking-phase codes -----------------------------------------------
PHASE_LABELS = {
    0: "UNKNOWN",
    1: "STATIONARY_OR_ZERO_VELOCITY",
    2: "GROUND_CONTACT_WITH_ROTATION",
    3: "SWING_OR_ON_AIR",
}

# ---- Buffer / web -------------------------------------------------------
BUFFER_MAXLEN = 600     # ~30 s of history at 20 Hz
HOST = "0.0.0.0"        # bind all interfaces so other devices can view it
PORT = 8080
POLL_MS = 150           # how often the browser polls /api/state
RECENT_POINTS = 200     # samples sent to the browser for the charts
