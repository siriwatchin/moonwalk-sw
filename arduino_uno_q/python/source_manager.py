"""SourceManager — owns the active data source + ingest worker, switchable live.

The dashboard can switch Mock <-> BLE and connect to a chosen BLE device at runtime
(no app restart). The manager stops the current source, starts the new one, and runs a
single worker thread that drains `source.lines()` into the store + TimeSeriesStore.

Source objects (MockNanoSource / BleNanoReceiver) implement: lines(), status(), stop().
"""

from __future__ import annotations

import threading
import time

from parser import parse_line
from store import SampleStore

_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    if tag not in _logged:
        _logged.add(tag)
        print(f"[warn] {tag} failed: {exc} (further errors suppressed)", flush=True)


def _build_source(mode: str, address: str | None):
    if mode == "mock":
        from mock_source import MockNanoSource
        return MockNanoSource()
    if mode == "ble":
        from ble_receiver import BleNanoReceiver
        return BleNanoReceiver(address=address)
    raise ValueError(f"unknown mode: {mode!r}")


class SourceManager:
    def __init__(self, store: SampleStore, tsstore):
        self._store = store
        self._tsstore = tsstore
        self._lock = threading.Lock()
        self._source = None
        self._worker: threading.Thread | None = None
        self._mode = "mock"
        self._address: str | None = None
        self._devices: list[dict] = []   # last BLE scan result

    # ---- control --------------------------------------------------------
    def select(self, mode: str, address: str | None = None) -> dict:
        """Switch to a new source (mock|ble) live. Returns the new state."""
        if mode not in ("mock", "ble"):
            raise ValueError(f"invalid mode {mode!r}")
        with self._lock:
            self._stop_current()
            self._mode = mode
            self._address = address if mode == "ble" else None
            self._source = _build_source(mode, self._address)
            self._store.set_mode(mode)
            self._store.set_status(self._source.status())
            self._worker = threading.Thread(target=self._run, args=(self._source,), daemon=True)
            self._worker.start()
            print(f"[source] selected mode={mode} address={self._address}", flush=True)
        return self.state()

    def scan(self, timeout: float = 6.0) -> list[dict]:
        """Scan for BLE devices. Only when not BLE-connected (single adapter)."""
        if self._mode == "ble" and self.connected():
            print("[source] scan refused: BLE connected (switch to mock or disconnect first)",
                  flush=True)
            return self._devices
        try:
            from ble_receiver import scan as ble_scan
            self._devices = ble_scan(timeout=timeout)
        except Exception as exc:
            _log_once("ble.scan", exc)
            self._devices = []
        return self._devices

    def _stop_current(self) -> None:
        if self._source is not None:
            try:
                self._source.stop()
            except Exception:
                pass
        if self._worker is not None and self._worker.is_alive():
            self._worker.join(timeout=3.0)   # let the old worker unwind
        self._source = None
        self._worker = None

    # ---- worker ---------------------------------------------------------
    def _run(self, source) -> None:
        store, tsstore = self._store, self._tsstore
        last_log = time.monotonic()
        for raw in source.lines():
            store.set_status(source.status())
            sample = parse_line(raw)
            if sample is None:
                store.note_bad()
                continue
            store.append(sample)
            try:
                tsstore.write(sample)
            except Exception as exc:
                _log_once("tsstore.write", exc)
            now = time.monotonic()
            if now - last_log >= 5.0:
                last_log = now
                st = store.status()
                print(f"[ingest] good={st['count']} bad={st['bad']} "
                      f"rate={st['rate_hz']}Hz status={st['source_status']}", flush=True)

    # ---- introspection --------------------------------------------------
    def connected(self) -> bool:
        return self._source is not None and self._source.status() == "connected"

    def state(self) -> dict:
        return {
            "selected_mode": self._mode,
            "target_address": self._address,
            "connected": self.connected(),
            "devices": self._devices,
        }
