"""UNO Q gateway entry point: source -> buffer -> local web dashboard.

    python -m src.main --mode mock              # develop/demo without hardware
    python -m src.main --mode ble               # receive a real NanoIMU

The source (mock/BLE) runs in a background thread feeding a thread-safe buffer; the
Flask dashboard server runs in the main thread and reads buffer snapshots.
"""

from __future__ import annotations

import argparse
import threading

from .buffer import SampleBuffer
from .config import BUFFER_MAXLEN, HOST, PORT
from .models import SensorSource
from .parser import parse_line


def build_source(mode: str) -> SensorSource:
    """Construct the sensor source. This is the only mode-specific line."""
    if mode == "mock":
        from .mock_source import MockNanoSource
        return MockNanoSource()
    if mode == "ble":
        from .ble_source import BleNanoSource
        return BleNanoSource()
    raise ValueError(f"unknown mode: {mode!r}")


def run_source(source: SensorSource, buffer: SampleBuffer) -> None:
    """Consume raw lines forever, parse them, and feed the buffer."""
    for raw in source.lines():
        buffer.set_status(source.status())
        sample = parse_line(raw)
        if sample is not None:
            buffer.append(sample)


def main() -> None:
    ap = argparse.ArgumentParser(description="UNO Q Smart Cane gateway + dashboard")
    ap.add_argument("--mode", choices=["mock", "ble"], default="mock")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--buffer", type=int, default=BUFFER_MAXLEN,
                    help="rolling buffer size (samples)")
    args = ap.parse_args()

    buffer = SampleBuffer(maxlen=args.buffer)
    source = build_source(args.mode)
    buffer.set_status(source.status())

    # Source runs in the background; the web server owns the main thread.
    worker = threading.Thread(target=run_source, args=(source, buffer), daemon=True)
    worker.start()

    from .webserver import FlaskDashboardServer
    server = FlaskDashboardServer(buffer)
    print(f"Dashboard: http://{args.host}:{args.port}  (mode={args.mode})")
    try:
        server.serve_forever(args.host, args.port)
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
