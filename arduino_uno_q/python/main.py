"""UNO Q IMU WebUI app entry point.

    python main.py --mode mock     # develop/demo the dashboard
    python main.py --mode ble      # receive a real NanoIMU over BLE

Pipeline (identical for mock and BLE):
    source.lines() -> parse_line -> TimeSeriesStore.write + SampleStore.append
The browser polls the WebUI brick's /api/* endpoints (REST, no Socket.IO).

This app runs on the Arduino App Lab **WebUI Brick** (+ TimeSeriesStore Brick) — there is
no other server. Those bricks are provided by App Lab on the UNO Q; importing them
off-device will fail by design (run it on the UNO Q / in App Lab).
"""

from __future__ import annotations

import argparse
import threading

from config import BUFFER_MAXLEN, UI_PORT
from models import SensorSource
from parser import parse_line
from store import SampleStore

_logged: set[str] = set()


def _log_once(tag: str, exc: Exception) -> None:
    """Log the first error per tag so a flaky brick call doesn't spam the console."""
    if tag not in _logged:
        _logged.add(tag)
        print(f"[warn] {tag} failed: {exc} (further errors suppressed)")


def build_source(mode: str) -> SensorSource:
    """Construct the data source. This is the only mode-specific line."""
    if mode == "mock":
        from mock_source import MockNanoSource
        return MockNanoSource()
    if mode == "ble":
        from ble_receiver import BleNanoReceiver
        return BleNanoReceiver()
    raise ValueError(f"unknown mode: {mode!r}")


def run_source(source: SensorSource, store: SampleStore, tsstore) -> None:
    """Consume raw lines forever: parse -> in-memory buffer + TimeSeriesStore."""
    for raw in source.lines():
        store.set_status(source.status())
        sample = parse_line(raw)
        if sample is None:
            continue
        # In-memory buffer first, so the dashboard keeps working even if the TS brick errs.
        store.append(sample)
        try:
            tsstore.write(sample)     # persist all 9 metrics to TimeSeriesStore
        except Exception as exc:
            _log_once("tsstore.write", exc)


def main() -> None:
    ap = argparse.ArgumentParser(description="UNO Q IMU WebUI gateway")
    ap.add_argument("--mode", choices=["mock", "ble"], default="mock")
    ap.add_argument("--buffer", type=int, default=BUFFER_MAXLEN)
    args = ap.parse_args()

    store = SampleStore(maxlen=args.buffer)
    store.set_mode(args.mode)
    source = build_source(args.mode)
    store.set_status(source.status())

    # TimeSeriesStore Brick: persist every sample. (Imports the Arduino SDK.)
    from ts_store import TsStore
    tsstore = TsStore()
    store.set_tsstore(True)

    # WebUI Brick: construct + register the /api/* routes. (Imports the Arduino SDK.)
    # Keep a reference so the brick stays registered with the App framework.
    from webui_server import WebUIServer
    _server = WebUIServer(store)  # noqa: F841 — must exist before App.run()

    # Source runs in the background; App.run() owns the main thread.
    worker = threading.Thread(target=run_source, args=(source, store, tsstore), daemon=True)
    worker.start()

    print(f"UNO Q IMU dashboard starting (mode={args.mode}, port={UI_PORT})")
    from arduino.app_utils import App
    try:
        App.run()         # starts all bricks (WebUI + TimeSeriesStore) and blocks
    finally:
        tsstore.stop()    # cleanly stop the TimeSeriesStore service on shutdown


if __name__ == "__main__":
    main()
