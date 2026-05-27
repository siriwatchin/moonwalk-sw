"""Host-side BLE bridge — run this on the UNO Q *host*, NOT inside the App Lab container.

Why this exists: the App Lab Python container has no BlueZ/D-Bus access (there is no Bluetooth
brick), so the dashboard cannot read the Nano directly. This script runs on the host — where
bleak/BlueZ work — connects to the NanoIMU, and re-broadcasts the firmware's exact CSV lines
over a plain TCP socket. The dashboard's "ble" slot (bridge_source.BridgeNanoSource) connects
to this socket via the Docker bridge gateway (config.BRIDGE_HOST, default 172.17.0.1).

    Nano --BLE--> ble_bridge.py (host) --TCP--> BridgeNanoSource (container) --> dashboard

It reuses BleNanoReceiver for the BLE read (auto-reconnect to the Nano is handled there), so
the wire format stays identical to BLE and parser.parse_line is unchanged. No bricks imported;
needs only `bleak` (host-side).

Run it on the host (over SSH):
    python python/ble_bridge.py

One bridge serves one Nano on one port. For a two-Nano live compare, run a second bridge with
a different BRIDGE_PORT / BRIDGE_BLE_ADDRESS and point a second slot at it.
"""

from __future__ import annotations

import socket
import socketserver
import threading

import config
from ble_receiver import BleNanoReceiver


class _Hub:
    """Thread-safe fan-out of CSV lines to every connected TCP client."""

    def __init__(self) -> None:
        self._clients: set[socket.socket] = set()
        self._lock = threading.Lock()

    def add(self, sock: socket.socket) -> None:
        with self._lock:
            self._clients.add(sock)

    def remove(self, sock: socket.socket) -> None:
        with self._lock:
            self._clients.discard(sock)

    def broadcast(self, line: str) -> None:
        data = (line + "\n").encode("utf-8")
        with self._lock:
            clients = list(self._clients)
        for sock in clients:
            try:
                sock.sendall(data)
            except OSError:
                self.remove(sock)
                try:
                    sock.close()
                except OSError:
                    pass

    def count(self) -> int:
        with self._lock:
            return len(self._clients)


def _make_handler(hub: _Hub):
    class _Handler(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            peer = self.client_address
            hub.add(self.request)
            print(f"[bridge] client connected {peer} (clients={hub.count()})", flush=True)
            try:
                # We only push to the client; block on recv to detect disconnect.
                while self.request.recv(1024):
                    pass
            except OSError:
                pass
            finally:
                hub.remove(self.request)
                print(f"[bridge] client gone {peer} (clients={hub.count()})", flush=True)

    return _Handler


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def _pump(hub: _Hub, receiver: BleNanoReceiver) -> None:
    """Read CSV lines from the Nano (via bleak) and fan them out to TCP clients."""
    for line in receiver.lines():
        hub.broadcast(line)


def main() -> None:
    host, port = "0.0.0.0", config.BRIDGE_PORT
    target = config.BRIDGE_BLE_ADDRESS or config.DEVICE_NAME
    print(f"[bridge] starting: BLE {target} -> TCP {host}:{port}", flush=True)

    hub = _Hub()
    receiver = BleNanoReceiver(address=config.BRIDGE_BLE_ADDRESS)
    pump = threading.Thread(target=_pump, args=(hub, receiver), daemon=True)
    pump.start()

    server = _Server((host, port), _make_handler(hub))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] stopping", flush=True)
    finally:
        server.shutdown()
        server.server_close()
        receiver.stop()


if __name__ == "__main__":
    main()
