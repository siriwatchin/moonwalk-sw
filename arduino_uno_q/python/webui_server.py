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
from urllib.parse import quote

from config import RECENT_POINTS
from registry import DeviceRegistry
from source_manager import ACTIVE   # single internal storage key for the active source


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

        # ---- GET: read the one active source's state (no slots) -----------
        def _status(_req=None):
            dev = reg.get(ACTIVE)
            return {
                **mgr.state(),                                   # scan_devices, source{...}
                "source_status": dev.store.status() if dev else {},  # buffer/ingest data quality
            }
        ui.expose_api("GET", "/api/status", _status)
        ui.expose_api("GET", "/api/latest", lambda _req=None: {
            "latest": (reg.get(ACTIVE).store.latest() if reg.get(ACTIVE) else None),
        })

        # Incremental realtime read (the hot path the browser polls). Reads the in-memory buffer
        # only — never InfluxDB. since_seq/limit are taken as raw strings and parsed/clamped in
        # samples_since(), so junk params can't 422 or crash; missing -> latest window.
        def _samples(since_seq: str | None = None, limit: str | None = None):
            dev = reg.get(ACTIVE)
            if dev is None:
                return {"latest_seq": 0, "samples": []}
            return dev.store.samples_since(since_seq, limit if limit is not None else RECENT_POINTS)
        ui.expose_api("GET", "/api/samples", _samples)

        # Download the active source's rolling buffer (~30 s) as a CSV file. Empty -> header only.
        def _export():
            dev = reg.get(ACTIVE)
            label = dev.label if dev else "source"
            safe = re.sub(r"[^A-Za-z0-9_-]+", "_", label).strip("_") or "source"
            fname = f"moonwalk_{safe}_{time.strftime('%Y%m%d-%H%M%S')}.csv"
            return Response(content=reg.csv(ACTIVE), media_type="text/csv",
                            headers={"Content-Disposition": f'attachment; filename="{fname}"'})
        ui.expose_api("GET", "/api/export", _export)

        # Download the last finished recording (start→stop session) as a CSV file. The browser
        # navigates here right after POST /api/record/stop. Recording state is in /api/status.
        def _record_download():
            fname = mgr.record_filename()              # the user's label + ".csv" (may be non-ASCII)
            # RFC 5987: ASCII fallback for old clients + UTF-8 form so Thai/spaces survive.
            ascii_name = fname.encode("ascii", "replace").decode("ascii").replace("?", "_")
            cd = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(fname, safe='')}"
            return Response(content=mgr.record_csv(), media_type="text/csv",
                            headers={"Content-Disposition": cd})
        ui.expose_api("GET", "/api/record/download", _record_download)

        # ---- POST: control actions (handlers receive the JSON body dict) -
        ui.expose_api("POST", "/api/clear", lambda data=None: {
            "cleared": True, "removed": reg.clear_buffers(),
        })
        # Set the one active source: {"kind":"none"|"mock"|"ble",
        #                             "gait":"normal"|"altered","address":<opt>,"label":<opt>}
        def _set_source(data: dict = Body(default=None)):
            d = data or {}
            return mgr.set_source(
                d.get("kind", "none"),
                gait=d.get("gait", "normal"),
                address=d.get("address"), label=d.get("label"),
            )
        ui.expose_api("POST", "/api/source/set", _set_source)
        # Reset to the demo source (a single mock 'normal' gait)
        ui.expose_api("POST", "/api/reset", lambda data=None: mgr.reset())
        # Scan for BLE devices -> {"devices":[{name,address}]}
        def _ble_scan(data: dict = Body(default=None)):
            return {"devices": mgr.scan(float((data or {}).get("timeout", 8.0)))}
        ui.expose_api("POST", "/api/ble/scan", _ble_scan)

        # Start a session recording of the active source: {"label":<name>}
        def _record_start(data: dict = Body(default=None)):
            d = data or {}
            return mgr.record_start(d.get("label", "rec"))
        ui.expose_api("POST", "/api/record/start", _record_start)
        # Stop the active recording (the finished CSV is then at GET /api/record/download)
        ui.expose_api("POST", "/api/record/stop", lambda data=None: mgr.record_stop())
