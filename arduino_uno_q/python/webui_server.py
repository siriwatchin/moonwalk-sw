"""WebUI Brick server layer — the ONLY module that imports the Arduino WebUI brick.

Wraps `arduino.app_bricks.web_ui.WebUI`: registers the dashboard REST API via
`expose_api`. The browser polls GET endpoints and POSTs control actions (source switch,
BLE scan/connect). No Socket.IO.

Confirmed brick API:
    web = WebUI()
    web.expose_api("GET", "/api/state", handler)    # GET handler: handler(_req=None)->dict
    web.expose_api("POST", "/led", handler)          # POST handler: handler(data)->dict (data=JSON body)
    # started by arduino.app_utils.App.run(); static assets served from assets/; port 7000
"""

from __future__ import annotations

from store import SampleStore


class WebUIServer:
    """Registers the dashboard REST API on the WebUI brick."""

    def __init__(self, store: SampleStore, manager):
        from arduino.app_bricks.web_ui import WebUI  # required — UNO Q / App Lab only

        self.store = store
        self.mgr = manager
        self.ui = WebUI()
        self._register_api()

    def _status(self) -> dict:
        # Merge buffer/ingest status with the source-manager state for one call.
        return {**self.store.status(), **self.mgr.state()}

    def _register_api(self) -> None:
        ui, store, mgr = self.ui, self.store, self.mgr

        # ---- GET: read state (handlers take an optional request arg) -----
        ui.expose_api("GET", "/api/status", lambda _req=None: self._status())
        ui.expose_api("GET", "/api/latest", lambda _req=None: {"latest": store.latest()})
        ui.expose_api("GET", "/api/series", lambda _req=None: store.series())
        ui.expose_api("GET", "/api/export_csv", lambda _req=None: {
            "filename": "imu_samples.csv",
            "csv": store.to_csv(),
        })

        # ---- POST: control actions (handlers receive the JSON body dict) -
        ui.expose_api("POST", "/api/clear", lambda data=None: {
            "cleared": True, "removed": store.clear(),
        })
        # Switch source: {"mode":"mock"|"ble","address":<optional>}
        ui.expose_api("POST", "/api/source", lambda data=None: mgr.select(
            (data or {}).get("mode", "mock"), (data or {}).get("address"),
        ))
        # Scan for BLE devices -> {"devices":[{name,address}]}
        ui.expose_api("POST", "/api/ble/scan", lambda data=None: {
            "devices": mgr.scan(float((data or {}).get("timeout", 6.0))),
        })
        # Connect to a chosen device: {"address":"…"}
        ui.expose_api("POST", "/api/ble/connect", lambda data=None: mgr.select(
            "ble", (data or {}).get("address"),
        ))
