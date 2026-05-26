"""UNO Q IMU WebUI app entry point.

    python main.py --mode mock     # start in mock (default)
    python main.py --mode ble      # start receiving a real NanoIMU over BLE

The source can also be switched live from the dashboard (Mock/BLE + scan/connect) via the
SourceManager — `--mode` / MODE env / config.DEFAULT_MODE only sets the *initial* source.

Pipeline (mock and BLE alike):
    source.lines() -> parse_line -> SampleStore.append (+ note_bad) -> TimeSeriesStore.write
The browser polls the WebUI brick's /api/* endpoints (REST, no Socket.IO).

Runs on the Arduino App Lab WebUI Brick (+ TimeSeriesStore Brick); both are provided by
App Lab on the UNO Q (importing them off-device fails by design).
"""

from __future__ import annotations

import argparse
import os

from config import BUFFER_MAXLEN, DEFAULT_MODE, UI_PORT
from registry import DeviceRegistry


def resolve_mode(cli_mode: str | None) -> tuple[str, str]:
    """Initial source: --mode arg > MODE env var > config.DEFAULT_MODE.

    Returns (mode, origin) where origin is 'cli' | 'env' | 'default' for logging.
    """
    if cli_mode:
        mode, origin = cli_mode, "cli"
    elif os.getenv("MODE"):
        mode, origin = os.environ["MODE"], "env"
    else:
        mode, origin = DEFAULT_MODE, "default"
    if mode not in ("mock", "ble"):
        raise SystemExit(f"invalid mode {mode!r} (use mock|ble)")
    return mode, origin


def main() -> None:
    ap = argparse.ArgumentParser(description="UNO Q IMU WebUI gateway")
    ap.add_argument("--mode", choices=["mock", "ble"], default=None,
                    help="initial data source; overrides MODE env / config.DEFAULT_MODE")
    ap.add_argument("--buffer", type=int, default=BUFFER_MAXLEN)
    args = ap.parse_args()

    mode, origin = resolve_mode(args.mode)
    registry = DeviceRegistry(maxlen=args.buffer)

    # TimeSeriesStore Brick: persist every sample (per-device metrics). (Arduino SDK.)
    from ts_store import TsStore
    tsstore = TsStore()

    # SourceManager owns the concurrent sources + ingest workers (multi-device).
    from source_manager import SourceManager
    mgr = SourceManager(registry, tsstore)
    if mode == "mock":
        mgr.set_mode("mock")    # spins up the normal + injured mock pair
    else:
        mgr.set_mode("ble")     # devices added later via the dashboard / connect()

    # WebUI Brick: register the /api/* routes (read + control). Keep a reference so the
    # brick stays registered with the App framework before App.run().
    from webui_server import WebUIServer
    _server = WebUIServer(registry, mgr)  # noqa: F841

    print(f"UNO Q IMU dashboard starting (initial mode={mode} [{origin}], port={UI_PORT})")
    from arduino.app_utils import App
    try:
        App.run()         # starts all bricks (WebUI + TimeSeriesStore) and blocks
    finally:
        tsstore.stop()    # cleanly stop the TimeSeriesStore service on shutdown


if __name__ == "__main__":
    main()
