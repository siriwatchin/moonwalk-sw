# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Moon Walk is an attachable sensor box that clips onto an ordinary walking stick or walker
("Host Aid"). The software here collects gait/IMU data, labels cane-posture samples, and is
the seed of later gait-trend analysis.

**Product framing is normative, not cosmetic.** Moon Walk is a *wellness self-monitoring*
product: it measures and trends gait for the user's awareness. It does **not** diagnose,
treat, predict disease, or predict fall risk. `CONTEXT.md` defines the product vocabulary and
`docs/adr/0005-*` makes it binding. When writing UI copy, docs, or anything user-facing:

- **Say:** wellness cue · self-monitoring · behaviour awareness · "your walking has changed".
- **Never say:** diagnosis · treatment · fall risk · "your condition is worsening" · any
  clinical/causal claim.
- Every dashboard or alert surface carries the disclaimer: *"a wellness awareness cue, not a
  medical assessment"*.

Read `CONTEXT.md` before touching product-facing text — terms like Host Aid, Stick Cycle,
Handle Load, Pendulum Model, Baseline, Drift, Alert, Speaking Stick have precise meanings.

## Two separate hardware tracks — do not conflate them

This repo contains **two independent sensor pipelines** with different sensors, transports,
and wire protocols. The shared word "IMU" makes them easy to mix up; they are not compatible.

| | `hardware/` track | `arduino_nano_33/` + `arduino_uno_q/` track |
| --- | --- | --- |
| Sensor | LSM6DSOX (Modulino Movement) | LSM9DS1 (Nano 33 BLE original gen) |
| Transport | wired UART / Arduino Bridge | Bluetooth LE (notify, ~20 Hz) |
| Protocol | JSON lines `MWALK_MOTION_RAW` / `MWALK_MOTION_SAMPLE` (`cane-posture.motion.v1`) | CSV line `IMU,ts,ax,ay,az,gx,gy,gz,acc_norm,gyro_norm,phase` |
| Consumer | `collection_interface/` (Streamlit) | `arduino_uno_q/` App Lab dashboard |
| Field units | accel in **g**, rates in **dps** | accel in **m/s²**, gyro in **dps** |

The long-term hardware design (`CONTEXT.md` / ADR-0004) is a two-board system: a Nano
**Sensor Node** streaming over UART to a UNO Q **Compute Brain** (Linux side runs gait
intelligence + a cloud-VLM "Speaking Stick" layer). The current code is early prototype work,
not that final architecture.

## arduino_uno_q — the active dashboard app

The most-developed component (current branch `feature/visual-graph-imu`). An **Arduino App
Lab app** that runs *on the UNO Q's Linux side* and consumes the `NanoIMU` BLE stream.

**Critical constraint:** it imports two App Lab "bricks" — `arduino.app_bricks.web_ui.WebUI`
and the TimeSeriesStore — which **only exist on the UNO Q / inside App Lab**. They are not
importable on a plain laptop, by design. Off-device you can only run mock mode, `scan` mode,
and the compile check below. Brick/BLE behaviour must be exercised on the board.

**Runtime mode is `config.APP_MODE`, not CLI flags** (`dashboard` / `empty` / `scan` /
`debug`) — App Lab's Run button passes no args. `python python/main.py` is the only entry.

**The App Lab container has no BlueZ/D-Bus access** (no Bluetooth brick exists). Live BLE is
read by a **host-side bridge** running on the UNO Q host (where BlueZ works), in one of two
interchangeable shapes selected by `config.BLE_TRANSPORT` — both carry the same Nano CSV:
- `"bridge"` (default): `python/ble_bridge.py` re-broadcasts the CSV over a raw **TCP** socket;
  the container's `ble` slot reads it via `bridge_source.BridgeNanoSource` at
  `config.BRIDGE_HOST:BRIDGE_PORT` (default `172.17.0.1:8780`).
- `"rest"`: `host_bridge/ble_bridge.py` (FastAPI, `:8787`) serves samples over an **HTTP REST**
  API (`/status` `/latest` `/samples` `/health`) + a systemd unit; the container's `ble` slot
  polls it via `rest_source.RestNanoSource` at `config.REST_BRIDGE_URL` (default
  `http://172.17.0.1:8787`). The bridge includes each sample's verbatim `csv`, so `parse_line`
  is shared and the ingest path is identical.

`scan`/`debug`/`"direct"` BLE only work on the host.

Architecture (`arduino_uno_q/python/`):

- **Two fixed compare slots, `A` and `B`.** The dashboard always shows exactly two panels;
  each slot binds independently to one source: `none`, a mock gait (`normal`/`altered`), or a
  live BLE Nano. Mix freely (e.g. mock baseline in A, real Nano in B).
- `parser.py` / `models.py` — pure CSV→`ImuSample` parsing, **no SDK imports** (testable
  off-device). `config.py` holds the BLE contract (must match the Nano firmware) and
  `STARTUP_SLOTS` for headless boot.
- `store.py` (`SampleStore`) — per-slot rolling buffer + data-quality stats (rate_hz, bad,
  lost). `registry.py` (`DeviceRegistry`) — one store per slot, keyed `"A"`/`"B"`.
- `source_manager.py` (`SourceManager`) — owns the live sources + ingest threads;
  `set_slot()` tears down and re-binds a slot's source at runtime. Source implementations:
  `mock_source.py`; `bridge_source.py` (TCP client to the host TCP bridge) and `rest_source.py`
  (HTTP poller of the host REST bridge) — the two in-container `ble` sources; and
  `ble_receiver.py` (direct bleak — used by both host bridges + off-container).
- `ts_store.py` — the **only** module touching the TimeSeriesStore brick;
  `webui_server.py` — the **only** module touching the WebUI brick (REST routes via
  `expose_api`, full `/api/...` paths — the brick does not auto-prefix). The browser **polls**
  `/api/series`+`/latest` (~300 ms) and `/api/status` (~1 s); there is **no Socket.IO**.
- `main.py` dispatches on `config.APP_MODE`: `dashboard`/`empty` build registry + manager +
  WebUI then `App.run()` blocks; `scan`/`debug` run the bleak debug helpers. Brick imports are
  deferred inside `run_dashboard()`, so `scan`/`debug` (and off-device `import main`) stay
  brick-free.
- `assets/` — static dashboard (vanilla JS REST polling, canvas charts). **Tailwind is
  vendored offline** in `assets/tailwind.css`; no CDN, no React/shadcn. Rebuild it with
  `tools/tailwind/build.sh` after changing classes (needs internet once).

The pipeline per sample: `source.lines() → parse_line → SampleStore.append → TimeSeriesStore.write`.

## Common commands

**arduino_uno_q (run on the UNO Q):**
```bash
cd arduino_uno_q
python python/main.py            # mode = config.APP_MODE (default "dashboard": apply STARTUP_SLOTS)
#   APP_MODE="empty" -> dashboard, no slots;  "scan"/"debug" -> host-side BLE bring-up (no bricks)
python python/ble_bridge.py      # HOST-side TCP bridge: Nano BLE -> TCP :8780 (BLE_TRANSPORT="bridge")
python host_bridge/ble_bridge.py # HOST-side REST bridge: Nano BLE -> HTTP :8787 (BLE_TRANSPORT="rest")
./sync.sh arduino@<uno-q-ip> <APP_DIR>   # rsync python/ + assets/ to the board (Mac-side only)
```
Off-device sanity check (no bricks, no hardware):
```bash
cd arduino_uno_q
python -m py_compile python/*.py host_bridge/*.py
cd python && python -c "import config, models, parser, store, registry, source_manager, ts_store, webui_server, mock_source, ble_receiver, bridge_source, rest_source, ble_bridge, main"
```
Dashboard URL on the board: `http://<uno-q-ip>:7000/`. REST API table and per-device
data-quality signals are documented in `arduino_uno_q/README.md`; BLE bring-up runbook in
`arduino_uno_q/BRINGUP.md`.

**arduino_nano_33 (Nano 33 BLE sender + PC-side BLE tools):**
```bash
cd arduino_nano_33
pip install -r requirements.txt    # bleak, websockets
python3 ble_smoketest.py           # connect, validate frames/rate/phases → SMOKETEST PASS/FAIL
python3 ble_bridge.py              # BLE in → WebSocket out (ws://0.0.0.0:8765), JSON frames
python3 ble_receiver.py            # print-only debug receiver
```
Flash `nano_imu_ble_sender.ino` via Arduino IDE (board "Arduino Nano 33 BLE"; libraries
`Arduino_LSM9DS1`, `ArduinoBLE`). First-time flashing runbook: `arduino_nano_33/BRINGUP.md`.

**hardware track (separate, uses `uv`):**
```bash
cd hardware
uv run python python/main.py                                  # Bridge receiver + posture classifier
uv run python -m unittest discover -s python/tests            # tests (single: -p test_<name>.py)

cd collection_interface
uv run streamlit run src/collection_interface/app.py          # data-collection UI
uv run python -m unittest discover -s tests
```

## BLE contract (shared by `arduino_nano_33/` and `arduino_uno_q/`)

These constants live in **both** the Nano firmware and `arduino_uno_q/python/config.py` and
must stay in sync; changing one without the other breaks the link:

- Device name `NanoIMU`; service `19B10000-E8F2-537E-4F6C-D104768A1214`; characteristic
  `19B10001-...-768A1214`; notify @ 50 ms; gravity `9.80665`.
- Walking phase codes: `0 UNKNOWN · 1 STATIONARY_OR_ZERO_VELOCITY · 2 GROUND_CONTACT_WITH_ROTATION · 3 SWING_OR_ON_AIR`.
- Phase detection works on accel/gyro **norms** (not double-integration); thresholds are
  `const` in the sketch. It deliberately does **not** compute velocity/distance or run a
  Kalman filter — it only proves a stable IMU+phase payload.

## Explicitly out of scope (don't add unprompted)

Supabase/cloud upload (only `TODO` hooks exist), Kalman filter, velocity/distance, per-device
calibration/tare. `SampleStore` and TimeSeriesStore are the intended seams for that future
work. Health data is privacy-first (on-device + user's phone, no cloud); only the see-and-speak
camera path is a scoped cloud exception (ADR-0003).
