#!/usr/bin/env python3
"""Generate the NanoIMU BLE contract into every consumer from one source of truth.

The BLE contract (device name, UUIDs, notify interval, gravity, payload layout) used to be
hand-copied across the Python modules — a silent drift hazard. Now `protocol/ble_contract.json`
is the single source; this script renders it into the Python consumers:

  - arduino_uno_q/python/ble_contract.py  (dashboard: re-exported by config.py)
  - arduino_nano_33/ble_contract_gen.py   (Nano dev tools: imported by imu_payload.py)

(The firmware `nano_imu_ble_sender.ino` inlines these constants directly — keep them in sync
with this JSON by hand.)

Usage:
  python3 protocol/gen_contract.py            # (re)write the generated files
  python3 protocol/gen_contract.py --check    # exit 1 if any generated file is stale (drift)

Pure stdlib. UUIDs are stored (and emitted) lowercase; the firmware inlines them uppercase by
hand (BLE UUIDs are case-insensitive).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = Path(__file__).resolve().parent / "ble_contract.json"

_BANNER = (
    "AUTO-GENERATED from protocol/ble_contract.json by protocol/gen_contract.py — DO NOT EDIT."
)


def _load() -> dict:
    with open(SPEC, encoding="utf-8") as f:
        return json.load(f)


def render_python(spec: dict) -> str:
    fields = ", ".join(f'"{f}"' for f in spec["fields"])
    lines = [
        f'"""{_BANNER}"""',
        "",
        f'DEVICE_NAME = "{spec["device_name"]}"',
        f'SERVICE_UUID = "{spec["service_uuid"]}"',
        f'CHAR_UUID = "{spec["char_uuid"]}"',
        "",
        f"SEND_INTERVAL_MS = {int(spec['send_interval_ms'])}",
        f"GRAVITY = {spec['gravity']!r}",
        f'PAYLOAD_TAG = "{spec["payload_tag"]}"',
        "",
        f"FIELDS = [{fields}]",
        "FIELD_COUNT = len(FIELDS) + 1  # +1 for the leading payload tag",
        "",
    ]
    return "\n".join(lines)


# target path -> renderer
def _targets(spec: dict) -> dict[Path, str]:
    py = render_python(spec)
    return {
        ROOT / "arduino_uno_q" / "python" / "ble_contract.py": py,
        ROOT / "arduino_nano_33" / "ble_contract_gen.py": py,
    }


def main(argv: list[str]) -> int:
    spec = _load()
    targets = _targets(spec)
    check = "--check" in argv

    stale = []
    for path, content in targets.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if check:
            if current != content:
                stale.append(path)
        else:
            path.write_text(content, encoding="utf-8")
            print(f"wrote {path.relative_to(ROOT)}")

    if check:
        if stale:
            print("DRIFT: regenerate with `python3 protocol/gen_contract.py`:", file=sys.stderr)
            for p in stale:
                print(f"  stale: {p.relative_to(ROOT)}", file=sys.stderr)
            return 1
        print("contract in sync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
