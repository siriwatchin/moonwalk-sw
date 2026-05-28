"""REST Nano source: poll the host-side FastAPI BLE bridge over HTTP.

The App Lab container has no BlueZ/D-Bus, so a live Nano reaches the dashboard through
host_bridge/ble_bridge.py (FastAPI, default :8787). This client polls its GET /samples endpoint
and yields each sample's verbatim CSV line — the same blocking lines() iterator as
MockNanoSource / BridgeNanoSource, so it's a drop-in slot source (BLE_TRANSPORT="rest").

The bridge ships the original CSV in every record, so we yield it as-is and parser.parse_line
stays unchanged. Pure stdlib (urllib): no bleak, no bricks — testable off-device.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator

_HTTP_TIMEOUT_S = 3.0    # per-request timeout before the bridge counts as unreachable
_BACKOFF_START_S = 1.0   # error backoff grows 1→2→4…→cap, resets on the next good poll
_BACKOFF_MAX_S = 30.0


class RestNanoSource:
    def __init__(self, base_url: str, poll_interval_s: float = 0.3):
        self._base = base_url.rstrip("/")
        self._poll = max(0.05, float(poll_interval_s))
        self._status = "starting"
        self._stop = threading.Event()

    def status(self) -> str:
        return self._status

    def stop(self) -> None:
        """Signal lines() to end (the next poll/sleep observes the flag)."""
        self._stop.set()

    def _set_status(self, s: str) -> None:
        if s != self._status:
            self._status = s
            print(f"[rest] {s}", flush=True)

    def _get(self, url: str):
        with urllib.request.urlopen(url, timeout=_HTTP_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def lines(self) -> Iterator[str]:
        last_seq = 0
        backoff = _BACKOFF_START_S
        while not self._stop.is_set():
            try:
                records = self._get(f"{self._base}/samples?since={last_seq}")
            except (urllib.error.URLError, OSError, ValueError) as exc:
                self._set_status(f"disconnected / reconnecting ({exc})")
                if self._stop.wait(backoff):
                    break
                backoff = min(backoff * 2, _BACKOFF_MAX_S)
                continue
            backoff = _BACKOFF_START_S   # good poll → reset backoff
            self._set_status("connected")
            for rec in records or []:
                last_seq = max(last_seq, rec.get("seq", 0))
                csv = rec.get("csv")
                if csv:
                    yield csv
            if self._stop.wait(self._poll):
                break
        self._set_status("stopped")
