"""Tests for the rolling SampleBuffer and the mock source feeding it."""

from src.buffer import SampleBuffer
from src.mock_source import MockNanoSource
from src.parser import parse_line


def test_buffer_rolls_and_snapshots():
    buf = SampleBuffer(maxlen=5)
    buf.set_status("MOCK")
    for i in range(8):
        buf.append(parse_line(f"IMU,{i},0,0,9.8,0,0,0,9.8,0,1"))

    snap = buf.snapshot()
    assert snap["status"] == "MOCK"
    assert snap["count"] == 8                       # total ever seen
    assert len(snap["recent"]["t"]) == 5            # but only maxlen retained
    assert snap["recent"]["t"] == [3, 4, 5, 6, 7]   # oldest dropped
    assert snap["latest"]["timestamp_ms"] == 7


def test_empty_snapshot():
    snap = SampleBuffer(maxlen=5).snapshot()
    assert snap["latest"] is None
    assert snap["recent"]["acc_norm"] == []
    assert snap["live"] is False


def test_mock_source_emits_valid_payloads_with_all_phases():
    # Unpaced so the test doesn't sleep; one full cycle = 100 samples.
    src = MockNanoSource(seed=1, paced=False)
    it = src.lines()
    phases = set()
    for _ in range(100):
        sample = parse_line(next(it))
        assert sample is not None          # every mock line must parse
        phases.add(sample.phase)
    assert {1, 2, 3} <= phases             # stationary, ground-contact, swing all appear
    assert src.status() == "MOCK"
