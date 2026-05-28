"""CLI entry point for the Phase 2 mock pipeline.

    python -m src.main --mode mock --duration 30 --output data/mock_imu.csv [--plot]

Runs the mock sensor for N seconds, emitting one payload every INTERVAL_MS,
parsing each line, printing raw + readable, logging to CSV, and (optionally)
live-plotting. Swap MockNanoSensor for a real BleNanoSensorClient later without
touching anything downstream.
"""

from __future__ import annotations

import argparse
import time

from .config import INTERVAL_MS
from .csv_logger import CsvLogger
from .mock_nano_sensor import MockNanoSensor
from .models import SensorSource
from .parser import parse_line


def build_source(mode: str, seed: int | None = None) -> SensorSource:
    """Construct the sensor source for the given mode (only 'mock' for now)."""
    if mode == "mock":
        return MockNanoSensor(seed=seed)
    # Future: if mode == "ble": return BleNanoSensorClient(...)
    raise ValueError(f"unknown mode: {mode!r}")


def run(source: SensorSource, duration_s: float, output: str, plot: bool) -> int:
    """Consume the source for duration_s seconds; return rows written."""
    plotter = None
    if plot:
        try:
            from .plotter import LivePlotter

            plotter = LivePlotter()
        except ImportError:
            print("[warn] matplotlib not installed; continuing without --plot")

    interval_s = INTERVAL_MS / 1000.0
    start = time.monotonic()
    next_tick = start

    with CsvLogger(output) as logger:
        for raw in source.lines():
            print(raw)                                   # raw CSV payload
            sample = parse_line(raw)
            if sample is not None:
                print("  " + sample.format_human())      # parsed readable
                logger.write(sample)
                if plotter is not None:
                    plotter.update(sample)

            # Stop once the wall-clock duration has elapsed.
            now = time.monotonic()
            if now - start >= duration_s:
                break

            # Pace to one sample per INTERVAL_MS (drift-free schedule).
            next_tick += interval_s
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)

        rows = logger.rows_written

    print(f"\nDone: wrote {rows} rows to {output}")
    if plotter is not None:
        plotter.close()
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description="Mock Nano IMU pipeline (Phase 2)")
    ap.add_argument("--mode", choices=["mock"], default="mock",
                    help="data source (only 'mock' for now)")
    ap.add_argument("--duration", type=float, default=30.0,
                    help="run time in seconds")
    ap.add_argument("--output", default="data/mock_imu.csv",
                    help="CSV output path")
    ap.add_argument("--plot", action="store_true",
                    help="live-plot acc_norm/gyro_norm/phase (needs matplotlib)")
    ap.add_argument("--seed", type=int, default=None,
                    help="RNG seed for reproducible mock data")
    args = ap.parse_args()

    source = build_source(args.mode, seed=args.seed)
    run(source, args.duration, args.output, args.plot)


if __name__ == "__main__":
    main()
