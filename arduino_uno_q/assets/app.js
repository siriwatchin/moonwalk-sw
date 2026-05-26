"use strict";

// Multi-device dashboard. Reads everything via the WebUI brick's REST API (no Socket.IO);
// the browser polls /api/* which return one JSON blob keyed by device.

const PHASE_NAMES = {
  0: "UNKNOWN", 1: "STATIONARY / ZERO-VEL",
  2: "GROUND CONTACT + ROTATION", 3: "SWING / ON-AIR",
};
const PHASE_BG = { 0: "bg-phase0", 1: "bg-phase1", 2: "bg-phase2", 3: "bg-phase3" };

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v === null || v === undefined) ? "—" : Number(v).toFixed(d);
const api = (path, opts) => fetch(`/api${path}`, { cache: "no-store", ...(opts || {}) });

function setBadge(text, cls) {
  const b = $("badge");
  b.textContent = text;
  b.className = "px-3 py-1 rounded-full text-[13px] font-semibold " +
    (cls === "live" ? "bg-[#1f6f3d]" : cls === "down" ? "bg-[#8a1f1f]" : "bg-[#30363d]");
}

// ---- per-device cards (created on demand, keyed by device) ----
const cards = {};          // key -> {root, els, acc[], gyro[], phase[]}
const MAXPTS = 200;

function deviceCard(key) {
  if (cards[key]) return cards[key];
  const root = document.createElement("section");
  root.className = "bg-[#161b22] border border-[#21262d] rounded-xl p-4";
  root.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <span class="font-bold text-[15px]" data-label>—</span>
      <span class="text-xs text-[#8b949e]" data-key></span>
      <span class="flex-1"></span>
      <span class="phase inline-block px-3 py-1 rounded-lg font-bold text-[13px] bg-phase0" data-phase>—</span>
    </div>
    <div class="text-[11px] text-[#8b949e] mb-3" data-meta></div>
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
  $("devices").appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const card = {
    root,
    els: {
      label: q("[data-label]"), key: q("[data-key]"), phase: q("[data-phase]"), meta: q("[data-meta]"),
      accN: q("[data-accN]"), gyroN: q("[data-gyroN]"),
      ax: q("[data-ax]"), ay: q("[data-ay]"), az: q("[data-az]"),
      gx: q("[data-gx]"), gy: q("[data-gy]"), gz: q("[data-gz]"),
      cacc: q("[data-cacc]"), cgyro: q("[data-cgyro]"), cphase: q("[data-cphase]"),
    },
    acc: [], gyro: [], phase: [],
  };
  card.els.key.textContent = key;
  cards[key] = card;
  return card;
}

function removeCard(key) {
  if (cards[key]) { cards[key].root.remove(); delete cards[key]; }
}

// ---- canvas charts (no external libs) ----
function lineChart(canvas, data, color, baseline = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (baseline !== null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const x = (i) => (i / (data.length - 1)) * w, y = (v) => h - ((v - lo) / (hi - lo)) * h;
  if (baseline !== null) {
    ctx.strokeStyle = "#30363d"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, y(baseline)); ctx.lineTo(w, y(baseline)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.stroke();
}
function stepChart(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;
  const lo = -0.3, hi = 3.3;
  const x = (i) => (i / (data.length - 1)) * w, y = (v) => h - ((v - lo) / (hi - lo)) * h;
  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
  for (const lvl of [0, 1, 2, 3]) { ctx.beginPath(); ctx.moveTo(0, y(lvl)); ctx.lineTo(w, y(lvl)); ctx.stroke(); }
  ctx.strokeStyle = "#a371f7"; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((v, i) => {
    const px = x(i);
    if (i === 0) { ctx.moveTo(px, y(v)); return; }
    ctx.lineTo(px, y(data[i - 1])); ctx.lineTo(px, y(v));
  });
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
    const seen = new Set();
    for (const [key, s] of Object.entries(sdev)) {
      seen.add(key);
      const card = deviceCard(key);
      card.els.label.textContent = s.label || key;
      lineChart(card.els.cacc, s.acc_norm, "#58a6ff", 9.80665);
      lineChart(card.els.cgyro, s.gyro_norm, "#f0883e");
      stepChart(card.els.cphase, s.phase);
      const L = ldev[key];
      if (L) {
        for (const k of ["ax", "ay", "az", "gx", "gy", "gz"]) card.els[k].textContent = fmt(L[k]);
        card.els.accN.textContent = fmt(L.acc_norm, 2);
        card.els.gyroN.textContent = fmt(L.gyro_norm, 2);
        card.els.phase.textContent = PHASE_NAMES[L.phase] ?? "—";
        card.els.phase.className = "phase inline-block px-3 py-1 rounded-lg font-bold text-[13px] " + (PHASE_BG[L.phase] || PHASE_BG[0]);
      }
    }
    // drop cards for devices that no longer exist
    for (const key of Object.keys(cards)) if (!seen.has(key)) removeCard(key);
  } catch (_) { /* transient */ }
}

function reflectMode(mode) {
  const on = " bg-[#1f6f3d] border-[#1f6f3d]";
  for (const [id, m] of [["srcMock", "mock"], ["srcBle", "ble"]]) {
    const el = $(id);
    el.className = el.className.replace(on, "");
    if (mode === m) el.className += on;
  }
  const ble = mode === "ble";
  $("btnScan").disabled = !ble;
  $("devSel").disabled = !ble;
  $("devLabel").disabled = !ble;
  $("btnConnect").disabled = !ble || !$("devSel").value;
}

async function pollStatus() {
  try {
    const s = await api("/status").then((r) => r.json());
    const devs = s.devices || [];
    const anyLive = Object.values(s.devices_status || {}).some((d) => d.live);
    setBadge(`${s.mode} · ${devs.length} device(s)`, (s.mode === "mock" || anyLive) ? "live" : "down");
    // total samples across devices
    const dstat = s.devices_status || {};
    const total = Object.values(dstat).reduce((a, d) => a + (d.count || 0), 0);
    $("meta").textContent = `samples: ${total}`;
    // per-device ingest health on each card
    for (const [key, d] of Object.entries(dstat)) {
      const card = cards[key];
      if (card) {
        card.els.meta.textContent =
          `${d.source_status || ""} · ${d.rate_hz ?? 0}Hz · bad:${d.bad || 0} · lost:${d.lost || 0}`;
      }
    }
    reflectMode(s.mode);
    // connected-device chips with disconnect buttons
    const cl = $("connList");
    cl.innerHTML = "";
    devs.forEach((d) => {
      const chip = document.createElement("span");
      chip.className = "inline-flex items-center gap-2 bg-[#21262d] border border-[#30363d] rounded-full px-3 py-1 text-[12px]";
      chip.innerHTML = `<b>${d.label}</b> <span class="text-[#8b949e]">${d.status}</span>`;
      const x = document.createElement("button");
      x.textContent = "✕"; x.className = "text-[#8b949e] hover:text-white";
      x.onclick = () => postJSON("/ble/disconnect", { key: d.key }).then(pollStatus);
      chip.appendChild(x);
      cl.appendChild(chip);
    });
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

$("srcMock").onclick = async () => {
  $("srcHint").textContent = "switching to mock…";
  const res = await postJSON("/source", { mode: "mock" });
  if (res) $("srcHint").textContent = "mock: normal + injured";
  pollStatus();
};
$("srcBle").onclick = async () => {
  $("srcHint").textContent = "switching to BLE…";
  const res = await postJSON("/source", { mode: "ble" });
  if (res) $("srcHint").textContent = "BLE — Scan, pick a device, label it, Connect (repeat to add more)";
  pollStatus();
};
$("btnScan").onclick = async () => {
  $("srcHint").textContent = "scanning…";
  $("btnScan").disabled = true;
  const res = await postJSON("/ble/scan", { timeout: 6 });
  if (res) {
    const devices = res.devices || [];
    const sel = $("devSel");
    sel.innerHTML = '<option value="">— select device —</option>';
    devices.forEach((d) => {
      const o = document.createElement("option");
      o.value = d.address; o.textContent = `${d.name}  (${d.address})`;
      sel.appendChild(o);
    });
    $("srcHint").textContent = `found ${devices.length} device(s)`;
  }
  $("btnScan").disabled = false;
};
$("devSel").onchange = () => { $("btnConnect").disabled = !$("devSel").value; };
$("btnConnect").onclick = async () => {
  const address = $("devSel").value;
  if (!address) return;
  const label = $("devLabel").value.trim() || undefined;
  $("srcHint").textContent = `connecting ${address}…`;
  const res = await postJSON("/ble/connect", { address, label });
  if (res) { $("srcHint").textContent = `added ${label || address}`; $("devLabel").value = ""; }
  pollStatus();
};
$("btnClear").onclick = () => postJSON("/clear", {});

pollData();
pollStatus();
setInterval(pollData, 300);
setInterval(pollStatus, 1000);
