"""BLE Nano receiver: NanoIMU notifications via bleak, exposed as lines().

bleak is async; the runner consumes a blocking lines() iterator. An internal thread
runs the asyncio loop (scan/connect/subscribe) and pushes raw CSV lines into a
thread-safe queue that lines() drains — so BleNanoReceiver is a drop-in for
MockNanoSource. `bleak` is imported lazily so mock mode works without it installed.
"""

from __future__ import annotations

import asyncio
import queue
import threading
from typing import Iterator

from config import CHAR_UUID, DEVICE_NAME


class BleNanoReceiver:
    def __init__(self):
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._status = "starting"
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._started = False

    def status(self) -> str:
        return self._status

    async def _run_once(self) -> None:
        from bleak import BleakClient, BleakScanner

        self._status = "scanning"
        device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15.0)
        if device is None:
            self._status = "NanoIMU not found"
            return

        disconnected = asyncio.Event()

        def on_disconnect(_client) -> None:
            disconnected.set()

        def on_notify(_char, data: bytearray) -> None:
            self._queue.put(data.decode("utf-8", errors="replace").strip())

        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            self._status = "connected"
            await client.start_notify(CHAR_UUID, on_notify)
            await disconnected.wait()

        self._status = "disconnected"

    def _run_loop(self) -> None:
        async def forever():
            while True:
                try:
                    await self._run_once()
                except Exception as exc:        # keep the gateway alive across BLE errors
                    self._status = f"error: {exc}"
                await asyncio.sleep(2.0)

        asyncio.run(forever())

    def lines(self) -> Iterator[str]:
        if not self._started:
            self._thread.start()
            self._started = True
        while True:
            yield self._queue.get()             # blocks until the next notification
