# uno_q_imu_webui — UNO Q IMU dashboard (Arduino App Lab WebUI Brick)

The UNO Q side of the Smart Cane prototype, built as an **Arduino App Lab app** using two
official bricks: the **TimeSeriesStore Brick** (`arduino.app_bricks.dbstorage_tsstore`)
for persistence and the **WebUI Brick** (`arduino.app_bricks.web_ui`) for the dashboard.
It receives the `NanoIMU` BLE stream on the UNO Q's Linux side, parses it, **writes every
sample to the time-series DB**, keeps a rolling in-memory buffer, exposes a REST API, and
pushes live samples to the browser via `send_message` (Socket.IO).

**Mock mode works with no Nano**, through the exact same pipeline as BLE mode. (The
WebUI brick + `arduino.app_utils` are provided by App Lab, so the app runs on the
UNO Q / in App Lab — not on a plain laptop.)

## Pipeline
```
                              ┌─ TsStore.write(sample)        # 9 metrics -> TimeSeriesStore brick
source.lines() -> parse_line ─┼─ SampleStore.append(sample)   # in-memory rolling buffer (dashboard reads)
   mock / ble                 └─ WebUI.send_message("imu_sample")   # real-time push
                                 REST: /status /latest /series /clear /export_csv
```
Each sample is written to the TimeSeriesStore as 9 separate metrics
(`ax_ms2, ay_ms2, az_ms2, gx_dps, gy_dps, gz_dps, acc_norm, gyro_norm, phase`) via
`db.write_sample(metric, value)`. The dashboard reads from the in-memory buffer (see
the assumption note below), so it works regardless of the TS read API.

## Payload contract (matches the Nano firmware)
```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
```
Phases: `0 UNKNOWN · 1 STATIONARY_OR_ZERO_VELOCITY · 2 GROUND_CONTACT_WITH_ROTATION · 3 SWING_OR_ON_AIR`

## Layout
```
app.yaml                 # bricks: [arduino:web_ui: {}]
python/
  config.py  models.py  parser.py        # data model + parsing (no SDK imports)
  store.py                               # in-memory rolling buffer, status, series, CSV
  ts_store.py                            # TimeSeriesStore brick: write_sample per metric (SDK here)
  mock_source.py  ble_receiver.py        # the two SensorSource implementations
  webui_server.py                        # WebUI brick: expose_api + send_message (SDK here)
  main.py                                # --mode mock|ble; wire pipeline; App.run()
assets/
  index.html  app.js  styles.css         # Socket.IO + canvas-chart dashboard (no CDN)
tests/                                   # pytest: parser + store (pure)
```

## Run on the UNO Q (App Lab)
1. Copy this folder into your App Lab apps directory (or open it in App Lab).
2. App Lab installs the `arduino:web_ui` brick and runs `python/main.py`.
   - Mock first: run args `--mode mock` (default).
   - BLE: `--mode ble` (needs `bleak`: `pip install -e ".[ble]"` on the device).
3. Open **`http://<uno-q-ip>:7000/`**. Badge shows `mock` / `connected`; numbers,
   phase label, and charts update live.

### REST API (exposed via `expose_api`, served under `/api/...`)
| Method | Path           | Returns |
| ------ | -------------- | ------- |
| GET    | `/status`      | `{mode, source_status, live, count, buffer_max, uptime_s, …}` |
| GET    | `/latest`      | `{latest: {…sample…}}` |
| GET    | `/series`      | `{t:[…], acc_norm:[…], gyro_norm:[…], phase:[…]}` (last ~200, for charts) |
| POST   | `/clear`       | `{cleared: true, removed: N}` (clears the in-memory dashboard buffer) |
| GET    | `/export_csv`  | `{filename, csv}` |

Real-time: `web_ui.send_message("imu_sample", sample_dict)` → browser `socket.on("imu_sample", …)`.

## Test (off-device — pure modules only)
```bash
cd uno_q_imu_webui
python -m pytest -q                   # or: uv run --with pytest pytest -q
```
This covers `parser` + `store` (no SDK). The brick/BLE paths can only be exercised on
the UNO Q.

## Notes / assumptions (verify on hardware)
- Entry point is `arduino.app_utils.App.run()` (per the official Web UI example), which
  starts the brick — used instead of a literal `web_ui.start()`.
- `expose_api("GET", "/path", handler)` with dict-returning handlers; the brick serves
  them under `/api/...`. The dashboard tries `/api/<x>` then `/<x>` for robustness.
- Socket.IO client is loaded from `/socket.io/socket.io.js`. If your brick build doesn't
  serve it there, vendor it to `assets/libs/socket.io.min.js` and update `index.html`
  (the page then polls `/latest` instead).

### TimeSeriesStore notes
- `app.yaml` declares both bricks: `arduino:web_ui` and `arduino:dbstorage_tsstore`.
- `ts_store.TsStore` calls `db.start()` then `db.write_sample(metric, value)` for the 9
  metrics on every sample. The exact TS **read** API (`read_last_sample` vs
  `read_samples(start_from=…)`) is unconfirmed, so the dashboard reads from the in-memory
  `SampleStore` instead; `TsStore.read_last()` is a best-effort alt path only. Adjust the
  brick id / read method on hardware if your App Lab version differs.

## Not implemented (by design)
Nano firmware, Supabase upload, Kalman filter, velocity/distance estimation.
`SampleStore` / the TimeSeriesStore are the seams for future analytics / Supabase.

> An earlier plain-Python/Flask variant lives in `../uno_q/`; this app supersedes it
> with the official WebUI Brick as the single server (no fallback).
