"""Append parsed ImuSample rows to a CSV file for later analysis."""

from __future__ import annotations

import csv
from pathlib import Path

from .models import ImuSample

# Column order written to disk (mirrors ImuSample.to_row()).
CSV_FIELDS = [
    "timestamp_ms",
    "ax_ms2", "ay_ms2", "az_ms2",
    "gx_dps", "gy_dps", "gz_dps",
    "acc_norm", "gyro_norm",
    "phase", "phase_label",
]


class CsvLogger:
    """Context manager that writes a header then one row per sample."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._fh = None
        self._writer = None
        self.rows_written = 0

    def __enter__(self) -> "CsvLogger":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("w", newline="")
        self._writer = csv.DictWriter(self._fh, fieldnames=CSV_FIELDS)
        self._writer.writeheader()
        return self

    def write(self, sample: ImuSample) -> None:
        self._writer.writerow(sample.to_row())
        self.rows_written += 1

    def __exit__(self, *exc) -> None:
        if self._fh is not None:
            self._fh.close()
