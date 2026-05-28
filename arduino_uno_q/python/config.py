"""Configuration for the UNO Q IMU WebUI app.

The BLE contract (device name + UUIDs + payload) must match the Nano firmware
(arduino_nano_33/nano_imu_ble_sender.ino).

Runtime mode is chosen here (APP_MODE), not via CLI flags: in App Lab the app is launched by
the Run button, which passes no arguments. Edit APP_MODE / STARTUP_SOURCE / BLE_TRANSPORT and
re-run; `python python/main.py` is all that's needed.
"""

# ---- Runtime mode (hardcoded; replaces CLI flags) ----------------------
# "dashboard" = start the WebUI dashboard and apply STARTUP_SOURCE  (runs in the App Lab container)
# "empty"     = start the dashboard with no active source           (runs in the container)
# "scan"      = list nearby BLE devices and exit; no bricks imported (run on the HOST over SSH)
# "debug"     = connect to the Nano and print parsed samples; no bricks (run on the HOST over SSH)
APP_MODE = "dashboard"

# scan / debug knobs (replace the former --address / --seconds / --scan-timeout flags).
# Only used by the host-side "scan" and "debug" modes.
SCAN_TIMEOUT_S = 8.0
DEBUG_ADDRESS = None      # None -> resolve NanoIMU by name; else a MAC string
DEBUG_SECONDS = None      # None -> run until Ctrl-C; else stop after N seconds

# ---- BLE transport for dashboard "ble" slots ---------------------------
# The App Lab container has NO BlueZ/D-Bus access (no Bluetooth brick exists), so a live Nano
# reaches the dashboard through a host-side bridge (run on the UNO Q host) in one of two shapes:
#   "bridge" -> the container connects to python/ble_bridge.py over a raw TCP socket (push/stream)
#   "rest"   -> the container polls host_bridge/ble_bridge.py over HTTP (FastAPI REST, JSON)
#   "direct" -> use bleak/BlueZ directly (only works off-container, e.g. running on a laptop)
# Both host bridges expose the SAME Nano CSV, so parser.parse_line and the ingest path are
# identical regardless of transport. Pick one and run the matching host-side bridge.
BLE_TRANSPORT = "bridge"
BRIDGE_HOST = "172.17.0.1"   # Docker bridge gateway = the host as seen from inside the container
BRIDGE_PORT = 8780
BRIDGE_BLE_ADDRESS = None     # the bridge's BLE target: None -> first NanoIMU by advertised name

# "rest" transport: the host REST bridge's base URL (default = Docker gateway, port 8787).
REST_BRIDGE_URL = "http://172.17.0.1:8787"
REST_POLL_INTERVAL_S = 0.3    # container poll cadence (spec's 250-500 ms band)

# ---- BLE contract (single source of truth) -----------------------------
# Generated from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT edit those
# values here. Re-export so downstream modules keep importing them from `config`.
# `INTERVAL_MS` is the local alias for the contract's SEND_INTERVAL_MS.
from ble_contract import (  # noqa: E402,F401
    CHAR_UUID,
    DEVICE_NAME,
    FIELD_COUNT,
    GRAVITY,
    PAYLOAD_TAG,
    SERVICE_UUID,
)
from ble_contract import SEND_INTERVAL_MS as INTERVAL_MS  # noqa: E402,F401

# Data-stall watchdog: force a BLE reconnect if no notification arrives for this long even
# though the link still looks connected (silent stall). At 50 ms notify (20 Hz), 3 s ≈ 60
# missed samples — unambiguously dead, not just jitter. (Local behaviour, not the wire contract.)
BLE_STALL_TIMEOUT_S = 3.0

# ---- Store / UI ---------------------------------------------------------
BUFFER_MAXLEN = 2400    # ~2 min of history at 20 Hz — sized so a backgrounded browser tab
                        # (where setInterval gets throttled to ~1 Hz) can recover on return
                        # without falling outside the buffer and triggering an /api/samples reset.
RECENT_POINTS = 200     # default samples per /api/samples response (~10 s @ 20 Hz)
SAMPLES_LIMIT_MAX = 1000  # server-side hard cap on /api/samples ?limit (guards huge responses)
CHART_WINDOW_MS = 10000 # live chart x-axis span: a 10 s scrolling time window
UI_PORT = 7000          # Arduino App Lab WebUI default port (informational)

# ---- Record feature -----------------------------------------------------
# A start→stop session recording accumulates in memory; this caps it so a forgotten recording
# can't grow unbounded. 72000 ≈ 60 min at 20 Hz (~5 MB CSV). Hitting it auto-stops the recording.
RECORD_MAX_SAMPLES = 72000

# ---- TimeSeriesStore batching (cold path; analysis/history, not the live view) ----
# DB writes are decoupled from ingest: the ingest loop only enqueues, a background thread
# flushes in batches. This keeps the hot path cheap and avoids per-sample DB pressure.
TS_FLUSH_INTERVAL_S = 1.0   # flush cadence (also bounds DB-timestamp skew to ~this)
TS_BATCH_MAX = 256          # flush early once this many samples are queued

# ---- InfluxDB direct-read (analysis cold-path; NOT the live view) -------
# The TimeSeriesStore brick writes here from the ingest loop. The Analysis page reads it
# directly via HTTP so we can do server-side aggregation (mean per 50 ms window) and avoid
# the brick's per-metric N+1 row reads. Credentials are the board defaults shared by the user.
# `influx_client.py` is the only module that talks to this URL (parallel to ts_store.py
# being the only module that talks to the brick); it has zero brick imports so it stays
# off-device-importable.
INFLUX_URL      = "http://dbstorage-influx:8086"   # Docker service alias on the App Lab network
# (the host's :8086 is mapped from the same container, so SSH-side probing uses localhost:8086;
# from inside this container — where main.py runs — use the service alias, not 172.17.0.1
# (that's the default bridge gateway; App Lab uses a custom network `arduino_uno_q_default`).
# Auth: v2 strongly prefers a Token; v1 (and the v2 v1-compat layer) use basic auth.
# When INFLUX_TOKEN is set, the client sends `Authorization: Token <token>` and ignores
# user/password. Token is the brick's admin token (visible inside the App Lab container
# as the INFLUXDB_ADMIN_TOKEN env var on this board).
INFLUX_TOKEN    = "392edbf2-b8a2-481f-979d-3f188b2c05f0"
INFLUX_USER     = "admin"
INFLUX_PASSWORD = "Arduino15"
# Bucket / org / DB. The brick on this UNO Q writes everything into a single measurement
# called "arduino", with the metric name (e.g. "A.ax_ms2") stored as the _field key, in
# the "arduinostorage" bucket under the "arduino" org. Pinned here so the client never
# auto-discovers (auto-discovery would also work but adds a round-trip per fresh process).
INFLUX_DB       = "arduinostorage"   # 1.x compat name (same as the v2 bucket)
INFLUX_BUCKET   = "arduinostorage"   # 2.x bucket on this board
INFLUX_ORG      = "arduino"          # 2.x org
INFLUX_TIMEOUT_S = 5.0
# The brick stores everything inside one measurement; the metric (`A.ax_ms2` etc.) is the
# _field key, not the _measurement name. influx_client.py reads `INFLUX_MEASUREMENT` from
# here so a future brick that switches to per-metric measurements is a one-line change.
INFLUX_MEASUREMENT = "arduino"

# ---- Analysis tunables -------------------------------------------------
# Server-side aggregateWindow grid. 50 ms matches the Nano @ 20 Hz so we get one row per
# real sample, lightly denoised by the brick's ~1 s flush jitter.
ANALYSIS_DOWNSAMPLE_MS      = 50
# Default duration for /api/analysis/latest (frontend "Last 10 minutes" preset).
ANALYSIS_DEFAULT_DURATION_S = 600

# Plant / cycle tunables (cookbook §Stage 2 / Metric 2). Tuned against the synthetic walk
# in test_analysis.py — change with care.
PLANT_GYRO_DPS      = 20.0   # |gyro| below this = quasi-still
PLANT_REFRACTORY_MS = 220    # reject double-counts within this window
STICK_LEN_M         = 0.9    # default cane length L — used only by stride absolute scaling
# Reserved for metric 5–8 (Phase 2); declared here so the API exposes them in /api/analysis/health.
P_TARE_PA           = 101325.0
WSFC_TARGET_PCT     = 60.0

# ---- Startup source (headless boot; mirrors SourceManager.set_source args) ----
# run_dashboard() applies this at boot when APP_MODE == "dashboard" (skipped for "empty");
# the UI can still change the active source at runtime. The dashboard shows ONE active source.
# kind: "none" | "mock" | "ble"  (case-sensitive)
#   mock -> set "gait": "normal" | "altered"
#   ble  -> with BLE_TRANSPORT="bridge" the source reads the host bridge (BRIDGE_HOST:BRIDGE_PORT);
#           "address" is only used when BLE_TRANSPORT="direct". Find a MAC with a host-side scan
#           (APP_MODE="scan", run over SSH), or omit/None for the first NanoIMU by name.
# Default: none — boot empty and pick a source from the UI dropdown (Reset = mock normal demo).
STARTUP_SOURCE = {"kind": "none"}
# Live example — boot straight onto the real Nano via the host bridge:
# STARTUP_SOURCE = {"kind": "ble"}    # BLE_TRANSPORT="bridge" -> reads ble_bridge.py on the host
