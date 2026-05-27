import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motion import POSTURE_UPRIGHT, build_sample
from stream_protocol import (
    PROTOCOL_VERSION,
    RAW_PREFIX,
    SAMPLE_PREFIX,
    decode_line,
    encode_raw_line,
    encode_sample_line,
    sample_from_payload,
)


class StreamProtocolTests(unittest.TestCase):
    def test_encode_raw_line_is_prefixed_json_protocol_frame(self):
        line = encode_raw_line(0, 0, 1, 1, 2, 3, timestamp_ms=42)

        self.assertTrue(line.startswith(RAW_PREFIX))
        payload = json.loads(line.removeprefix(RAW_PREFIX))
        self.assertEqual(payload["protocol"], PROTOCOL_VERSION)
        self.assertEqual(payload["kind"], "raw")
        self.assertEqual(payload["az_g"], 1.0)
        self.assertEqual(payload["timestamp_ms"], 42)

    def test_decode_line_accepts_raw_prefix(self):
        payload = decode_line(encode_raw_line(0, 0, 1, 1, 2, 3))
        self.assertEqual(payload["kind"], "raw")

    def test_decode_line_accepts_sample_prefix(self):
        sample = build_sample(0, 0, 1, 0, 0, 0, timestamp=123)
        payload = decode_line(encode_sample_line(sample))
        self.assertEqual(payload["kind"], "sample")
        self.assertEqual(payload["posture"], POSTURE_UPRIGHT)

    def test_sample_from_raw_payload_classifies_posture(self):
        payload = decode_line(encode_raw_line(0, 0, 1, 0, 0, 0))
        sample = sample_from_payload(payload)
        self.assertEqual(sample.posture, POSTURE_UPRIGHT)

    def test_sample_line_uses_sample_prefix(self):
        line = encode_sample_line(build_sample(0, 0, 1, 0, 0, 0))
        self.assertTrue(line.startswith(SAMPLE_PREFIX))


if __name__ == "__main__":
    unittest.main()
