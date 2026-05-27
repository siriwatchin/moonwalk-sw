import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motion import (
    POSTURE_LEANING,
    POSTURE_MOVING,
    POSTURE_UPRIGHT,
    accel_magnitude,
    build_sample,
    classify_posture,
    parse_motion_values,
    tilt_from_accel,
)


class MotionTests(unittest.TestCase):
    def test_accel_magnitude_uses_three_axes(self):
        self.assertEqual(accel_magnitude(2, 3, 6), 7)

    def test_tilt_from_accel_is_zero_when_cane_is_vertical(self):
        self.assertAlmostEqual(tilt_from_accel(0, 0, 1), 0)

    def test_tilt_from_accel_detects_horizontal_cane(self):
        self.assertAlmostEqual(tilt_from_accel(1, 0, 0), 90)

    def test_classifies_upright_static_posture(self):
        posture = classify_posture(0.05, 0.02, 1.0, 0.2, 0.1, 0.0)
        self.assertEqual(posture, POSTURE_UPRIGHT)

    def test_classifies_leaning_static_posture(self):
        posture = classify_posture(0.5, 0.0, math.sqrt(0.75), 0.0, 0.0, 0.0)
        self.assertEqual(posture, POSTURE_LEANING)

    def test_classifies_moving_before_leaning_when_gyro_is_high(self):
        posture = classify_posture(0.5, 0.0, math.sqrt(0.75), 45.0, 0.0, 0.0)
        self.assertEqual(posture, POSTURE_MOVING)

    def test_parse_motion_values_builds_complete_sample(self):
        sample = parse_motion_values([0, 0, 1, 1, 2, 3], timestamp=123.0)
        self.assertEqual(sample.timestamp, 123.0)
        self.assertEqual(sample.posture, POSTURE_UPRIGHT)
        self.assertEqual(sample.roll_dps, 1)

    def test_parse_motion_values_requires_six_values(self):
        with self.assertRaises(ValueError):
            parse_motion_values([0, 0, 1])

    def test_build_sample_keeps_collection_metadata(self):
        sample = build_sample(0, 0, 1, 0, 0, 0, label="walking", note="left hand")
        self.assertEqual(sample.label, "walking")
        self.assertEqual(sample.note, "left hand")


if __name__ == "__main__":
    unittest.main()
