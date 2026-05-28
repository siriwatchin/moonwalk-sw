import { cors } from "@elysiajs/cors";
import { env } from "@user-interface/env/server";
import { Elysia } from "elysia";

const UNO_Q_BRIDGE_URL = process.env.UNO_Q_BRIDGE_URL ?? "http://172.17.0.1:7000";

type BridgePath =
  | "/api/status"
  | "/api/latest"
  | "/api/series"
  | "/api/ble/scan"
  | "/api/slot/set"
  | "/api/reset"
  | "/api/clear";

type ProxyResult =
  | {
      ok: true;
      source: "uno-q";
      bridgeUrl: string;
      data: unknown;
    }
  | {
      ok: false;
      source: "uno-q";
      bridgeUrl: string;
      error: string;
      hint: string;
    };

async function readBridge(path: BridgePath, init?: RequestInit): Promise<ProxyResult> {
  const url = new URL(path, UNO_Q_BRIDGE_URL);

  try {
    const response = await fetch(url, {
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
      ...init,
    });

    if (!response.ok) {
      return {
        ok: false,
        source: "uno-q",
        bridgeUrl: UNO_Q_BRIDGE_URL,
        error: `UNO Q bridge returned ${response.status}`,
        hint: "Confirm the UNO Q WebUI bridge is running and reachable.",
      };
    }

    return {
      ok: true,
      source: "uno-q",
      bridgeUrl: UNO_Q_BRIDGE_URL,
      data: await response.json(),
    };
  } catch (error) {
    return {
      ok: false,
      source: "uno-q",
      bridgeUrl: UNO_Q_BRIDGE_URL,
      error: error instanceof Error ? error.message : "Unknown bridge error",
      hint: "Set UNO_Q_BRIDGE_URL if the bridge is not available at the default Docker gateway.",
    };
  }
}

function writeBridge(path: BridgePath, body?: unknown) {
  return readBridge(path, {
    body: JSON.stringify(body ?? {}),
    method: "POST",
  });
}

new Elysia()
  .use(
    cors({
      origin: env.CORS_ORIGIN,
      methods: ["GET", "POST", "OPTIONS"],
    }),
  )
  .get("/", () => "OK")
  .get("/api/health", () => ({
    ok: true,
    service: "moon-walk-api",
    unoQBridgeUrl: UNO_Q_BRIDGE_URL,
  }))
  .get("/api/device/status", () => readBridge("/api/status"))
  .get("/api/device/latest", () => readBridge("/api/latest"))
  .get("/api/device/series", () => readBridge("/api/series"))
  .post("/api/device/scan", ({ body }) => writeBridge("/api/ble/scan", body))
  .post("/api/device/slot", ({ body }) => writeBridge("/api/slot/set", body))
  .post("/api/device/reset", () => writeBridge("/api/reset"))
  .post("/api/device/clear", () => writeBridge("/api/clear"))
  .listen(3000, () => {
    console.log("Server is running on http://localhost:3000");
  });
