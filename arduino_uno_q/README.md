# arduino_uno_q — UNO Q IMU dashboard

The UNO Q side of the Smart Cane prototype: an **Arduino App Lab app** that receives the
`NanoIMU` BLE stream on the UNO Q's Linux side, stores it, and shows a live web dashboard.
The dashboard has **two fixed compare slots (A / B)** — set each slot's source independently
to compare two subjects side-by-side (e.g. normal vs injured, or two real Nanos).

Uses two App Lab bricks: **WebUI** (`web_ui`) for the dashboard and **TimeSeriesStore**
(`dbstorage_tsstore`) for persistence. **Mock mode needs no hardware.** Runs on the UNO Q /
in App Lab only (the bricks aren't importable on a plain laptop).

## Pipeline
```
NanoIMU --BLE--> source ─> parse ─┬─> SampleStore (per-slot buffer)  ─> dashboard polls /api/* (LIVE)
   (or mock)                      └─> TimeSeriesStore (batched ~1 s, namespaced <slot>.ax_ms2)
```
**Hot path = live, cold path = history.** The live charts plot from the in-memory `SampleStore`
(lowest latency); the TimeSeriesStore is a separate **batched** sink for later analysis (the UI
never reads it back). See the batching caveat under *Notes*.

## Payload (must match the Nano firmware in ../arduino_nano_33/)
```
IMU,timestamp_ms,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,acc_norm,gyro_norm,phase
```
Phases: `0 UNKNOWN · 1 STATIONARY_OR_ZERO_VELOCITY · 2 GROUND_CONTACT_WITH_ROTATION · 3 SWING_OR_ON_AIR`

## Layout
```
app.yaml                 bricks: web_ui + dbstorage_tsstore
python/
  config.py models.py parser.py    data model + CSV parsing (no SDK)
  store.py                         per-slot rolling buffer + stats (rate/bad/lost)
  registry.py                      DeviceRegistry: one store per slot (keyed "A"/"B")
  mock_source.py ble_receiver.py   sources (mock normal/injured gaits; direct BLE via bleak)
  bridge_source.py                 source: read CSV from the host TCP bridge (container)
  rest_source.py                   source: poll the host REST bridge over HTTP (container)
  ble_bridge.py                    HOST-side: Nano BLE -> TCP fan-out (run outside the container)
  source_manager.py                two fixed slots (A/B); set_slot swaps a slot's source live
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
| `dashboard` | WebUI + TimeSeriesStore dashboard; applies `STARTUP_SLOTS` (default) | container |
| `empty`     | dashboard with both slots unbound (add sources from the UI) | container |
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
Boot applies `STARTUP_SLOTS` in `python/config.py` (default: the mock normal+injured pair, so
behaviour is unchanged out of the box). To show a real Nano on boot with **no UI**, run the
host bridge (above) and bind a slot to BLE:
```python
# python/config.py  (with BLE_TRANSPORT="bridge")
STARTUP_SLOTS = {
    "A": {"kind": "ble"},     # reads the host bridge; "address" is only used in "direct" mode
    "B": {"kind": "none"},
}
```
Re-run `sync.sh` (or update via App Lab) and Run — the slot connects on boot, retrying every
2 s until the bridge/Nano appears. `APP_MODE="empty"` starts with no slots; the dashboard can
still override any slot live. See [`BRINGUP.md`](BRINGUP.md) §1.

### Compare slots (A / B)
The dashboard shows **two fixed panels**, slot A and slot B. Each panel has its own source
dropdown — set them independently and mix freely (e.g. slot A a mock baseline, slot B a real
Nano):
- Each dropdown offers **— no source —**, **Mock: normal**, **Mock: injured**, and one entry
  per scanned BLE device. Picking an entry swaps that slot's stream live.
- **Scan BLE**: with `BLE_TRANSPORT="bridge"` (the UNO Q) the container has no BlueZ, so scan
  surfaces a single **NanoIMU (via host bridge)** entry — picking it reads `ble_bridge.py` on
  the host. (Off-container with `BLE_TRANSPORT="direct"`, scan does a real BlueZ discovery and
  lists nearby Nanos, `NanoIMU` first.)
- **Reset to demo pair** sets A=normal, B=injured. Startup applies `STARTUP_SLOTS` in
  `config.py` (defaults to this pair; `APP_MODE="empty"` starts with both slots empty).
- All Nanos advertise `NanoIMU`; they're told apart by **BLE address** (no firmware change).

### BLE bring-up
Step-by-step (bleak install, BlueZ, expected logs, troubleshooting) → **[`BRINGUP.md`](BRINGUP.md)**.
The receiver logs each hop `[ble] …`; the manager logs `[ingest:<key>] good=… bad=… rate=…Hz`.

## REST API (served under `/api/...`)
| Method | Path | Returns |
| ------ | ---- | ------- |
| GET  | `/status` | `{slots:{A:{kind,gait,address,label,status}, B:{…}}, scan_devices, devices_status:{slot:{count,bad,lost,rate_hz,live}}}` |
| GET  | `/latest` | `{devices:{slot:{…sample…}}}` |
| GET  | `/series` | `{devices:{slot:{label, rel_ms, t, acc_norm, gyro_norm, phase}}}` (last ~200) |
| POST | `/slot/set` | `{slot:"A"\|"B", kind:"none"\|"mock"\|"ble", gait?, address?, label?}` → set a slot's source |
| POST | `/reset` | set both slots to the demo pair (A=normal, B=injured) |
| POST | `/ble/scan` | `{timeout?}` → `{devices:[{name,address}]}` (NanoIMU first) |
| POST | `/clear` | clear both slot buffers |

Reads are keyed by slot ("A"/"B", no query params). POST handlers take the JSON body dict
(`handler(data)`); GET handlers take `_req=None`. Browser polls `/series`+`/latest` (~300 ms)
and `/status` (~1 s) — no Socket.IO.

### Per-device data-quality signals
- **`rate_hz`** — effective rate (EWMA), ~20 Hz expected.
- **`bad`** — lines that failed to parse (truncation / MTU / noise).
- **`lost`** — *estimated* dropped samples from `timestamp_ms` gaps (no seq number → estimate).
- **`rel_ms`** — gateway 0-based clock shared across devices, so two Nanos (independent
  millis-since-boot) compare on one time axis. Visual alignment, not hard sync.

## Off-device sanity check (no SDK)
```bash
python -m py_compile python/*.py host_bridge/*.py
cd python && python -c "import config, models, parser, store, registry, source_manager, ts_store, webui_server, mock_source, rest_source, bridge_source, main"
```
Brick/BLE behaviour itself can only be exercised on the UNO Q. The host REST bridge
(`host_bridge/ble_bridge.py`) needs `fastapi`/`uvicorn`/`bleak` and runs on the host, not here.

## Notes
- Started with `App.run()` (`arduino.app_utils`); `WebUI()` built before it. `expose_api`
  uses **full `/api/…` paths** (brick doesn't auto-prefix).
- Tailwind is **vendored offline** (`assets/tailwind.css`, prebuilt). Rebuild after changing
  classes: `./tools/tailwind/build.sh` (needs internet once). No CDN, no React/shadcn.
- TimeSeriesStore (cold path): the ingest loop only `enqueue()`s; a background thread flushes
  to the brick in **batches** every `TS_FLUSH_INTERVAL_S` (~1 s) or once `TS_BATCH_MAX` samples
  queue (`config.py`). 9 metrics per sample, namespaced `<slot>.ax_ms2`. Read API
  (`read_last_sample`, `read_samples`) is for future analytics — the dashboard reads the
  in-memory buffer, never the DB. **Caveat:** batching stamps points at ~flush time, so a DB
  timestamp can lag the sample by up to one flush interval (fine for trend analysis). Retention
  is managed by the brick/DB.
- Live charts plot value-vs-**time** on a 10 s scrolling window (`CHART_WINDOW_MS`), x = the
  Nano `timestamp_ms`; a time jump > `GAP_MS` breaks the trace so dropouts show as real gaps.

## Not implemented (by design)
Nano firmware (in `../arduino_nano_33/`), Supabase upload, Kalman filter, velocity/distance,
per-device calibration/tare. `SampleStore` / TimeSeriesStore are the seams for future work.
