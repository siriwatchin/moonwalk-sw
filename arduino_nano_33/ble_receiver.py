#!/usr/bin/env python3
"""
ble_receiver.py
---------------------------------------------------------------------------
Simple debug receiver for the UNO Q Linux side: scan for "NanoIMU", subscribe
to its IMU characteristic, and print each payload (raw CSV + parsed values).

This is the minimal "does BLE work?" tool. For the gateway that re-broadcasts
the stream over WebSocket, use ble_bridge.py instead.

Setup (on the UNO Q Linux side):
    pip install -r requirements.txt
Run:
    python3 ble_receiver.py
---------------------------------------------------------------------------
"""

import asyncio

from bleak import BleakClient, BleakScanner
from imu_payload import CHAR_UUID, DEVICE_NAME, format_human, parse_payload


def notification_handler(_characteristic, data: bytearray) -> None:
    """bleak notify callback: print the raw line and a readable parsed form."""
    raw = data.decode("utf-8", errors="replace").strip()
    print(f"raw: {raw}")
    sample = parse_payload(raw)
    if sample is not None:
        print(format_human(sample))


async def run_once() -> None:
    """Scan -> connect -> subscribe -> stream until disconnect."""
    print("scanning...")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15.0)
    if device is None:
        print(f"{DEVICE_NAME} not found")
        return
    print(f"found {DEVICE_NAME} ({device.address})")

    disconnected = asyncio.Event()

    def on_disconnect(_client: BleakClient) -> None:
        disconnected.set()

    async with BleakClient(device, disconnected_callback=on_disconnect) as client:
        print("connected")
        await client.start_notify(CHAR_UUID, notification_handler)
        print("subscribed")
        await disconnected.wait()

    print("disconnected / reconnecting")


async def main() -> None:
    # Reconnect loop: keep trying so a power cycle of the Nano recovers cleanly.
    while True:
        try:
            await run_once()
        except Exception as exc:
            print(f"error: {exc} (retrying)")
        await asyncio.sleep(2.0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
