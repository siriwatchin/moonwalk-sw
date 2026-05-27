#!/usr/bin/env python3
"""
ble_bridge.py
---------------------------------------------------------------------------
UNO Q (Linux side) BLE -> WebSocket bridge / gateway.

Receives IMU samples from the Nano 33 BLE peripheral "NanoIMU" over BLE, turns
each one into JSON, and re-broadcasts it to every connected WebSocket client.
This is the gateway role: dashboards / other clients (and later Supabase) read
the live stream from here instead of talking to BLE directly.

Output: one JSON object per text frame (see imu_payload.parse_payload):
    {"device":"NanoIMU","timestamp_ms":...,"recv_time":...,
     "linAcc":{...},"vel":{...},"pos":{...},"distance":...,"angle":{...}}

Setup (on the UNO Q Linux side):
    pip install -r requirements.txt
Run:
    python3 ble_bridge.py
Then connect a WebSocket client to:  ws://<uno-q-ip>:8765
---------------------------------------------------------------------------
"""

import asyncio
import json
import time

import websockets
from bleak import BleakClient, BleakScanner
from imu_payload import CHAR_UUID, DEVICE_NAME, parse_payload

# ---- WebSocket server config --------------------------------------------
WS_HOST = "0.0.0.0"   # bind on all interfaces so remote clients can connect
WS_PORT = 8765

# Connected WebSocket clients and the most recent sample (sent to new clients).
clients: set = set()
latest: dict | None = None


# ==========================================================================
# WebSocket server side
# ==========================================================================
async def ws_handler(websocket):
    """Register a client, push the latest sample, keep the socket open."""
    clients.add(websocket)
    print(f"ws client connected ({len(clients)} total)")
    try:
        if latest is not None:
            await websocket.send(json.dumps(latest))
        # We don't expect inbound messages; just hold the connection open.
        async for _ in websocket:
            pass
    finally:
        clients.discard(websocket)
        print(f"ws client disconnected ({len(clients)} total)")


async def broadcast(sample: dict) -> None:
    """Send one sample to all connected clients; drop any that error out."""
    if not clients:
        return
    message = json.dumps(sample)
    await asyncio.gather(
        *(client.send(message) for client in list(clients)),
        return_exceptions=True,  # a dead socket must not kill the others
    )


# ==========================================================================
# BLE side
# ==========================================================================
def notification_handler(_characteristic, data: bytearray) -> None:
    """bleak notify callback: CSV bytes -> JSON sample -> broadcast."""
    global latest
    raw = data.decode("utf-8", errors="replace").strip()
    sample = parse_payload(raw)
    if sample is None:
        return  # ignore malformed lines

    sample["recv_time"] = time.time()
    latest = sample
    asyncio.create_task(broadcast(sample))   # runs on the same event loop

    # TODO(Supabase): forward `sample` to Supabase / persistent storage here.
    # e.g. await upload_to_supabase(sample)


async def run_once() -> None:
    """Scan -> connect -> subscribe -> stream until the link drops."""
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


async def ble_loop() -> None:
    """Keep (re)connecting to the Nano forever."""
    while True:
        try:
            await run_once()
        except Exception as exc:
            print(f"ble error: {exc} (retrying)")
        await asyncio.sleep(2.0)


# ==========================================================================
# Entry point
# ==========================================================================
async def main() -> None:
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        print(f"WebSocket bridge on ws://{WS_HOST}:{WS_PORT}")
        await ble_loop()   # runs forever alongside the server


# TODO(Supabase): implement once a gateway/credentials are chosen.
# async def upload_to_supabase(sample: dict) -> None:
#     """Insert one IMU sample into Supabase. Not implemented yet."""
#     raise NotImplementedError


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
