"""Walking-phase classification — identical rules to the Nano firmware."""

from .config import (
    ACC_NEAR_G_THRESHOLD,
    GRAVITY,
    GYRO_SWING_THRESHOLD,
    GYRO_ZERO_THRESHOLD,
    PHASE_GROUND_CONTACT_WITH_ROTATION,
    PHASE_STATIONARY_OR_ZERO_VELOCITY,
    PHASE_SWING_OR_ON_AIR,
    PHASE_UNKNOWN,
)


def classify_phase(acc_norm: float, gyro_norm: float) -> int:
    """Classify the cane's walking phase from the accel/gyro norms.

    Pure function (no I/O). Mirrors classifyPhase() in nano_imu_ble_sender.ino.
    """
    acc_delta = abs(acc_norm - GRAVITY)
    near_gravity = acc_delta < ACC_NEAR_G_THRESHOLD

    if near_gravity and gyro_norm < GYRO_ZERO_THRESHOLD:
        return PHASE_STATIONARY_OR_ZERO_VELOCITY
    if near_gravity and GYRO_ZERO_THRESHOLD <= gyro_norm < GYRO_SWING_THRESHOLD:
        return PHASE_GROUND_CONTACT_WITH_ROTATION
    if acc_delta >= ACC_NEAR_G_THRESHOLD or gyro_norm >= GYRO_SWING_THRESHOLD:
        return PHASE_SWING_OR_ON_AIR
    return PHASE_UNKNOWN
