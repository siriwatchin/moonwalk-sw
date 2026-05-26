"""SourceManager — manages many concurrent data sources (multi-device).

Each device (mock-N, or a BLE address) has its own source + ingest worker feeding that
device's SampleStore in the DeviceRegistry. Supports live add/remove so the dashboard can
compare e.g. a "normal" vs an "injured" subject side-by-side.

Source objects (MockNanoSource / BleNanoReceiver) implement: lines(), status(), stop().
"""

from __future__ import annotations

import threading
import time

from parser import parse_line
from registry import DeviceRegistry

_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    if tag not in _logged:
        _logged.add(tag)
        print(f"[warn] {tag} failed: {exc} (further errors suppressed)", flush=True)


def _short(address: str) -> str:
    """Short, human-ish key from a BLE address (last 2 octets)."""
    parts = address.replace("-", ":").split(":")
    return "".join(parts[-2:]) if len(parts) >= 2 else address


class SourceManager:
    def __init__(self, registry: DeviceRegistry, tsstore):
        self._reg = registry
        self._tsstore = tsstore
        self._lock = threading.Lock()
        self._mode = "mock"            # current top-level mode
        self._scan_devices: list[dict] = []

    # ---- top-level mode -------------------------------------------------
    def set_mode(self, mode: str) -> dict:
        """Switch the whole gateway between mock and ble.

        mock -> spin up two mock devices (normal + altered) for comparison.
        ble  -> tear down everything; devices are added via connect().
        """
        if mode not in ("mock", "ble"):
            raise ValueError(f"invalid mode {mode!r}")
        with self._lock:
            self._teardown_all()
            self._mode = mode
            if mode == "mock":
                self._add_locked("mock", key="mock-1", label="normal", gait="normal")
                self._add_locked("mock", key="mock-2", label="injured", gait="altered")
            print(f"[source] mode={mode}", flush=True)
        return self.state()

    # ---- BLE device management -----------------------------------------
    def connect(self, address: str, label: str | None = None) -> dict:
        """Add (not replace) a BLE device by address."""
        with self._lock:
            if self._mode != "ble":
                self._teardown_all()
                self._mode = "ble"
            key = _short(address)
            self._add_locked("ble", key=key, label=label or key, address=address)
            print(f"[source] connect {address} as {label or key}", flush=True)
        return self.state()

    def disconnect(self, key: str) -> dict:
        with self._lock:
            self._remove_locked(key)
            print(f"[source] disconnect {key}", flush=True)
        return self.state()

    def scan(self, timeout: float = 6.0) -> list[dict]:
        """Scan for BLE devices. Blocked while any BLE device is connected (one adapter)."""
        if self._mode == "ble" and any(
            d.source and d.source.status() == "connected" for d in self._reg.devices()
        ):
            print("[source] scan refused: a BLE device is connected", flush=True)
            return self._scan_devices
        try:
            from ble_receiver import scan as ble_scan
            self._scan_devices = ble_scan(timeout=timeout)
        except Exception as exc:
            _log_once("ble.scan", exc)
            self._scan_devices = []
        return self._scan_devices

    # ---- internal (lock held) ------------------------------------------
    def _build_source(self, mode: str, address: str | None, gait: str):
        if mode == "mock":
            from mock_source import MockNanoSource
            return MockNanoSource(gait=gait)
        from ble_receiver import BleNanoReceiver
        return BleNanoReceiver(address=address)

    def _add_locked(self, mode, key, label, address=None, gait="normal") -> None:
        self._remove_locked(key)
        dev = self._reg.ensure(key, label=label, mode=mode)
        dev.mode = mode
        dev.source = self._build_source(mode, address, gait)
        dev.store.set_status(dev.source.status())
        dev.worker = threading.Thread(target=self._run, args=(key, dev.source), daemon=True)
        dev.worker.start()

    def _remove_locked(self, key) -> None:
        dev = self._reg.get(key)
        if dev is None:
            return
        if dev.source is not None:
            try:
                dev.source.stop()
            except Exception:
                pass
        if dev.worker is not None and dev.worker.is_alive():
            dev.worker.join(timeout=3.0)
        self._reg.remove(key)

    def _teardown_all(self) -> None:
        for key in self._reg.keys():
            self._remove_locked(key)

    # ---- worker ---------------------------------------------------------
    def _run(self, key: str, source) -> None:
        reg, tsstore = self._reg, self._tsstore
        last_log = time.monotonic()
        for raw in source.lines():
            dev = reg.get(key)
            if dev is None:        # removed while running
                break
            dev.store.set_status(source.status())
            sample = parse_line(raw)
            if sample is None:
                dev.store.note_bad()
                continue
            dev.store.append(sample)
            try:
                tsstore.write(sample, device_key=key)
            except Exception as exc:
                _log_once("tsstore.write", exc)
            now = time.monotonic()
            if now - last_log >= 5.0:
                last_log = now
                st = dev.store.status()
                print(f"[ingest:{key}] good={st['count']} bad={st['bad']} "
                      f"rate={st['rate_hz']}Hz status={st['source_status']}", flush=True)

    # ---- introspection --------------------------------------------------
    def state(self) -> dict:
        return {
            "mode": self._mode,
            "scan_devices": self._scan_devices,
            "devices": [
                {"key": d.key, "label": d.label, "mode": d.mode,
                 "status": d.store.status()["source_status"]}
                for d in self._reg.devices()
            ],
        }
