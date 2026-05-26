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
#   ./sync.sh <ssh-host> <app-dir-on-board>
# Example:
#   ./sync.sh arduino@192.168.1.50 /home/arduino/.local/share/arduino-app-cli/.../Moonwalk-server
#
# Find <app-dir-on-board> on the board with:
#   ssh <ssh-host> "find / -path '*Moonwalk-server*/app.yaml' 2>/dev/null"
set -euo pipefail

HOST="${1:?usage: ./sync.sh <ssh-host> <app-dir-on-board>}"
APP="${2:?usage: ./sync.sh <ssh-host> <app-dir-on-board>}"
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

echo "Done. (sketch/, app.yaml, README.md on the board were left untouched.)"
