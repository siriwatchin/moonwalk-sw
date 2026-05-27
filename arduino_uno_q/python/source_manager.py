"""SourceManager — two fixed compare slots (A / B), each independently configurable.

The dashboard compares exactly two subjects side-by-side. There are two fixed slots, "A"
and "B"; each slot binds to one source — `none`, a mock gait (normal / injured), or a live
BLE Nano picked from a scan. Slots are independent, so you can mix freely (e.g. slot A a mock
'normal' baseline, slot B a real Nano). Setting a slot tears down whatever it held and starts
the new source under the slot's key, so the device registry only ever holds keys "A"/"B".

Source objects (MockNanoSource / BleNanoReceiver) implement: lines(), status(), stop().
"""

from __future__ import annotations

import threading
import time

import config
from config import DEVICE_NAME
from parser import parse_line
from registry import DeviceRegistry

SLOTS = ("A", "B")

_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    if tag not in _logged:
        _logged.add(tag)
        print(f"[warn] {tag} failed: {exc} (further errors suppressed)", flush=True)


def _ble_label(address: str | None) -> str:
    """Human-ish default label from a BLE address (last 2 octets).

    address=None means connect-by-name (first NanoIMU), so fall back to DEVICE_NAME.
    """
    if not address:
        return DEVICE_NAME
    parts = address.replace("-", ":").split(":")
    tail = "".join(parts[-2:]) if len(parts) >= 2 else address
    return f"NanoIMU {tail}"


def _empty_slot() -> dict:
    return {"kind": "none", "gait": None, "address": None, "label": None}


class SourceManager:
    def __init__(self, registry: DeviceRegistry, tsstore):
        self._reg = registry
        self._tsstore = tsstore
        self._lock = threading.Lock()
        self._scan_devices: list[dict] = []
        self._slots: dict[str, dict] = {s: _empty_slot() for s in SLOTS}

    # ---- configuring a slot --------------------------------------------
    def set_slot(self, slot: str, kind: str = "none", gait: str = "normal",
                 address: str | None = None, label: str | None = None) -> dict:
        """Bind a fixed slot ("A"/"B") to a source. kind: 'none'|'mock'|'ble'.

        Replaces whatever the slot held (the worker for that key is torn down first).
        """
        if slot not in SLOTS:
            print(f"[source] set_slot ignored: unknown slot {slot!r}", flush=True)
            return self.state()
        with self._lock:
            self._remove_locked(slot)
            if kind == "mock":
                lbl = label or ("injured" if gait == "altered" else gait)
                self._add_locked("mock", key=slot, label=lbl, gait=gait)
                self._slots[slot] = {"kind": "mock", "gait": gait,
                                     "address": None, "label": lbl}
                print(f"[source] slot {slot} = mock {gait}", flush=True)
            elif kind == "ble":
                # address=None -> connect to the first NanoIMU by advertised name.
                lbl = label or _ble_label(address)
                self._add_locked("ble", key=slot, label=lbl, address=address)
                self._slots[slot] = {"kind": "ble", "gait": None,
                                     "address": address, "label": lbl}
                print(f"[source] slot {slot} = ble {address or DEVICE_NAME}", flush=True)
            else:
                self._slots[slot] = _empty_slot()
                print(f"[source] slot {slot} = none", flush=True)
        return self.state()

    def reset(self) -> dict:
        """Re-seed the default demo pair: slot A = normal, slot B = injured."""
        self.set_slot("A", "mock", gait="normal")
        self.set_slot("B", "mock", gait="altered")
        print("[source] reset to demo pair", flush=True)
        return self.state()

    # ---- BLE scan -------------------------------------------------------
    def scan(self, timeout: float = 8.0) -> list[dict]:
        """Discover nearby BLE devices (allowed even while a slot is connected).

        With a host bridge ("bridge"/"rest", the UNO Q container) there is no BlueZ here, so a
        real scan would just D-Bus-fail — surface the host bridge as the one selectable source
        instead. Scanning for addresses is a host-side activity (APP_MODE="scan" over SSH).
        """
        if config.BLE_TRANSPORT == "rest":
            self._scan_devices = [{
                "name": f"{DEVICE_NAME} (via host REST bridge)",
                "address": config.REST_BRIDGE_URL,
            }]
            return self._scan_devices
        if config.BLE_TRANSPORT == "bridge":
            self._scan_devices = [{
                "name": f"{DEVICE_NAME} (via host bridge)",
                "address": f"{config.BRIDGE_HOST}:{config.BRIDGE_PORT}",
            }]
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
        # mode == "ble": pick the transport. In the App Lab container (no BlueZ/D-Bus) the
        # live Nano arrives via a host-side bridge; "direct" only works off-container.
        if config.BLE_TRANSPORT == "rest":
            from rest_source import RestNanoSource
            return RestNanoSource(config.REST_BRIDGE_URL, config.REST_POLL_INTERVAL_S)
        if config.BLE_TRANSPORT == "bridge":
            from bridge_source import BridgeNanoSource
            return BridgeNanoSource(config.BRIDGE_HOST, config.BRIDGE_PORT)
        from ble_receiver import BleNanoReceiver
        return BleNanoReceiver(address=address)

    def _add_locked(self, mode, key, label, address=None, gait="normal") -> None:
        self._remove_locked(key)                      # replace if same key exists
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
                tsstore.enqueue(sample, device_key=key)   # batched DB write (cold path)
            except Exception as exc:
                _log_once("tsstore.enqueue", exc)
            now = time.monotonic()
            if now - last_log >= 5.0:
                last_log = now
                st = dev.store.status()
                print(f"[ingest:{key}] good={st['count']} bad={st['bad']} "
                      f"rate={st['rate_hz']}Hz status={st['source_status']}", flush=True)

    # ---- introspection --------------------------------------------------
    def state(self) -> dict:
        statuses = {d.key: d.store.status()["source_status"] for d in self._reg.devices()}
        return {
            "scan_devices": self._scan_devices,
            "slots": {
                s: {**self._slots[s], "status": statuses.get(s, "none")}
                for s in SLOTS
            },
        }
