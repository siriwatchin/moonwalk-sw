"""Tests for TsStore metric mapping, using an injected fake db (no Arduino SDK)."""

from parser import parse_line
from ts_store import TsStore


class FakeTsDb:
    """Stand-in for arduino.app_bricks.dbstorage_tsstore.TimeSeriesStore."""

    def __init__(self):
        self.started = False
        self.writes = []          # list of (metric, value)

    def start(self):
        self.started = True

    def write_sample(self, metric, value):
        self.writes.append((metric, value))


def test_start_called_on_construction():
    db = FakeTsDb()
    TsStore(db=db)
    assert db.started is True


def test_write_emits_all_nine_metrics_with_spec_names():
    db = FakeTsDb()
    ts = TsStore(db=db)
    s = parse_line("IMU,123,0.10,0.20,9.80,1.0,2.0,3.0,9.81,3.74,2")
    ts.write(s)

    got = dict(db.writes)
    assert len(db.writes) == 9                      # one write per metric
    assert got == {
        "ax_ms2": 0.10, "ay_ms2": 0.20, "az_ms2": 9.80,
        "gx_dps": 1.0, "gy_dps": 2.0, "gz_dps": 3.0,
        "acc_norm": 9.81, "gyro_norm": 3.74,
        "phase": 2,
    }


def test_read_last_is_best_effort():
    class NoRead(FakeTsDb):
        def read_last_sample(self, metric):
            raise RuntimeError("range API differs")

    ts = TsStore(db=NoRead())
    assert ts.read_last("acc_norm") is None          # swallows errors -> None
