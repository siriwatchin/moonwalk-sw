"use strict";

// Dashboard reads everything via the WebUI brick's REST API (no Socket.IO).
// Endpoints are registered on the brick under /api/...; the page polls them.

const PHASE_NAMES = {
  0: "UNKNOWN", 1: "STATIONARY / ZERO-VEL",
  2: "GROUND CONTACT + ROTATION", 3: "SWING / ON-AIR",
};
const PHASE_BG = { 0: "bg-phase0", 1: "bg-phase1", 2: "bg-phase2", 3: "bg-phase3" };
const PHASE_BASE = "inline-block mt-1 px-3.5 py-1.5 rounded-lg font-bold text-[15px] ";

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v === null || v === undefined) ? "—" : Number(v).toFixed(d);
const api = (path, opts) => fetch(`/api${path}`, { cache: "no-store", ...(opts || {}) });

function setBadge(text, cls) {
  const b = $("badge");
  b.textContent = text;
  b.className = cls || "";
}

function renderLatest(s) {
  if (!s) return;
  for (const k of ["ax", "ay", "az", "gx", "gy", "gz"]) $(k).textContent = fmt(s[k]);
  $("accN").textContent = fmt(s.acc_norm, 2);
  $("gyroN").textContent = fmt(s.gyro_norm, 2);
  const ph = $("phase");
  ph.textContent = PHASE_NAMES[s.phase] ?? "—";
  ph.className = PHASE_BASE + (PHASE_BG[s.phase] ?? PHASE_BG[0]);
}

// Step chart for the phase code (0..3) over time.
function drawPhase(canvas, data) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  if (!data || data.length < 2) return;

  const lo = -0.3, hi = 3.3;
  const x = (i) => (i / (data.length - 1)) * w;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;

  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;          // gridlines at 0..3
  for (const lvl of [0, 1, 2, 3]) {
    ctx.beginPath(); ctx.moveTo(0, y(lvl)); ctx.lineTo(w, y(lvl)); ctx.stroke();
  }
  ctx.strokeStyle = "#a371f7"; ctx.lineWidth = 2; ctx.beginPath();  // step line (post)
  data.forEach((v, i) => {
    const px = x(i);
    if (i === 0) { ctx.moveTo(px, y(v)); return; }
    ctx.lineTo(px, y(data[i - 1]));   // hold previous level
    ctx.lineTo(px, y(v));             // step to new level
  });
  ctx.stroke();
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

// Charts + latest numbers (server keeps the rolling buffer; we just render it).
async function pollData() {
  try {
    const [series, latest] = await Promise.all([
      api("/series").then((r) => r.json()),
      api("/latest").then((r) => r.json()),
    ]);
    drawChart($("cAcc"), series.acc_norm, "#58a6ff", 9.80665);
    drawChart($("cGyro"), series.gyro_norm, "#f0883e");
    drawPhase($("cPhase"), series.phase);
    renderLatest(latest.latest);
  } catch (_) { /* transient — next tick retries */ }
}

async function pollStatus() {
  try {
    const s = await api("/status").then((r) => r.json());
    setBadge(`${s.mode || "?"} · ${s.source_status || ""}${s.live ? " · live" : ""}`,
             (s.mode === "mock" || s.live) ? "live" : "down");
    $("meta").textContent = `samples: ${s.count}`
      + (s.tsstore ? ` · db:${s.tsstore}` : "")
      + (s.age_s != null ? ` · last ${s.age_s}s ago` : "");
  } catch (_) {
    setBadge("server unreachable", "down");
  }
}

$("btnClear").onclick = () => api("/clear", { method: "POST" });
$("btnExport").onclick = async () => {
  try {
    const { filename, csv } = await api("/export_csv").then((r) => r.json());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = filename || "imu_samples.csv";
    a.click();
  } catch (_) { /* ignore */ }
};

pollData();
pollStatus();
setInterval(pollData, 300);     // charts + latest values
setInterval(pollStatus, 1000);  // connection / status badge
