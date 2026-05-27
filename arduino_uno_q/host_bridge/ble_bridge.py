"""Host-side REST BLE bridge — run on the UNO Q *host*, NOT inside the App Lab container.

Why this exists: the App Lab Python container has no BlueZ/D-Bus access (there is no Bluetooth
brick), so the dashboard cannot read the Nano directly. This service runs on the host — where
bleak/BlueZ work — connects to the NanoIMU, parses each firmware CSV line, and serves the
samples over an HTTP REST API (FastAPI). The dashboard's "ble" slot polls it via
rest_source.RestNanoSource (selected by config.BLE_TRANSPORT="rest").

    Nano --BLE--> host_bridge/ble_bridge.py (host, :8787) --HTTP--> RestNanoSource (container)

It reuses the App Lab app's BLE + parsing code from the sibling ../python directory
(BleNanoReceiver handles Nano auto-reconnect; parse_line validates the CSV). Every record keeps
the original "csv" line, so the container yields it verbatim and parser.parse_line is shared.

Sibling to (not a replacement for) python/ble_bridge.py — that streams raw CSV over a TCP
socket (BLE_TRANSPORT="bridge"); this serves JSON over REST (BLE_TRANSPORT="rest").

Deploy + run: see host_bridge/README.md (venv, requirements, systemd). Manually:
    python ble_bridge.py        # then curl http://127.0.0.1:8787/health
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections import deque

# Reuse the App Lab app's config / BLE receiver / parser from the sibling python/ dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _cand in (os.environ.get("MOONWALK_PY_DIR"),
              os.path.join(_HERE, "..", "python"),
              os.path.join(_HERE, "python")):
    if _cand and os.path.isdir(_cand):
        sys.path.insert(0, os.path.abspath(_cand))
        break

import config                                  # noqa: E402
from ble_receiver import BleNanoReceiver       # noqa: E402
from parser import parse_line                  # noqa: E402

from fastapi import FastAPI                     # noqa: E402

BRIDGE_REST_PORT = 8787
_BUFFER_MAXLEN = 500       # rolling window of recent samples served by /samples


def build_record(sample, raw: str, seq: int) -> dict:
    """Pure: one parsed sample -> the REST JSON record (spec keys + received_at + verbatim csv)."""
    return {
        "seq": seq,
        "timestamp_ms": sample.timestamp_ms,
        "ax_ms2": sample.ax, "ay_ms2": sample.ay, "az_ms2": sample.az,
        "gx_dps": sample.gx, "gy_dps": sample.gy, "gz_dps": sample.gz,
        "acc_norm": sample.acc_norm,
        "gyro_norm": sample.gyro_norm,
        "phase": sample.phase,
        "phase_label": sample.phase_label,
        "received_at": time.time(),
        "csv": raw.strip(),
    }


class Samples:
    """Shared, lock-guarded sample store: a rolling buffer + a good/bad tally.

    `seq` doubles as the running count of good samples (total received) and the /samples cursor.
    `latest` is just the last buffered record; `last_seen_at` is its received_at.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buf: deque[dict] = deque(maxlen=_BUFFER_MAXLEN)
        self._seq = 0
        self._bad = 0

    def add(self, sample, raw: str) -> None:
        with self._lock:
            self._seq += 1
            self._buf.append(build_record(sample, raw, self._seq))

    def note_bad(self) -> None:
        with self._lock:
            self._bad += 1

    def latest(self) -> dict:
        with self._lock:
            return dict(self._buf[-1]) if self._buf else {}

    def recent(self, limit: int, since: int) -> list[dict]:
        with self._lock:
            items = [r for r in self._buf if r["seq"] > since] if since else list(self._buf)
        return items[-limit:] if limit and limit > 0 else items

    def counts(self) -> tuple[int, int, float | None]:
        with self._lock:
            received, bad = self._seq, self._bad
            last_seen = self._buf[-1]["received_at"] if self._buf else None
        return received, bad, last_seen


def _pump(samples: Samples, receiver: BleNanoReceiver) -> None:
    """Read CSV from the Nano (via bleak) and fold each sample into the store. Never crashes."""
    for raw in receiver.lines():
        sample = parse_line(raw)
        if sample is None:
            samples.note_bad()
        else:
            samples.add(sample, raw)


SAMPLES = Samples()
RECEIVER = BleNanoReceiver(address=config.BRIDGE_BLE_ADDRESS)

app = FastAPI(title="Moon Walk BLE REST bridge")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/status")
def status() -> dict:
    st = RECEIVER.status()
    received, bad, last_seen = SAMPLES.counts()
    return {
        "connected": st == "connected",
        "device_name": config.DEVICE_NAME,
        "device_address": config.BRIDGE_BLE_ADDRESS,
        "samples_received": received,
        "bad": bad,
        "last_seen_at": last_seen,
        "last_error": st if st.startswith("error") else None,
        "source_status": st,
    }


@app.get("/latest")
def latest() -> dict:
    return SAMPLES.latest()


@app.get("/samples")
def samples(limit: int = 200, since: int = 0) -> list[dict]:
    return SAMPLES.recent(limit, since)


def main() -> None:
    import uvicorn

    target = config.BRIDGE_BLE_ADDRESS or config.DEVICE_NAME
    print(f"[rest-bridge] starting: BLE {target} -> HTTP 0.0.0.0:{BRIDGE_REST_PORT}", flush=True)
    threading.Thread(target=_pump, args=(SAMPLES, RECEIVER), daemon=True).start()
    try:
        uvicorn.run(app, host="0.0.0.0", port=BRIDGE_REST_PORT, log_level="info")
    finally:
        RECEIVER.stop()


if __name__ == "__main__":
    main()
