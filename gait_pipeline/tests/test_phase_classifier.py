"""Tests for phase_classifier.classify_phase (truth table incl. boundaries)."""

import pytest

from src.config import (
    GRAVITY,
    PHASE_GROUND_CONTACT_WITH_ROTATION,
    PHASE_STATIONARY_OR_ZERO_VELOCITY,
    PHASE_SWING_OR_ON_AIR,
)
from src.phase_classifier import classify_phase


@pytest.mark.parametrize(
    "acc_norm, gyro_norm, expected",
    [
        # near gravity + no rotation -> stationary
        (GRAVITY, 0.0, PHASE_STATIONARY_OR_ZERO_VELOCITY),
        (GRAVITY + 0.29, 1.999, PHASE_STATIONARY_OR_ZERO_VELOCITY),
        # near gravity + moderate rotation -> ground contact
        (GRAVITY, 2.0, PHASE_GROUND_CONTACT_WITH_ROTATION),     # ZERO boundary
        (GRAVITY, 10.0, PHASE_GROUND_CONTACT_WITH_ROTATION),
        (GRAVITY, 24.999, PHASE_GROUND_CONTACT_WITH_ROTATION),
        # high rotation OR acc off gravity -> swing
        (GRAVITY, 25.0, PHASE_SWING_OR_ON_AIR),                 # SWING boundary
        (GRAVITY, 40.0, PHASE_SWING_OR_ON_AIR),
        (GRAVITY + 0.30, 0.0, PHASE_SWING_OR_ON_AIR),           # NEAR_G boundary
        (12.0, 0.5, PHASE_SWING_OR_ON_AIR),
        (5.0, 0.0, PHASE_SWING_OR_ON_AIR),
    ],
)
def test_classify_phase(acc_norm, gyro_norm, expected):
    assert classify_phase(acc_norm, gyro_norm) == expected
