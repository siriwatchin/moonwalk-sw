"""WebUI Brick server layer — the ONLY module that imports the Arduino WebUI brick.

Wraps `arduino.app_bricks.web_ui.WebUI`: registers the dashboard REST API via
`expose_api`. The browser polls these endpoints (no Socket.IO push).

Verified usage (working App Lab dashboards, e.g. philippe86220/uno-q-sensors-webui):
    from arduino.app_bricks.web_ui import WebUI
    web = WebUI()
    web.expose_api("GET", "/api/state", handler)   # full path incl. /api; handler(_req=None)->dict
    # the app is started by arduino.app_utils.App.run() (which starts all bricks)
Static files are served from the app's assets/ folder; UI is at port 7000.
"""

from __future__ import annotations

from store import SampleStore


class WebUIServer:
    """Registers the dashboard REST API on the WebUI brick."""

    def __init__(self, store: SampleStore):
        from arduino.app_bricks.web_ui import WebUI  # required — UNO Q / App Lab only

        self.store = store
        self.ui = WebUI()
        self._register_api()

    def _register_api(self) -> None:
        ui, store = self.ui, self.store
        # Full paths incl. /api (the brick does NOT auto-prefix). Handlers accept an
        # optional request arg and return a plain dict (serialized to JSON).
        ui.expose_api("GET", "/api/status", lambda _req=None: store.status())
        ui.expose_api("GET", "/api/latest", lambda _req=None: {"latest": store.latest()})
        ui.expose_api("GET", "/api/series", lambda _req=None: store.series())
        ui.expose_api("POST", "/api/clear", lambda _req=None: {"cleared": True, "removed": store.clear()})
        ui.expose_api("GET", "/api/export_csv", lambda _req=None: {
            "filename": "imu_samples.csv",
            "csv": store.to_csv(),
        })
