"use strict";

const PHASE_NAMES = {
  0: "UNKNOWN", 1: "STATIONARY / ZERO-VEL",
  2: "GROUND CONTACT + ROTATION", 3: "SWING / ON-AIR",
};
const MAXPTS = 200;
const acc = [], gyro = [];   // client-side ring buffers for the charts

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v === null || v === undefined) ? "—" : Number(v).toFixed(d);

// REST helper: WebUI brick serves these under /api/...; also try the bare path
// in case a given build doesn't prefix them.
async function apiFetch(path, opts) {
  for (const url of [`/api${path}`, path]) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
    } catch (_) { /* try next */ }
  }
  return null;
}

function setBadge(text, cls) {
  const b = $("badge");
  b.textContent = text;
  b.className = cls || "";
}

function handleSample(s) {
  if (!s) return;
  for (const k of ["ax", "ay", "az", "gx", "gy", "gz"]) $(k).textContent = fmt(s[k]);
  $("accN").textContent = fmt(s.acc_norm, 2);
  $("gyroN").textContent = fmt(s.gyro_norm, 2);
  const ph = $("phase");
  ph.textContent = PHASE_NAMES[s.phase] ?? "—";
  ph.className = "phase p" + (s.phase ?? 0);

  acc.push(s.acc_norm); if (acc.length > MAXPTS) acc.shift();
  gyro.push(s.gyro_norm); if (gyro.length > MAXPTS) gyro.shift();
  drawChart($("cAcc"), acc, "#58a6ff", 9.80665);
  drawChart($("cGyro"), gyro, "#f0883e");
}

// Minimal self-contained line chart on a canvas (no external libs).
function drawChart(canvas, data, color, baseline = null) {
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
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;

  if (baseline !== null) {
    ctx.strokeStyle = "#30363d"; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, y(baseline)); ctx.lineTo(w, y(baseline)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.stroke();
}

async function refreshStatus() {
  const r = await apiFetch("/status");
  if (!r) { setBadge("server unreachable", "down"); return; }
  const s = await r.json();
  const live = s.live;
  setBadge(`${s.mode || "?"} · ${s.source_status || ""}${live ? " · live" : ""}`,
           (s.mode === "mock" || live) ? "live" : "down");
  $("meta").textContent = `samples: ${s.count}`
    + (s.tsstore ? ` · db:${s.tsstore}` : "")
    + (s.age_s !== null ? ` · last ${s.age_s}s ago` : "");
}

async function backfill() {
  // Seed the charts from /series (column arrays) ...
  const rs = await apiFetch("/series");
  if (rs) {
    const s = await rs.json();
    (s.acc_norm || []).forEach((v) => acc.push(v));
    (s.gyro_norm || []).forEach((v) => gyro.push(v));
    while (acc.length > MAXPTS) acc.shift();
    while (gyro.length > MAXPTS) gyro.shift();
  }
  // ... and the numeric panels from /latest.
  const rl = await apiFetch("/latest");
  if (rl) handleSample((await rl.json()).latest);
}

// --- real-time: Socket.IO push from the WebUI brick's send_message ---
function startRealtime() {
  if (typeof io === "function") {
    const socket = io(`http://${window.location.host}`);
    socket.on("imu_sample", handleSample);
    return;
  }
  // The Socket.IO client script didn't load (check /socket.io/socket.io.js).
  // Keep the page usable by polling the /latest REST endpoint.
  console.warn("Socket.IO client not loaded; polling /latest instead");
  setInterval(async () => {
    const r = await apiFetch("/latest");
    if (r) handleSample((await r.json()).latest);
  }, 150);
}

$("btnClear").onclick = async () => {
  await apiFetch("/clear", { method: "POST" });
  acc.length = 0; gyro.length = 0;
};
$("btnExport").onclick = async () => {
  const r = await apiFetch("/export_csv");
  if (!r) return;
  const { filename, csv } = await r.json();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename || "imu_samples.csv";
  a.click();
};

backfill();
startRealtime();
refreshStatus();
setInterval(refreshStatus, 1000);
