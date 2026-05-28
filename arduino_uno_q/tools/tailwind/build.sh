#!/usr/bin/env bash
# Rebuild the vendored, offline Tailwind CSS into assets/tailwind.css.
# Run from the arduino_uno_q/ folder:  ./tools/tailwind/build.sh
# Re-run whenever you add new Tailwind/daisyUI classes to assets/index.html or app.js.
#
# Tooling: tools/tailwind/ is now a small npm project (package.json) because daisyUI is added
# as a Tailwind plugin via require("daisyui"); the config can't resolve that without
# node_modules. First run does `npm install` (needs internet); the compiled assets/tailwind.css
# still ships offline-vendored — runtime never touches the network or node_modules.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."   # -> arduino_uno_q/

if [[ ! -d "$HERE/node_modules/tailwindcss" ]]; then
  echo "==> first-time install in tools/tailwind/ (needs internet) ..."
  ( cd "$HERE" && npm install --no-audit --no-fund --silent )
fi

"$HERE/node_modules/.bin/tailwindcss" \
  -c tools/tailwind/tailwind.config.js \
  -i tools/tailwind/input.css \
  -o assets/tailwind.css \
  --minify
echo "Built assets/tailwind.css"
