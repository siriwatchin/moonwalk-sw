# uno_q — Smart Cane gateway + local dashboard

The **UNO Q** side of the prototype. It runs on the UNO Q's Qualcomm **Linux** side
(where the BLE radio is) and acts as the **gateway / edge visualizer**:

receive the `NanoIMU` BLE stream → parse → keep recent samples in a rolling buffer →
serve a **local web dashboard** (connection status, accel/gyro, acc_norm/gyro_norm,
phase label, real-time charts).

**Mock mode works with no hardware**, so the dashboard can be built and demoed first.
The input source is swappable (mock ↔ BLE) without touching the buffer, server, or page.

## Payload contract (matches the Nano firmware)
```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
```
Phases: `0 UNKNOWN · 1 STATIONARY_OR_ZERO_VELOCITY · 2 GROUND_CONTACT_WITH_ROTATION · 3 SWING_OR_ON_AIR`

## Layout
```
src/
  config.py        BLE UUIDs, device name, phase labels, buffer size, host/port
  models.py        ImuSample + SensorSource protocol (the mock↔BLE swap point)
  parser.py        parse_line() -> ImuSample | None
  mock_source.py   MockNanoSource — cane-state cycle + noise (no hardware)
  ble_source.py    BleNanoSource — bleak scan/connect/subscribe -> CSV lines
  buffer.py        SampleBuffer — thread-safe rolling buffer + snapshot()
  webserver.py     DashboardServer interface + FlaskDashboardServer
  static/dashboard.html   vanilla-JS dashboard (polls /api/state, canvas charts)
  main.py          CLI: source -> runner thread -> buffer -> Flask server
tests/             pytest: parser + buffer/mock
```

## Run

### Mock mode (no hardware — start here)
```bash
cd uno_q
pip install -e .                 # installs flask  (or: uv run --with flask ...)
python -m src.main --mode mock
# open http://localhost:8080
```
The badge shows `MOCK`, numbers + phase label update, and the charts move as the mock
cycles stationary → swing → ground-contact → swing → stationary.

### BLE mode (on the UNO Q, with a powered Nano)
```bash
cd uno_q
pip install -e ".[ble]"          # adds bleak
python -m src.main --mode ble
# open http://<uno-q-ip>:8080
```
Badge goes `scanning → connected`; live values stream in. Only one BLE central at a
time — close other scanners/receivers first.

### Test
```bash
cd uno_q
python -m pytest -q              # or: uv run --with pytest pytest -q
```

## UNO Q Linux setup notes
- Python 3.10+ on the Qualcomm/Debian side; `pip`/`uv` available.
- `bleak` uses BlueZ — ensure Bluetooth is up (`bluetoothctl power on`) and the user
  can access it (run under a user in the `bluetooth` group or via the system service).
- Bind is `0.0.0.0:8080`, so you can open the dashboard from a laptop on the same network.

## Future hooks (not implemented)
- **Brick Web Server**: `webserver.DashboardServer` is an interface — add a
  `BrickDashboardServer` with the same two jobs (serve the page, expose the snapshot)
  and select it in `main`. Nothing else changes.
- **Analytics / Supabase**: `SampleBuffer.snapshot()` is the read seam a future uploader
  or analytics step consumes. No cloud/DB code here yet.

## Not implemented (by design)
Nano firmware, Supabase upload, Kalman filter, velocity/distance estimation.
