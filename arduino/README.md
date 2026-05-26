# Nano 33 BLE → UNO Q IMU BLE Prototype

A self-contained Bluetooth Low Energy prototype:

1. **Arduino Nano 33 BLE** (LSM9DS1 IMU) reads accel + gyro and **notifies** a compact
   CSV string over BLE every 50 ms.
2. An **Arduino UNO Q** acts as the BLE **central**, receives the data, and prints it.
3. The receiver is structured so it can later forward data to Supabase
   (**TODO hooks only — no upload implemented yet**).

> This prototype is intentionally separate from the `../hardware/` code, which uses a
> different sensor (LSM6DSOX Modulino) and a wired-UART/Bridge design.

## Shared BLE contract (identical in all three programs)

| Item               | Value                                       |
| ------------------ | ------------------------------------------- |
| Device name        | `NanoIMU`                                   |
| Service UUID       | `19B10000-E8F2-537E-4F6C-D104768A1214`      |
| Characteristic UUID| `19B10001-E8F2-537E-4F6C-D104768A1214`      |
| Properties         | notify + read                               |
| Send interval      | 50 ms (~20 Hz)                              |
| Gravity            | 9.80665 (g → m/s²)                          |

**Payload** (one CSV line; accel in m/s², gyro in deg/s):

```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps
IMU,123456,0.0123,-0.0456,9.8012,0.1200,-0.3100,0.0500
```

## Files

| Path                                            | Role                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `nano_imu_ble_sender/nano_imu_ble_sender.ino`   | **Sender** — Nano 33 BLE peripheral.                              |
| `uno_q_linux_ble_receiver/ble_receiver.py`      | **Primary receiver** — Python `bleak`, runs on UNO Q Linux side.  |
| `uno_q_ble_receiver/uno_q_ble_receiver.ino`     | **Best-effort receiver** — ArduinoBLE central on the UNO Q MCU.   |

### Why two receivers?

On the UNO Q, the BLE/Wi-Fi radio is attached to the **Qualcomm Linux (Debian)** side, not
the STM32 MCU. So the MCU-side `ArduinoBLE` central sketch most likely **cannot reach the
radio** (it may not even compile for this board). The **Python `bleak` receiver is the path
expected to work**; the `.ino` is included only to confirm that behaviour on real hardware.

## Setup & run

### Sender (Nano 33 BLE)
1. Arduino IDE → Boards Manager: install **Arduino Mbed OS Nano Boards**.
2. Library Manager: install **Arduino_LSM9DS1** and **ArduinoBLE**.
3. Select board **Arduino Nano 33 BLE**, open `nano_imu_ble_sender/nano_imu_ble_sender.ino`, upload.
4. Serial Monitor @ **115200** → expect `IMU init OK`, `BLE init OK`, `BLE advertising started`.

### Receiver — primary (UNO Q Linux)
```bash
pip install bleak
python3 uno_q_linux_ble_receiver/ble_receiver.py
```
Expect: `scanning...` → `found NanoIMU` → `connected` → `subscribed` → payload lines ~every 50 ms.

### Receiver — best-effort (UNO Q MCU)
Open `uno_q_ble_receiver/uno_q_ble_receiver.ino`, select the UNO Q board, upload, and watch
Serial @ 115200. If BLE init fails or it never finds `NanoIMU`, use the Python receiver above.

## Testing plan
1. Upload the sender; confirm the three init logs and that it prints payloads when a central connects.
2. Run the Python receiver; confirm the scan → connect → subscribe → payload sequence.
3. **Move the Nano** and confirm accel/gyro values change in the receiver output.
4. Confirm the receiver prints both the raw CSV line and parsed `timestamp=.. ax=.. ...` values.
5. (Optional) Try the `.ino` receiver on the UNO Q MCU to confirm whether MCU-side BLE central works.

## Future work
- **Supabase upload:** both receivers have a `TODO(Supabase)` hook where a parsed sample would be
  forwarded. No network/database code is implemented yet.
