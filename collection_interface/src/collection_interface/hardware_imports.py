from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
HARDWARE_PYTHON = REPO_ROOT / "hardware" / "python"


def ensure_hardware_path() -> Path:
    hardware_path = str(HARDWARE_PYTHON)
    if hardware_path not in sys.path:
        sys.path.insert(0, hardware_path)
    return HARDWARE_PYTHON


ensure_hardware_path()
