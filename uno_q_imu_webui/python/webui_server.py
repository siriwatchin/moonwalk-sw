"""WebUI Brick server layer — the ONLY module that imports the Arduino WebUI brick.

Wraps `arduino.app_bricks.web_ui.WebUI`:
  - exposes the REST API via `ui.expose_api(method, path, handler)`
  - pushes live samples to the browser via `ui.send_message("imu_sample", dict)`

Verified usage (Arduino App Lab examples):
    from arduino.app_bricks.web_ui import WebUI
    ui = WebUI()
    ui.expose_api("GET", "/status", handler)         # handler returns a dict
    ui.send_message("temperature", {...})            # real-time push (Socket.IO)
The app is started elsewhere via arduino.app_utils.App.run().
"""

from __future__ import annotations

from store import SampleStore


class WebUIServer:
    """Registers the dashboard REST API and pushes real-time IMU samples."""

    def __init__(self, store: SampleStore):
        from arduino.app_bricks.web_ui import WebUI  # required — UNO Q / App Lab only

        self.store = store
        self.ui = WebUI()
        self._register_api()

    def _register_api(self) -> None:
        ui, store = self.ui, self.store
        # Handlers return plain dicts; the brick serializes them as JSON under /api/...
        ui.expose_api("GET", "/status", lambda: store.status())
        ui.expose_api("GET", "/latest", lambda: {"latest": store.latest()})
        # /series: recent values per metric for the charts (from the in-memory buffer).
        ui.expose_api("GET", "/series", lambda: store.series())
        ui.expose_api("POST", "/clear", lambda: {"cleared": True, "removed": store.clear()})
        ui.expose_api("GET", "/export_csv", lambda: {
            "filename": "imu_samples.csv",
            "csv": store.to_csv(),
        })

    def push(self, sample) -> None:
        """Push one new sample to all connected browser clients."""
        self.ui.send_message("imu_sample", sample.to_dict())
