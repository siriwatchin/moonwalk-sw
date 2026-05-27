from __future__ import annotations

import csv
import io
import json
import math
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Iterable

from .hardware_imports import ensure_hardware_path

ensure_hardware_path()

from motion import MotionSample, build_sample, samples_to_csv  # noqa: E402
from stream_protocol import decode_line, encode_sample_line, sample_from_payload  # noqa: E402


COLLECTOR_MANIFEST_VERSION = "moonwalk.collection_manifest.v1"


@dataclass(frozen=True)
class ImportResult:
    samples: list[MotionSample]
    errors: list[str]
    ignored: int = 0


def parse_protocol_text(text: str) -> ImportResult:
    samples: list[MotionSample] = []
    errors: list[str] = []
    ignored = 0

    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            ignored += 1
            continue

        try:
            samples.append(sample_from_payload(decode_line(stripped)))
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            errors.append(f"line {line_number}: {error}")

    return ImportResult(samples=samples, errors=errors, ignored=ignored)


def parse_csv_text(text: str) -> ImportResult:
    samples: list[MotionSample] = []
    errors: list[str] = []
    reader = csv.DictReader(io.StringIO(text))

    required = {"ax_g", "ay_g", "az_g", "roll_dps", "pitch_dps", "yaw_dps"}
    if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
        return ImportResult([], ["CSV must include ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps columns"])

    for row_number, row in enumerate(reader, start=2):
        try:
            timestamp = float(row["timestamp"]) if row.get("timestamp") else None
            samples.append(
                build_sample(
                    float(row["ax_g"]),
                    float(row["ay_g"]),
                    float(row["az_g"]),
                    float(row["roll_dps"]),
                    float(row["pitch_dps"]),
                    float(row["yaw_dps"]),
                    timestamp=timestamp,
                    label=row.get("label", ""),
                    note=row.get("note", ""),
                )
            )
        except (TypeError, ValueError) as error:
            errors.append(f"row {row_number}: {error}")

    return ImportResult(samples=samples, errors=errors)


def parse_uploaded_text(filename: str, text: str) -> ImportResult:
    if Path(filename).suffix.lower() == ".csv":
        return parse_csv_text(text)
    return parse_protocol_text(text)


def apply_metadata(samples: Iterable[MotionSample], *, label: str, note: str) -> list[MotionSample]:
    clean_label = label.strip()
    clean_note = note.strip()
    return [replace(sample, label=clean_label, note=clean_note) for sample in samples]


def sample_to_row(sample: MotionSample) -> dict[str, Any]:
    row = asdict(sample)
    row["angular_rate_dps"] = max(abs(sample.roll_dps), abs(sample.pitch_dps), abs(sample.yaw_dps))
    return row


def samples_to_frame_rows(samples: Iterable[MotionSample]) -> list[dict[str, Any]]:
    rows = [sample_to_row(sample) for sample in samples]
    if not rows:
        return rows

    start = min(float(row["timestamp"]) for row in rows)
    for row in rows:
        row["elapsed_s"] = float(row["timestamp"]) - start
    return rows


def summarize_samples(samples: Iterable[MotionSample]) -> dict[str, Any]:
    sample_list = list(samples)
    if not sample_list:
        return {
            "sample_count": 0,
            "duration_s": 0.0,
            "sample_rate_hz": 0.0,
            "mean_tilt_deg": 0.0,
            "mean_accel_g": 0.0,
            "max_angular_rate_dps": 0.0,
            "posture_counts": {},
            "label_counts": {},
        }

    timestamps = [sample.timestamp for sample in sample_list]
    duration_s = max(timestamps) - min(timestamps)
    posture_counts = count_values(sample.posture for sample in sample_list)
    label_counts = count_values(sample.label for sample in sample_list if sample.label)

    return {
        "sample_count": len(sample_list),
        "duration_s": max(0.0, duration_s),
        "sample_rate_hz": (len(sample_list) - 1) / duration_s if duration_s > 0 else 0.0,
        "mean_tilt_deg": mean(sample.tilt_deg for sample in sample_list),
        "mean_accel_g": mean(sample.accel_magnitude_g for sample in sample_list),
        "max_angular_rate_dps": max(
            max(abs(sample.roll_dps), abs(sample.pitch_dps), abs(sample.yaw_dps))
            for sample in sample_list
        ),
        "posture_counts": posture_counts,
        "label_counts": label_counts,
    }


def count_values(values: Iterable[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def mean(values: Iterable[float]) -> float:
    value_list = list(values)
    return sum(value_list) / len(value_list) if value_list else 0.0


def trim_samples(samples: list[MotionSample], *, keep_last: int | None) -> list[MotionSample]:
    if keep_last is None or keep_last <= 0 or len(samples) <= keep_last:
        return list(samples)
    return samples[-keep_last:]


def downsample_samples(samples: list[MotionSample], *, max_points: int) -> list[MotionSample]:
    if max_points <= 0 or len(samples) <= max_points:
        return list(samples)

    step = math.ceil(len(samples) / max_points)
    return samples[::step]


def generate_demo_samples(count: int = 240) -> list[MotionSample]:
    now = time.time()
    samples: list[MotionSample] = []

    for index in range(count):
        phase = index / 13.0
        swing = math.sin(phase)
        lean_bias = 0.36 if index > count * 0.62 else 0.04
        ax_g = lean_bias + 0.14 * swing
        ay_g = 0.07 * math.cos(phase * 0.8)
        az_g = 0.96 + 0.03 * math.sin(phase * 0.5)
        roll_dps = 16.0 * math.sin(phase * 1.2)
        pitch_dps = 9.0 * math.cos(phase)
        yaw_dps = 44.0 if index % 54 in (0, 1, 2) else 5.5 * math.sin(phase * 0.6)
        label = "steady walk" if index <= count * 0.62 else "lean trial"
        samples.append(
            build_sample(
                ax_g,
                ay_g,
                az_g,
                roll_dps,
                pitch_dps,
                yaw_dps,
                timestamp=now + index * 0.05,
                label=label,
                note="demo",
            )
        )

    return samples


def export_csv(samples: Iterable[MotionSample]) -> str:
    return samples_to_csv(samples)


def export_jsonl(samples: Iterable[MotionSample]) -> str:
    return "\n".join(encode_sample_line(sample) for sample in samples)


def export_manifest(samples: Iterable[MotionSample], *, session_name: str, operator_note: str = "") -> str:
    sample_list = list(samples)
    payload = {
        "protocol": COLLECTOR_MANIFEST_VERSION,
        "session_name": session_name.strip(),
        "operator_note": operator_note.strip(),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "summary": summarize_samples(sample_list),
    }
    return json.dumps(payload, indent=2, sort_keys=True)
