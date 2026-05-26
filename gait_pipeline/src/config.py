"""Shared constants for the gait pipeline.

These mirror the Nano 33 BLE firmware (nano_imu_ble_sender.ino) so the mock
sensor, parser and classifier all agree on the payload and the phase rules.
"""

# Physics / timing
GRAVITY = 9.80665        # m/s^2
INTERVAL_MS = 50         # one sample every 50 ms (~20 Hz)

# Phase-classification thresholds (identical to the firmware)
ACC_NEAR_G_THRESHOLD = 0.30   # |acc_norm - GRAVITY| below this = "near gravity"
GYRO_ZERO_THRESHOLD = 2.0     # deg/s below this = "no rotation"
GYRO_SWING_THRESHOLD = 25.0   # deg/s at/above this = "swing"

# Payload
PAYLOAD_TAG = "IMU"      # leading token of every CSV line
FIELD_COUNT = 11         # tag + 10 values

# Walking-phase codes
PHASE_UNKNOWN = 0
PHASE_STATIONARY_OR_ZERO_VELOCITY = 1
PHASE_GROUND_CONTACT_WITH_ROTATION = 2
PHASE_SWING_OR_ON_AIR = 3

PHASE_LABELS = {
    PHASE_UNKNOWN: "UNKNOWN",
    PHASE_STATIONARY_OR_ZERO_VELOCITY: "STATIONARY_OR_ZERO_VELOCITY",
    PHASE_GROUND_CONTACT_WITH_ROTATION: "GROUND_CONTACT_WITH_ROTATION",
    PHASE_SWING_OR_ON_AIR: "SWING_OR_ON_AIR",
}
