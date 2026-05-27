"use strict";

// Two fixed compare slots (A / B). Each slot has its own source <select> (none / mock /
// scanned BLE Nano). Everything goes through the WebUI brick's REST API (no Socket.IO):
// the browser polls /api/* which return JSON keyed by slot ("A"/"B").

const SLOTS = ["A", "B"];
const PHASE_NAMES = {
  0: "UNKNOWN", 1: "STATIONARY / ZERO-VEL",
  2: "GROUND CONTACT + ROTATION", 3: "SWING / ON-AIR",
};
const PHASE_BG = { 0: "bg-phase0", 1: "bg-phase1", 2: "bg-phase2", 3: "bg-phase3" };

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v === null || v === undefined) ? "—" : Number(v).toFixed(d);
const api = (path, opts) => fetch(`/api${path}`, { cache: "no-store", ...(opts || {}) });

// Live charts plot value-vs-TIME on a fixed scrolling window: the newest sample sits at the
// right edge ("0s") and the trace scrolls right→left. x = the Nano's own timestamp_ms (even
// 50 ms spacing, honest across both bridge transports). A time jump > GAP_MS breaks the line,
// so dropped samples show as a real gap instead of a stretched segment.
const WINDOW_MS = 10000;   // ~matches server RECENT_POINTS (200 @ 20 Hz ≈ 10 s)
const GAP_MS = 200;        // break the trace when sample time jumps more than this

function setBadge(text, cls) {
  const b = $("badge");
  b.textContent = text;
  b.className = "px-3 py-1 rounded-full text-[13px] font-semibold " +
    (cls === "live" ? "bg-[#1f6f3d]" : cls === "down" ? "bg-[#8a1f1f]" : "bg-[#30363d]");
}

// ---- slot source <select> encoding ----
//   ""             -> none
//   "mock:normal"  -> mock gait normal
//   "mock:altered" -> mock gait altered (injured)
//   "ble:<addr>"   -> live BLE device by address
function parseSlotValue(v) {
  if (!v) return { kind: "none" };
  const i = v.indexOf(":");
  const kind = v.slice(0, i), rest = v.slice(i + 1);
  if (kind === "mock") return { kind: "mock", gait: rest };
  if (kind === "ble") return { kind: "ble", address: rest };
  return { kind: "none" };
}
function slotValueFromConfig(cfg) {
  if (!cfg) return "";
  if (cfg.kind === "mock") return "mock:" + (cfg.gait || "normal");
  if (cfg.kind === "ble") return "ble:" + cfg.address;
  return "";
}

// ---- fixed slot panels (built once) ----
const panels = {};         // slot -> {root, els}
let bleDevices = [];        // [{name,address}] for the dropdowns (scanned ∪ assigned)
let lastOptSig = null;      // rebuild options only when the BLE list changes

function buildPanel(slot) {
  const root = document.createElement("section");
  root.className = "bg-[#161b22] border border-[#21262d] rounded-xl p-4";
  root.innerHTML = `
    <div class="flex items-center gap-2 mb-2">
      <span class="font-bold text-[15px]">Slot ${slot}</span>
      <span class="text-xs text-[#8b949e]" data-label>—</span>
      <span class="flex-1"></span>
      <span class="phase inline-block px-3 py-1 rounded-lg font-bold text-[13px] bg-phase0" data-phase>—</span>
    </div>
    <select data-sel class="bg-[#0e1116] border border-[#30363d] rounded-lg px-2 py-1.5 text-[13px] w-full mb-2"></select>
    <div class="text-[11px] text-[#8b949e] mb-3" data-meta>no source selected</div>
    <div class="flex gap-4 text-xs text-[#8b949e] mb-3">
      <div>acc_norm <span class="text-[22px] font-bold tabular-nums text-[#e6edf3]" data-accN>—</span></div>
      <div>gyro_norm <span class="text-[22px] font-bold tabular-nums text-[#e6edf3]" data-gyroN>—</span></div>
    </div>
    <div class="grid grid-cols-2 gap-3 text-[13px] tabular-nums mb-3">
      <div class="grid grid-cols-[auto_1fr] gap-x-2">
        <span class="text-[#8b949e]">ax</span><span class="text-right" data-ax>—</span>
        <span class="text-[#8b949e]">ay</span><span class="text-right" data-ay>—</span>
        <span class="text-[#8b949e]">az</span><span class="text-right" data-az>—</span>
      </div>
      <div class="grid grid-cols-[auto_1fr] gap-x-2">
        <span class="text-[#8b949e]">gx</span><span class="text-right" data-gx>—</span>
        <span class="text-[#8b949e]">gy</span><span class="text-right" data-gy>—</span>
        <span class="text-[#8b949e]">gz</span><span class="text-right" data-gz>—</span>
      </div>
    </div>
    <div class="text-[11px] uppercase tracking-wider text-[#8b949e] mt-2">acc_norm</div>
    <canvas data-cacc class="w-full h-20 block"></canvas>
    <div class="text-[11px] uppercase tracking-wider text-[#8b949e] mt-2">gyro_norm</div>
    <canvas data-cgyro class="w-full h-20 block"></canvas>
    <div class="text-[11px] uppercase tracking-wider text-[#8b949e] mt-2">phase</div>
    <canvas data-cphase class="w-full h-16 block"></canvas>
  `;
  $("panels").appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const els = {
    sel: q("[data-sel]"), label: q("[data-label]"), phase: q("[data-phase]"), meta: q("[data-meta]"),
    accN: q("[data-accN]"), gyroN: q("[data-gyroN]"),
    ax: q("[data-ax]"), ay: q("[data-ay]"), az: q("[data-az]"),
    gx: q("[data-gx]"), gy: q("[data-gy]"), gz: q("[data-gz]"),
    cacc: q("[data-cacc]"), cgyro: q("[data-cgyro]"), cphase: q("[data-cphase]"),
  };
  els.sel.onchange = async () => {
    const cfg = parseSlotValue(els.sel.value);
    $("srcHint").textContent = `slot ${slot} → ${els.sel.options[els.sel.selectedIndex].text}…`;
    const res = await postJSON("/slot/set", { slot, ...cfg });
    if (res) $("srcHint").textContent = `slot ${slot} set`;
    pollStatus();
  };
  panels[slot] = { root, els };
}

function renderSlotOptions(sel) {
  const cur = sel.value;
  sel.innerHTML = "";
  const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
  add("", "— no source —");
  add("mock:normal", "Mock: normal");
  add("mock:altered", "Mock: injured");
  bleDevices.forEach((d) => add("ble:" + d.address, `${d.name} (${d.address})`));
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;  // keep selection
}
function renderAllOptions() {
  for (const s of SLOTS) renderSlotOptions(panels[s].els.sel);
}

function clearPanel(slot) {
  const e = panels[slot].els;
  e.label.textContent = "(no source)";
  for (const k of ["ax", "ay", "az", "gx", "gy", "gz"]) e[k].textContent = "—";
  e.accN.textContent = "—"; e.gyroN.textContent = "—";
  e.phase.textContent = "—";
  e.phase.className = "phase inline-block px-3 py-1 rounded-lg font-bold text-[13px] bg-phase0";
  lineChart(e.cacc, [], [], "#58a6ff", 9.80665);
  lineChart(e.cgyro, [], [], "#f0883e");
  stepChart(e.cphase, [], []);
}

// ---- canvas charts (no external libs) ----
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// Map a timestamp (ms) to a pixel x within the [maxT - WINDOW_MS, maxT] scrolling window.
function timeMapX(ts, w) {
  const maxT = ts.length ? ts[ts.length - 1] : 0;
  const left = maxT - WINDOW_MS;
  return (t) => ((t - left) / WINDOW_MS) * w;
}

// Vertical gridline every 2 s + "-Ns / 0s" edge labels (the realtime time axis).
function drawTimeGrid(ctx, w, h, ts) {
  if (!ts || !ts.length) return;
  const maxT = ts[ts.length - 1], X = timeMapX(ts, w);
  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
  for (let s = 0; s <= WINDOW_MS / 1000; s += 2) {
    const px = X(maxT - s * 1000);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }
  ctx.fillStyle = "#6e7681"; ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "left"; ctx.fillText("-" + (WINDOW_MS / 1000) + "s", 2, h - 2);
  ctx.textAlign = "right"; ctx.fillText("0s", w - 2, h - 2); ctx.textAlign = "left";
}

// Stroke a polyline over (ts, data), lifting the pen across time gaps > GAP_MS.
function strokeOverTime(ctx, X, y, ts, data) {
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < data.length; i++) {
    const px = X(ts[i]), py = y(data[i]);
    if (!pen || ts[i] - ts[i - 1] > GAP_MS) { ctx.moveTo(px, py); pen = true; }
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function lineChart(canvas, ts, data, color, baseline = null) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (!data || data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (baseline !== null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const X = timeMapX(ts, w), y = (v) => h - ((v - lo) / (hi - lo)) * h;
  drawTimeGrid(ctx, w, h, ts);
  if (baseline !== null) {
    ctx.strokeStyle = "#30363d"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, y(baseline)); ctx.lineTo(w, y(baseline)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  strokeOverTime(ctx, X, y, ts, data);
}
function stepChart(canvas, ts, data) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (!data || data.length < 2) return;
  const lo = -0.3, hi = 3.3;
  const X = timeMapX(ts, w), y = (v) => h - ((v - lo) / (hi - lo)) * h;
  drawTimeGrid(ctx, w, h, ts);
  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
  for (const lvl of [0, 1, 2, 3]) { ctx.beginPath(); ctx.moveTo(0, y(lvl)); ctx.lineTo(w, y(lvl)); ctx.stroke(); }
  ctx.strokeStyle = "#a371f7"; ctx.lineWidth = 2; ctx.beginPath();
  let pen = false;
  for (let i = 0; i < data.length; i++) {
    const px = X(ts[i]);
    if (!pen || ts[i] - ts[i - 1] > GAP_MS) { ctx.moveTo(px, y(data[i])); pen = true; continue; }
    ctx.lineTo(px, y(data[i - 1])); ctx.lineTo(px, y(data[i]));   // step: hold then rise
  }
  ctx.stroke();
}

// ---- polling ----
async function pollData() {
  try {
    const [series, latest] = await Promise.all([
      api("/series").then((r) => r.json()),
      api("/latest").then((r) => r.json()),
    ]);
    const sdev = series.devices || {}, ldev = latest.devices || {};
    for (const slot of SLOTS) {
      const s = sdev[slot];
      if (!s) { clearPanel(slot); continue; }
      const e = panels[slot].els;
      e.label.textContent = s.label || slot;
      const ts = s.t || [];   // Nano timestamp_ms per sample — the chart x-axis (time)
      lineChart(e.cacc, ts, s.acc_norm, "#58a6ff", 9.80665);
      lineChart(e.cgyro, ts, s.gyro_norm, "#f0883e");
      stepChart(e.cphase, ts, s.phase);
      const L = ldev[slot];
      if (L) {
        for (const k of ["ax", "ay", "az", "gx", "gy", "gz"]) e[k].textContent = fmt(L[k]);
        e.accN.textContent = fmt(L.acc_norm, 2);
        e.gyroN.textContent = fmt(L.gyro_norm, 2);
        e.phase.textContent = PHASE_NAMES[L.phase] ?? "—";
        e.phase.className = "phase inline-block px-3 py-1 rounded-lg font-bold text-[13px] " + (PHASE_BG[L.phase] || PHASE_BG[0]);
      }
    }
  } catch (_) { /* transient */ }
}

async function pollStatus() {
  try {
    const st = await api("/status").then((r) => r.json());
    const slots = st.slots || {};
    const dstat = st.devices_status || {};
    const anyLive = Object.values(dstat).some((d) => d.live);
    const active = Object.values(slots).filter((s) => s && s.kind !== "none").length;
    setBadge(`${active} source(s)`, anyLive ? "live" : "down");
    const total = Object.values(dstat).reduce((a, d) => a + (d.count || 0), 0);
    $("meta").textContent = `samples: ${total}`;

    // Dropdown device list = scanned devices ∪ any address already assigned to a slot.
    const map = new Map();
    for (const d of (st.scan_devices || [])) map.set(d.address, d.name);
    for (const slot of SLOTS) {
      const c = slots[slot];
      if (c && c.kind === "ble" && c.address && !map.has(c.address)) {
        map.set(c.address, c.label || "NanoIMU");
      }
    }
    bleDevices = [...map.entries()].map(([address, name]) => ({ address, name }));
    const sig = bleDevices.map((d) => d.address).join(",");
    if (sig !== lastOptSig) { lastOptSig = sig; renderAllOptions(); }

    // Reflect each slot's configured source + ingest health.
    for (const slot of SLOTS) {
      const e = panels[slot].els;
      const c = slots[slot] || { kind: "none" };
      const want = slotValueFromConfig(c);
      if (e.sel.value !== want) e.sel.value = want;
      const ds = dstat[slot];
      e.meta.textContent = ds
        ? `${ds.source_status || ""} · ${ds.rate_hz ?? 0}Hz · bad:${ds.bad || 0} · lost:${ds.lost || 0}`
        : (c.kind === "none" ? "no source selected" : (c.status || ""));
    }
  } catch (_) {
    setBadge("server unreachable", "down");
  }
}

// ---- controls (POST helper surfaces failures in the hint) ----
async function postJSON(path, body) {
  try {
    const r = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("POST", path, r.status, text);
      $("srcHint").textContent = `POST ${path} → HTTP ${r.status}`;
      return null;
    }
    return await r.json().catch(() => ({}));
  } catch (e) {
    console.error("POST", path, e);
    $("srcHint").textContent = `POST ${path} failed: ${e.message || e}`;
    return null;
  }
}

$("btnScan").onclick = async () => {
  $("srcHint").textContent = "scanning…";
  $("btnScan").disabled = true;
  const res = await postJSON("/ble/scan", { timeout: 8 });
  if (res) $("srcHint").textContent = `found ${(res.devices || []).length} device(s)`;
  $("btnScan").disabled = false;
  pollStatus();   // refresh both dropdowns from the updated scan list
};
$("btnReset").onclick = async () => {
  const res = await postJSON("/reset", {});
  if (res) $("srcHint").textContent = "reset to demo pair";
  pollStatus();
};
$("btnClear").onclick = () => postJSON("/clear", {});

// ---- boot ----
for (const s of SLOTS) buildPanel(s);
renderAllOptions();
pollData();
pollStatus();
setInterval(pollData, 300);
setInterval(pollStatus, 1000);
