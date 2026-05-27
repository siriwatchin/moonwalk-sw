"""Configuration for the UNO Q IMU WebUI app.

The BLE contract (device name + UUIDs + payload) must match the Nano firmware
(arduino_nano_33/nano_imu_ble_sender.ino).

Runtime mode is chosen here (APP_MODE), not via CLI flags: in App Lab the app is launched by
the Run button, which passes no arguments. Edit APP_MODE / STARTUP_SLOTS / BLE_TRANSPORT and
re-run; `python python/main.py` is all that's needed.
"""

# ---- Runtime mode (hardcoded; replaces CLI flags) ----------------------
# "dashboard" = start the WebUI dashboard and apply STARTUP_SLOTS   (runs in the App Lab container)
# "empty"     = start the dashboard with both slots unbound         (runs in the container)
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
    ACC_NEAR_G_THRESHOLD,
    CHAR_UUID,
    DEVICE_NAME,
    FIELD_COUNT,
    GRAVITY,
    GYRO_SWING_THRESHOLD,
    GYRO_ZERO_THRESHOLD,
    PAYLOAD_TAG,
    PHASE_LABELS,
    SERVICE_UUID,
)
from ble_contract import SEND_INTERVAL_MS as INTERVAL_MS  # noqa: E402,F401

# Data-stall watchdog: force a BLE reconnect if no notification arrives for this long even
# though the link still looks connected (silent stall). At 50 ms notify (20 Hz), 3 s ≈ 60
# missed samples — unambiguously dead, not just jitter. (Local behaviour, not the wire contract.)
BLE_STALL_TIMEOUT_S = 3.0

# ---- Store / UI ---------------------------------------------------------
BUFFER_MAXLEN = 600     # ~30 s of history at 20 Hz
RECENT_POINTS = 200     # samples returned to the browser for charts (~10 s @ 20 Hz)
CHART_WINDOW_MS = 10000 # live chart x-axis span: a 10 s scrolling time window
UI_PORT = 7000          # Arduino App Lab WebUI default port (informational)

# ---- TimeSeriesStore batching (cold path; analysis/history, not the live view) ----
# DB writes are decoupled from ingest: the ingest loop only enqueues, a background thread
# flushes in batches. This keeps the hot path cheap and avoids per-sample DB pressure.
TS_FLUSH_INTERVAL_S = 1.0   # flush cadence (also bounds DB-timestamp skew to ~this)
TS_BATCH_MAX = 256          # flush early once this many samples are queued

# ---- Startup slot bindings (headless boot; mirrors SourceManager.set_slot args) ----
# run_dashboard() applies these at boot when APP_MODE == "dashboard" (skipped for "empty");
# the UI can still override a slot at runtime.
# kind: "none" | "mock" | "ble"  (case-sensitive)
#   mock -> set "gait": "normal" | "altered"
#   ble  -> with BLE_TRANSPORT="bridge" the slot reads the host bridge (BRIDGE_HOST:BRIDGE_PORT);
#           "address" is only used when BLE_TRANSPORT="direct". Find a MAC with a host-side scan
#           (APP_MODE="scan", run over SSH), or omit/None for the first NanoIMU by name.
STARTUP_SLOTS = {
    "A": {"kind": "mock", "gait": "normal"},
    "B": {"kind": "mock", "gait": "altered"},
}
# Live example — mock baseline in A, real Nano (via the host bridge) in B:
# STARTUP_SLOTS = {
#     "A": {"kind": "mock", "gait": "normal"},
#     "B": {"kind": "ble"},   # BLE_TRANSPORT="bridge" -> reads ble_bridge.py on the host
# }
