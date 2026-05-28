"""WebUI Brick server layer — the ONLY module that imports the Arduino WebUI brick.

Registers the multi-device dashboard REST API via `expose_api`. The browser polls GET
endpoints (one JSON blob keyed by device) and POSTs control actions. No Socket.IO.

Confirmed brick API:
    web = WebUI()
    web.expose_api("GET", "/api/state", handler)    # GET handler: handler(_req=None)->dict
    web.expose_api("POST", "/led", handler)          # POST handler: handler(data)->dict (data=JSON body)
    # started by arduino.app_utils.App.run(); static assets served from assets/; port 7000
"""

from __future__ import annotations

from registry import DeviceRegistry


class WebUIServer:
    """Registers the dashboard REST API on the WebUI brick (multi-device)."""

    def __init__(self, registry: DeviceRegistry, manager):
        from arduino.app_bricks.web_ui import WebUI  # required — UNO Q / App Lab only

        self.reg = registry
        self.mgr = manager
        self.ui = WebUI()
        self._register_api()

    def _register_api(self) -> None:
        ui, reg, mgr = self.ui, self.reg, self.mgr

        # ---- GET: read state (keyed by slot "A"/"B"; no query params) -----
        ui.expose_api("GET", "/api/status", lambda _req=None: {
            **mgr.state(),                 # scan_devices, slots{A,B}
            "devices_status": reg.status(),  # per-slot buffer/ingest stats
        })
        ui.expose_api("GET", "/api/latest", lambda _req=None: {"devices": reg.latest()})
        ui.expose_api("GET", "/api/series", lambda _req=None: {"devices": reg.series()})

        # ---- POST: control actions (handlers receive the JSON body dict) -
        ui.expose_api("POST", "/api/clear", lambda data=None: {
            "cleared": True, "removed": reg.clear_buffers(),
        })
        # Set a slot's source: {"slot":"A"|"B","kind":"none"|"mock"|"ble",
        #                       "gait":"normal"|"altered","address":<opt>,"label":<opt>}
        ui.expose_api("POST", "/api/slot/set", lambda data=None: mgr.set_slot(
            (data or {}).get("slot"), (data or {}).get("kind", "none"),
            gait=(data or {}).get("gait", "normal"),
            address=(data or {}).get("address"), label=(data or {}).get("label"),
        ))
        # Reset both slots to the demo pair (A=normal, B=injured)
        ui.expose_api("POST", "/api/reset", lambda data=None: mgr.reset())
        # Scan for BLE devices -> {"devices":[{name,address}]}
        ui.expose_api("POST", "/api/ble/scan", lambda data=None: {
            "devices": mgr.scan(float((data or {}).get("timeout", 8.0))),
        })
