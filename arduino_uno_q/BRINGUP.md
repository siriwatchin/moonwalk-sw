# UNO Q — BLE bring-up runbook

Goal: get the UNO Q (Linux side) to receive the real `NanoIMU` BLE stream and show it on
the dashboard. The Nano sender is brought up separately — see `../arduino/BRINGUP.md`.

The link: **Nano = BLE peripheral** (advertises `NanoIMU`, notifies the IMU
characteristic every 50 ms) → **UNO Q = BLE central** (`python/ble_receiver.py` via
`bleak`: scan → connect → subscribe → parse → store → dashboard).

---

## 0. Prerequisites

1. **Nano is advertising** `NanoIMU` (flashed per `../arduino/BRINGUP.md`; Serial shows
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

## 1. Select BLE mode

Easiest: switch live from the dashboard **Source** card — click **BLE** (auto-finds
`NanoIMU`), or **Scan** → pick from the dropdown → **Connect**.

To start in BLE on boot instead, source is resolved as
**`--mode` arg → `MODE` env → `config.DEFAULT_MODE`**; set `DEFAULT_MODE = "ble"` in
`python/config.py` (or `MODE=ble`). You can still switch in the UI afterwards.

> Scan needs a free adapter — it's blocked while BLE-connected. Switch to **Mock** (or
> disconnect) before scanning.

## 2. Sync + run

```bash
cd arduino_uno_q
./sync.sh arduino@<uno-q-ip> <APP_DIR>     # pushes python/ + assets/
```
Then **Run** the app in App Lab (both bricks must be added: Web UI + Database – Time
Series). Open `http://<uno-q-ip>:7000/`.

## 3. What you should see

**Console (App Lab):** the `[ble]` hop log —
```
[ble] scanning
[ble] found NanoIMU (XX:XX:XX:XX:XX:XX)
[ble] connected
[ingest] good=… bad=0 rate=~20.0Hz status=connected
```
**Dashboard badge / meta:** `ble · connected` (green) and
`samples: N · ~20Hz · db:running`. Moving the Nano changes the values and the
acc_norm / gyro_norm / phase charts.

## 4. Acceptance checklist
- [ ] Console prints `[ble] found NanoIMU (…)` then `[ble] connected`.
- [ ] Badge shows `ble · connected`; `rate_hz` ≈ 20; `bad` stays ~0.
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
| Permission / DBus errors | Run under a user in the `bluetooth` group or via the App Lab service. |
