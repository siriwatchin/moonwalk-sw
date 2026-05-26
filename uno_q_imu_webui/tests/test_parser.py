"""Tests for parser.parse_line (pure module, no Arduino SDK)."""

from models import ImuSample
from parser import parse_line


def test_parse_valid_line():
    raw = "IMU,123456,0.0123,-0.0456,9.8012,0.1200,-0.3100,0.0500,9.8014,0.3370,1"
    s = parse_line(raw)
    assert isinstance(s, ImuSample)
    assert s.timestamp_ms == 123456
    assert (s.ax, s.ay, s.az) == (0.0123, -0.0456, 9.8012)
    assert s.acc_norm == 9.8014 and s.gyro_norm == 0.337
    assert s.phase == 1 and s.phase_label == "STATIONARY_OR_ZERO_VELOCITY"


def test_to_dict_includes_phase_label():
    s = parse_line("IMU,1,0,0,9.8,0,0,0,9.8,30,3")
    assert s.to_dict()["phase_label"] == "SWING_OR_ON_AIR"


def test_parse_rejects_bad_lines():
    assert parse_line("FOO,1,0,0,9.8,0,0,0,9.8,0,1") is None      # wrong tag
    assert parse_line("IMU,1,2,3") is None                        # too few
    assert parse_line("IMU,1,0,0,9.8,0,0,0,9.8,0,1,x") is None    # too many
    assert parse_line("IMU,x,0,0,9.8,0,0,0,9.8,0,1") is None      # non-numeric
    assert parse_line("") is None
