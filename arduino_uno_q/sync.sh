#!/usr/bin/env bash
# Sync this app's python/ + assets/ to the UNO Q App Lab app over SSH (rsync).
#
# Only python/ and assets/ are pushed. The board's sketch/, app.yaml, README.md and
# .gitignore are left untouched (bricks/app.yaml are managed in the App Lab UI; the
# board keeps its own sketch/ scaffold).
#
# This script stays Mac-side only — it is never copied to the board.
#
# Usage:
#   ./sync.sh <ssh-host> <app-dir-on-board> [--bridge]
#
#   --bridge   After syncing, (re)start the host-side TCP BLE bridge over SSH: kills any old
#              ble_bridge.py, then nohup's a fresh one (for BLE_TRANSPORT="bridge"; log at
#              /tmp/ble_bridge.log on the board). Override the interpreter with BRIDGE_PY=... if
#              the host's python isn't python3. Does NOT start the dashboard (main.py) — that is
#              still the App Lab Run button.
#
# Example:
#   ./sync.sh arduino@192.168.1.50 /home/arduino/.local/share/arduino-app-cli/.../Moonwalk-server
#   ./sync.sh arduino@192.168.1.50 /home/.../Moonwalk-server --bridge
#
# Find <app-dir-on-board> on the board with:
#   ssh <ssh-host> "find / -path '*Moonwalk-server*/app.yaml' 2>/dev/null"
set -euo pipefail

# Args: first two non-flag args are HOST/APP; --bridge (anywhere) opts into starting the bridge.
HOST="" ; APP="" ; START_BRIDGE=0
for arg in "$@"; do
  case "$arg" in
    --bridge) START_BRIDGE=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) if [[ -z "$HOST" ]]; then HOST="$arg"; elif [[ -z "$APP" ]]; then APP="$arg"; fi ;;
  esac
done
: "${HOST:?usage: ./sync.sh <ssh-host> <app-dir-on-board> [--bridge]}"
: "${APP:?usage: ./sync.sh <ssh-host> <app-dir-on-board> [--bridge]}"
BRIDGE_PY="${BRIDGE_PY:-python3}"   # host interpreter for ble_bridge.py (override if not python3)
HERE="$(cd "$(dirname "$0")" && pwd)"

# --delete keeps the board's python/ and assets/ in exact sync (removes stale files),
# but is scoped to those two subdirs only.
RSYNC_OPTS=(-avz --delete
  --exclude='__pycache__/' --exclude='*.pyc' --exclude='.venv/'
  --exclude='assets/libs/socket.io.min.js')

echo "==> python/  ->  $HOST:$APP/python/"
rsync "${RSYNC_OPTS[@]}" "$HERE/python/"  "$HOST:$APP/python/"

echo "==> assets/  ->  $HOST:$APP/assets/"
rsync "${RSYNC_OPTS[@]}" "$HERE/assets/"  "$HOST:$APP/assets/"

if [[ "$START_BRIDGE" == 1 ]]; then
  # Restart the host-side BLE bridge so it picks up the just-synced ble_bridge.py.
  # $BRIDGE_PY/$APP expand here (Mac); \$(...) and \" run remotely. nohup + </dev/null lets
  # the bridge survive the SSH session closing; the kill+sleep frees the Nano's single BLE link.
  echo "==> restarting BLE bridge on $HOST ..."
  ssh "$HOST" "
    pkill -f 'python.*ble_bridge.py' 2>/dev/null || true
    sleep 1
    nohup '$BRIDGE_PY' '$APP/python/ble_bridge.py' > /tmp/ble_bridge.log 2>&1 </dev/null &
    sleep 1
    echo \"[bridge] pid \$(pgrep -f 'ble_bridge.py' | head -1) — log: /tmp/ble_bridge.log\"
  "
  echo "Done. (bridge restarted; sketch/, app.yaml, README.md left untouched.)"
else
  echo "Done. (sketch/, app.yaml, README.md left untouched. Pass --bridge to also start the BLE bridge.)"
fi
