# gait_pipeline — Phase 2: mock Nano IMU pipeline

Builds the **receiver / processing pipeline** for the smart-cane gait prototype
*before* real BLE hardware exists. A `MockNanoSensor` emits payloads in the exact
format the Nano 33 BLE firmware sends, and the pipeline parses → classifies →
prints → logs (→ optionally plots) them.

Inspired by *"Walking Distance Estimation Using Walking Canes with Inertial
Sensors"*: start from IMU features + walking-phase classification, **not** raw
velocity/distance.

## Payload format (same as the Nano firmware)
```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
```
Phase codes: `0 UNKNOWN · 1 STATIONARY_OR_ZERO_VELOCITY · 2 GROUND_CONTACT_WITH_ROTATION · 3 SWING_OR_ON_AIR`

## Layout
```
src/
  config.py            constants (gravity, interval, thresholds, phase labels)
  models.py            ImuSample dataclass + SensorSource protocol (BLE swap point)
  phase_classifier.py  classify_phase() — same rules as the firmware
  parser.py            parse_line() -> ImuSample | None
  mock_nano_sensor.py  MockNanoSensor — cane-state cycle + noise
  csv_logger.py        CsvLogger — header + one row per sample
  plotter.py           LivePlotter — optional matplotlib live chart
  main.py              CLI
tests/                 pytest: parser + phase classifier
data/                  default CSV output dir
```

## Run
```bash
cd gait_pipeline
python -m src.main --mode mock --duration 30 --output data/mock_imu.csv
# optional live plot (needs matplotlib):
pip install -e ".[plot]"
python -m src.main --mode mock --duration 30 --output data/mock_imu.csv --plot
# reproducible data:
python -m src.main --mode mock --duration 10 --seed 42
```
Each 50 ms it prints the raw CSV line and a readable parsed line, and appends a row
(with `phase_label`) to the output CSV. The mock cycles:
`stationary → swing → ground_contact → swing → stationary` (1 s each).

## Test
```bash
cd gait_pipeline
python -m pytest -q          # or: pip install -e ".[dev]" first
```

## Future integration hook
`MockNanoSensor` implements the `SensorSource` protocol (`lines() -> Iterator[str]`).
Later, a real `BleNanoSensorClient` implementing the same `lines()` can be selected in
`main.build_source()` (`--mode ble`) — the parser, classifier, logger, and plot are
unchanged.

## Not implemented yet (by design)
Real BLE, Supabase upload, Kalman filter, production distance estimation.
