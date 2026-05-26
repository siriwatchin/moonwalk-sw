"""Local dashboard web server.

`DashboardServer` is the interface the rest of the app depends on. `FlaskDashboardServer`
is the current implementation. To switch to a Brick Web Server later, write a
`BrickDashboardServer` with the same two responsibilities (serve the dashboard HTML and
expose the buffer snapshot as JSON) and select it in main — nothing else changes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .buffer import SampleBuffer

_STATIC_DIR = Path(__file__).parent / "static"


class DashboardServer(Protocol):
    def serve_forever(self, host: str, port: int) -> None: ...


class FlaskDashboardServer:
    """Serves the dashboard page and a /api/state JSON snapshot of the buffer."""

    def __init__(self, buffer: SampleBuffer):
        from flask import Flask, jsonify

        from .config import POLL_MS

        self._buffer = buffer
        # Inject the poll interval into the page once at startup.
        html = (_STATIC_DIR / "dashboard.html").read_text(encoding="utf-8")
        self._page = html.replace("__POLL_MS__", str(POLL_MS))

        app = Flask(__name__, static_folder=None)

        @app.route("/")
        def index():
            return self._page, 200, {"Content-Type": "text/html; charset=utf-8"}

        @app.route("/api/state")
        def state():
            return jsonify(self._buffer.snapshot())

        self._app = app

    def serve_forever(self, host: str, port: int) -> None:
        # threaded=True so concurrent /api/state polls don't block each other.
        self._app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)
