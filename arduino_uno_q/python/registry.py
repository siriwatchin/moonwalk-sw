"""DeviceRegistry — one SampleStore (+ label/source/worker) per device.

Multi-device support: each Nano (keyed by BLE address, or mock-N) gets its own
SampleStore so the dashboard can compare them side-by-side. Thread-safe; the
SourceManager owns the sources/workers, the registry owns the per-device buffers.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

from config import BUFFER_MAXLEN
from store import SampleStore


@dataclass
class Device:
    key: str
    label: str
    store: SampleStore
    source: object = None              # MockNanoSource | BleNanoReceiver
    worker: threading.Thread = None
    mode: str = "mock"                 # "mock" | "ble"


class DeviceRegistry:
    def __init__(self, maxlen: int = BUFFER_MAXLEN):
        self._maxlen = maxlen
        self._lock = threading.Lock()
        self._devices: dict[str, Device] = {}

    def ensure(self, key: str, label: str | None = None, mode: str = "mock") -> Device:
        """Get or create the Device for `key` (creating its SampleStore)."""
        with self._lock:
            dev = self._devices.get(key)
            if dev is None:
                store = SampleStore(maxlen=self._maxlen)
                store.set_mode(mode)
                store.set_tsstore(True)   # all devices persist to the shared TimeSeriesStore
                dev = Device(key=key, label=label or key, store=store, mode=mode)
                self._devices[key] = dev
            elif label:
                dev.label = label
            return dev

    def get(self, key: str) -> Device | None:
        with self._lock:
            return self._devices.get(key)

    def remove(self, key: str) -> Device | None:
        with self._lock:
            return self._devices.pop(key, None)

    def keys(self) -> list[str]:
        with self._lock:
            return list(self._devices)

    def devices(self) -> list[Device]:
        with self._lock:
            return list(self._devices.values())

    def clear_buffers(self) -> int:
        with self._lock:
            return sum(d.store.clear() for d in self._devices.values())

    # ---- snapshots for the API -----------------------------------------
    def status(self) -> dict:
        with self._lock:
            return {
                d.key: {"label": d.label, **d.store.status()}
                for d in self._devices.values()
            }

    def latest(self) -> dict:
        with self._lock:
            return {d.key: d.store.latest() for d in self._devices.values()}

    def series(self) -> dict:
        with self._lock:
            return {
                d.key: {"label": d.label, **d.store.series()}
                for d in self._devices.values()
            }
