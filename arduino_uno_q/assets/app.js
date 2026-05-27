"use strict";

// Two fixed compare slots (A / B). Each slot has its own source <select> (none / mock /
// scanned BLE Nano). Everything goes through the WebUI brick's REST API (no Socket.IO):
// the browser polls /api/* which return JSON keyed by slot ("A"/"B").

const SLOTS = ["A", "B"];

// The nine realtime line charts: canvas key in els -> {field in /api/series, stroke color}.
// accel axes share a blue family, gyro axes an orange family; phase is drawn separately.
const CHANNELS = [
  { c: "cax", f: "ax", color: "#58a6ff" },
  { c: "cay", f: "ay", color: "#79c0ff" },
  { c: "caz", f: "az", color: "#388bfd" },
  { c: "cgx", f: "gx", color: "#f0883e" },
  { c: "cgy", f: "gy", color: "#ffa657" },
  { c: "cgz", f: "gz", color: "#db6d28" },
  { c: "cacc", f: "acc_norm", color: "#58a6ff", baseline: 9.80665 },
  { c: "cgyro", f: "gyro_norm", color: "#f0883e" },
];

const $ = (id) => document.getElementById(id);
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
let viewSlot = "A";         // only one slot is shown full-width at a time (A or B)

// Show one slot full-width; hide the other (its source keeps running in the backend).
// Skipping the hidden panel's 9-canvas redraw is also what keeps the UNO Q CPU happy.
function setViewSlot(slot) {
  viewSlot = slot;
  for (const s of SLOTS) panels[s].root.style.display = (s === slot) ? "" : "none";
  for (const btn of document.querySelectorAll(".slot-tab")) {
    const on = btn.dataset.slot === slot;
    btn.className = "slot-tab px-3 py-1 rounded-lg text-[13px] font-semibold border border-[#30363d] " +
      (on ? "bg-[#21262d]" : "text-[#8b949e]");
  }
  // The panel was hidden (display:none → 0px), so its charts need a resize before redraw.
  const p = panels[slot];
  if (p) for (const k in p.charts) p.charts[k].resize();
  pollData();   // redraw the now-visible slot immediately (don't wait for the next tick)
}

function buildPanel(slot) {
  const root = document.createElement("section");
  root.className = "bg-[#161b22] border border-[#21262d] rounded-xl p-4";
  // One <label + canvas> block per channel. `top` starts a new visual group (border + gap).
  // Chart.js sizes the canvas to its parent, so the height lives on the wrapper div.
  const chart = (key, title, top) =>
    `<div class="text-[11px] uppercase tracking-wider text-[#8b949e] mt-2${
      top ? " border-t border-[#21262d] pt-3" : ""}">${title}</div>
     <div class="relative h-24"><canvas data-c${key}></canvas></div>`;
  root.innerHTML = `
    <div class="flex items-center gap-2 mb-2">
      <span class="font-bold text-[15px]">Slot ${slot}</span>
      <span class="text-xs text-[#8b949e]" data-label>—</span>
      <span class="flex-1"></span>
      <span class="text-xs font-semibold text-[#8b949e]" data-live>—</span>
    </div>
    <select data-sel class="bg-[#0e1116] border border-[#30363d] rounded-lg px-2 py-1.5 text-[13px] w-full mb-2"></select>
    <div class="text-[11px] text-[#8b949e] mb-2" data-meta>no source selected</div>
    ${chart("ax", "ax (m/s²)", true)}
    ${chart("ay", "ay (m/s²)")}
    ${chart("az", "az (m/s²)")}
    ${chart("gx", "gx (dps)", true)}
    ${chart("gy", "gy (dps)")}
    ${chart("gz", "gz (dps)")}
    ${chart("acc", "acc_norm (m/s²)", true)}
    ${chart("gyro", "gyro_norm (dps)")}
    ${chart("phase", "phase", true)}
  `;
  $("panels").appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const els = {
    sel: q("[data-sel]"), label: q("[data-label]"), live: q("[data-live]"), meta: q("[data-meta]"),
    cax: q("[data-cax]"), cay: q("[data-cay]"), caz: q("[data-caz]"),
    cgx: q("[data-cgx]"), cgy: q("[data-cgy]"), cgz: q("[data-cgz]"),
    cacc: q("[data-cacc]"), cgyro: q("[data-cgyro]"), cphase: q("[data-cphase]"),
  };
  els.sel.onchange = async () => {
    const cfg = parseSlotValue(els.sel.value);
    $("srcHint").textContent = `slot ${slot} → ${els.sel.options[els.sel.selectedIndex].text}…`;
    const res = await postJSON("/slot/set", { slot, ...cfg });
    if (res) $("srcHint").textContent = `slot ${slot} set`;
    pollStatus();
  };
  // One Chart.js chart per channel (built once; updated in place on each poll).
  const charts = {};
  for (const ch of CHANNELS) charts[ch.c] = makeLineChart(els[ch.c], ch.color, ch.baseline);
  charts.cphase = makePhaseChart(els.cphase);
  panels[slot] = { root, els, charts };
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
  const { els, charts } = panels[slot];
  els.label.textContent = "(no source)";
  els.live.textContent = "—";
  for (const ch of CHANNELS) updateChart(charts[ch.c], [], [], ch.baseline);
  updateChart(charts.cphase, [], []);
}

// ---- Chart.js charts (vendored offline) ----
// Shared dark theme. x is a linear axis over the Nano timestamp_ms; we slide its [min,max]
// each poll to make the 10 s window scroll right→left, and label ticks relative to "now" (0s).
function baseOptions() {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,        // data is pre-shaped as {x, y}
    normalized: true,
    scales: {
      x: {
        type: "linear",
        grid: { color: "#21262d" },
        border: { display: false },
        ticks: {
          color: "#6e7681", font: { size: 9 }, maxRotation: 0,
          autoSkip: true, maxTicksLimit: 6, stepSize: 2000,
          callback(v) { return Math.round((v - this.chart.scales.x.max) / 1000) + "s"; },
        },
      },
      y: {
        grid: { color: "#21262d" },
        border: { display: false },
        ticks: { color: "#6e7681", font: { size: 9 }, maxTicksLimit: 4 },
      },
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  };
}

// A scrolling line chart. `baseline` (optional) draws a dashed reference line (e.g. gravity).
function makeLineChart(canvas, color, baseline) {
  const datasets = [{
    data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0,
    tension: 0, spanGaps: GAP_MS, fill: false,
  }];
  if (baseline != null) {
    datasets.push({
      data: [], borderColor: "#30363d", borderWidth: 1,
      borderDash: [4, 4], pointRadius: 0, spanGaps: true,
    });
  }
  return new Chart(canvas, { type: "line", data: { datasets }, options: baseOptions() });
}

// The phase chart: a stepped line locked to the four phase levels (0..3).
function makePhaseChart(canvas) {
  const o = baseOptions();
  o.scales.y.min = -0.3; o.scales.y.max = 3.3;
  o.scales.y.ticks = {
    color: "#6e7681", font: { size: 9 }, stepSize: 1,
    callback: (v) => ([0, 1, 2, 3].includes(v) ? v : ""),
  };
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ data: [], borderColor: "#a371f7", borderWidth: 1.5, pointRadius: 0, stepped: true, spanGaps: GAP_MS }] },
    options: o,
  });
}

// Push (ts, data) into a chart and slide the 10 s window to end at the newest sample.
function updateChart(chart, ts, data, baseline) {
  const pts = new Array(data.length);
  for (let i = 0; i < data.length; i++) pts[i] = { x: ts[i], y: data[i] };
  chart.data.datasets[0].data = pts;
  const maxT = ts.length ? ts[ts.length - 1] : 0;
  chart.options.scales.x.min = maxT - WINDOW_MS;
  chart.options.scales.x.max = maxT;
  if (baseline != null && chart.data.datasets[1]) {
    chart.data.datasets[1].data = ts.length
      ? [{ x: maxT - WINDOW_MS, y: baseline }, { x: maxT, y: baseline }] : [];
  }
  chart.update("none");
}

// ---- polling ----
async function pollData() {
  try {
    const series = await api("/series").then((r) => r.json());
    const sdev = series.devices || {};
    for (const slot of SLOTS) {
      if (slot !== viewSlot) continue;   // only the visible slot needs its charts redrawn
      const s = sdev[slot];
      if (!s) { clearPanel(slot); continue; }
      const { els, charts } = panels[slot];
      els.label.textContent = s.label || slot;
      const ts = s.t || [];   // Nano timestamp_ms per sample — the chart x-axis (time)
      for (const ch of CHANNELS) updateChart(charts[ch.c], ts, s[ch.f] || [], ch.baseline);
      updateChart(charts.cphase, ts, s.phase || []);
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
        ? `${ds.source_status || ""} · ${ds.rate_hz ?? 0}Hz · bad:${ds.bad || 0} · lost:${ds.lost || 0} · drop:${ds.dropped || 0} · buf:${ds.buffered ?? 0}/${ds.buffer_max ?? 0}`
        : (c.kind === "none" ? "no source selected" : (c.status || ""));
      if (ds && ds.live) {
        e.live.textContent = "● LIVE";
        e.live.className = "text-xs font-semibold text-[#3fb950]";
      } else {
        e.live.textContent = c.kind === "none" ? "—" : "○ offline";
        e.live.className = "text-xs font-semibold text-[#8b949e]";
      }
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
for (const btn of document.querySelectorAll(".slot-tab")) btn.onclick = () => setViewSlot(btn.dataset.slot);
setViewSlot("A");   // default to slot A; hides B
pollData();
pollStatus();
setInterval(pollData, 300);
setInterval(pollStatus, 1000);
