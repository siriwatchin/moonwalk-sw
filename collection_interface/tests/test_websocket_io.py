import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hardware" / "python"))

from collection_interface.websocket_io import WebSocketReadConfig, read_available_messages
from stream_protocol import encode_raw_line


class FakeWebSocket:
    def __init__(self, messages):
        self.messages = list(messages)

    def recv(self, timeout=None):
        if not self.messages:
            raise TimeoutError()
        return self.messages.pop(0)


class WebSocketIoTests(unittest.TestCase):
    def test_read_available_messages_parses_text_frames(self):
        connection = FakeWebSocket([encode_raw_line(0, 0, 1, 0, 0, 0)])

        result = read_available_messages(
            connection,
            config=WebSocketReadConfig(max_messages=10, timeout_s=0.01),
        )

        self.assertEqual(len(result.samples), 1)
        self.assertEqual(result.errors, [])

    def test_read_available_messages_parses_bytes_frames(self):
        line = encode_raw_line(0, 0, 1, 0, 0, 0).encode("utf-8")
        connection = FakeWebSocket([line])

        result = read_available_messages(
            connection,
            config=WebSocketReadConfig(max_messages=10, timeout_s=0.01),
        )

        self.assertEqual(len(result.samples), 1)
        self.assertEqual(result.errors, [])


if __name__ == "__main__":
    unittest.main()
