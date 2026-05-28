# UNO Q — BLE bring-up runbook

Goal: get the UNO Q (Linux side) to receive the real `NanoIMU` BLE stream and show it on
the dashboard. The Nano sender is brought up separately — see `../arduino_nano_33/BRINGUP.md`.

The link: **Nano = BLE peripheral** (advertises `NanoIMU`, notifies the IMU
characteristic every 50 ms) → **UNO Q = BLE central** (`python/ble_receiver.py` via
`bleak`: scan → connect → subscribe → parse → store → dashboard).

---

## 0. Prerequisites

1. **Nano is advertising** `NanoIMU` (flashed per `../arduino_nano_33/BRINGUP.md`; Serial shows
   `BLE advertising started`). Only **one** BLE central may connect at a time — close any
   phone scanner (nRF Connect/LightBlue) before connecting from the UNO Q.
2. On the UNO Q Linux side:
   ```bash
   pip install bleak                 # mock mode doesn't need it; BLE does
   bluetoothctl show                 # expect a controller with "Powered: yes"
   # if not powered:  bluetoothctl power on
   ```
3. The process must be able to use BlueZ (run as a user in the `bluetooth` group, or via
   the App Lab service which has access).

## 1. Choose the BLE source

> **Why a bridge?** The App Lab Python container has **no BlueZ/D-Bus access** (there is no
> Bluetooth brick), so the dashboard can't read the Nano directly. A live Nano reaches the
> dashboard through a bridge running on the **host** (where BlueZ works). Two interchangeable
> shapes, chosen by `BLE_TRANSPORT` in `config.py` — both carry the same Nano CSV:
> - `"bridge"` (default) → `python/ble_bridge.py` re-broadcasts CSV over a raw **TCP** socket
>   (`:8780`); the container reads it at `172.17.0.1:8780`.
> - `"rest"` → `host_bridge/ble_bridge.py` serves samples over an HTTP **REST** API (`:8787`);
>   the container polls `REST_BRIDGE_URL` (default `http://172.17.0.1:8787`). Adds
>   `curl`-able `/status` `/latest` `/samples` `/health` and a systemd unit.

**Start the host bridge (over SSH on the UNO Q, outside App Lab):**
```bash
python python/main.py            # with APP_MODE="scan" in config.py: list devices, then exit
# BLE_TRANSPORT="bridge":
python python/ble_bridge.py      # Nano BLE -> TCP :8780; leave running while the dashboard is up
# BLE_TRANSPORT="rest" (FastAPI; venv + systemd in host_bridge/README.md):
python host_bridge/ble_bridge.py # Nano BLE -> HTTP :8787
curl 127.0.0.1:8787/status       # connected=true, samples_received rising
```
For the REST bridge as a managed background service (survives reboot/crash), install the
`moonwalk-ble-bridge.service` unit — full runbook in
[`host_bridge/README.md`](host_bridge/README.md).

**From the dashboard (live):** click **Scan BLE** — with the bridge transport it shows one
**NanoIMU (via host bridge)** entry; pick it in slot **A** or **B** to read the bridge. Slots
are independent (each can be a mock gait or the live Nano).

**Headless on boot (no UI):** edit `STARTUP_SLOTS` in `python/config.py` so a slot binds to
BLE (it reads the host bridge; `address` is only used in `BLE_TRANSPORT="direct"` mode):
```python
STARTUP_SLOTS = {
    "A": {"kind": "ble"},     # reads the host bridge at BRIDGE_HOST:BRIDGE_PORT
    "B": {"kind": "none"},
}
```
On boot the slot auto-connects to the bridge (retrying every 2 s until it appears) with no UI;
the dashboard can still override a slot afterwards. Changes to `config.py` take effect after
the file is deployed to the board (§2) and the app is re-run.

> Mode is set by `config.APP_MODE` (`dashboard` / `empty` / `scan` / `debug`), not CLI flags.
> `scan`/`debug` need BlueZ — run them on the host over SSH, not in the container. The Nano's
> adapter allows only one central: stop the bridge before a host `scan`, and don't run a phone
> scanner at the same time.

## 2. Sync + run

```bash
cd arduino_uno_q
./sync.sh arduino@<uno-q-ip> <APP_DIR>     # pushes python/ + assets/
```
Then **Run** the app in App Lab (both bricks must be added: Web UI + Database – Time
Series). Open `http://<uno-q-ip>:7000/`.

## 3. What you should see

**Host bridge console (SSH, `ble_bridge.py`):** the `[ble]` hop log + client connections —
```
[bridge] starting: BLE NanoIMU -> TCP 0.0.0.0:8780
[ble] scanning
[ble] found NanoIMU (XX:XX:XX:XX:XX:XX)
[ble] connected
[bridge] client connected ('172.17.0.X', …) (clients=1)
```
**Dashboard console (App Lab container):** the `[bridge]` client hop + the per-slot ingest —
```
[bridge] connecting 172.17.0.1:8780
[bridge] connected
[ingest:A] good=… bad=0 rate=20.0Hz status=connected
```
**Dashboard:** the header badge turns green (`1 source(s)`) and the slot panel shows
`connected · ~20Hz · bad:0 · lost:0`. Moving the Nano changes the values and the
acc_norm / gyro_norm / phase charts.

## 4. Acceptance checklist
- [ ] Console prints `[ble] found NanoIMU (…)` then `[ble] connected`, then `[ingest:A] …`.
- [ ] Header badge is green; the slot panel shows `connected · ~20Hz`; `bad` stays ~0.
- [ ] Charts + numbers update when the Nano moves (phase 1 still / 2 rotate / 3 swing).
- [ ] `curl http://<uno-q-ip>:7000/api/status` shows `"source_status":"connected"`.

## 5. Pre-check the Nano stream from a PC (optional)
Before involving the UNO Q, prove the Nano sends a valid stream from any Mac/PC with BLE
(close phone scanners first):
```bash
cd ../arduino && pip install -r requirements.txt && python3 ble_smoketest.py
```
→ connects, validates frames, prints a phase histogram + `SMOKETEST PASS`.

## 6. Troubleshooting

| Symptom (badge / log) | Cause / fix |
| --------------------- | ----------- |
| `error: No module named 'bleak'` | `pip install bleak` on the UNO Q. |
| `ble · NanoIMU not found` | Nano not advertising / too far / another central is connected. Re-check the Nano's Serial, close phone scanners, move closer. |
| `bluetoothctl show` → no controller / Powered: no | Bring Bluetooth up: `bluetoothctl power on`; check the radio is enabled on the Qualcomm side. |
| Connects but `rate≈0`, no data | Nano only notifies while a central is connected — confirm the Nano's Serial prints `central connected`. Check the characteristic UUID matches `config.CHAR_UUID`. |
| `bad` count climbing | Lines truncated/garbled — likely **MTU** (payload ~68 B > default 20 B). BlueZ usually negotiates a larger MTU automatically; if not, shorten the payload or split it on the firmware side. |
| Frequent `disconnected / reconnecting` | Range/interference; the receiver auto-reconnects every 2 s. |
| `[bridge] disconnected / reconnecting` in the dashboard console | The host TCP bridge isn't running or isn't reachable. Start `python python/ble_bridge.py` on the host; check `BRIDGE_HOST`/`BRIDGE_PORT` in `config.py` (default `172.17.0.1:8780`). |
| `[rest] disconnected / reconnecting (no bridge)` in the dashboard console | The host REST bridge isn't up/reachable (`BLE_TRANSPORT="rest"`). Start `host_bridge/ble_bridge.py` (or its systemd service) and verify `curl 172.17.0.1:8787/health`; check `REST_BRIDGE_URL` in `config.py`. |
| `FileNotFoundError` / DBus errors from `bleak` **inside App Lab** | Expected — the container has no BlueZ/D-Bus. Don't run `scan`/`debug`/`direct` BLE in the container; use the host bridge (§1) and keep `BLE_TRANSPORT="bridge"`. |
| DBus / permission errors on the **host** | Run under a user in the `bluetooth` group (or root) on the UNO Q host. |
