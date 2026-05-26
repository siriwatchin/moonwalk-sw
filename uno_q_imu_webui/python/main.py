"""UNO Q IMU WebUI app entry point.

    python main.py --mode mock     # develop/demo the dashboard
    python main.py --mode ble      # receive a real NanoIMU over BLE

Pipeline (identical for mock and BLE):
    source.lines() -> parse_line -> SampleStore.append -> WebUI.send_message("imu_sample")

This app runs on the Arduino App Lab **WebUI Brick** — there is no other server.
On the UNO Q the brick and arduino.app_utils are provided by App Lab; importing them
off-device will fail by design (run it on the UNO Q / in App Lab).
"""

from __future__ import annotations

import argparse
import threading

from config import BUFFER_MAXLEN, UI_PORT
from models import SensorSource
from parser import parse_line
from store import SampleStore


def build_source(mode: str) -> SensorSource:
    """Construct the data source. This is the only mode-specific line."""
    if mode == "mock":
        from mock_source import MockNanoSource
        return MockNanoSource()
    if mode == "ble":
        from ble_receiver import BleNanoReceiver
        return BleNanoReceiver()
    raise ValueError(f"unknown mode: {mode!r}")


def run_source(source: SensorSource, store: SampleStore, tsstore, server) -> None:
    """Consume raw lines forever: parse -> TimeSeriesStore + in-memory buffer -> push."""
    for raw in source.lines():
        store.set_status(source.status())
        sample = parse_line(raw)
        if sample is not None:
            tsstore.write(sample)     # persist all 9 metrics to TimeSeriesStore
            store.append(sample)      # in-memory buffer for dashboard reads
            server.push(sample)       # real-time push to browser clients


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

    # WebUI Brick is the server. (Imports the Arduino SDK — UNO Q / App Lab only.)
    from webui_server import WebUIServer
    server = WebUIServer(store)

    # Source runs in the background; the brick (App.run) owns the main thread.
    worker = threading.Thread(target=run_source, args=(source, store, tsstore, server), daemon=True)
    worker.start()

    print(f"UNO Q IMU dashboard starting (mode={args.mode}, port={UI_PORT})")
    from arduino.app_utils import App
    App.run()   # starts the WebUI brick and blocks (Arduino App Lab runtime)


if __name__ == "__main__":
    main()
