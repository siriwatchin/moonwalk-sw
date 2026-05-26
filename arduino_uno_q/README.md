# arduino_uno_q — UNO Q IMU dashboard (Arduino App Lab WebUI Brick)

The UNO Q side of the Smart Cane prototype, built as an **Arduino App Lab app** using two
official bricks: the **TimeSeriesStore Brick** (`arduino.app_bricks.dbstorage_tsstore`)
for persistence and the **WebUI Brick** (`arduino.app_bricks.web_ui`) for the dashboard.
It receives the `NanoIMU` BLE stream on the UNO Q's Linux side, parses it, **writes every
sample to the time-series DB**, keeps a rolling in-memory buffer, and exposes a REST API
that the browser dashboard polls (no Socket.IO).

**Mock mode works with no Nano**, through the exact same pipeline as BLE mode. (Both
bricks are provided by App Lab, so the app runs on the UNO Q / in App Lab — not on a
plain laptop.)

## Pipeline
```
                              ┌─ TsStore.write(sample)        # 9 metrics -> TimeSeriesStore brick
source.lines() -> parse_line ─┤
   mock / ble                 └─ SampleStore.append(sample)   # in-memory rolling buffer

browser ── polls /api/status /api/latest /api/series every ~300ms ──► WebUI brick (REST)
```
Each sample is written to the TimeSeriesStore as 9 separate metrics
(`ax_ms2, ay_ms2, az_ms2, gx_dps, gy_dps, gz_dps, acc_norm, gyro_norm, phase`) via
`db.write_sample(metric, value)`. The dashboard **polls** the WebUI brick's REST API
(no Socket.IO) and reads from the in-memory buffer, so it works regardless of the TS read API.

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
  webui_server.py                        # WebUI brick: expose_api REST routes (SDK here)
  main.py                                # --mode mock|ble; wire pipeline; App.run()
sketch/                                  # placeholder MCU sketch — unused (BLE is Linux-side)
  sketch.ino  sketch.yaml
assets/
  index.html  app.js  tailwind.css       # vendored Tailwind (offline) + REST polling;
                                          # canvas charts: acc_norm, gyro_norm, phase
tools/tailwind/                          # dev-only: rebuild assets/tailwind.css (not synced)
  input.css  tailwind.config.js  build.sh
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

Updates: the browser **polls** `/api/series` + `/api/latest` (~300 ms) and `/api/status` (~1 s).
No Socket.IO — keeps the UI dependency-free and robust on the brick.

## Off-device check (no SDK on a laptop)
The dev extras (`tests/`, `pyproject.toml`) were dropped to match the App Lab layout, so
sanity-check with the standard library only:
```bash
cd arduino_uno_q
python -m py_compile python/*.py
cd python && python -c "import config, models, parser, store, ts_store, webui_server, mock_source, ble_receiver, main"
```
Both should succeed (brick/`bleak` imports are lazy). The brick/BLE behaviour itself can
only be exercised on the UNO Q.

## Notes (API confirmed from working App Lab dashboards)
- Started with **`App.run()`** (`arduino.app_utils`) — starts all bricks (WebUI +
  TimeSeriesStore). `WebUI()` is constructed before `App.run()` so the brick is registered.
- `expose_api(method, path, handler)` — register the **full path incl. `/api/`** (the brick
  does not auto-prefix); handler signature is `handler(_req=None) -> dict`.
- **No Socket.IO**: the dashboard polls the REST endpoints. This matches the proven
  community example (philippe86220/uno-q-sensors-webui) and avoids socket.io client
  serving/vendoring entirely.
- Static UI is served from `assets/` (entry `index.html`); the `assets/` folder must be
  added from outside the App Lab IDE (e.g. via `sync.sh`).
- Styling uses **vendored Tailwind** — `assets/tailwind.css` is a prebuilt, minified file
  (~8 KB, only the classes actually used) linked via `<link>`. **Fully offline, no CDN.**
  Rebuild it after changing classes in `index.html`/`app.js`:
  ```bash
  cd arduino_uno_q && ./tools/tailwind/build.sh   # runs Tailwind v3 CLI via npx (needs internet once)
  ```
  `tools/tailwind/` is dev-only and is **not** synced to the board (only `python/` + `assets/`).
- shadcn/ui was **not** used — it requires a React build pipeline, not a plain HTML page.
- Charts are plain `<canvas>` (acc_norm, gyro_norm line charts + a phase step chart),
  fed from `/api/series`. No charting library.

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

> The Nano 33 BLE sender firmware lives in the sibling `../arduino/` folder.
