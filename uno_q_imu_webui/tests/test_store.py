"""Tests for SampleStore + the mock source feeding it (pure modules, no SDK)."""

from mock_source import MockNanoSource
from parser import parse_line
from store import SampleStore


def _feed(store, n, seed=1):
    src = MockNanoSource(seed=seed, paced=False)   # unpaced: no sleeps in tests
    it = src.lines()
    store.set_mode("mock")
    store.set_status(src.status())
    phases = set()
    for _ in range(n):
        s = parse_line(next(it))
        assert s is not None                       # every mock line must parse
        store.append(s)
        phases.add(s.phase)
    return phases


def test_store_rolls_and_reports():
    store = SampleStore(maxlen=50)
    phases = _feed(store, 100)                      # one full cane cycle
    st = store.status()
    assert st["count"] == 100                       # total ever seen
    assert st["buffered"] == 50                     # rolling cap
    assert st["mode"] == "mock"
    assert {1, 2, 3} <= phases                      # stationary, ground-contact, swing
    assert store.latest() is not None
    assert len(store.recent(10)) == 10


def test_series_arrays_aligned_and_capped():
    store = SampleStore(maxlen=500)
    _feed(store, 100)
    s = store.series(40)
    # all four chart arrays present, same length, capped at requested n
    assert set(s) == {"t", "acc_norm", "gyro_norm", "phase"}
    lens = {len(v) for v in s.values()}
    assert lens == {40}
    assert all(p in (0, 1, 2, 3) for p in s["phase"])


def test_tsstore_flag_in_status():
    store = SampleStore(maxlen=10)
    assert store.status()["tsstore"] == "off"
    store.set_tsstore(True)
    assert store.status()["tsstore"] == "running"


def test_clear_and_csv():
    store = SampleStore(maxlen=50)
    _feed(store, 30)
    csv = store.to_csv()
    lines = csv.strip().splitlines()
    assert lines[0].startswith("timestamp_ms,")     # header
    assert len(lines) == 1 + 30                      # header + rows
    assert "phase_label" in lines[0]

    removed = store.clear()
    assert removed == 30
    assert store.latest() is None
    assert store.to_csv().strip().splitlines() == [lines[0]]  # header only
