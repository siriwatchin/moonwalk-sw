# uno_q_imu_webui — UNO Q IMU dashboard (Arduino App Lab WebUI Brick)

The UNO Q side of the Smart Cane prototype, built as an **Arduino App Lab app** using two
official bricks: the **TimeSeriesStore Brick** (`arduino.app_bricks.dbstorage_tsstore`)
for persistence and the **WebUI Brick** (`arduino.app_bricks.web_ui`) for the dashboard.
It receives the `NanoIMU` BLE stream on the UNO Q's Linux side, parses it, **writes every
sample to the time-series DB**, keeps a rolling in-memory buffer, exposes a REST API, and
pushes live samples to the browser via `send_message` (Socket.IO).

**Mock mode works with no Nano**, through the exact same pipeline as BLE mode. (Both
bricks are provided by App Lab, so the app runs on the UNO Q / in App Lab — not on a
plain laptop.)

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

## Layout (mirrors the App Lab app)
```
app.yaml                 # bricks: web_ui + dbstorage_tsstore
python/
  config.py  models.py  parser.py        # data model + parsing (no SDK imports)
  store.py                               # in-memory rolling buffer, status, series, CSV
  ts_store.py                            # TimeSeriesStore brick: write_sample per metric (SDK here)
  mock_source.py  ble_receiver.py        # the two SensorSource implementations
  webui_server.py                        # WebUI brick: expose_api + send_message (SDK here)
  main.py                                # --mode mock|ble; wire pipeline; web_ui.start()
sketch/                                  # placeholder MCU sketch — unused (BLE is Linux-side)
  sketch.ino  sketch.yaml
assets/
  index.html  app.js  styles.css         # Socket.IO + canvas-chart dashboard (no CDN)
```

## Run on the UNO Q (App Lab)
1. Copy `python/` + `assets/` into your App Lab app dir (the board already has its own
   `sketch/` + `app.yaml` — **don't overwrite the board's `sketch/`**; ours is a placeholder).
2. In the **Bricks** panel add both bricks: **Web UI** and **Database – Time Series**
   (installs them + updates `app.yaml`). App Lab then runs `python/main.py`.
   - Mock first: `--mode mock` (default, runs with no args).
   - BLE: `--mode ble` (needs `bleak`: `pip install bleak` on the device).
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

## Off-device check (no SDK on a laptop)
The dev extras (`tests/`, `pyproject.toml`) were dropped to match the App Lab layout, so
sanity-check with the standard library only:
```bash
cd uno_q_imu_webui
python -m py_compile python/*.py
cd python && python -c "import config, models, parser, store, ts_store, webui_server, mock_source, ble_receiver, main"
```
Both should succeed (brick/`bleak` imports are lazy). The brick/BLE behaviour itself can
only be exercised on the UNO Q.

## Notes (API confirmed from the brick examples)
- Server started with **`web_ui.start()`** (serves static assets + API, blocks).
- `expose_api("GET", "/path", handler)` (dict-returning) → served under **`/api/...`**.
  The dashboard tries `/api/<x>` then `/<x>`.
- Real-time push via `send_message` → browser Socket.IO loaded from
  `/socket.io/socket.io.js` (if your build doesn't serve it there, vendor
  `assets/libs/socket.io.min.js`; the page then polls `/latest`).

### TimeSeriesStore
- `app.yaml` declares both bricks (`arduino:web_ui`, `arduino:dbstorage_tsstore`).
- `TsStore` uses the confirmed API: `db.start()`, `db.write_sample(metric, value)` ×9 per
  sample, `db.stop()` on shutdown. Read API also confirmed: `read_last_sample(metric)` and
  `read_samples(metric, start_from=…, end_to=…)` (ISO8601) — wrapped as `read_last()` /
  `read_range()` for **future analytics**. The live dashboard still reads from the
  in-memory `SampleStore` (full samples incl. `phase_label`, lighter than per-metric reads).
- Sample timestamps use the store's default (server time); we don't pass the Nano's
  boot-relative `timestamp_ms` as the absolute DB timestamp.

## Not implemented (by design)
Nano firmware, Supabase upload, Kalman filter, velocity/distance estimation.
`SampleStore` / the TimeSeriesStore are the seams for future analytics / Supabase.

> An earlier plain-Python/Flask variant lives in `../uno_q/`; this app supersedes it
> with the official WebUI Brick as the single server (no fallback).
