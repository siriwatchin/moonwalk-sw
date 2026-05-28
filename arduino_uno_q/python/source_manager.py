"""SourceManager — one active source for the realtime dashboard.

The dashboard shows exactly ONE active source at a time: `none`, a mock gait
(normal / changed-pattern), or a live BLE Nano picked from a scan. Setting the source tears
down whatever was running and starts the new one. Internally it is stored under a single fixed
registry key (`ACTIVE`); the DeviceRegistry/SampleStore machinery is reused as-is, just with one
device. (An earlier version compared two fixed slots A/B; that was removed.)

Source objects (MockNanoSource / BleNanoReceiver) implement: lines(), status(), stop().
"""

from __future__ import annotations

import threading
import time
from parser import parse_line

import config
from config import DEVICE_NAME
from recorder import Recorder
from registry import DeviceRegistry

# Single internal storage key for the one active source (the registry/store stay generic).
ACTIVE = "A"

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
        self._source: dict = _empty_slot()    # the one active source's config
        self.recorder = Recorder()   # single start→stop session recorder (fed by _run)

    # ---- configuring the active source ---------------------------------
    def set_source(self, kind: str = "none", gait: str = "normal",
                   address: str | None = None, label: str | None = None) -> dict:
        """Set the one active source. kind: 'none'|'mock'|'ble'.

        Replaces whatever was running (the ingest worker is torn down first).
        """
        # Changing the source mid-recording would mix data from two sources — finalize first.
        if self.recorder.state()["active"]:
            self.recorder.stop()
            print("[source] source changed — recording stopped", flush=True)
        with self._lock:
            self._remove_locked(ACTIVE)
            if kind == "mock":
                lbl = label or ("changed pattern" if gait == "altered" else gait)
                self._add_locked("mock", key=ACTIVE, label=lbl, gait=gait)
                self._source = {"kind": "mock", "gait": gait, "address": None, "label": lbl}
                print(f"[source] active = mock {gait}", flush=True)
            elif kind == "ble":
                # address=None -> connect to the first NanoIMU by advertised name.
                lbl = label or _ble_label(address)
                self._add_locked("ble", key=ACTIVE, label=lbl, address=address)
                self._source = {"kind": "ble", "gait": None, "address": address, "label": lbl}
                print(f"[source] active = ble {address or DEVICE_NAME}", flush=True)
            else:
                self._source = _empty_slot()
                print("[source] active = none", flush=True)
        return self.state()

    def reset(self) -> dict:
        """Reset to the demo source: a single mock 'normal' gait."""
        self.set_source("mock", gait="normal")
        print("[source] reset to demo source", flush=True)
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
            drop = getattr(source, "dropped", None)   # only the live BLE source sheds on full queue
            if drop is not None:
                dev.store.set_dropped(drop())
            sample = parse_line(raw)
            if sample is None:
                dev.store.note_bad()
                continue
            dev.store.append(sample)
            self.recorder.record(key, sample)             # session capture (no-op unless recording this slot)
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

    # ---- recording (single start→stop session, fed by _run) ------------
    def record_start(self, label: str) -> dict:
        """Start recording the active source (start→stop session)."""
        self.recorder.start(ACTIVE, label)
        print(f"[record] start label={label!r}", flush=True)
        return self.state()

    def record_stop(self) -> dict:
        st = self.recorder.stop()
        print(f"[record] stop — {st['count']} samples (label={st['label']!r})", flush=True)
        return self.state()

    def record_csv(self) -> str:
        return self.recorder.to_csv()

    def record_filename(self) -> str:
        return self.recorder.download_filename()

    # ---- introspection --------------------------------------------------
    def state(self) -> dict:
        dev = self._reg.get(ACTIVE)
        status = dev.store.status()["source_status"] if dev else "none"
        return {
            "scan_devices": self._scan_devices,
            "source": {**self._source, "status": status},
            "recording": self.recorder.state(),
        }
