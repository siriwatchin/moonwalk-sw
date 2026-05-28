"""Tests for parser.parse_line."""

from src.models import ImuSample
from src.parser import parse_line


def test_parse_valid_line():
    raw = "IMU,123456,0.0123,-0.0456,9.8012,0.1200,-0.3100,0.0500,9.8014,0.3370,1"
    s = parse_line(raw)
    assert isinstance(s, ImuSample)
    assert s.timestamp_ms == 123456
    assert s.ax == 0.0123 and s.ay == -0.0456 and s.az == 9.8012
    assert s.gx == 0.12 and s.gy == -0.31 and s.gz == 0.05
    assert s.acc_norm == 9.8014 and s.gyro_norm == 0.337
    assert s.phase == 1
    assert s.phase_label == "STATIONARY_OR_ZERO_VELOCITY"


def test_parse_strips_whitespace_and_newline():
    raw = "  IMU,1,0,0,9.8,0,0,0,9.8,0,1\n"
    assert parse_line(raw) is not None


def test_roundtrip_payload():
    raw = "IMU,200,1.0000,2.0000,3.0000,4.0000,5.0000,6.0000,3.7417,8.7750,3"
    s = parse_line(raw)
    assert s is not None
    assert parse_line(s.to_csv_payload()) == s


def test_parse_rejects_wrong_tag():
    assert parse_line("FOO,1,0,0,9.8,0,0,0,9.8,0,1") is None


def test_parse_rejects_wrong_field_count():
    assert parse_line("IMU,1,2,3") is None                       # too few
    assert parse_line("IMU,1,0,0,9.8,0,0,0,9.8,0,1,extra") is None  # too many


def test_parse_rejects_non_numeric():
    assert parse_line("IMU,x,0,0,9.8,0,0,0,9.8,0,1") is None
    assert parse_line("IMU,1,0,0,9.8,0,0,0,9.8,0,notint") is None


def test_parse_empty_returns_none():
    assert parse_line("") is None
