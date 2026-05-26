#!/usr/bin/env bash
# Rebuild the vendored, offline Tailwind CSS into assets/tailwind.css.
# Run from the arduino_uno_q/ folder:  ./tools/tailwind/build.sh
# Re-run whenever you add new Tailwind classes to assets/index.html or app.js.
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> arduino_uno_q/
npx -y tailwindcss@3.4.17 \
  -c tools/tailwind/tailwind.config.js \
  -i tools/tailwind/input.css \
  -o assets/tailwind.css \
  --minify
echo "Built assets/tailwind.css"
