"""Bridge Nano source: read the Nano's CSV stream from the host-side BLE bridge over TCP.

The App Lab Python container has no BlueZ/D-Bus access, so it cannot talk to the Nano
directly. Instead ble_bridge.py runs on the UNO Q *host* (where bleak works) and forwards the
firmware's exact CSV lines over a TCP socket; this client connects to it (via the Docker
bridge gateway, default 172.17.0.1) and exposes the same blocking lines() iterator as
MockNanoSource / BleNanoReceiver — so it is a drop-in slot source. Pure stdlib: no bleak, no
bricks, importable and testable off-device.

The wire format is identical to BLE (raw CSV lines), so parser.parse_line is unchanged.
"""

from __future__ import annotations

import socket
import threading
from typing import Iterator

_CONNECT_TIMEOUT_S = 5.0   # TCP connect attempt before retrying
_RETRY_S = 2.0             # backoff between reconnects (mirrors BleNanoReceiver)


class BridgeNanoSource:
    def __init__(self, host: str, port: int):
        self._host = host
        self._port = port
        self._status = "starting"
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None

    def status(self) -> str:
        return self._status

    def stop(self) -> None:
        """Signal lines() to end and unblock a blocked socket read by closing it."""
        self._stop.set()
        with self._lock:
            sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def _set_status(self, s: str) -> None:
        if s != self._status:
            self._status = s
            print(f"[bridge] {s}", flush=True)

    def lines(self) -> Iterator[str]:
        target = f"{self._host}:{self._port}"
        while not self._stop.is_set():
            self._set_status(f"connecting {target}")
            try:
                sock = socket.create_connection((self._host, self._port),
                                                timeout=_CONNECT_TIMEOUT_S)
            except OSError as exc:
                self._set_status(f"disconnected / reconnecting ({exc})")
                if self._stop.wait(_RETRY_S):
                    break
                continue

            sock.settimeout(None)   # block on reads; stop() closes the socket to unblock
            with self._lock:
                self._sock = sock
            self._set_status("connected")

            # makefile gives a clean line iterator; stop()/peer-close ends readline().
            reader = sock.makefile("r", encoding="utf-8", errors="replace", newline="\n")
            try:
                while not self._stop.is_set():
                    line = reader.readline()
                    if line == "":          # EOF: bridge closed or socket shut down
                        break
                    line = line.strip()
                    if line:
                        yield line
            except OSError:
                pass                        # socket closed under us (stop() or peer drop)
            finally:
                with self._lock:
                    self._sock = None
                try:
                    reader.close()
                except OSError:
                    pass
                try:
                    sock.close()
                except OSError:
                    pass

            if self._stop.is_set():
                break
            self._set_status("disconnected / reconnecting")
            if self._stop.wait(_RETRY_S):
                break

        self._set_status("stopped")
