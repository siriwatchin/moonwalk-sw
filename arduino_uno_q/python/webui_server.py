"""WebUI Brick server layer — the ONLY module that imports the Arduino WebUI brick.

Registers the multi-device dashboard REST API via `expose_api`. The browser polls GET
endpoints (one JSON blob keyed by device) and POSTs control actions. No Socket.IO.

Confirmed brick API:
    web = WebUI()
    web.expose_api("GET", "/api/state", handler)    # GET handler: handler(_req=None)->dict
    # expose_api hands `function` straight to FastAPI's add_api_route, so the handler signature
    # IS the FastAPI signature. To read a POST's JSON body, the param MUST be declared with
    # Body() (e.g. `data: dict = Body(default=None)`); a plain `data=None` becomes a *query*
    # param and the JSON body is silently dropped (slot stays unchanged).
    # started by arduino.app_utils.App.run(); static assets served from assets/; port 7000
"""

from __future__ import annotations

import re
import time

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
        # FastAPI ships with the WebUI brick (UNO Q only). Lazy import keeps off-device
        # `import webui_server` brick-free. POST bodies MUST be declared with Body(), or
        # FastAPI treats a plain-default param as a *query* param and the JSON body is dropped.
        from fastapi import Body
        from fastapi.responses import Response

        # ---- GET: read state (keyed by slot "A"/"B"; no query params) -----
        ui.expose_api("GET", "/api/status", lambda _req=None: {
            **mgr.state(),                 # scan_devices, slots{A,B}
            "devices_status": reg.status(),  # per-slot buffer/ingest stats
        })
        ui.expose_api("GET", "/api/latest", lambda _req=None: {"devices": reg.latest()})
        ui.expose_api("GET", "/api/series", lambda _req=None: {"devices": reg.series()})

        # Download a slot's rolling buffer (~30 s) as a CSV file. slot is a query param (GET, no
        # Body). Returns text/csv with a Content-Disposition filename; empty slot -> header only.
        def _export(slot: str = "A"):
            dev = reg.get(slot)
            label = dev.label if dev else slot
            safe = re.sub(r"[^A-Za-z0-9_-]+", "_", label).strip("_") or slot
            fname = f"moonwalk_{slot}_{safe}_{time.strftime('%Y%m%d-%H%M%S')}.csv"
            return Response(content=reg.csv(slot), media_type="text/csv",
                            headers={"Content-Disposition": f'attachment; filename="{fname}"'})
        ui.expose_api("GET", "/api/export", _export)

        # ---- POST: control actions (handlers receive the JSON body dict) -
        ui.expose_api("POST", "/api/clear", lambda data=None: {
            "cleared": True, "removed": reg.clear_buffers(),
        })
        # Set a slot's source: {"slot":"A"|"B","kind":"none"|"mock"|"ble",
        #                       "gait":"normal"|"altered","address":<opt>,"label":<opt>}
        def _set_slot(data: dict = Body(default=None)):
            d = data or {}
            return mgr.set_slot(
                d.get("slot"), d.get("kind", "none"),
                gait=d.get("gait", "normal"),
                address=d.get("address"), label=d.get("label"),
            )
        ui.expose_api("POST", "/api/slot/set", _set_slot)
        # Reset both slots to the demo pair (A=normal, B=injured)
        ui.expose_api("POST", "/api/reset", lambda data=None: mgr.reset())
        # Scan for BLE devices -> {"devices":[{name,address}]}
        def _ble_scan(data: dict = Body(default=None)):
            return {"devices": mgr.scan(float((data or {}).get("timeout", 8.0)))}
        ui.expose_api("POST", "/api/ble/scan", _ble_scan)
