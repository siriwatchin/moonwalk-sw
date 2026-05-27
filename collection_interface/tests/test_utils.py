import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from collection_interface.hardware_imports import ensure_hardware_path

ensure_hardware_path()

from collection_interface.utils import (
    apply_metadata,
    downsample_samples,
    export_jsonl,
    export_manifest,
    generate_demo_samples,
    parse_csv_text,
    parse_protocol_text,
    summarize_samples,
    trim_samples,
)
from motion import build_sample
from stream_protocol import encode_raw_line, encode_sample_line


class CollectionUtilsTests(unittest.TestCase):
    def test_parse_protocol_text_accepts_raw_and_sample_frames(self):
        sample = build_sample(0, 0, 1, 0, 0, 0, timestamp=42)
        text = "\n".join([encode_raw_line(0, 0, 1, 0, 0, 0), encode_sample_line(sample)])

        result = parse_protocol_text(text)

        self.assertEqual(len(result.samples), 2)
        self.assertEqual(result.errors, [])

    def test_parse_protocol_text_reports_invalid_lines(self):
        result = parse_protocol_text("not json")

        self.assertEqual(result.samples, [])
        self.assertEqual(len(result.errors), 1)
        self.assertIn("line 1", result.errors[0])

    def test_parse_csv_text_builds_samples_from_columns(self):
        text = "timestamp,ax_g,ay_g,az_g,roll_dps,pitch_dps,yaw_dps,label,note\n1,0,0,1,0,0,0,walk,test\n"

        result = parse_csv_text(text)

        self.assertEqual(len(result.samples), 1)
        self.assertEqual(result.samples[0].label, "walk")
        self.assertEqual(result.samples[0].timestamp, 1)

    def test_apply_metadata_strips_label_and_note(self):
        samples = apply_metadata([build_sample(0, 0, 1, 0, 0, 0)], label=" walk ", note=" trial ")

        self.assertEqual(samples[0].label, "walk")
        self.assertEqual(samples[0].note, "trial")

    def test_summary_contains_rates_and_counts(self):
        samples = [
            build_sample(0, 0, 1, 0, 0, 0, timestamp=10, label="a"),
            build_sample(0, 0, 1, 4, 0, 0, timestamp=12, label="a"),
            build_sample(0, 0, 1, 8, 0, 0, timestamp=14, label="b"),
        ]

        summary = summarize_samples(samples)

        self.assertEqual(summary["sample_count"], 3)
        self.assertEqual(summary["duration_s"], 4)
        self.assertEqual(summary["sample_rate_hz"], 0.5)
        self.assertEqual(summary["label_counts"], {"a": 2, "b": 1})
        self.assertEqual(summary["max_angular_rate_dps"], 8)

    def test_trim_and_downsample_keep_order(self):
        samples = [build_sample(0, 0, 1, 0, 0, 0, timestamp=i) for i in range(10)]

        self.assertEqual([sample.timestamp for sample in trim_samples(samples, keep_last=3)], [7, 8, 9])
        self.assertLessEqual(len(downsample_samples(samples, max_points=4)), 4)

    def test_export_jsonl_uses_sample_protocol_lines(self):
        output = export_jsonl([build_sample(0, 0, 1, 0, 0, 0)])

        self.assertTrue(output.startswith("MWALK_MOTION_SAMPLE "))

    def test_export_manifest_is_json_with_summary(self):
        manifest = json.loads(export_manifest(generate_demo_samples(5), session_name="demo"))

        self.assertEqual(manifest["session_name"], "demo")
        self.assertEqual(manifest["summary"]["sample_count"], 5)


if __name__ == "__main__":
    unittest.main()
