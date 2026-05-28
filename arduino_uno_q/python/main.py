"""UNO Q IMU app entry point — runtime mode comes from config.APP_MODE (no CLI flags).

App Lab launches this with its Run button and passes no arguments, so the mode is a hardcoded
constant. Just run `python python/main.py`; change behaviour by editing config.py.

config.APP_MODE:
    "dashboard" -> start the WebUI + TimeSeriesStore dashboard and apply config.STARTUP_SOURCE.
    "empty"     -> start the dashboard with no active source (pick one from the UI).
    "scan"      -> list nearby BLE devices and exit. No bricks imported.
    "debug"     -> connect to the Nano and print every parsed sample + Hz. No bricks imported.

Bluetooth note: the App Lab Python container has NO BlueZ/D-Bus access, so "scan"/"debug" (and
any *direct* BLE) only work when run on the UNO Q host over SSH, not inside the container. A
live Nano reaches the dashboard through the host-side bridge (ble_bridge.py) — see config
BLE_TRANSPORT. The "dashboard"/"empty" modes are what run inside the container.

The `debug_*` helpers below print with a `[debug]` prefix and concrete values so you can see
exactly where the link breaks. The BLE contract comes from config.py and must match the Nano
firmware (arduino_nano_33/nano_imu_ble_sender.ino).
"""

from __future__ import annotations

import asyncio
import sys
import time
from parser import parse_line

import config
from config import CHAR_UUID, DEVICE_NAME, INTERVAL_MS, SERVICE_UUID

# Expected over-the-air payload length (CSV ~60-70 B). The ATT MTU must exceed this or
# notifications get truncated and every line fails to parse. (MTU usable bytes = mtu - 3.)
_MIN_USABLE_BYTES = 73


def _dbg(msg: str) -> None:
    print(f"[debug] {msg}", flush=True)


def _matches_nano(name: str | None, service_uuids: list[str]) -> bool:
    """True if this advertisement looks like our Nano — by local name OR advertised service.

    On Linux/BlueZ the local name is often missing during a passive scan, so we also accept
    a device that advertises our SERVICE_UUID (the Nano does `setAdvertisedService`).
    """
    if (name or "").strip() == DEVICE_NAME:
        return True
    return SERVICE_UUID.lower() in {u.lower() for u in service_uuids}


async def debug_scan(timeout: float = 8.0):
    """Scan and print every device found; return the matching NanoIMU device (or None)."""
    from bleak import BleakScanner

    _dbg(f"scanning for {timeout:.0f}s ...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    if not found:
        _dbg("no BLE devices seen at all — is the adapter powered? (try: bluetoothctl show)")
        return None

    match = None
    _dbg(f"found {len(found)} device(s):")
    for dev, adv in found.values():
        name = (getattr(adv, "local_name", None) or dev.name or "(unknown)").strip()
        svc = list(getattr(adv, "service_uuids", []) or [])
        rssi = getattr(adv, "rssi", None)
        flag = ""
        if _matches_nano(name, svc):
            flag = "   <-- NanoIMU MATCH"
            match = dev
        _dbg(f"  {dev.address}  name={name!r}  rssi={rssi}  services={svc}{flag}")

    if match is None:
        _dbg(f"no device matching name={DEVICE_NAME!r} or service={SERVICE_UUID} was found.")
        _dbg("possible causes: Nano not advertising / out of range / a phone scanner is "
             "already connected (only one central allowed) / adapter not powered.")
    return match


async def debug_resolve(address: str | None, timeout: float = 8.0):
    """Resolve the target device — by explicit address, else by scanning for the Nano."""
    if address:
        from bleak import BleakScanner
        _dbg(f"resolving address {address} (timeout {timeout:.0f}s) ...")
        dev = await BleakScanner.find_device_by_address(address, timeout=timeout)
        if dev is None:
            _dbg(f"address {address} not found (not advertising / wrong address / out of range).")
        return dev
    return await debug_scan(timeout)


def _check_characteristic(client) -> bool:
    """Enumerate GATT; confirm CHAR_UUID exists and supports notify. Prints PASS/FAIL."""
    target = CHAR_UUID.lower()
    found_char = None
    _dbg("GATT services / characteristics:")
    for service in client.services:
        _dbg(f"  service {service.uuid}")
        for char in service.characteristics:
            props = ",".join(char.properties)
            mark = ""
            if char.uuid.lower() == target:
                found_char = char
                mark = "   <-- target characteristic"
            _dbg(f"    char {char.uuid}  props=[{props}]{mark}")

    if found_char is None:
        _dbg(f"FAIL: characteristic {CHAR_UUID} not present on the device.")
        return False
    if "notify" not in found_char.properties:
        _dbg(f"FAIL: characteristic {CHAR_UUID} has no 'notify' property "
             f"(props={found_char.properties}).")
        return False
    _dbg(f"PASS: characteristic {CHAR_UUID} found with 'notify'.")
    return True


async def debug_stream(device, seconds: float | None) -> None:
    """Connect, verify MTU + characteristic, subscribe, and print every parsed sample."""
    from bleak import BleakClient

    disconnected = asyncio.Event()

    def on_disconnect(_client) -> None:
        disconnected.set()

    stats = {"good": 0, "bad": 0, "win_good": 0, "win_bad": 0, "last_report": time.monotonic()}

    def on_notify(_char, data: bytearray) -> None:
        raw = data.decode("utf-8", errors="replace").strip()
        sample = parse_line(raw)
        if sample is None:
            stats["bad"] += 1
            stats["win_bad"] += 1
            _dbg(f"BAD  ({len(data)}B) {raw!r}")
        else:
            stats["good"] += 1
            stats["win_good"] += 1
            _dbg(f"OK   ts={sample.timestamp_ms} "
                 f"ax={sample.ax:+.3f} ay={sample.ay:+.3f} az={sample.az:+.3f} "
                 f"gx={sample.gx:+.2f} gy={sample.gy:+.2f} gz={sample.gz:+.2f} "
                 f"p={sample.pressure:.1f}")

        now = time.monotonic()
        elapsed = now - stats["last_report"]
        if elapsed >= 1.0:
            rate = stats["win_good"] / elapsed
            _dbg(f"--- rate={rate:.1f}Hz  good={stats['win_good']}  bad={stats['win_bad']} "
                 f"(total good={stats['good']} bad={stats['bad']}) ---")
            stats["win_good"] = stats["win_bad"] = 0
            stats["last_report"] = now

    _dbg(f"connecting to {getattr(device, 'name', None) or DEVICE_NAME} ({device.address}) ...")
    async with BleakClient(device, disconnected_callback=on_disconnect) as client:
        _dbg(f"connected. mtu_size={client.mtu_size}")
        usable = client.mtu_size - 3
        if usable < _MIN_USABLE_BYTES:
            _dbg(f"WARNING: usable MTU {usable}B < ~{_MIN_USABLE_BYTES}B — payload may be "
                 "truncated; expect 'BAD' lines. BlueZ usually negotiates a larger MTU.")

        if not _check_characteristic(client):
            _dbg("aborting: target characteristic not usable for notify.")
            return

        await client.start_notify(CHAR_UUID, on_notify)
        _dbg(f"subscribed. streaming (expect ~{1000 // INTERVAL_MS}Hz). "
             f"{'stopping after %.0fs' % seconds if seconds else 'Ctrl-C to stop'} ...")

        try:
            if seconds:
                # Stop on timeout OR early disconnect, whichever comes first.
                await asyncio.wait_for(disconnected.wait(), timeout=seconds)
            else:
                await disconnected.wait()
        except asyncio.TimeoutError:
            _dbg(f"reached --seconds={seconds:.0f}; stopping.")
        finally:
            try:
                await client.stop_notify(CHAR_UUID)
            except Exception:
                pass

    if disconnected.is_set():
        _dbg("peripheral disconnected.")


async def run_debug(address: str | None, scan_timeout: float, seconds: float | None) -> None:
    _dbg("BLE contract in use (compare against arduino_nano_33/nano_imu_ble_sender.ino):")
    _dbg(f"  DEVICE_NAME  = {DEVICE_NAME!r}")
    _dbg(f"  SERVICE_UUID = {SERVICE_UUID}")
    _dbg(f"  CHAR_UUID    = {CHAR_UUID}")
    _dbg(f"  INTERVAL_MS  = {INTERVAL_MS} (~{1000 // INTERVAL_MS}Hz)")

    # Reconnect loop: keep retrying so a Nano power-cycle / brief range loss recovers.
    while True:
        device = await debug_resolve(address, scan_timeout)
        if device is not None:
            try:
                await debug_stream(device, seconds)
            except Exception as exc:        # keep going across BLE errors
                _dbg(f"error: {exc!r}")
            if seconds:                     # bounded run: don't loop forever
                return
        _dbg("retrying in 2.0s ... (Ctrl-C to stop)")
        await asyncio.sleep(2.0)


def run_dashboard(empty: bool) -> None:
    """Start the full App Lab dashboard (WebUI + TimeSeriesStore bricks) and block.

    The brick imports stay deferred to here so `scan`/`debug` modes — and any off-device
    `import main` — never pull in the App-Lab-only bricks.
    """
    from config import BUFFER_MAXLEN, STARTUP_SOURCE, UI_PORT
    from registry import DeviceRegistry

    registry = DeviceRegistry(maxlen=BUFFER_MAXLEN)

    # TimeSeriesStore Brick: persist every sample (per-device metrics). (Arduino SDK.)
    from ts_store import TsStore
    tsstore = TsStore()

    # SourceManager owns the one active source + its ingest worker.
    from source_manager import SourceManager
    mgr = SourceManager(registry, tsstore)
    if not empty:
        mgr.set_source(STARTUP_SOURCE.get("kind", "none"),
                       gait=STARTUP_SOURCE.get("gait", "normal"),
                       address=STARTUP_SOURCE.get("address"),
                       label=STARTUP_SOURCE.get("label"))

    # Analysis service (cold-path; reads InfluxDB directly via influx_client.py). Constructed
    # lazily — the client doesn't hit the wire until the first /api/analysis/* call, so an
    # InfluxDB that's slow/unreachable at boot doesn't delay App.run(). If the *construction*
    # itself raises (bad config), we still want the dashboard up: log and pass None, which
    # makes /api/analysis/* return 503 while the realtime path stays alive.
    analysis = None
    try:
        from influx_client import InfluxClient
        from analysis import AnalysisParams, AnalysisService
        influx = InfluxClient(
            url=config.INFLUX_URL,
            username=config.INFLUX_USER,
            password=config.INFLUX_PASSWORD,
            token=config.INFLUX_TOKEN,
            db=config.INFLUX_DB,
            bucket=config.INFLUX_BUCKET,
            org=config.INFLUX_ORG,
            measurement=config.INFLUX_MEASUREMENT,
            timeout_s=config.INFLUX_TIMEOUT_S,
        )
        analysis = AnalysisService(
            influx,
            params=AnalysisParams(
                plant_gyro_dps=config.PLANT_GYRO_DPS,
                plant_refractory_ms=config.PLANT_REFRACTORY_MS,
                stick_length_m=config.STICK_LEN_M,
                p_tare_pa=config.P_TARE_PA,
                wsfc_target_pct=config.WSFC_TARGET_PCT,
            ),
            downsample_ms=config.ANALYSIS_DOWNSAMPLE_MS,
            default_duration_s=config.ANALYSIS_DEFAULT_DURATION_S,
        )
        print(f"[main] analysis ready (InfluxDB at {config.INFLUX_URL})", flush=True)
    except Exception as exc:
        print(f"[main] analysis disabled: {exc!r} — /api/analysis/* will 503", flush=True)

    # WebUI Brick: register the /api/* routes (read + control). tsstore is passed in so
    # /api/export/history can serve cold-path range exports (CSV modal in the dashboard).
    # analysis is passed in so /api/analysis/* can compute reports over windows of the same
    # InfluxDB data; None ⇒ those routes return 503.
    from webui_server import WebUIServer
    _server = WebUIServer(registry, mgr, tsstore=tsstore, analysis=analysis)  # noqa: F841

    print(f"UNO Q IMU dashboard starting (port={UI_PORT}, "
          f"{'empty' if empty else 'STARTUP_SOURCE'})", flush=True)
    from arduino.app_utils import App
    try:
        App.run()         # starts all bricks (WebUI + TimeSeriesStore) and blocks
    finally:
        tsstore.stop()    # cleanly stop the TimeSeriesStore service on shutdown


def main() -> None:
    mode = config.APP_MODE
    if mode == "dashboard":
        run_dashboard(empty=False)
    elif mode == "empty":
        run_dashboard(empty=True)
    elif mode in ("scan", "debug"):
        try:
            if mode == "scan":
                asyncio.run(debug_scan(config.SCAN_TIMEOUT_S))
            else:
                asyncio.run(run_debug(config.DEBUG_ADDRESS, config.SCAN_TIMEOUT_S,
                                      config.DEBUG_SECONDS))
        except KeyboardInterrupt:
            print("\n[debug] stopped")
    else:
        print(f"[main] unknown APP_MODE {mode!r}; expected one of "
              "'dashboard', 'empty', 'scan', 'debug' (edit config.APP_MODE).", flush=True)
        sys.exit(2)


if __name__ == "__main__":
    main()
