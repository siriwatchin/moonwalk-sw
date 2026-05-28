# host_bridge — REST BLE bridge (runs on the UNO Q host)

The App Lab container has **no BlueZ/D-Bus access**, so it cannot read the Nano over BLE
directly (a direct bleak scan there fails with a D-Bus `FileNotFoundError`). This service runs
on the **UNO Q Debian host**, where bleak works, connects to the `NanoIMU`, and serves the
parsed samples over an HTTP REST API. The App Lab dashboard then *polls* this API instead of
touching BLE.

```
Nano --BLE--> host_bridge/ble_bridge.py (host, FastAPI :8787) --HTTP--> dashboard container
```

This is the REST counterpart to `python/ble_bridge.py` (which streams the same CSV over a raw
TCP socket). Pick one in `python/config.py`:

| `config.BLE_TRANSPORT` | Host bridge to run | Wire |
| --- | --- | --- |
| `"rest"` | `host_bridge/ble_bridge.py` (this) | HTTP JSON, polled (`:8787`) |
| `"bridge"` | `python/ble_bridge.py` | raw CSV over TCP, pushed (`:8780`) |
| `"direct"` | none (off-container only) | bleak/BlueZ in-process |

## REST API

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | `{"ok": true}` |
| GET | `/status` | `connected, device_name, device_address, samples_received, bad, last_seen_at, last_error, source_status` |
| GET | `/latest` | the latest parsed sample, or `{}` |
| GET | `/samples?limit=200&since=<seq>` | recent samples (newest `limit`); `since` returns only records with `seq > since` (the dashboard's incremental cursor) |

Each sample record:
```json
{
  "timestamp_ms": 12345, "ax_ms2": 0.1, "ay_ms2": 0.2, "az_ms2": 9.8,
  "gx_dps": 0.4, "gy_dps": 0.5, "gz_dps": 0.6, "acc_norm": 9.81, "gyro_norm": 0.9,
  "phase": 2, "phase_label": "GROUND_CONTACT_WITH_ROTATION",
  "received_at": 1748300000.12, "seq": 41, "csv": "IMU,12345,0.1,0.2,9.8,0.4,0.5,0.6,9.81,0.9,2"
}
```
`csv` is the Nano's verbatim line; the container yields it unchanged so `parser.parse_line` is
shared, with no float reserialization drift.

## Deploy + run (on the host)

The bridge reuses the App Lab app's `python/` modules (`config.py`, `ble_receiver.py`,
`parser.py`). Keep `python/` next to `host_bridge/` (the default lookup is `../python`), or set
`MOONWALK_PY_DIR` to the directory that holds `config.py`.

```bash
# on the UNO Q host
cd /home/arduino/moonwalk-ble-bridge       # this directory, however you deployed it
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python ble_bridge.py                        # foreground; Ctrl-C to stop
```

With a powered Nano nearby, in another shell:
```bash
curl 127.0.0.1:8787/health                  # {"ok": true}
curl 127.0.0.1:8787/status                  # connected=true, samples_received rising
curl 127.0.0.1:8787/latest                  # one parsed sample
curl "127.0.0.1:8787/samples?limit=10"
```

## Run as a service (systemd)

Edit the paths in `moonwalk-ble-bridge.service` (and `MOONWALK_PY_DIR` if `python/` is not at
`../python`), then:
```bash
sudo cp moonwalk-ble-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moonwalk-ble-bridge

# debug
systemctl status moonwalk-ble-bridge
journalctl -u moonwalk-ble-bridge -f
```

The unit starts after `bluetooth.service`, runs as user `arduino`, and `Restart=always` so the
bridge comes back after a crash; `BleNanoReceiver` reconnects to the Nano on its own when the
Nano power-cycles.

## Then, in the dashboard container

Set in `python/config.py`:
```python
BLE_TRANSPORT = "rest"
REST_BRIDGE_URL = "http://172.17.0.1:8787"   # Docker gateway = the host from the container
```
Bind a slot to `ble` (UI dropdown, or `STARTUP_SLOTS`) and run `python python/main.py`. The
container polls this bridge — no BLE, no D-Bus error.
