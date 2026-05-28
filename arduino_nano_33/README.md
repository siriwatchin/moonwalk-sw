# Nano 33 BLE → UNO Q IMU BLE Prototype

A self-contained Bluetooth Low Energy prototype:

1. **Arduino Nano 33 BLE** (LSM9DS1 IMU + BME680 pressure) reads accel+gyro and
   barometric pressure, and **notifies** one compact raw CSV line over BLE every
   50 ms (no on-Nano feature extraction).
2. The **Arduino UNO Q** receives the data on its **Linux side** and acts as a
   gateway: `ble_bridge.py` re-broadcasts each sample as JSON over a **WebSocket
   server**, so dashboards / other clients can consume the live stream.
   (`ble_receiver.py` is a simpler print-only debug receiver.)
3. The bridge is structured so it can later forward data to Supabase
   (**TODO hooks only — no upload implemented yet**).

> Separate from the `../hardware/` code, which uses a different sensor (LSM6DSOX
> Modulino) and a wired-UART/Bridge design.

## Files (all at this root)

| File                       | Role                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `nano_imu_ble_sender.ino`  | Nano 33 BLE peripheral: IMU + BME680 pressure + BLE notify.       |
| `ble_bridge.py`            | **UNO Q gateway**: BLE in → WebSocket server out (JSON). Primary. |
| `ble_receiver.py`          | UNO Q simple debug receiver: prints raw + parsed payloads.        |
| `imu_payload.py`           | Shared BLE UUIDs + CSV→JSON parser used by the Python scripts.     |
| `ble_smoketest.py`         | Bring-up PASS/FAIL test: connect, validate frames, rate, timestamps. |
| `requirements.txt`         | Python deps (`bleak`, `websockets`).                              |

> 🔧 **Flashing the Nano for the first time?** Follow [`BRINGUP.md`](BRINGUP.md) —
> a step-by-step flash + Serial + BLE-scanner + smoke-test runbook with an
> acceptance checklist and troubleshooting.

> The UNO Q's BLE radio is on its **Qualcomm Linux** side, not the STM32 MCU, so
> the receiver/bridge are Python scripts (not an `ArduinoBLE` central sketch).

## Shared BLE contract (identical in both files)

| Item                | Value                                       |
| ------------------- | ------------------------------------------- |
| Device name         | `NanoIMU`                                   |
| Service UUID        | `19B10000-E8F2-537E-4F6C-D104768A1214`      |
| Characteristic UUID | `19B10001-E8F2-537E-4F6C-D104768A1214`      |
| Properties          | notify + read                               |
| Send interval       | 50 ms (~20 Hz)                              |
| Gravity             | 9.80665 (g → m/s²)                          |
| Pressure sensor     | BME680 over hardware `Wire` bus: **A4=SDA, A5=SCL** |

**Payload** (one CSV line, 9 fields; accel in m/s², gyro in deg/s, pressure in Pa):

```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,pressure_pa
IMU,123456,0.0123,-0.0456,9.8012,0.1200,-0.3100,0.0500,101325.0
```

> **Raw 6-axis IMU + pressure only.** The Nano does **no** feature extraction — no norms, no
> walking-phase classification, no velocity/distance, no Kalman filter. (An earlier prototype
> emitted `acc_norm`/`gyro_norm`/`phase`; that was removed — any feature extraction is now a
> downstream UNO Q concern.) The wire field list is generated from `protocol/ble_contract.json`.

### BME680 pressure
A BME680 is wired on the standard hardware **`Wire`** bus (A4=SDA, A5=SCL); the onboard LSM9DS1
lives on the internal `Wire1`, so `Wire` is free. The sketch reads it ~1 Hz (non-blocking
`beginReading`/`endReading`), caches the value, and repeats it on every 50 ms line; the gas
heater is disabled (pressure only). The sensor is optional: if it doesn't init, the Nano still
streams IMU with `pressure=0`. Needs Arduino libraries **`Adafruit_BME680`** + **`Adafruit_Sensor`**
(Adafruit Unified Sensor). Setup runs an I2C scan and `updatePressure()` emits rate-limited
`[bme] …` Serial logs to make bring-up easy to diagnose.

## Setup & run

### Sender (Nano 33 BLE)
1. Arduino IDE → install **Arduino Mbed OS Nano Boards**.
2. Library Manager: install **Arduino_LSM9DS1**, **ArduinoBLE**, **Adafruit BME680
   Library**, and **Adafruit Unified Sensor**.
3. Wire the BME680 over I2C to **A4 (SDA)** and **A5 (SCL)** + 3V3/GND (most breakouts have
   pull-ups on board).
4. Select board **Arduino Nano 33 BLE**, open `nano_imu_ble_sender.ino`, upload.
   - The IDE may offer to move the file into a matching sketch folder — accept it,
     or open it directly; the code is unchanged either way.
5. Serial Monitor @ **115200**. Expect:
   `IMU init OK` → `BME680 init OK (pressure)` → `BLE init OK` → `BLE advertising
   started`, then a CSV header and payload lines ~every 50 ms (last column = pressure in Pa).

#### Test BLE advertising with a phone scanner app
Use **nRF Connect** (iOS/Android) or **LightBlue**:
- Scan → a device named **NanoIMU** appears → Connect.
- Open the custom service `19B10000-…-768A1214` → characteristic `19B10001-…-768A1214`.
- Tap **Notify** (subscribe); the value updates ~every 50 ms. The app shows it as
  bytes/hex — decode as UTF-8 to read the CSV line.

### UNO Q gateway — `ble_bridge.py` (primary)
```bash
pip install -r requirements.txt
python3 ble_bridge.py
```
Expect: `WebSocket bridge on ws://0.0.0.0:8765` → `scanning...` → `found NanoIMU`
→ `connected` → `subscribed`. Then connect any WebSocket client to
`ws://<uno-q-ip>:8765` to receive ~20 Hz JSON frames.

**WebSocket output schema** (one JSON object per frame):
```json
{
  "device": "NanoIMU",
  "timestamp_ms": 123456,
  "recv_time": 1716700000.123,
  "accel":     {"x": 0.0123, "y": -0.0456, "z": 9.8012},
  "gyro":      {"x": 0.12, "y": -0.31, "z": 0.05},
  "acc_norm":  9.8014,
  "gyro_norm": 0.337,
  "phase":     1,
  "phase_label": "STATIONARY_OR_ZERO_VELOCITY"
}
```
`timestamp_ms` is the Nano's millis-since-boot; `recv_time` is the bridge's epoch
seconds when it received the sample; `phase_label` is the human name for `phase`.

### UNO Q debug receiver — `ble_receiver.py` (optional)
```bash
python3 ble_receiver.py
```
Prints raw CSV + a readable parsed line per sample. Use it to confirm BLE works
without the WebSocket server.

## Test checklist
1. Serial Monitor shows the CSV header then `IMU,...,phase` payload lines ~every 50 ms.
2. A BLE scanner app sees device **NanoIMU** advertising.
3. A central (scanner app, or `ble_bridge.py` / `ble_receiver.py`) can connect.
4. The characteristic notifies / updates ~every 50 ms.
5. **Moving the Nano** changes `acc_norm` / `gyro_norm` and the `phase` code
   (still ≈ 1 when laid flat, → 2/3 when rotated or swung).

### UNO Q side (next phase — already wired to the new payload)
- Run `ble_bridge.py`; confirm `WebSocket bridge ...` → scan → connect → subscribe;
  a WS client on `ws://<uno-q-ip>:8765` receives the JSON frames above.
- Or run `ble_receiver.py` to just print raw + parsed lines.

## Future work
- **Supabase upload:** `ble_bridge.py` has a `TODO(Supabase)` hook (in the BLE
  notify handler) where each parsed sample would be forwarded. No network/database
  code is implemented yet.
