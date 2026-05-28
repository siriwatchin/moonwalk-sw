# arduino_uno_q — UNO Q IMU dashboard

The UNO Q side of the Smart Cane prototype: an **Arduino App Lab app** that receives the
`NanoIMU` BLE stream on the UNO Q's Linux side, stores it, and shows a live web dashboard.
The dashboard shows **one active source** — pick `none`, a mock gait (normal / changed pattern),
or a live BLE Nano. The browser polls the **incremental** `/api/samples?since_seq=` endpoint and
appends into a browser-side ring buffer (it does not reload the full window every poll).

Uses two App Lab bricks: **WebUI** (`web_ui`) for the dashboard and **TimeSeriesStore**
(`dbstorage_tsstore`) for persistence. **Mock mode needs no hardware.** Runs on the UNO Q /
in App Lab only (the bricks aren't importable on a plain laptop).

## Pipeline
```
NanoIMU --BLE--> source ─> parse ─┬─> SampleStore (ring buffer + seq) ─> browser polls /api/samples (LIVE)
   (or mock)                      └─> TimeSeriesStore (batched ~1 s, namespaced A.ax_ms2) — history only
```
**Hot path = live, cold path = history.** The live charts plot from the in-memory `SampleStore`
(lowest latency); the TimeSeriesStore is a separate **batched** sink for later analysis (the UI
never reads it back). See the batching caveat under *Notes*.

## Payload (must match the Nano firmware in ../arduino_nano_33/)
```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,pressure_pa
```
Raw 6-axis IMU + BME680 `pressure_pa` (Pa) — no norms or phase classification on the wire (any
feature extraction is a downstream concern). Stored as TimeSeriesStore metrics `ax_ms2`…`gz_dps`
plus `pressure_pa`.

## Layout
```
app.yaml                 bricks: web_ui + dbstorage_tsstore
python/
  config.py models.py parser.py    data model + CSV parsing (no SDK)
  store.py                         rolling ring buffer + seq + samples_since() + stats (rate/bad/lost)
  registry.py                      DeviceRegistry: per-key store map (holds the single active key)
  mock_source.py ble_receiver.py   sources (mock normal/changed gaits; direct BLE via bleak)
  bridge_source.py                 source: read CSV from the host TCP bridge (container)
  rest_source.py                   source: poll the host REST bridge over HTTP (container)
  ble_bridge.py                    HOST-side: Nano BLE -> TCP fan-out (run outside the container)
  source_manager.py                one active source; set_source swaps it live
  ts_store.py                      TimeSeriesStore brick (SDK)
  webui_server.py                  WebUI brick: REST routes (SDK)
  main.py                          dispatch on config.APP_MODE; wire registry + manager + WebUI
host_bridge/                       HOST-side REST BLE bridge (FastAPI :8787) + systemd unit
assets/  index.html app.js tailwind.css    dashboard (REST polling, canvas charts, offline Tailwind)
sketch/  placeholder MCU sketch (unused — BLE is Linux-side)
tools/tailwind/  dev-only: rebuild assets/tailwind.css (not synced)
```

## Run on the UNO Q
1. In the **Bricks** panel add **Web UI** + **Database – Time Series** (updates `app.yaml`).
2. Sync `python/` + `assets/` to the app dir (don't overwrite the board's `sketch/`):
   ```bash
   ./sync.sh arduino@<uno-q-ip> <APP_DIR>
   ```
3. Run in App Lab, open `http://<uno-q-ip>:7000/`.

### Runtime mode = `config.APP_MODE` (no CLI flags)
App Lab's Run button passes no arguments, so the mode is a hardcoded constant in
`python/config.py` — `python python/main.py` is all that runs. Edit and re-run to switch:

| `APP_MODE`  | What it does | Where it runs |
| ----------- | ------------ | ------------- |
| `dashboard` | WebUI + TimeSeriesStore dashboard; applies `STARTUP_SOURCE` (default) | container |
| `empty`     | dashboard with no active source (pick one from the UI) | container |
| `scan`      | list nearby BLE devices and exit; no bricks imported | **host** (SSH) |
| `debug`     | connect to the Nano and print parsed samples + Hz; no bricks | **host** (SSH) |

`scan`/`debug` need BlueZ, which the App Lab container does **not** have — run them on the UNO
Q host over SSH. The `scan`/`debug` knobs (`SCAN_TIMEOUT_S`, `DEBUG_ADDRESS`, `DEBUG_SECONDS`)
live in `config.py` too.

### Live BLE needs a host bridge
The App Lab Python container has **no BlueZ/D-Bus access**, so a live Nano can't be read from
inside it. Run a host-side bridge (where BlueZ works); pick one with `BLE_TRANSPORT` in
`config.py`:

| `BLE_TRANSPORT` | Host bridge to run | Container source | Wire |
| --- | --- | --- | --- |
| `"bridge"` (default) | `python python/ble_bridge.py` (`:8780`) | `bridge_source.BridgeNanoSource` | raw CSV over TCP, pushed |
| `"rest"` | `host_bridge/ble_bridge.py` (FastAPI `:8787`) | `rest_source.RestNanoSource` | HTTP JSON, polled |
| `"direct"` | none — off-container only (laptop + bleak) | `ble_receiver.BleNanoReceiver` | bleak/BlueZ in-process |

```bash
# transport = "bridge": raw-CSV TCP fan-out
python python/ble_bridge.py        # on the UNO Q HOST (SSH); Nano BLE -> TCP :8780
# transport = "rest": FastAPI REST + systemd service  (see host_bridge/README.md)
python host_bridge/ble_bridge.py   # on the UNO Q HOST; Nano BLE -> HTTP :8787
```
Both expose the **same Nano CSV**, so the ingest path is identical. Either way the container
reaches the host at `172.17.0.1` (the Docker bridge gateway) — `BRIDGE_HOST`/`BRIDGE_PORT` for
TCP, `REST_BRIDGE_URL` for REST. The REST bridge adds `/status` `/latest` `/samples` `/health`
for `curl` debugging and ships a `moonwalk-ble-bridge.service` systemd unit; full runbook in
[`host_bridge/README.md`](host_bridge/README.md).

### Headless / startup config
Boot applies `STARTUP_SOURCE` in `python/config.py` (default: `{"kind": "none"}` — boot empty
and pick a source from the UI). To show a real Nano on boot with **no UI**, run the host bridge
(above) and set the active source to BLE:
```python
# python/config.py  (with BLE_TRANSPORT="bridge")
STARTUP_SOURCE = {"kind": "ble"}   # reads the host bridge; "address" is only used in "direct" mode
```
Re-run `sync.sh` (or update via App Lab) and Run — it connects on boot, retrying every 2 s until
the bridge/Nano appears. `APP_MODE="empty"` also starts with no source. See [`BRINGUP.md`](BRINGUP.md) §1.

### Active source
The dashboard shows **one source** via a single dropdown in the header:
- Options: **— no source —**, **Mock: normal**, **Mock: changed pattern**, and one entry per
  scanned BLE device. Picking an entry swaps the live stream (the ring buffer restarts clean).
- **Scan BLE**: with `BLE_TRANSPORT="bridge"` (the UNO Q) the container has no BlueZ, so scan
  surfaces a single **NanoIMU (via host bridge)** entry — picking it reads `ble_bridge.py` on
  the host. (Off-container with `BLE_TRANSPORT="direct"`, scan does a real BlueZ discovery and
  lists nearby Nanos, `NanoIMU` first.)
- **Reset to demo source** sets a single mock `normal` gait. `APP_MODE="empty"` / default
  `STARTUP_SOURCE` start with no source.
- All Nanos advertise `NanoIMU`; they're told apart by **BLE address** (no firmware change).

### BLE bring-up
Step-by-step (bleak install, BlueZ, expected logs, troubleshooting) → **[`BRINGUP.md`](BRINGUP.md)**.
The receiver logs each hop `[ble] …`; the manager logs `[ingest:<key>] good=… bad=… rate=…Hz`.

## REST API (served under `/api/...`)
| Method | Path | Returns |
| ------ | ---- | ------- |
| GET  | `/samples` | `?since_seq=&limit=` → `{latest_seq, samples:[{seq,t,ax,ay,az,gx,gy,gz,pressure}], reset?}` — **incremental** realtime read from the in-memory buffer (the hot path; never InfluxDB). Missing `since_seq` → latest window; stale/ahead cursor → `reset:true` + latest window; junk params never error |
| GET  | `/status` | `{source:{kind,gait,address,label,status}, scan_devices, source_status:{count,bad,lost,dropped,rate_hz,live,buffered,buffer_max,latest_seq,samples_received,last_seen_at}, recording:{active,label,count,elapsed_s,has_recording}}` |
| GET  | `/latest` | `{latest:{…sample…}}` (active source) |
| GET  | `/export` | the active source's rolling buffer (~30 s) as a `text/csv` download (`Content-Disposition` filename) |
| GET  | `/record/download` | the last finished recording (start→stop session) as a `text/csv` download |
| POST | `/source/set` | `{kind:"none"\|"mock"\|"ble", gait?, address?, label?}` → set the active source |
| POST | `/record/start` | `{label}` → begin a session recording of the active source (one at a time) |
| POST | `/record/stop` | stop the active recording; the CSV is then at `GET /record/download` |
| POST | `/reset` | set the active source to the demo source (mock `normal`) |
| POST | `/ble/scan` | `{timeout?}` → `{devices:[{name,address}]}` (NanoIMU first) |
| POST | `/clear` | clear the active source's buffer |
| GET  | `/export/history` | `?from=&to=` (ISO8601) → CSV from the cold-path TimeSeriesStore over the range (via the brick's `read_samples`). 503 if no `tsstore` was constructed. |
| GET  | `/analysis/window` | `?from=&to=&device=A` (ISO8601) → JSON gait report for the window. Reads InfluxDB **directly** at `INFLUX_URL` (not via the brick) so it can do server-side `aggregateWindow(50ms)` and avoid N+1 per-metric reads. Returns 503 if Influx was unreachable at boot. |
| GET  | `/analysis/latest` | `?duration_s=&device=A` → convenience for "now − duration_s, now" (default 600 s). |
| GET  | `/analysis/health` | `{available, influx:{reachable,version,db\|bucket}, params:{…}}` — used by the Analysis tab to show a clear "offline" message instead of a generic 503. |

`expose_api` hands the handler straight to FastAPI's `add_api_route`, so the handler signature
IS the FastAPI signature: POST bodies must be declared with `Body()` (e.g. `data: dict =
Body(default=None)`) or the JSON body is dropped; query params (like `/samples?since_seq=`) are
plain typed defaults (taken as strings + parsed/clamped in `samples_since`, so junk can't 422).
Browser polls `/samples` (~250 ms, append-only) and `/status` (~1 s); a separate ~150 ms loop
renders. No Socket.IO.

### Data-quality signals (`source_status` in `/status`)
- **`rate_hz`** — effective rate (EWMA), ~20 Hz expected.
- **`bad`** — lines that failed to parse (truncation / MTU / noise).
- **`lost`** — *estimated* dropped samples from `timestamp_ms` gaps (sensor-side estimate).
- **`latest_seq` / `samples_received`** — the monotonic sequence counter + total accepted
  samples; the browser fetches only `seq > since_seq` and detects gaps/restarts from `seq`.
- **`last_seen_at`** — wall-clock epoch of the last accepted sample.

## Off-device sanity check (no SDK)
```bash
python -m py_compile python/*.py host_bridge/*.py
cd python && python -c "import config, models, parser, store, registry, source_manager, ts_store, webui_server, mock_source, rest_source, bridge_source, main, influx_client, analysis"
python -m unittest test_analysis -v       # cadence/duty/symmetry against synthetic IMU
```
Brick/BLE behaviour itself can only be exercised on the UNO Q. The host REST bridge
(`host_bridge/ble_bridge.py`) needs `fastapi`/`uvicorn`/`bleak` and runs on the host, not here.

## Analysis page (cold-path; reads InfluxDB directly)
The `Analysis` tab computes a gait report (cadence, stick-cycle time, duty factor, stride
length + velocity, rhythm/symmetry score) over a history window. It reads InfluxDB **directly**
via `python/influx_client.py` — a stdlib-only HTTP client — not through the TimeSeriesStore
brick, so it can do server-side aggregation (`mean per 50 ms` window) and avoid the brick's
per-metric N+1 reads. Configuration knobs live in `config.py`:

| Knob | Default | What it does |
| --- | --- | --- |
| `INFLUX_URL` | `http://172.17.0.1:8086` | Docker bridge gateway → the host's InfluxDB |
| `INFLUX_USER` / `INFLUX_PASSWORD` | `admin` / `Arduino15` | basic auth (1.x and 2.x v1-compat) |
| `INFLUX_DB` / `INFLUX_BUCKET` / `INFLUX_ORG` | `None` | pin after the on-board probe; `None` ⇒ auto-discover the first non-system DB/bucket |
| `ANALYSIS_DOWNSAMPLE_MS` | `50` | server-side `aggregateWindow` grid (matches Nano @ 20 Hz) |
| `ANALYSIS_DEFAULT_DURATION_S` | `600` | `Last 10 minutes` preset |
| `PLANT_GYRO_DPS` / `PLANT_REFRACTORY_MS` | `20` / `220` | plant-detection thresholds |
| `STICK_LEN_M` | `0.9` | cane length `L` for stride scaling |
| `P_TARE_PA` / `WSFC_TARGET_PCT` | `101325` / `60` | reserved for the Handle Load + WSFC metrics (Phase 2) |

Architecture rule: `ts_store.py` remains the only module that touches the **TimeSeriesStore
brick**; `influx_client.py` is the allowed direct-InfluxDB path. Both stay brick-free for
off-device imports.

## Notes
- Started with `App.run()` (`arduino.app_utils`); `WebUI()` built before it. `expose_api`
  uses **full `/api/…` paths** (brick doesn't auto-prefix).
- **Tailwind + daisyUI** vendored offline (`assets/tailwind.css`, prebuilt). daisyUI is a
  Tailwind *plugin* (pure CSS — no React/shadcn) that gives the dashboard `btn` / `select` /
  `drawer` / `badge` / `divider` components. Rebuild with `./tools/tailwind/build.sh`; first run
  does `npm install` in `tools/tailwind/` (needs internet once to fetch `tailwindcss` + `daisyui`).
  Runtime stays offline — only the compiled `assets/tailwind.css` is served. Two custom themes
  (`moonwalk-light` / `moonwalk-dark`) mirror the existing `--bg/--text/--chart-*` palette;
  the theme toggle sets both `data-theme` (daisyUI) and the `.dark` class (legacy CSS vars).
- TimeSeriesStore (cold path): the ingest loop only `enqueue()`s; a background thread flushes
  to the brick in **batches** every `TS_FLUSH_INTERVAL_S` (~1 s) or once `TS_BATCH_MAX` samples
  queue (`config.py`). 9 metrics per sample, namespaced `A.ax_ms2` (the active key). Read API
  (`read_last_sample`, `read_samples`) is for future analytics — the dashboard reads the
  in-memory buffer, never the DB. **Caveat:** batching stamps points at ~flush time, so a DB
  timestamp can lag the sample by up to one flush interval (fine for trend analysis). Retention
  is managed by the brick/DB.
- Live charts plot value-vs-**time** on a 10 s scrolling window (`WINDOW_MS` in `app.js`), x =
  the Nano `timestamp_ms`. The browser keeps a ring buffer trimmed to that window, appends only
  new samples (`/api/samples?since_seq=`), and a separate throttled loop redraws ~6–7 FPS only
  when new data arrived — so realtime stays smooth without reloading the full window each poll.

## Not implemented (by design)
Nano firmware (in `../arduino_nano_33/`), Supabase upload, Kalman filter, velocity/distance,
per-device calibration/tare. `SampleStore` / TimeSeriesStore are the seams for future work.
