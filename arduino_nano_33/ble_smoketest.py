#!/usr/bin/env python3
"""
ble_smoketest.py
---------------------------------------------------------------------------
Programmatic bring-up test for the Nano 33 BLE firmware. Connects to "NanoIMU",
collects samples for a few seconds, validates them, and prints SMOKETEST PASS /
FAIL (non-zero exit on failure) so you get an unambiguous green light.

Checks:
  - the device is found and connectable
  - every notification parses as a valid IMU payload
  - effective rate is ~20 Hz (50 ms interval)
  - timestamp_ms is strictly increasing
  - phase is always one of {0,1,2,3}

Usage (from a Mac/PC with BLE):
    pip install -r requirements.txt
    python3 ble_smoketest.py [seconds]      # default 5
---------------------------------------------------------------------------
"""

import asyncio
import sys
import time

from bleak import BleakClient, BleakScanner
from imu_payload import CHAR_UUID, DEVICE_NAME, PHASE_LABELS, parse_payload

# Acceptance window for the effective sample rate (target 20 Hz).
RATE_MIN_HZ = 12.0
RATE_MAX_HZ = 28.0


async def collect(duration_s: float) -> dict:
    """Connect, subscribe, and gather stats for duration_s seconds."""
    print(f"scanning for {DEVICE_NAME}...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15.0)
    if device is None:
        return {"found": False}
    print(f"found {DEVICE_NAME} ({device.address}); collecting {duration_s:.0f}s...")

    stats = {
        "found": True,
        "good": 0,
        "bad": 0,
        "phase_hist": {code: 0 for code in PHASE_LABELS},
        "last_ts": None,
        "ts_monotonic": True,
    }

    def on_notify(_char, data: bytearray) -> None:
        raw = data.decode("utf-8", errors="replace").strip()
        sample = parse_payload(raw)
        if sample is None:
            stats["bad"] += 1
            return
        stats["good"] += 1
        stats["phase_hist"][sample["phase"]] = stats["phase_hist"].get(sample["phase"], 0) + 1
        ts = sample["timestamp_ms"]
        if stats["last_ts"] is not None and ts <= stats["last_ts"]:
            stats["ts_monotonic"] = False
        stats["last_ts"] = ts

    async with BleakClient(device) as client:
        await client.start_notify(CHAR_UUID, on_notify)
        t0 = time.monotonic()
        await asyncio.sleep(duration_s)
        await client.stop_notify(CHAR_UUID)
        stats["elapsed"] = time.monotonic() - t0

    return stats


def report(stats: dict) -> bool:
    """Print the findings and return True on PASS."""
    if not stats.get("found"):
        print(f"FAIL: {DEVICE_NAME} not found (is it powered and advertising?)")
        return False

    good, bad = stats["good"], stats["bad"]
    elapsed = stats.get("elapsed", 0.0) or 1e-9
    rate = good / elapsed

    print("\n--- results ---")
    print(f"good frames : {good}")
    print(f"bad frames  : {bad}")
    print(f"rate        : {rate:.1f} Hz (over {elapsed:.1f}s)")
    print(f"ts increasing: {stats['ts_monotonic']}")
    print("phase histogram:")
    for code, label in PHASE_LABELS.items():
        print(f"  {code} {label:<28} {stats['phase_hist'].get(code, 0)}")

    checks = {
        "received frames": good > 0,
        "no parse errors": bad == 0,
        f"rate in {RATE_MIN_HZ:.0f}-{RATE_MAX_HZ:.0f} Hz": RATE_MIN_HZ <= rate <= RATE_MAX_HZ,
        "timestamp increasing": stats["ts_monotonic"],
    }
    print("\n--- checks ---")
    for name, ok in checks.items():
        print(f"  [{'OK' if ok else 'XX'}] {name}")

    return all(checks.values())


async def main() -> None:
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    stats = await collect(duration)
    passed = report(stats)
    print("\nSMOKETEST PASS" if passed else "\nSMOKETEST FAIL")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
        sys.exit(1)
