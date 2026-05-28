"use strict";

// Single active source realtime dashboard. The browser polls the INCREMENTAL endpoint
// /api/samples?since_seq=<n> (not a full-window reload), appends new samples into a local ring
// buffer trimmed to the 10 s window, and a SEPARATE throttled render loop redraws the
// Chart.js charts only when new data arrived. InfluxDB is never on this hot path. No Socket.IO.

// The realtime channels: field -> {stroke colour, chart title}. accel = blue family,
// gyro = orange family, pressure = green. Mid-tones read on both light and dark themes.
const CHANNELS = [
  { f: "ax", color: "#1f6feb", title: "ax (m/s²)" },
  { f: "ay", color: "#0969da", title: "ay (m/s²)" },
  { f: "az", color: "#218bff", title: "az (m/s²)" },
  { f: "gx", color: "#bc4c00", title: "gx (dps)" },
  { f: "gy", color: "#e16f24", title: "gy (dps)" },
  { f: "gz", color: "#fb8f44", title: "gz (dps)" },
  { f: "pressure", color: "#1a7f37", title: "pressure (Pa)" },
];

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(`/api${path}`, { cache: "no-store", ...(opts || {}) });

const WINDOW_MS = 10000;    // realtime chart window + ring-buffer time trim
const SAMPLE_LIMIT = 200;   // max samples returned per /api/samples poll (~10 s @ 20 Hz)
const POLL_MS = 250;        // realtime data poll cadence
const STATUS_MS = 1000;     // status poll cadence (badge / data quality)
// Render runs on requestAnimationFrame and skips every other frame (~30 FPS). At ~250 ms poll
// cadence the data only changes ~4 times/sec, but the x-axis is projected from the wall clock
// each frame so the trace SLIDES smoothly between polls — no more "axis jumps in 250 ms steps".
const RENDER_FRAME_SKIP = 1;  // 0 = every frame (60 FPS), 1 = every 2nd (30 FPS), 2 = every 3rd (20 FPS) ...
const STALL_MS = 1500;        // if no new sample arrives within this window, freeze the projection
                              // so the trace doesn't slide off the right past actual data

// Wellness-framed data-quality copy (no medical wording; carries the claim-safety disclaimer).
const MSG_MISSING = "Some walking movement samples may be missing. This is a wellness awareness cue, not a medical assessment.";
const MSG_RESUMED = "Your walking data stream has resumed. This is a wellness awareness cue, not a medical assessment.";

// ---- browser-side ring buffer (parallel arrays, trimmed by time each poll) ----
const buf = { seq: [], t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [], pressure: [] };
let lastSeq = 0;            // highest seq we've consumed (sent as since_seq)
let dirty = false;          // gates the rebuild of chart datasets (axis still slides every frame)
// Wall-clock anchor: lets the render loop project a "current" x-axis time between polls.
// Each successful pollSamples that appended new data sets anchorT = newest sample t and
// anchorWall = performance.now(). render() then projects:
//   maxT = anchorT + min(performance.now() - anchorWall, STALL_MS)
// giving a continuously-sliding axis even between data arrivals (oscilloscope feel).
let anchorWall = 0;
let anchorT = 0;
let serverDown = false;     // true while /api/status is unreachable (toast on transition)
let wasLive = false;        // previous status poll's live flag (for resumed/missing messages)
let everLive = false;       // has the source ever been live this session
let bleDevices = [];        // [{name,address}] for the dropdown (scanned ∪ active)
let lastOptSig = null;      // rebuild dropdown options only when the BLE list changes

// ---- small helpers -------------------------------------------------------
// Compact numeric formatter for the per-channel readout (accel ~±20, gyro ~±2000).
function fmt(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

function setHint(text) { $("srcHint").textContent = text; }

function setBadge(text, cls) {
  const b = $("badge");
  // A glyph carries the state too, so it doesn't rely on colour alone (a11y).
  const glyph = cls === "live" ? "● " : cls === "down" ? "○ " : "";
  b.textContent = glyph + text;
  b.className = "badge gap-1 " + (cls === "live" ? "badge-success text-success-content"
    : cls === "down" ? "badge-error text-error-content"
    : "badge-ghost");
}

// Build the data-quality chip row (innerHTML) for the panel. Severity drives the badge colour
// so anomalies stand out — but a glyph/text on each chip means colour isn't the only signal.
function renderChipsHtml(active, ds) {
  if (!active) return `<span class="text-[11px] opacity-60">no source selected</span>`;
  const chip = (cls, txt) => `<span class="badge badge-sm ${cls}">${txt}</span>`;
  const sev = (n) => (n > 0 ? "badge-warning" : "badge-ghost");
  return [
    chip("badge-ghost", ds.source_status || "—"),
    chip("badge-outline", `${ds.rate_hz ?? 0} Hz`),
    chip(sev(ds.bad), `bad ${ds.bad || 0}`),
    chip(sev(ds.lost), `lost ${ds.lost || 0}`),
    chip(sev(ds.dropped), `drop ${ds.dropped || 0}`),
    chip("badge-ghost", `buf ${ds.buffered ?? 0}/${ds.buffer_max ?? 0}`),
  ].join("");
}

// Transient error toast (bottom-right) for POST failures / server-unreachable, so they don't
// get silently overwritten in the informational #srcHint line.
function toast(msg) {
  const stack = $("toasts");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Theme-dependent chart colours, read live from CSS variables so the canvas charts match the UI.
function chartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  return {
    grid: v("--chart-grid", "#d8dee4"),
    tick: v("--chart-tick", "#8c959f"),
  };
}

// ---- source <select> encoding ----
//   ""             -> none
//   "mock:normal"  -> mock gait normal
//   "mock:altered" -> mock gait altered (shown as "changed pattern")
//   "ble:<addr>"   -> live BLE source by address
function parseSourceValue(v) {
  if (!v) return { kind: "none" };
  const i = v.indexOf(":");
  const kind = v.slice(0, i), rest = v.slice(i + 1);
  if (kind === "mock") return { kind: "mock", gait: rest };
  if (kind === "ble") return { kind: "ble", address: rest };
  return { kind: "none" };
}
function sourceValueFromConfig(cfg) {
  if (!cfg) return "";
  if (cfg.kind === "mock") return "mock:" + (cfg.gait || "normal");
  if (cfg.kind === "ble") return "ble:" + cfg.address;
  return "";
}

function renderSourceOptions() {
  const sel = $("srcSel");
  const cur = sel.value;
  sel.innerHTML = "";
  const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
  add("", "— no source —");
  add("mock:normal", "Mock: normal");
  add("mock:altered", "Mock: changed pattern");
  bleDevices.forEach((d) => add("ble:" + d.address, `${d.name} (${d.address})`));
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;  // keep selection
}

// ---- the single panel (built once) ---------------------------------------
const charts = {};   // field -> Chart
const els = { val: {}, nd: {} };

function buildPanel() {
  const root = $("panel");
  root.className = "bg-[var(--panel)] border border-[var(--border)] rounded-xl p-3 flex flex-col min-h-0 lg:h-full";
  // The pressure cell spans the full bottom row so the 7-channel grid stays balanced (accel
  // row · gyro row · pressure full-width) instead of leaving two empty cells in 3×3.
  const chart = (key, title, wide) =>
    `<div class="flex flex-col min-h-[140px] lg:min-h-0${wide ? " md:col-span-2 lg:col-span-3" : ""}">
       <div class="flex items-baseline justify-between gap-1 shrink-0">
         <span class="text-[10px] uppercase tracking-wider text-[var(--muted)]">${title}</span>
         <span class="text-[11px] font-semibold tabular-nums" data-val${key}>—</span>
       </div>
       <div class="relative flex-1 min-h-0">
         <canvas data-c${key}></canvas>
         <div class="no-data" data-nd${key}>no data</div>
       </div>
     </div>`;
  root.innerHTML = `
    <div class="flex items-center gap-2 mb-2 shrink-0">
      <span class="font-bold text-[15px]">Realtime</span>
      <span class="text-xs text-[var(--muted)]" data-label>—</span>
      <span class="flex-1"></span>
      <span class="text-xs font-semibold text-[var(--muted)]" data-live>—</span>
    </div>
    <!-- Data-quality chips (daisyUI badges) populated by pollStatus. Empty until a source is set. -->
    <div class="flex flex-wrap items-center gap-1 mb-2 shrink-0" data-meta></div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 lg:grid-rows-3 gap-2 flex-1 min-h-0">
      ${CHANNELS.map((c) => chart(c.f, c.title, c.f === "pressure")).join("")}
    </div>
  `;
  const q = (sel) => root.querySelector(sel);
  els.label = q("[data-label]"); els.live = q("[data-live]"); els.meta = q("[data-meta]");
  for (const ch of CHANNELS) {
    els.val[ch.f] = q(`[data-val${ch.f}]`);
    els.nd[ch.f] = q(`[data-nd${ch.f}]`);
    charts[ch.f] = makeLineChart(q(`[data-c${ch.f}]`), ch.color);
  }
}

// ---- Chart.js charts (vendored offline) ----
// x is a linear axis over the Nano timestamp_ms; the render loop slides [min,max] each frame so
// the 10 s window scrolls right→left, labelling ticks relative to "now" (0s).
function baseOptions() {
  const c = chartTheme();
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,        // data is pre-shaped as {x, y}
    normalized: true,
    scales: {
      x: {
        type: "linear",
        grid: { color: c.grid },
        border: { display: false },
        ticks: {
          color: c.tick, font: { size: 9 }, maxRotation: 0,
          autoSkip: true, maxTicksLimit: 6, stepSize: 2000,
          callback(v) { return Math.round((v - this.chart.scales.x.max) / 1000) + "s"; },
        },
      },
      y: {
        grid: { color: c.grid },
        border: { display: false },
        ticks: { color: c.tick, font: { size: 9 }, maxTicksLimit: 4 },
      },
    },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
  };
}

function makeLineChart(canvas, color) {
  return new Chart(canvas, {
    type: "line",
    data: { datasets: [{ data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0, spanGaps: false, fill: false }] },
    options: baseOptions(),
  });
}

// ---- ring buffer ops -----------------------------------------------------
function clearBuf() {
  for (const k in buf) buf[k].length = 0;
  lastSeq = 0;
  anchorWall = 0;   // drop the projection anchor too — next sample will set a fresh one
  anchorT = 0;
  dirty = true;     // let the render loop draw the now-empty state (no-data overlays)
}

function trimByTime() {
  const n = buf.t.length;
  if (!n) return;
  const cutoff = buf.t[n - 1] - WINDOW_MS;
  let drop = 0;
  while (drop < n && buf.t[drop] < cutoff) drop++;
  if (drop) for (const k in buf) buf[k].splice(0, drop);
}

// ---- data poll (incremental; append-only) --------------------------------
async function pollSamples() {
  let r;
  try {
    r = await api(`/samples?since_seq=${lastSeq}&limit=${SAMPLE_LIMIT}`).then((x) => x.json());
  } catch (_) {
    return;   // transient — the status loop owns the offline UI
  }
  const list = r.samples || [];
  // Two reset shapes — and they should be handled DIFFERENTLY:
  //   (a) seq went backwards (latest_seq < lastSeq): source was actually restarted
  //       (set_source / /reset / /clear / container restart). Old buf samples are from a
  //       different time origin (the Nano `t` also restarted) — must wipe.
  //   (b) r.reset === true while seq still moving forward: the client just fell behind the
  //       server's ring buffer (e.g. tab was backgrounded long enough that 2-min buffer wrapped).
  //       Old buf samples are still valid until they fall outside the 10 s window — leave them
  //       and let trimByTime drop them naturally. Surface a toast so the gap is explicit.
  const seqWentBack = typeof r.latest_seq === "number" && r.latest_seq < lastSeq;
  if (seqWentBack) {
    clearBuf();
  } else if (r.reset && lastSeq > 0 && (r.latest_seq - lastSeq) > 20) {
    const gapS = Math.round((r.latest_seq - lastSeq) / 20);   // 20 Hz → seq/20 ≈ seconds
    toast(`Data gap recovered (~${gapS}s)`);
  }
  if (list.length) {
    const lastBufSeq = buf.seq.length ? buf.seq[buf.seq.length - 1] : 0;
    for (const s of list) {
      // Dedupe: on a "fell behind" reset, server resends its latest window which may overlap.
      // Skip seq we've already consumed so buf stays strictly monotonic.
      if (s.seq <= lastBufSeq) continue;
      buf.seq.push(s.seq); buf.t.push(s.t);
      buf.ax.push(s.ax); buf.ay.push(s.ay); buf.az.push(s.az);
      buf.gx.push(s.gx); buf.gy.push(s.gy); buf.gz.push(s.gz);
      buf.pressure.push(s.pressure);
    }
    trimByTime();
    dirty = true;
    // Anchor wall-clock to the newest sample's t — the render loop projects from here so the
    // x-axis slides smoothly between polls instead of jumping ~250 ms per poll.
    const n = buf.t.length;
    if (n) { anchorT = buf.t[n - 1]; anchorWall = performance.now(); }
  }
  if (typeof r.latest_seq === "number") lastSeq = r.latest_seq;
}

// ---- render loop (rAF; redraws every frame, but only rebuilds datasets when dirty) -------
// Decouples DATA arrival (~4 Hz, on each pollSamples) from VISUAL slide (~30 FPS). The x-axis
// is projected from `performance.now()` so the trace slides continuously even between polls;
// dataset pts are rebuilt only when new samples actually arrived (dirty=true) — cheap.
function render() {
  const n = buf.t.length;
  if (!n) {
    if (!dirty) return;       // nothing to do until next clearBuf / first sample
    dirty = false;
    // Empty state: clear pts + show no-data overlays.
    for (const ch of CHANNELS) {
      charts[ch.f].data.datasets[0].data.length = 0;
      charts[ch.f].update("none");
      els.val[ch.f].textContent = "—";
      els.nd[ch.f].style.display = "";
    }
    return;
  }

  // Project x.max from wall-clock since the last anchor; freeze after STALL_MS so a paused
  // source doesn't keep sliding the trace off the right edge past real data.
  const elapsed = anchorWall ? performance.now() - anchorWall : 0;
  const proj = anchorT + (elapsed < STALL_MS ? elapsed : STALL_MS);
  const maxT = Math.max(proj, buf.t[n - 1]);   // safety: never below actual newest

  for (const ch of CHANNELS) {
    const chart = charts[ch.f];
    if (dirty) {
      const arr = buf[ch.f];
      const pts = new Array(n);
      for (let i = 0; i < n; i++) pts[i] = { x: buf.t[i], y: arr[i] };
      chart.data.datasets[0].data = pts;
      els.val[ch.f].textContent = fmt(arr[n - 1]);
      els.nd[ch.f].style.display = "none";
    }
    chart.options.scales.x.min = maxT - WINDOW_MS;
    chart.options.scales.x.max = maxT;
    chart.update("none");
  }
  dirty = false;
}

// ---- status poll (badge / meta / data quality / source dropdown) ---------
async function pollStatus() {
  try {
    const st = await api("/status").then((r) => r.json());
    serverDown = false;
    const src = st.source || { kind: "none" };
    const ds = st.source_status || {};
    const active = !!src.kind && src.kind !== "none";
    const live = !!ds.live;

    setBadge(active ? (live ? "live" : "source set") : "no source",
      active ? (live ? "live" : "down") : "");
    $("meta").textContent = `samples: ${ds.samples_received ?? 0} · seq: ${ds.latest_seq ?? 0}`;

    updateRecordUI(st.recording || {});

    // Dropdown device list = scanned devices ∪ the address already bound (if a live BLE source).
    const map = new Map();
    for (const d of (st.scan_devices || [])) map.set(d.address, d.name);
    if (src.kind === "ble" && src.address && !map.has(src.address)) {
      map.set(src.address, src.label || "NanoIMU");
    }
    bleDevices = [...map.entries()].map(([address, name]) => ({ address, name }));
    const sig = bleDevices.map((d) => d.address).join(",");
    if (sig !== lastOptSig) { lastOptSig = sig; renderSourceOptions(); }

    // Reflect the configured source + its ingest health.
    const want = sourceValueFromConfig(src);
    if ($("srcSel").value !== want) $("srcSel").value = want;
    els.label.textContent = active ? (src.label || src.kind) : "(no source)";
    els.meta.innerHTML = renderChipsHtml(active, ds);
    if (live) {
      els.live.textContent = "● LIVE";
      els.live.className = "text-xs font-semibold text-[var(--live)]";
    } else {
      els.live.textContent = active ? "○ offline" : "—";
      els.live.className = "text-xs font-semibold text-[var(--muted)]";
    }

    // Wellness data-quality messages, driven by live transitions (stable across polls).
    if (everLive) {
      if (live && !wasLive) setHint(MSG_RESUMED);
      else if (!live && wasLive) setHint(MSG_MISSING);
    }
    if (live) everLive = true;
    wasLive = live;
  } catch (_) {
    setBadge("server unreachable", "down");
    if (!serverDown) { serverDown = true; toast("Server unreachable — retrying…"); }
  }
}

// ---- theme (light/dark, persisted; canvas charts re-coloured to match) ---
function retheme() {
  const c = chartTheme();
  for (const f in charts) {
    const ch = charts[f];
    ch.options.scales.x.grid.color = c.grid;
    ch.options.scales.x.ticks.color = c.tick;
    ch.options.scales.y.grid.color = c.grid;
    ch.options.scales.y.ticks.color = c.tick;
    ch.update("none");
  }
}
function applyTheme(t) {
  const root = document.documentElement;
  // Keep both signals in sync: .dark drives the existing --bg/--text/--chart-* CSS vars
  // (used by utility classes + Chart.js); data-theme drives daisyUI components.
  root.classList.toggle("dark", t === "dark");
  root.setAttribute("data-theme", t === "dark" ? "moonwalk-dark" : "moonwalk-light");
  localStorage.setItem("theme", t);
  $("btnTheme").textContent = t === "dark" ? "☀️" : "🌙";
  retheme();
}

// ---- controls ------------------------------------------------------------
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
      toast(`${path} → HTTP ${r.status}`);
      return null;
    }
    return await r.json().catch(() => ({}));
  } catch (e) {
    console.error("POST", path, e);
    toast(`${path} failed: ${e.message || e}`);
    return null;
  }
}

// Same-origin GET download: the server's Content-Disposition sets the filename.
function triggerDownload(href) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- record (one start→stop session on the active source; auto-downloads on stop) ----
let recActive = false;   // mirrors server /api/status recording.active (set in pollStatus)

async function toggleRecord() {
  if (recActive) {
    const res = await postJSON("/record/stop", {});
    if (res && (res.recording || {}).has_recording) {
      triggerDownload("/api/record/download");   // auto-download the finished CSV
    }
  } else {
    const label = ($("recLabel").value || "").trim() || "rec";
    await postJSON("/record/start", { label });
  }
  pollStatus();
}

function updateRecordUI(rec) {
  recActive = !!rec.active;
  const btn = $("btnRecord");
  if (recActive) {
    const secs = Math.floor(rec.elapsed_s || 0);
    const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    btn.textContent = "⏹ Stop";
    btn.className = "btn btn-error btn-sm";
    btn.setAttribute("aria-label", "Stop recording");
    $("recLabel").disabled = true;
    $("recStatus").textContent = `● REC · ${mmss} · ${rec.count || 0}`;
    $("recStatus").className = "text-xs font-semibold text-[var(--down)] min-h-[1rem]";
  } else {
    btn.textContent = "⏺ Rec";
    btn.className = "btn btn-primary btn-sm";
    btn.setAttribute("aria-label", "Start recording");
    $("recLabel").disabled = false;
    $("recStatus").textContent = rec.has_recording
      ? `saved ${rec.label || ""} (${rec.count || 0})` : "";
    $("recStatus").className = "text-xs opacity-70 min-h-[1rem]";
  }
}

$("srcSel").onchange = async () => {
  const cfg = parseSourceValue($("srcSel").value);
  clearBuf();   // start the realtime cursor clean for the new source
  setHint(`source → ${$("srcSel").options[$("srcSel").selectedIndex].text}…`);
  const res = await postJSON("/source/set", cfg);
  if (res) setHint("source set");
  everLive = false; wasLive = false;
  pollStatus();
};
$("btnScan").onclick = async () => {
  setHint("scanning…");
  $("btnScan").disabled = true;
  const res = await postJSON("/ble/scan", { timeout: 8 });
  if (res) setHint(`found ${(res.devices || []).length} device(s)`);
  $("btnScan").disabled = false;
  pollStatus();
};
$("btnReset").onclick = async () => {
  clearBuf();
  everLive = false; wasLive = false;
  const res = await postJSON("/reset", {});
  if (res) setHint("reset to demo source");
  pollStatus();
};
$("btnClear").onclick = async () => { clearBuf(); await postJSON("/clear", {}); };
$("btnRecord").onclick = toggleRecord;
$("btnExport").onclick = () => triggerDownload("/api/export");
$("btnTheme").onclick = () =>
  applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");

// ---- polling lifecycle (pause when tab hidden) ---------------------------
// Browsers throttle setInterval on background tabs to ~1 Hz; at 20 Hz incoming, the client
// would fall behind and after ~2 min hit the server's "fell behind" reset path. Pausing the
// loops explicitly when the tab is hidden — and firing one immediate catch-up poll when it
// becomes visible again — avoids that drift entirely.
let _ivSamples = null, _ivStatus = null, _rafId = null, _rafFrame = 0;
function startLoops() {
  if (_ivSamples) return;
  _ivSamples = setInterval(pollSamples, POLL_MS);
  _ivStatus = setInterval(pollStatus, STATUS_MS);
  // Render on rAF — syncs with the browser repaint and pauses automatically when the tab is
  // hidden. RENDER_FRAME_SKIP throttles from 60 FPS down to a kinder rate (default 30 FPS).
  _rafFrame = 0;
  const tick = () => {
    if (RENDER_FRAME_SKIP === 0 || (_rafFrame++ % (RENDER_FRAME_SKIP + 1)) === 0) render();
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}
function stopLoops() {
  if (_ivSamples) clearInterval(_ivSamples);
  if (_ivStatus) clearInterval(_ivStatus);
  if (_rafId) cancelAnimationFrame(_rafId);
  _ivSamples = _ivStatus = _rafId = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopLoops();
  } else {
    pollSamples();   // catch-up immediately on return; server's 2-min buffer covers normal gaps
    pollStatus();
    startLoops();
  }
});

// ---- boot ----------------------------------------------------------------
buildPanel();
renderSourceOptions();
// Sync charts + button to the theme the FOUC script already set from localStorage.
applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
pollSamples();
pollStatus();
startLoops();
