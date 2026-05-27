"""BLE Nano receiver: NanoIMU notifications via bleak, exposed as lines().

bleak is async; the runner consumes a blocking lines() iterator. An internal thread
runs the asyncio loop (scan/connect/subscribe) and pushes raw CSV lines into a
thread-safe queue that lines() drains — so BleNanoReceiver is a drop-in for
MockNanoSource. `bleak` is imported lazily so mock mode works without it installed.

Supports targeting a specific device address (from the dashboard scan/connect flow)
and clean stop() so the SourceManager can switch sources live. Every state transition
is printed with a `[ble]` prefix for bring-up debugging.
"""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from collections.abc import Iterator

from config import BLE_STALL_TIMEOUT_S, CHAR_UUID, DEVICE_NAME

_QUEUE_MAX = 2000     # ~100 s at 20 Hz; guards memory if the consumer ever stalls
_SENTINEL = object()  # pushed to unblock lines() on stop
_BACKOFF_START_S = 1.0   # reconnect backoff grows 1→2→4…→cap, resets after a real session
_BACKOFF_MAX_S = 30.0
_SESSION_OK_S = 10.0     # a session lasting this long counts as "connected" → reset backoff


def scan(timeout: float = 8.0) -> list[dict]:
    """Discover nearby BLE devices. Returns [{"name","address"}] (NanoIMU first).

    Reads the advertisement data's local name, not just BLEDevice.name: on Linux/BlueZ
    `device.name` is often None during a passive scan, so the Nano would show as
    "(unknown)". `return_adv=True` gives us AdvertisementData.local_name, which carries
    the advertised name reliably. Runs a throwaway event loop.
    """
    from bleak import BleakScanner

    def _entry(name: str | None, address: str) -> dict:
        return {"name": (name or "").strip() or "(unknown)", "address": address}

    async def _discover():
        out = []
        try:
            found = await BleakScanner.discover(timeout=timeout, return_adv=True)
            # found: {address: (BLEDevice, AdvertisementData)}
            for dev, adv in found.values():
                name = getattr(adv, "local_name", None) or dev.name
                out.append(_entry(name, dev.address))
        except TypeError:
            # Older bleak without return_adv — fall back to device.name only.
            for dev in await BleakScanner.discover(timeout=timeout):
                out.append(_entry(dev.name, dev.address))
        # NanoIMU first, then other named devices, unknowns last.
        out.sort(key=lambda x: (x["name"] != DEVICE_NAME,
                                x["name"] == "(unknown)",
                                x["name"]))
        return out

    return asyncio.run(_discover())


class BleNanoReceiver:
    def __init__(self, address: str | None = None):
        # address=None -> scan + connect by name DEVICE_NAME (default NanoIMU).
        self._address = address
        self._queue: queue.Queue = queue.Queue(maxsize=_QUEUE_MAX)
        self._status = "starting"
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._started = False
        self._start_lock = threading.Lock()   # guards the one-time thread start in lines()
        self._dropped = 0                      # samples shed because the queue was full
        self._warned_drop = False
        self._stop = threading.Event()
        self._last_rx = 0.0   # monotonic time of the last notification (stall watchdog)

    def status(self) -> str:
        return self._status

    def dropped(self) -> int:
        """Count of samples dropped due to a full queue (consumer fell behind)."""
        return self._dropped

    def stop(self) -> None:
        """Signal the loop to stop and unblock lines()."""
        self._stop.set()
        try:
            self._queue.put_nowait(_SENTINEL)   # wake a blocked lines()
        except queue.Full:
            pass

    def _set_status(self, s: str) -> None:
        if s != self._status:
            self._status = s
            print(f"[ble] {s}", flush=True)

    async def _resolve_device(self):
        from bleak import BleakScanner
        if self._address:
            self._set_status(f"connecting {self._address}")
            return await BleakScanner.find_device_by_address(self._address, timeout=15.0)
        self._set_status("scanning")
        return await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=15.0)

    async def _run_once(self) -> None:
        from bleak import BleakClient

        device = await self._resolve_device()
        if device is None:
            self._set_status(f"{self._address or DEVICE_NAME} not found")
            return
        self._set_status(f"found {getattr(device, 'name', None) or DEVICE_NAME} ({device.address})")

        disconnected = asyncio.Event()

        def on_disconnect(_client) -> None:
            disconnected.set()

        def on_notify(_char, data: bytearray) -> None:
            self._last_rx = time.monotonic()   # feed the stall watchdog
            line = data.decode("utf-8", errors="replace").strip()
            try:
                self._queue.put_nowait(line)
            except queue.Full:
                try:
                    self._queue.get_nowait()
                    self._queue.put_nowait(line)
                except queue.Empty:
                    pass
                self._dropped += 1
                if not self._warned_drop:
                    self._warned_drop = True
                    print("[ble] WARNING: queue full, dropping oldest samples", flush=True)

        stalled = False
        async with BleakClient(device, disconnected_callback=on_disconnect) as client:
            self._set_status("connected")
            self._last_rx = time.monotonic()   # arm the watchdog (grace before first sample)
            await client.start_notify(CHAR_UUID, on_notify)
            # Wait until the peripheral drops, data stalls, OR we're asked to stop. Leaving this
            # block exits the BleakClient context = a clean disconnect, so forever() reconnects.
            while not disconnected.is_set() and not self._stop.is_set():
                await asyncio.sleep(0.2)
                if time.monotonic() - self._last_rx > BLE_STALL_TIMEOUT_S:
                    stalled = True
                    break

        if self._stop.is_set():
            self._set_status("stopped")
        elif stalled:
            self._set_status(f"stalled: no data {BLE_STALL_TIMEOUT_S}s / reconnecting")
        else:
            self._set_status("disconnected / reconnecting")

    def _run_loop(self) -> None:
        async def forever():
            backoff = _BACKOFF_START_S
            while not self._stop.is_set():
                t0 = time.monotonic()
                try:
                    await self._run_once()
                except Exception as exc:        # keep going across BLE errors
                    self._set_status(f"error: {exc}")
                if self._stop.is_set():
                    break
                # Reset backoff only after a session that actually lasted (a real connection),
                # so a flapping "not found"/error loop keeps backing off instead of hammering.
                if time.monotonic() - t0 >= _SESSION_OK_S:
                    backoff = _BACKOFF_START_S
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_MAX_S)

        asyncio.run(forever())

    def lines(self) -> Iterator[str]:
        with self._start_lock:          # guard against concurrent lines() starting the thread twice
            if not self._started:
                self._thread.start()
                self._started = True
        while not self._stop.is_set():
            item = self._queue.get()            # blocks until next notification / sentinel
            if item is _SENTINEL:
                break
            yield item
