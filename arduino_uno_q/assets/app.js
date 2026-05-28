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
const $$ = (sel) => document.querySelectorAll(sel);
const api = (path, opts) => fetch(`/api${path}`, { cache: "no-store", ...(opts || {}) });

const WINDOW_MS = 10000;    // realtime chart window + ring-buffer time trim
const SAMPLE_LIMIT = 200;   // max samples returned per /api/samples poll (~10 s @ 20 Hz)
const POLL_MS = 100;        // realtime data poll cadence (~10/s; ≤2 samples per batch @ 20 Hz Nano)
const STATUS_MS = 1000;     // status poll cadence (badge / data quality)
// Rendering policy: redraw ONLY when new data has arrived (driven by pollSamples), with no
// between-poll interpolation. Earlier we projected the x-axis from the wall clock so the trace
// looked continuously sliding, but Nano BLE bursts (not a steady 20 Hz) made the anchor jump
// whenever a batch landed — visible jitter. Tying the axis directly to the newest sample makes
// the trace step honestly at each poll; an empty buffer just shows the no-data overlays.

// Wellness-framed data-quality copy (no medical wording; carries the claim-safety disclaimer).
const MSG_MISSING = "Some walking movement samples may be missing. This is a wellness awareness cue, not a medical assessment.";
const MSG_RESUMED = "Your walking data stream has resumed. This is a wellness awareness cue, not a medical assessment.";

// ---- browser-side ring buffer (parallel arrays, trimmed by time each poll) ----
const buf = { seq: [], t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [], pressure: [] };
let lastSeq = 0;            // highest seq we've consumed (sent as since_seq)
let serverDown = false;     // true while /api/status is unreachable (toast on transition)
let wasLive = false;        // previous status poll's live flag (for resumed/missing messages)
let everLive = false;       // has the source ever been live this session
let bleDevices = [];        // [{name,address}] for the dropdown (scanned ∪ active)
let lastSourceSig = null;   // rebuild dropdown items only when the device set or active source changes
let currentSource = { kind: "none" };  // last-known active source config (used when rendering items)

// ---- peak detection state (frontend-only) -------------------------------
// Calibrate a baseline per channel from the first calibrationMs of data, then mark samples
// whose deviation from baseline exceeds `multiplier × MAD` as peaks. baseline + peaks live
// in the browser only — backend has no notion of either. Refresh = recalibrate (intended).
// Calibration warmup is global (one recalibrate covers all channels). Everything else lives
// per-channel in peakCfgs[ch.f] so the user can tune each gait signal independently — accel
// impacts need a different threshold than a slow pressure drift. clusterGapMs merges
// consecutive above-threshold samples within this gap into a single peak event (the biggest
// |deviation| wins) — without it, a cane impact covers 2-4 samples at 50 ms each and Δt
// between "adjacent peaks" reads as the sample interval instead of step cadence.
const peakCfg = { calibrationMs: 5000 };
const PEAK_CH_DEFAULT = { enabled: true, multiplier: 5, clusterGapMs: 200, visible: true };
const peakCfgs = {};   // field -> { enabled, multiplier, clusterGapMs, visible }
const calib = { active: false, anchorT: null, samples: {}, baseline: {} };
const peaks = {};      // field -> [{x, y, mid}]  (x = Nano timestamp_ms — must be "x" not "t"
                       // because baseOptions sets parsing:false; mid = baseline mean for label placement)
for (const ch of CHANNELS) {
  peakCfgs[ch.f] = { ...PEAK_CH_DEFAULT };
  calib.samples[ch.f] = [];
  calib.baseline[ch.f] = { mean: 0, amp: 0, ready: false };
  peaks[ch.f] = [];
}

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
  b.className = "badge gap-1 shrink-0 " + (cls === "live" ? "badge-success text-success-content"
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

// ---- source picker (daisyUI dropdown with card list) ---------------------
// Encoding survives in URLs/forms even though we no longer use a <select>:
//   ""             -> none
//   "mock:normal"  -> mock gait normal
//   "mock:altered" -> mock gait altered (shown as "changed pattern")
//   "ble:<addr>"   -> live BLE source by address
function sourceValueFromConfig(cfg) {
  if (!cfg) return "";
  if (cfg.kind === "mock") return "mock:" + (cfg.gait || "normal");
  if (cfg.kind === "ble") return "ble:" + cfg.address;
  return "";
}

// Items rendered into every [data-source-list] in the document (header + drawer share the list).
// The shape is a flat array with optional "section" rows turned into menu-titles.
function buildSourceItems() {
  const items = [
    { value: "", title: "No source", subtitle: "Idle — pick something below", kind: "none" },
    { section: "Mock" },
    { value: "mock:normal", title: "Mock — Normal", subtitle: "Synthetic baseline gait", kind: "mock", gait: "normal" },
    { value: "mock:altered", title: "Mock — Changed pattern", subtitle: "Synthetic altered gait", kind: "mock", gait: "altered" },
  ];
  if (bleDevices.length) {
    items.push({ section: "BLE devices" });
    for (const d of bleDevices) items.push({
      value: "ble:" + d.address, title: d.name || "NanoIMU", subtitle: d.address, kind: "ble",
    });
  } else {
    items.push({ section: "BLE devices" });
    items.push({ note: "No devices yet — tap Scan." });
  }
  items.push({ action: "scan", title: "🔍 Scan again", subtitle: "Search nearby BLE" });
  return items;
}

function renderSourceLists() {
  const activeValue = sourceValueFromConfig(currentSource);
  const items = buildSourceItems();
  for (const list of $$("[data-source-list]")) {
    list.innerHTML = "";
    for (const it of items) {
      if (it.section) {
        const li = document.createElement("li");
        li.className = "menu-title text-[11px] uppercase tracking-wider opacity-60 px-2 pt-2 pb-0";
        li.textContent = it.section;
        list.appendChild(li);
        continue;
      }
      if (it.note) {
        const li = document.createElement("li");
        li.className = "px-3 py-1 text-xs opacity-60";
        li.textContent = it.note;
        list.appendChild(li);
        continue;
      }
      if (it.action === "scan") {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "flex items-start gap-2 text-left";
        btn.dataset.action = "scan";
        btn.innerHTML = `<span class="text-base leading-none">🔍</span>
          <span class="flex flex-col"><span class="font-medium text-sm">${it.title}</span>
          <span class="text-[11px] opacity-60">${it.subtitle}</span></span>`;
        li.appendChild(btn);
        list.appendChild(li);
        continue;
      }
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.dataset.sourceValue = it.value;
      const isActive = it.value === activeValue;
      a.className = "flex items-start gap-2" + (isActive ? " active" : "");
      a.setAttribute("role", "menuitemradio");
      a.setAttribute("aria-checked", isActive ? "true" : "false");
      const icon = it.kind === "ble" ? "📡" : it.kind === "mock" ? "🧪" : "○";
      const dot = isActive ? '<span class="status-dot status-live"></span>' : '<span class="status-dot"></span>';
      a.innerHTML = `${dot}<span class="text-base leading-none">${icon}</span>
        <span class="flex flex-col min-w-0">
          <span class="font-medium text-sm truncate">${it.title}</span>
          <span class="text-[11px] opacity-60 truncate">${it.subtitle || ""}</span>
        </span>`;
      li.appendChild(a);
      list.appendChild(li);
    }
  }
  updateSourceTriggers();
}

function updateSourceTriggers() {
  // The trigger button (in header and drawer) shows the active source label + a status dot.
  const active = !!currentSource.kind && currentSource.kind !== "none";
  const label = active ? (currentSource.label || currentSource.kind) : "No source";
  const liveOk = active && lastLive;
  for (const el of $$("[data-source-label]")) el.textContent = label;
  for (const dot of $$("[data-source-dot]")) {
    dot.className = "status-dot" + (liveOk ? " status-live" : active ? " status-warn" : "");
  }
}

// ---- the single panel (built once) ---------------------------------------
const charts = {};   // field -> Chart
const els = { val: {}, nd: {} };

function buildPanel() {
  const root = $("panel");
  root.className = "bg-[var(--panel)] border border-[var(--border)] rounded-xl p-3 flex flex-col min-h-0 lg:h-full";
  // The pressure cell spans the full bottom row so the 7-channel grid stays balanced (accel
  // row · gyro row · pressure full-width) instead of leaving two empty cells in 3×3.
  // Each chart cell carries data-cell="<field>" at the root — used to hide/show the cell when
  // the per-chart "Show this chart" toggle flips. The ⚙ button in the header opens dlgChartCfg
  // pre-populated with that channel's peakCfgs entry; multi-channel tuning is the whole point
  // of F#4 (per-chart settings) so the button needs to be discoverable on every cell.
  const chart = (key, title, wide) =>
    `<div class="flex flex-col min-h-[140px] lg:min-h-0${wide ? " md:col-span-2 lg:col-span-3" : ""}"
          data-cell="${key}">
       <div class="flex items-baseline justify-between gap-1 shrink-0">
         <span class="text-[10px] uppercase tracking-wider text-[var(--muted)]">${title}</span>
         <span class="flex items-baseline gap-1">
           <span class="text-[11px] font-semibold tabular-nums" data-val${key}>—</span>
           <button type="button" class="text-[var(--muted)] opacity-60 hover:opacity-100 leading-none px-1"
                   data-chart-cfg="${key}" aria-label="Settings for ${title}" title="Chart settings">⚙</button>
         </span>
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
    <!-- Slim global row. Per-chart settings (multiplier / cluster gap / enabled / visible) moved
         into the ⚙ button on each chart cell — only baseline reset and overall status live here.
         The "hidden charts" dropdown appears only when at least one chart is hidden, so the user
         can recover a channel whose ⚙ button is no longer on screen. -->
    <div class="flex flex-wrap items-center gap-2 mb-2 shrink-0 text-xs">
      <span class="text-[10px] uppercase tracking-wider opacity-60">Peak</span>
      <button class="btn btn-ghost btn-xs" data-action="recalibrate"
              aria-label="Recalibrate baseline">↻ recalibrate</button>
      <span class="text-[var(--muted)]" data-peak-status>—</span>
      <span class="flex-1"></span>
      <div class="dropdown dropdown-end hidden" data-hidden-wrap>
        <button tabindex="0" role="button" class="btn btn-ghost btn-xs"
                aria-label="Show hidden charts" title="Show hidden charts">
          <span data-hidden-count>0</span> hidden ▾
        </button>
        <ul tabindex="0" class="dropdown-content z-30 menu bg-base-200 text-base-content shadow-lg rounded-box w-48 p-1 mt-1 text-xs"
            data-hidden-list role="menu"></ul>
      </div>
    </div>
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
    data: {
      datasets: [
        { data: [], borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0, spanGaps: false, fill: false },
        // datasets[1] = peak markers (scatter-style: showLine:false). Coordinates are
        // {x: Nano timestamp_ms, y: value, mid: baseline mean} — same x-space as the line, so
        // markers scroll with the trace as the 10 s window slides. datalabels opt-in here only
        // (line dataset stays clean via the global `display:false` default set above).
        {
          data: [], showLine: false, pointRadius: 4, pointHoverRadius: 4,
          pointBackgroundColor: "rgba(239,68,68,0.9)", pointBorderColor: "rgba(239,68,68,1)",
          pointBorderWidth: 1.5, borderColor: "rgba(0,0,0,0)",
          datalabels: {
            display: true,
            // parsing:false ⇒ formatter receives the raw point object ({x, y, mid}), not just y.
            formatter: (v) => fmt(v.y),
            anchor: "end",
            // Peak above baseline → label above; below baseline → label below.
            align: (ctx) => {
              const pt = ctx.dataset.data[ctx.dataIndex];
              return pt && pt.y >= (pt.mid ?? 0) ? "top" : "bottom";
            },
            offset: 4,
            clip: false,            // let labels poke outside the chart area near top/bottom edges
            color: "rgba(239,68,68,1)",
            font: { size: 10, family: "ui-sans-serif, system-ui, sans-serif", weight: "600" },
          },
        },
        // datasets[2] = Δt labels between adjacent peaks. Invisible markers (pointRadius:0)
        // at the midpoint of each peak pair; datalabels draws the gap in ms in gray so it
        // reads as "interval" rather than "value" (which is red on datasets[1]).
        {
          data: [], showLine: false, pointRadius: 0,
          borderColor: "rgba(0,0,0,0)", backgroundColor: "rgba(0,0,0,0)",
          datalabels: {
            display: true,
            formatter: (v) => `${Math.round(v.dt)}ms`,
            anchor: "center", align: "center",
            color: "rgba(107,114,128,1)",   // gray-500 — distinct from the red peak labels
            font: { size: 9, family: "ui-sans-serif, system-ui, sans-serif", weight: "500" },
            clip: false,
          },
        },
      ],
    },
    options: baseOptions(),
  });
}

// ---- peak detection helpers + Chart.js label plugin --------------------
// Calibration is anchored to Nano `timestamp_ms` (sample.t), NOT wall clock — BLE is bursty
// and Nano clock ≠ host clock, so a Date.now() window would drift from what the user sees on
// the x-axis. anchorT is set on the first sample after startCalibration() and the warmup
// window closes when (sample.t − anchorT) reaches peakCfg.calibrationMs.
function startCalibration() {
  calib.active = true;
  calib.anchorT = null;
  for (const ch of CHANNELS) {
    calib.samples[ch.f].length = 0;
    calib.baseline[ch.f] = { mean: 0, amp: 0, ready: false };
    peaks[ch.f].length = 0;
  }
}

function finalizeBaseline() {
  for (const ch of CHANNELS) {
    const arr = calib.samples[ch.f];
    if (arr.length < 5) continue;   // not enough data — leave ready:false; user can recalibrate
    let sum = 0;
    for (const v of arr) sum += v;
    const mean = sum / arr.length;
    let absDev = 0;
    for (const v of arr) absDev += Math.abs(v - mean);
    // MAD (mean absolute deviation) — robust + intuitive ("5× the average deviation").
    // Floor avoids div-by-zero / "every sample is a peak" on perfectly flat signals.
    const amp = Math.max(absDev / arr.length, 1e-6);
    calib.baseline[ch.f] = { mean, amp, ready: true };
  }
  calib.active = false;
  // Backfill: detect peaks that landed during the warmup window itself, so the user sees
  // markers immediately on the data they were just calibrating on.
  recomputePeaks();
}

// Cluster-aware push: if the new point falls within peakCfgs[field].clusterGapMs of the
// previous peak in the channel, keep only the one with the larger |deviation| from baseline
// (the cluster's actual peak). Both ingestForPeaks (online, sample-by-sample) and
// recomputePeaks (batch over the whole buffer) feed time-ordered points here, so the
// "previous peak" is always the most recent in time — the merge condition is correct in
// both modes. clusterGapMs is now per-channel so each gait signal can be tuned independently.
function pushClusteredPeak(field, point) {
  const arr = peaks[field];
  const last = arr.length ? arr[arr.length - 1] : null;
  if (last && point.x - last.x <= peakCfgs[field].clusterGapMs) {
    if (Math.abs(point.y - point.mid) > Math.abs(last.y - last.mid)) {
      arr[arr.length - 1] = point;
    }
    return;
  }
  arr.push(point);
}

function ingestForPeaks(s) {
  if (calib.active) {
    if (calib.anchorT === null) calib.anchorT = s.t;
    for (const ch of CHANNELS) calib.samples[ch.f].push(s[ch.f]);
    if (s.t - calib.anchorT >= peakCfg.calibrationMs) finalizeBaseline();
    return;
  }
  // Calibration still seeds *all* baselines — we just skip detection on channels whose
  // user-level "Detect peaks" is off. That way toggling enabled mid-session doesn't force
  // a recalibrate; flipping back on resumes detection against the same baseline.
  for (const ch of CHANNELS) {
    const cfg = peakCfgs[ch.f];
    if (!cfg.enabled) continue;
    const b = calib.baseline[ch.f];
    if (!b.ready) continue;
    if (Math.abs(s[ch.f] - b.mean) > cfg.multiplier * b.amp) {
      pushClusteredPeak(ch.f, { x: s.t, y: s[ch.f], mid: b.mean });
    }
  }
}

// Re-detect peaks across the WHOLE in-memory buffer. Called when any per-channel setting
// changes (the modal sliders are live-update) and after finalizeBaseline to backfill peaks
// from the warmup window. Each channel uses its own multiplier + clusterGapMs.
function recomputePeaks() {
  for (const ch of CHANNELS) peaks[ch.f].length = 0;
  const n = buf.t.length;
  if (!n) return;
  for (const ch of CHANNELS) {
    const cfg = peakCfgs[ch.f];
    if (!cfg.enabled) continue;
    const b = calib.baseline[ch.f];
    if (!b.ready) continue;
    const arr = buf[ch.f];
    const threshold = cfg.multiplier * b.amp;
    for (let i = 0; i < n; i++) {
      if (Math.abs(arr[i] - b.mean) > threshold) {
        pushClusteredPeak(ch.f, { x: buf.t[i], y: arr[i], mid: b.mean });
      }
    }
  }
}

function trimPeaks(maxT) {
  const cutoff = maxT - WINDOW_MS;
  for (const ch of CHANNELS) {
    const arr = peaks[ch.f];
    while (arr.length && arr[0].x < cutoff) arr.shift();
  }
}

function peakStatusText() {
  if (!buf.t.length) return "—";
  if (calib.active) {
    if (calib.anchorT === null) return "calibrating…";
    const last = buf.t[buf.t.length - 1];
    const remain = Math.max(0, (peakCfg.calibrationMs - (last - calib.anchorT)) / 1000);
    return `calibrating… ${remain.toFixed(1)}s`;
  }
  let total = 0;
  for (const ch of CHANNELS) total += peaks[ch.f].length;
  return `ready · ${total} peak${total === 1 ? "" : "s"}`;
}

// Use the official chartjs-plugin-datalabels (vendored alongside chart.umd.min.js) to draw
// the value label above each peak marker. Register once globally; disable on every dataset
// by default so the line trace stays clean — we opt-in per-dataset on datasets[1] inside
// makeLineChart(). The per-dataset config lives there because the formatter and align
// callback are tied to the {x, y, mid} point shape used by the peak scatter dataset.
Chart.register(ChartDataLabels);
Chart.defaults.set("plugins.datalabels", { display: false });

// ---- ring buffer ops -----------------------------------------------------
function clearBuf() {
  for (const k in buf) buf[k].length = 0;
  lastSeq = 0;
  // Buffer reset ⇒ baseline + peaks are stale (data origin / Nano clock just restarted).
  // Re-arm calibration so the next data that arrives establishes a fresh baseline.
  startCalibration();
  // No render loop to notify — callers that clear and want the empty-state visible should call
  // render() themselves (e.g. selectSource / doReset / doClear). pollSamples will eventually
  // call render() once new data arrives.
  render();
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
// In-flight guard: setInterval fires every POLL_MS regardless of whether the previous
// request finished, so on slow ticks two fetches can be in flight at once. If they complete
// out of order — older response landing AFTER newer — `lastSeq` ends up updated by the
// newer one, then the older response carries a smaller `latest_seq` and trips seqWentBack
// → clearBuf() → false "calibrating…" → chart reset. Mock makes this visible because its
// pacing (50 ms exact) puts steady seq motion between every two polls. Skipping while a
// poll is outstanding kills the race entirely; server holds a ~30 s buffer so missed ticks
// are not lost data — the next poll picks up everything seq > lastSeq.
let _pollSamplesInFlight = false;
async function pollSamples() {
  if (_pollSamplesInFlight) return;
  _pollSamplesInFlight = true;
  try {
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
    let appended = false;
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
        ingestForPeaks(s);
        appended = true;
      }
      trimByTime();
      if (buf.t.length) trimPeaks(buf.t[buf.t.length - 1]);
    }
    if (typeof r.latest_seq === "number") lastSeq = r.latest_seq;
    // Repaint only on actual new data — no rAF loop, no wall-clock projection. The trace will
    // step forward each poll instead of pretending to slide, but that's faithful to what the
    // Nano sends (which is bursty, not perfectly 20 Hz). Less perceived jitter.
    if (appended) render();
  } finally {
    _pollSamplesInFlight = false;
  }
}

// ---- render -------------------------------------------------------------
// Called when pollSamples has new data, or when clearBuf was invoked. NOT on a timer or rAF —
// keep render() in lockstep with data arrivals so the trace movement reflects the actual sample
// cadence instead of being interpolated against the wall clock.
function render() {
  const statusEl = document.querySelector("[data-peak-status]");
  const n = buf.t.length;
  if (!n) {
    // Empty state: clear pts + peak markers + Δt labels + show no-data overlays.
    for (const ch of CHANNELS) {
      charts[ch.f].data.datasets[0].data.length = 0;
      charts[ch.f].data.datasets[1].data.length = 0;
      charts[ch.f].data.datasets[2].data.length = 0;
      charts[ch.f].update("none");
      els.val[ch.f].textContent = "—";
      els.nd[ch.f].style.display = "";
    }
    if (statusEl) statusEl.textContent = peakStatusText();
    return;
  }

  // The 10 s window is anchored on the newest sample's timestamp. No projection, no slide
  // between polls — when a poll arrives the axis advances by the gap to the new newest.
  const maxT = buf.t[n - 1];
  for (const ch of CHANNELS) {
    const chart = charts[ch.f];
    const arr = buf[ch.f];
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = { x: buf.t[i], y: arr[i] };
    chart.data.datasets[0].data = pts;
    // slice() so Chart.js sees a new reference and redraws datasets[1] under update("none").
    const pa = peaks[ch.f];
    chart.data.datasets[1].data = pa.slice();
    // datasets[2] = Δt label points (midpoint between adjacent peaks). Each carries .dt in ms
    // for the datalabels formatter. After clustering, adjacent peaks are real events, so .dt
    // reads as an inter-event interval (cadence) rather than a sample gap.
    const dtPts = [];
    for (let j = 1; j < pa.length; j++) {
      const a = pa[j - 1], b = pa[j];
      dtPts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dt: b.x - a.x });
    }
    chart.data.datasets[2].data = dtPts;
    els.val[ch.f].textContent = fmt(arr[n - 1]);
    els.nd[ch.f].style.display = "none";
    chart.options.scales.x.min = maxT - WINDOW_MS;
    chart.options.scales.x.max = maxT;
    chart.update("none");
  }
  if (statusEl) statusEl.textContent = peakStatusText();
}

// ---- status poll (badge / meta / data quality / source dropdown) ---------
let lastLive = false;
let lastRecording = {};      // mirrored in updateRecordUI()

let _pollStatusInFlight = false;
async function pollStatus() {
  // Same in-flight guard as pollSamples — see the rationale there. pollStatus races don't
  // wipe the chart, but a stale source/scan_devices arriving after a fresh one can flicker
  // the dropdown and badge. Guarding keeps state monotonic.
  if (_pollStatusInFlight) return;
  _pollStatusInFlight = true;
  try {
    const st = await api("/status").then((r) => r.json());
    serverDown = false;
    const src = st.source || { kind: "none" };
    const ds = st.source_status || {};
    const active = !!src.kind && src.kind !== "none";
    const live = !!ds.live;
    lastLive = live;
    currentSource = src;

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
    // Re-render only when device set OR active source changed (cheap signature).
    const sig = sourceValueFromConfig(src) + "|" + bleDevices.map((d) => d.address).join(",");
    if (sig !== lastSourceSig) { lastSourceSig = sig; renderSourceLists(); }
    else { updateSourceTriggers(); }

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
  } finally {
    _pollStatusInFlight = false;
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
  // Update both copies of the theme toggle (header + drawer).
  for (const b of $$('[data-action="theme"]')) {
    b.textContent = (b.textContent || "").includes("Toggle")
      ? (t === "dark" ? "☀️ Toggle theme" : "🌙 Toggle theme")
      : (t === "dark" ? "☀️" : "🌙");
  }
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
    pollStatus();
  } else {
    // The first tap doesn't start anything — it asks the user to name the session via the
    // dlgRecName modal. Start happens on the modal's submit (recStartFromForm); Stop is
    // still this same button (which now reads "⏹ Stop" while recActive).
    openRecDialog();
  }
}

function updateRecordUI(rec) {
  lastRecording = rec || {};
  recActive = !!rec.active;
  // Update every record button (header join + drawer join) — they share data-action="record".
  // Idle = btn-outline btn-error (red outline reads as "armed, ready to record" — and crucially
  // doesn't look like a stuck "active" state the way btn-primary did). Active = solid btn-error.
  for (const btn of $$('[data-action="record"]')) {
    const isJoin = btn.classList.contains("join-item");
    const tail = (isJoin ? " join-item" : "") + (btn.classList.contains("flex-1") ? " flex-1" : "");
    if (recActive) {
      // Blinking dot + scaling glow = "REC light is on". Render the dot as a real <span> so
      // its blink can be animated independently of the button's breathing scale.
      btn.innerHTML = `<span class="rec-dot" aria-hidden="true"></span>Stop`;
      btn.className = "btn btn-sm btn-error btn-rec-active" + tail;
      btn.setAttribute("aria-label", "Stop recording");
    } else {
      btn.textContent = "⏺ Rec";
      btn.className = "btn btn-sm btn-outline btn-error" + tail;
      btn.setAttribute("aria-label", "Start recording");
    }
  }
  const recLabelEl = document.querySelector("[data-rec-label]");
  if (recLabelEl) recLabelEl.disabled = recActive;
  const status = document.querySelector("[data-rec-status]");
  if (status) {
    if (recActive) {
      const secs = Math.floor(rec.elapsed_s || 0);
      const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      status.textContent = `● REC · ${mmss} · ${rec.count || 0}`;
      status.className = "text-xs font-semibold text-[var(--down)] min-h-[1rem]";
    } else {
      status.textContent = rec.has_recording ? `saved ${rec.label || ""} (${rec.count || 0})` : "";
      status.className = "text-xs opacity-70 min-h-[1rem]";
    }
  }
}

// ---- CSV download modal --------------------------------------------------
// Source-of-truth dialog: one form, four destinations.
//   buffer-all → /api/export                            (no params; whole rolling buffer)
//   buffer-Ns  → /api/export?from_ms=&to_ms=           (live SampleStore.samples_in_range)
//   hist-*     → /api/export/history?from=&to=         (cold-path TsStore.read_range_csv)
//   session    → /api/record/download                  (last finished recording)
function openCsvDialog() {
  const dlg = $("dlgCsv");
  if (!dlg || typeof dlg.showModal !== "function") {
    // Old browser without <dialog>: fall back to the existing whole-buffer export.
    triggerDownload("/api/export");
    return;
  }
  // Enable/disable the session radio based on the latest /api/status snapshot.
  const sessRadio = dlg.querySelector('input[name="csvRange"][value="session"]');
  const sessText = dlg.querySelector("[data-csv-session-text]");
  const has = !!lastRecording.has_recording;
  if (sessRadio) sessRadio.disabled = !has;
  if (sessText) {
    sessText.textContent = has
      ? `Last recording${lastRecording.label ? ` — “${lastRecording.label}”` : ""} (${lastRecording.count || 0} samples)`
      : "No recording yet";
  }
  // Default the custom-range inputs to "the last 5 minutes" (the most common ask) the first
  // time the dialog opens, so the user can just pick Custom and tweak from there.
  const from = dlg.querySelector("[data-csv-from]");
  const to = dlg.querySelector("[data-csv-to]");
  if (from && !from.value) from.value = toLocalDtInput(new Date(Date.now() - 5 * 60 * 1000));
  if (to && !to.value) to.value = toLocalDtInput(new Date());
  dlg.showModal();
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in *local* time (not ISO/UTC).
function toLocalDtInput(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Parse a "datetime-local" value (no timezone suffix) as local time → Date.
function fromLocalDtInput(s) {
  if (!s) return null;
  // The Date(string) parser treats "YYYY-MM-DDTHH:MM" as local time, which is what we want.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function csvDownloadFromForm() {
  const dlg = $("dlgCsv");
  if (!dlg) return;
  const range = (dlg.querySelector('input[name="csvRange"]:checked') || {}).value || "buffer-all";

  if (range === "buffer-all") {
    triggerDownload("/api/export");
  } else if (range === "buffer-10s" || range === "buffer-30s") {
    // Time-range over the in-memory buffer. The buffer is keyed by the Nano timestamp_ms
    // (millis-since-boot), so "last N seconds" is computed from the newest sample in our local
    // buffer, not Date.now(). Fall back to whole-buffer if we have no data yet.
    const n = buf.t.length;
    if (!n) { triggerDownload("/api/export"); }
    else {
      const window_ms = range === "buffer-10s" ? 10_000 : 30_000;
      const tEnd = buf.t[n - 1];
      const tStart = tEnd - window_ms;
      triggerDownload(`/api/export?from_ms=${tStart}&to_ms=${tEnd}`);
    }
  } else if (range === "hist-5m" || range === "hist-30m" || range === "hist-1h") {
    const minutes = range === "hist-5m" ? 5 : range === "hist-30m" ? 30 : 60;
    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60_000);
    triggerDownload(`/api/export/history?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  } else if (range === "hist-custom") {
    const from = fromLocalDtInput((dlg.querySelector("[data-csv-from]") || {}).value);
    const to = fromLocalDtInput((dlg.querySelector("[data-csv-to]") || {}).value);
    if (!from || !to || to <= from) {
      toast("Invalid range — set From earlier than To.");
      return;
    }
    triggerDownload(`/api/export/history?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  } else if (range === "session") {
    triggerDownload("/api/record/download");
  }
  dlg.close();
}

// ---- Record-name modal --------------------------------------------------
// Tapping ⏺ Rec opens dlgRecName so the user can label the session; pressing Stop on the
// same button (which now reads ⏹ Stop) finalises and auto-downloads, same as before. The
// modal is dismissable with Esc / backdrop / Cancel — none of those start a recording.
function defaultRecName() {                                  // e.g. "rec-20260528-1503"
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  return `rec-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function openRecDialog() {
  const dlg = $("dlgRecName");
  // Fallback for browsers without <dialog> (Safari < 15.4, Firefox < 98): don't block the
  // user — start immediately with the default name. The CSV downloads on Stop as usual.
  if (!dlg || typeof dlg.showModal !== "function") {
    postJSON("/record/start", { label: defaultRecName() }).then(pollStatus);
    return;
  }
  const input = dlg.querySelector("[data-rec-name]");
  if (input) {
    input.value = defaultRecName();
    // Defer focus until after the dialog's open animation so the input lands focused with the
    // default name pre-selected (type-to-overwrite).
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }
  dlg.showModal();
}

async function recStartFromForm() {
  const dlg = $("dlgRecName");
  if (!dlg) return;
  const raw = (dlg.querySelector("[data-rec-name]")?.value || "").trim();
  // Empty -> use the default; recorder._safe_label() also defaults to "rec" but the dated
  // default is friendlier when the user has multiple sessions in a day.
  const label = raw || defaultRecName();
  dlg.close();
  await postJSON("/record/start", { label });
  pollStatus();
}

function wireRecDialog() {
  const dlg = $("dlgRecName");
  if (!dlg) return;
  // The form's submit fires on the ⏺ Start button AND on Enter inside the input.
  dlg.querySelector("#frmRecName")?.addEventListener("submit", (e) => {
    e.preventDefault();
    recStartFromForm();
  });
  dlg.querySelector("[data-rec-cancel]")?.addEventListener("click", () => dlg.close());
}

// ---- per-chart settings (⚙ button + dlgChartCfg) ------------------------
// Resolve the channel's display title (e.g. "ax (m/s²)") from CHANNELS without rebuilding it.
function channelTitle(field) {
  const c = CHANNELS.find((x) => x.f === field);
  return c ? c.title : field;
}

// Reflect a channel's `visible` state to its grid cell + keep the "hidden charts" dropdown
// in sync. Hidden cells use the HTML `hidden` attribute so the CSS grid auto-flows the
// remaining cells into the freed slots; nothing else in the page needs to know.
function applyChannelVisibility(field) {
  const cell = document.querySelector(`[data-cell="${field}"]`);
  if (cell) cell.hidden = !peakCfgs[field].visible;
  renderHiddenChartsChip();
}

// Build the "+ N hidden ▾" dropdown that lets the user unhide a chart whose ⚙ button is no
// longer reachable. Wrap is `hidden` when N == 0 so the row stays tidy.
function renderHiddenChartsChip() {
  const wrap = document.querySelector("[data-hidden-wrap]");
  if (!wrap) return;
  const hiddenList = CHANNELS.filter((c) => !peakCfgs[c.f].visible);
  if (!hiddenList.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const countEl = wrap.querySelector("[data-hidden-count]");
  if (countEl) countEl.textContent = String(hiddenList.length);
  const list = wrap.querySelector("[data-hidden-list]");
  if (list) {
    list.innerHTML = hiddenList.map((c) =>
      `<li><a href="#" data-unhide="${c.f}">${c.title}</a></li>`
    ).join("");
  }
}

// Populate dlgChartCfg with the channel's current peakCfgs entry and show it. The active
// channel is stashed on the modal-box's data-cfg-active so input handlers can route mutations.
function openChartCfg(field) {
  const dlg = $("dlgChartCfg");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const cfg = peakCfgs[field];
  if (!cfg) return;
  const box = dlg.querySelector("[data-cfg-active]");
  if (box) box.dataset.cfgActive = field;
  dlg.querySelector("[data-cfg-title]").textContent = channelTitle(field);
  dlg.querySelector("[data-cfg-enabled]").checked = cfg.enabled;
  dlg.querySelector("[data-cfg-mult]").value = String(cfg.multiplier);
  dlg.querySelector("[data-cfg-mult-val]").textContent = cfg.multiplier.toFixed(1) + "×";
  dlg.querySelector("[data-cfg-gap]").value = String(cfg.clusterGapMs);
  dlg.querySelector("[data-cfg-gap-val]").textContent = cfg.clusterGapMs + "ms";
  dlg.querySelector("[data-cfg-visible]").checked = cfg.visible;
  dlg.showModal();
}

// Wire the modal once at boot. Each input mutates `peakCfgs[active]` live so the chart
// behind the modal updates without an explicit Save step — matching the existing slider UX.
function wireChartCfgDialog() {
  const dlg = $("dlgChartCfg");
  if (!dlg) return;
  const box = dlg.querySelector("[data-cfg-active]");
  const active = () => box?.dataset.cfgActive || "";
  dlg.querySelector("[data-cfg-enabled]")?.addEventListener("change", (e) => {
    const f = active(); if (!f) return;
    peakCfgs[f].enabled = e.target.checked;
    // Toggle off ⇒ wipe just this channel's markers; toggle on ⇒ recompute across buf.
    if (!peakCfgs[f].enabled) peaks[f].length = 0;
    else recomputePeaks();
    render();
  });
  dlg.querySelector("[data-cfg-mult]")?.addEventListener("input", (e) => {
    const f = active(); if (!f) return;
    peakCfgs[f].multiplier = parseFloat(e.target.value);
    dlg.querySelector("[data-cfg-mult-val]").textContent = peakCfgs[f].multiplier.toFixed(1) + "×";
    recomputePeaks();
    render();
  });
  dlg.querySelector("[data-cfg-gap]")?.addEventListener("input", (e) => {
    const f = active(); if (!f) return;
    peakCfgs[f].clusterGapMs = parseInt(e.target.value, 10);
    dlg.querySelector("[data-cfg-gap-val]").textContent = peakCfgs[f].clusterGapMs + "ms";
    recomputePeaks();
    render();
  });
  dlg.querySelector("[data-cfg-visible]")?.addEventListener("change", (e) => {
    const f = active(); if (!f) return;
    peakCfgs[f].visible = e.target.checked;
    applyChannelVisibility(f);
    // Chart cell visibility just changes layout — no need to recompute peaks.
    render();
  });
}

// Toggle the custom date-range row visibility based on which radio is selected.
function wireCsvDialog() {
  const dlg = $("dlgCsv");
  if (!dlg) return;
  const custom = dlg.querySelector("[data-csv-custom]");
  const refresh = () => {
    const v = (dlg.querySelector('input[name="csvRange"]:checked') || {}).value || "";
    if (custom) custom.hidden = v !== "hist-custom";
  };
  dlg.addEventListener("change", (e) => {
    if (e.target && e.target.name === "csvRange") refresh();
  });
  dlg.querySelector("[data-csv-cancel]")?.addEventListener("click", () => dlg.close());
  dlg.querySelector("[data-csv-download]")?.addEventListener("click", csvDownloadFromForm);
  refresh();
}

// ---- global action delegation -------------------------------------------
// Buttons in the header AND the drawer share `data-action="…"`, so one listener wires both.
// Source picker items use `data-source-value` instead, dispatched in the same handler.
async function selectSource(value) {
  const cfg = parseSourceValue(value);
  clearBuf();
  setHint(`source → ${displayNameFor(value)}…`);
  const res = await postJSON("/source/set", cfg);
  if (res) setHint("source set");
  everLive = false; wasLive = false;
  // Close any open dropdown (daisyUI uses :focus to keep them open; blur to close).
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  pollStatus();
}

function parseSourceValue(v) {
  if (!v) return { kind: "none" };
  const i = v.indexOf(":");
  const kind = v.slice(0, i), rest = v.slice(i + 1);
  if (kind === "mock") return { kind: "mock", gait: rest };
  if (kind === "ble") return { kind: "ble", address: rest };
  return { kind: "none" };
}

function displayNameFor(value) {
  if (!value) return "no source";
  if (value === "mock:normal") return "Mock — Normal";
  if (value === "mock:altered") return "Mock — Changed pattern";
  if (value.startsWith("ble:")) {
    const a = value.slice(4);
    const d = bleDevices.find((x) => x.address === a);
    return d ? `${d.name} (${a})` : a;
  }
  return value;
}

async function doScan() {
  setHint("scanning…");
  // Disable every Scan button (header More menu + drawer + source dropdown's "Scan again").
  const scans = $$('[data-action="scan"]');
  for (const b of scans) b.disabled = true;
  const res = await postJSON("/ble/scan", { timeout: 8 });
  if (res) setHint(`found ${(res.devices || []).length} device(s)`);
  for (const b of scans) b.disabled = false;
  pollStatus();
}

async function doReset() {
  clearBuf();
  everLive = false; wasLive = false;
  const res = await postJSON("/reset", {});
  if (res) setHint("reset to demo source");
  pollStatus();
}

async function doClear() {
  clearBuf();
  await postJSON("/clear", {});
}

document.addEventListener("click", (e) => {
  // Source picker items: <a data-source-value="…">.
  const srcItem = e.target.closest("[data-source-value]");
  if (srcItem) {
    e.preventDefault();
    selectSource(srcItem.dataset.sourceValue);
    return;
  }
  // ⚙ per-chart settings button.
  const cfgBtn = e.target.closest("[data-chart-cfg]");
  if (cfgBtn) {
    e.preventDefault();
    openChartCfg(cfgBtn.dataset.chartCfg);
    return;
  }
  // "+ N hidden ▾" dropdown item — unhide that channel.
  const unhide = e.target.closest("[data-unhide]");
  if (unhide) {
    e.preventDefault();
    const f = unhide.dataset.unhide;
    if (peakCfgs[f]) {
      peakCfgs[f].visible = true;
      applyChannelVisibility(f);
      render();
    }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    return;
  }
  const t = e.target.closest("[data-action]");
  if (!t) return;
  // Buttons in dropdowns are inside <li>; the global listener works regardless.
  // Mouse-driven clicks (MouseEvent.detail >= 1) leave daisyUI's :focus outline on the button
  // until the next click elsewhere — blur the source so it doesn't look "stuck". Keyboard
  // activations come through with detail === 0; those keep focus so the user can repeat the
  // action with another Enter.
  if (e.detail > 0 && typeof t.blur === "function") t.blur();
  const action = t.dataset.action;
  if (action === "record") { toggleRecord(); }
  else if (action === "export") { openCsvDialog(); }
  else if (action === "scan") { doScan(); }
  else if (action === "reset") { doReset(); }
  else if (action === "clear") { doClear(); }
  else if (action === "recalibrate") {
    startCalibration();
    render();
  }
  else if (action === "theme") {
    applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
  }
});

// ---- polling lifecycle (pause when tab hidden) ---------------------------
// Browsers throttle setInterval on background tabs to ~1 Hz; at 20 Hz incoming, the client
// would fall behind and after ~2 min hit the server's "fell behind" reset path. Pausing the
// loops explicitly when the tab is hidden — and firing one immediate catch-up poll when it
// becomes visible again — avoids that drift entirely.
let _ivSamples = null, _ivStatus = null;
function startLoops() {
  if (_ivSamples) return;
  _ivSamples = setInterval(pollSamples, POLL_MS);
  _ivStatus = setInterval(pollStatus, STATUS_MS);
  // No rAF — render() runs inside pollSamples when new data lands. Saves a render call every
  // 16 ms (≈60/s) for the in-between frames that would have shown nothing new anyway.
}
function stopLoops() {
  if (_ivSamples) clearInterval(_ivSamples);
  if (_ivStatus) clearInterval(_ivStatus);
  _ivSamples = _ivStatus = null;
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

// ---- analysis tab (cold-path: reads InfluxDB via /api/analysis/*) -------
// Separated from the realtime hot path: the realtime poll loops are PAUSED while the user is
// on Analysis (saves the 100 ms /api/samples polling that would render nothing visible), and
// re-armed on switch back. The 3 analysis charts are destroyed on tab leave so we don't leak
// Chart.js memory on repeated switches. State is reset by clicking Refresh.

const ANALYSIS = {
  currentTab: "realtime",
  rangeMode: "preset",            // "preset" | "custom"
  presetSec: 600,                 // last-clicked preset duration in seconds (10 min default)
  charts: { cadence: null, cycleHist: null, timeline: null },
  loading: false,
  lastReport: null,
  lastStatus: null,               // most recent /api/status response (for the source badge)
  deviceKey: "A",                 // selected device prefix; sent as ?device= in loadAnalysis()
  availableDevices: ["A"],        // populated by loadAnalysisLabels(); seed = ["A"] so the
                                  //   dropdown isn't empty before the labels probe returns
  labelsLoaded: false,            // gate so we only fetch /api/analysis/labels once per session
};

function switchTab(name) {
  if (ANALYSIS.currentTab === name) return;
  ANALYSIS.currentTab = name;
  // Toggle nav button visuals.
  for (const b of $$('[data-tab-nav] [data-tab]')) {
    const active = b.dataset.tab === name;
    b.classList.toggle("btn-active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  // Show only the matching panel.
  for (const p of $$('[data-tab-panel]')) {
    p.hidden = (p.dataset.tabPanel !== name);
  }

  if (name === "analysis") {
    // Pause realtime; the live charts will just freeze on their last frame (correct: there's
    // no "current data" to show in the background, and we don't want to keep polling for
    // values nobody is looking at).
    stopLoops();
    // Probe once for available device keys so the selector has the full list.
    if (!ANALYSIS.labelsLoaded) loadAnalysisLabels();
    loadAnalysis();
  } else {
    // Re-arm realtime. Catch-up poll first so the user sees fresh data immediately, not after
    // the next 100 ms tick.
    destroyAnalysisCharts();
    pollSamples();
    pollStatus();
    startLoops();
  }
}

function destroyAnalysisCharts() {
  for (const k of Object.keys(ANALYSIS.charts)) {
    if (ANALYSIS.charts[k]) {
      ANALYSIS.charts[k].destroy();
      ANALYSIS.charts[k] = null;
    }
  }
}

async function loadAnalysis() {
  if (ANALYSIS.loading) return;
  ANALYSIS.loading = true;

  // Show the skeleton immediately so stale numbers don't pretend to be current. The header
  // subtitle gets a "Loading <range>…" cue at the same time.
  const rangeLabel = presetLabel(ANALYSIS.presetSec, ANALYSIS.rangeMode);
  renderAnalysisSkeleton(rangeLabel);

  const dev = encodeURIComponent(ANALYSIS.deviceKey || "A");
  let url;
  if (ANALYSIS.rangeMode === "preset") {
    url = `/analysis/latest?duration_s=${ANALYSIS.presetSec}&device=${dev}`;
  } else {
    const fromI = document.querySelector("[data-range-from]");
    const toI = document.querySelector("[data-range-to]");
    const fromIso = fromI?.value ? new Date(fromI.value).toISOString() : null;
    const toIso = toI?.value ? new Date(toI.value).toISOString() : null;
    if (!fromIso || !toIso) {
      const subtitle = document.querySelector("[data-analysis-subtitle]");
      if (subtitle) subtitle.textContent = "Custom range needs both From and To.";
      clearChartSkeletons();
      ANALYSIS.loading = false;
      return;
    }
    url = `/analysis/window?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&device=${dev}`;
  }

  try {
    // Fetch the analysis report and the live-source status concurrently. The status call is
    // cheap (no DB hit) and we want both before painting the header — they show together.
    const [reportRes, statusRes] = await Promise.all([
      api(url),
      api("/status").catch(() => null),
    ]);
    if (reportRes.status === 503) {
      renderAnalysisOffline("Analysis is offline — InfluxDB unreachable on the board.");
      return;
    }
    if (!reportRes.ok) {
      const txt = await reportRes.text().catch(() => "");
      renderAnalysisOffline(`Analysis request failed (${reportRes.status}): ${txt.slice(0, 120)}`);
      toast("Analysis request failed");
      return;
    }
    const report = await reportRes.json();
    ANALYSIS.lastReport = report;
    // /api/status is best-effort: if it failed, render header with a "—" badge instead of
    // blocking the whole tab on a status-page hiccup.
    let statusJson = null;
    if (statusRes && statusRes.ok) {
      try { statusJson = await statusRes.json(); } catch { /* leave null */ }
    }
    ANALYSIS.lastStatus = statusJson;
    renderAnalysisHeader(report, statusJson);
    renderAnalysis(report);
  } catch (exc) {
    renderAnalysisOffline(`Analysis request error: ${exc}`);
    toast("Analysis request error");
  } finally {
    ANALYSIS.loading = false;
  }
}

function renderAnalysisOffline(msg) {
  const subtitle = document.querySelector("[data-analysis-subtitle]");
  if (subtitle) subtitle.textContent = msg;
  const cards = document.querySelector("[data-analysis-cards]");
  if (cards) cards.innerHTML = "";
  clearChartSkeletons();
  destroyAnalysisCharts();
}

function renderAnalysis(report) {
  const cards = document.querySelector("[data-analysis-cards]");
  if (!cards) return;
  const s = report.summary || {};

  const em = "—";
  const fmtNum = (v, dp = 1) => (v == null ? em : Number(v).toFixed(dp));
  const fmtPct = (v) => (v == null ? em : Math.round(v * 100) + "%");

  const cad = s.cadence_steps_per_min;
  const cyc = s.stick_cycle_time_ms;
  const duty = s.duty_factor;
  const stride = s.stride_length_m;
  const velocity = s.stride_velocity_mps;
  const sym = s.symmetry || {};

  cards.innerHTML = [
    cardHTML("Cadence", `${fmtNum(cad?.mean, 1)}`, "steps/min",
             cad ? `median ${fmtNum(cad.median, 1)} · CV ${fmtPct(cad.cv)}` : "no cycles in window"),
    cardHTML("Stick cycle time", `${fmtNum(cyc?.mean, 0)}`, "ms",
             cyc ? `median ${fmtNum(cyc.median, 0)} ms` : em),
    cardHTML("Duty factor", `${duty == null ? em : fmtNum(duty.mean * 100, 1) + "%"}`, "planted",
             duty ? `median ${fmtNum(duty.median * 100, 1)}%` : em),
    cardHTML("Stride length", `${fmtNum(stride?.mean, 2)}`, "m",
             stride ? `median ${fmtNum(stride.median, 2)} m` : em),
    cardHTML("Stride velocity", `${fmtNum(velocity?.mean, 2)}`, "m/s",
             velocity ? `median ${fmtNum(velocity.median, 2)} m/s` : em),
    cardHTML("Rhythm score", `${fmtNum(sym.rhythm_score, 0)}`, "/ 100",
             (sym.symmetry_ratio != null)
               ? `L:R ratio ${fmtNum(sym.symmetry_ratio, 2)} · L ${fmtNum(sym.left_interval_ms_mean, 0)} ms · R ${fmtNum(sym.right_interval_ms_mean, 0)} ms`
               : "needs ≥2 cycles"),
  ].join("");

  drawAnalysisCharts(report);
}

function cardHTML(title, value, unit, sub) {
  return `
    <div class="card bg-base-200 shadow-sm">
      <div class="card-body p-3">
        <div class="text-[11px] uppercase tracking-wider opacity-60">${title}</div>
        <div class="flex items-baseline gap-1">
          <div class="text-2xl font-semibold leading-none">${value}</div>
          <div class="text-xs opacity-70">${unit}</div>
        </div>
        <div class="text-[11px] opacity-70">${sub}</div>
      </div>
    </div>
  `;
}

// Span-adaptive tick formatter shared by the time-axis charts on the Analysis tab. Without
// this Chart.js prints the raw epoch ms (≈1.7×10¹²) as "1,716,930,000,000" — the bug the
// user spotted. Granularity is chosen from the visible span so a 30 s window reads as "-12s"
// while a 24 h window reads as "21:08"; the date format kicks in past a day.
function timeFormatter(xMin, xMax) {
  const span = xMax - xMin;
  if (span <= 60_000)     return (v) => `${Math.round((v - xMax) / 1000)}s`;
  if (span <= 3_600_000)  return (v) => `${Math.round((v - xMax) / 60_000)}m`;
  if (span <= 86_400_000) return (v) => {
    const d = new Date(v);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return (v) => new Date(v).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function drawAnalysisCharts(report) {
  destroyAnalysisCharts();
  // The skeleton overlays were painted by renderAnalysisSkeleton(); drop them now that
  // the real Chart.js instances are about to render in their place.
  clearChartSkeletons();
  const cycles = report.series?.cycles || [];
  const hist = report.series?.cycle_time_histogram || { bin_edges_ms: [], counts: [] };
  const planted = report.series?.planted_timeline || [];
  const range = report.range || {};
  const theme = chartTheme();
  const opts = (xMin, xMax) => ({
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    plugins: { legend: { display: false }, tooltip: { enabled: true }, datalabels: { display: false } },
    scales: {
      x: { type: "linear", min: xMin, max: xMax, grid: { color: theme.grid },
           ticks: { color: theme.tick, maxTicksLimit: 6,
                    callback: timeFormatter(xMin, xMax) } },
      y: { grid: { color: theme.grid }, ticks: { color: theme.tick } },
    },
  });

  // Cadence trend: x = plant time (ms), y = instantaneous cadence (steps/min). Stable units +
  // a clean trend line tell the same story as the cards but with eye-friendly trajectory.
  const c1 = document.querySelector('[data-analysis-chart="cadence"]');
  if (c1) {
    const pts = cycles
      .filter((c) => c.cycle_ms > 0)
      .map((c) => ({ x: c.t_plant_ms, y: 60000 / c.cycle_ms }));
    const xMin = pts.length ? pts[0].x : 0;
    const xMax = pts.length ? pts[pts.length - 1].x : 1;
    ANALYSIS.charts.cadence = new Chart(c1, {
      type: "line",
      data: { datasets: [{ data: pts, borderColor: "#1f6feb", borderWidth: 1.5,
                           pointRadius: 0, tension: 0, fill: false }] },
      options: opts(xMin, xMax),
    });
  }

  // Cycle-time histogram: bar chart of cycle_ms distribution.
  const c2 = document.querySelector('[data-analysis-chart="cycleHist"]');
  if (c2) {
    const edges = hist.bin_edges_ms || [];
    const counts = hist.counts || [];
    const labels = counts.map((_, i) => `${Math.round(edges[i])}–${Math.round(edges[i + 1])}`);
    ANALYSIS.charts.cycleHist = new Chart(c2, {
      type: "bar",
      data: { labels, datasets: [{ data: counts, backgroundColor: "#fb8f44" }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: true }, datalabels: { display: false } },
        scales: {
          x: { grid: { color: theme.grid }, ticks: { color: theme.tick, maxRotation: 0 } },
          y: { grid: { color: theme.grid }, ticks: { color: theme.tick, beginAtZero: true } },
        },
      },
    });
  }

  // Planted/swing timeline: a horizontal bar (one row, y=0) with one segment per planted
  // span. Background canvas colour = "swing"; coloured bars = "planted".
  const c3 = document.querySelector('[data-analysis-chart="timeline"]');
  if (c3) {
    const t0 = range.from ? new Date(range.from).getTime() : 0;
    const t1 = range.to ? new Date(range.to).getTime() : 0;
    // Use bar chart with floating bars [from_ms, to_ms].
    const bars = planted.map((p) => ({ x: [p.from_ms, p.to_ms], y: "planted" }));
    ANALYSIS.charts.timeline = new Chart(c3, {
      type: "bar",
      data: { datasets: [{
        data: bars,
        backgroundColor: "#22c55e",
        borderColor: "#16a34a",
        borderWidth: 0,
        barPercentage: 0.9,
      }] },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: true }, datalabels: { display: false } },
        scales: {
          x: { type: "linear", min: t0, max: t1, grid: { color: theme.grid },
               // Same time formatter as the cadence trend — consistent reading across both
               // time-axis charts on the page.
               ticks: { color: theme.tick, maxTicksLimit: 8,
                        callback: timeFormatter(t0, t1) } },
          y: { type: "category", grid: { display: false }, ticks: { color: theme.tick } },
        },
      },
    });
  }
}

// ---- analysis: header band + loading skeleton ---------------------------
// `renderAnalysisSkeleton` paints the eventual layout in `.skel` pulse blocks so the user
// sees the right *shape* immediately and stale numbers from the previous range don't get
// to pretend they're current. `renderAnalysisHeader` then writes the real title/subtitle
// and the live-source badge on top once the fetch resolves.

const PRESET_LABELS = {
  600:   "Last 10 minutes",
  3600:  "Last 1 hour",
  86400: "Last 24 hours",
};

function presetLabel(sec, mode) {
  if (mode === "custom") return "custom range";
  return PRESET_LABELS[sec] || `${sec} s`;
}

// Build the badge that summarises the currently-streaming source (NOT what was streaming
// during the analyzed window — the tooltip on the badge says so). Mirrors the realtime
// tab's source-picker label so the language is consistent across tabs.
function formatSourceBadge(source, live) {
  if (!source || !source.kind || source.kind === "none") {
    return { text: "— no source", cls: "badge-ghost" };
  }
  if (source.kind === "mock") {
    const gait = source.gait === "altered" ? "Changed pattern" : "Normal";
    return { text: `Mock · ${gait}`, cls: live ? "badge-success" : "badge-ghost" };
  }
  if (source.kind === "ble") {
    const id = source.label || source.address || "Live Nano";
    return { text: `Nano · ${id}`, cls: live ? "badge-success" : "badge-warning" };
  }
  return { text: source.kind, cls: "badge-ghost" };
}

function renderAnalysisHeader(report, statusJson) {
  const title = document.querySelector("[data-analysis-title]");
  const subtitle = document.querySelector("[data-analysis-subtitle]");
  const badge = document.querySelector("[data-analysis-source]");
  const r = report?.range || {};

  if (title) {
    const dev = r.device_key ? ` · Device ${r.device_key}` : "";
    title.textContent = `🦯 Gait analysis${dev}`;
  }
  if (subtitle) {
    const fmtRange = (x) => (x ? new Date(x).toLocaleString() : "—");
    const warnSep = (report?.warnings || []).filter(
      (w) => !w.includes("phase 2") && !w.includes("alternation"),
    );
    const warnText = warnSep.length ? ` · ${warnSep.join("; ")}` : "";
    subtitle.textContent =
      `${fmtRange(r.from)}  →  ${fmtRange(r.to)} ` +
      `· ${r.duration_s || 0}s · ${r.n_samples || 0} samples ` +
      `· swing ${report?.params?.swing_axis || "—"}${warnText}`;
  }
  if (badge) {
    const source = statusJson?.source;
    const live = !!statusJson?.source_status?.live;
    const { text, cls } = formatSourceBadge(source, live);
    // Reset to base classes + apply the variant so prior states (badge-success etc.) clear.
    badge.className = `badge gap-1 shrink-0 ${cls}`;
    badge.textContent = text;
  }
}

// Skeleton card stub mirrors `cardHTML()` — same shell, faux bars for the inner text so
// dimensions don't jump when real data swaps in.
function skeletonCardHTML() {
  return `
    <div class="card bg-base-200 shadow-sm">
      <div class="card-body p-3 gap-1.5">
        <div class="skel h-3 w-24"></div>
        <div class="flex items-baseline gap-1">
          <div class="skel h-7 w-20"></div>
          <div class="skel h-3 w-10"></div>
        </div>
        <div class="skel h-3 w-40"></div>
      </div>
    </div>
  `;
}

function renderAnalysisSkeleton(rangeLabel) {
  // Subtitle gets a "Loading …" cue; title stays put (still says what kind of data this is).
  const subtitle = document.querySelector("[data-analysis-subtitle]");
  if (subtitle) subtitle.textContent = `Loading ${rangeLabel}…`;

  // 6 placeholder cards in the same grid slots as the real ones.
  const cards = document.querySelector("[data-analysis-cards]");
  if (cards) cards.innerHTML = Array.from({ length: 6 }, skeletonCardHTML).join("");

  // Chart overlays: layer a `.skel` div over each canvas's relative wrapper so the live
  // Chart.js instance stays mounted under it (cheap; we don't destroy + recreate per click).
  for (const wrap of document.querySelectorAll("[data-analysis-chart-wrap]")) {
    if (wrap.querySelector("[data-analysis-skel]")) continue;  // already overlaid
    const overlay = document.createElement("div");
    overlay.className = "skel absolute inset-0 z-10";
    overlay.setAttribute("data-analysis-skel", wrap.dataset.analysisChartWrap);
    wrap.appendChild(overlay);
  }
}

function clearChartSkeletons() {
  for (const o of document.querySelectorAll("[data-analysis-skel]")) o.remove();
}

// Probe /api/analysis/labels once per session and fill the device-key dropdown. On 503 the
// dropdown stays disabled with just the seeded "Device A" — same fallback semantics as the
// rest of /api/analysis/*. We never block loadAnalysis() on this; it runs in parallel.
async function loadAnalysisLabels() {
  ANALYSIS.labelsLoaded = true;
  const sel = document.querySelector("[data-analysis-device]");
  try {
    const r = await api("/analysis/labels");
    if (!r.ok) {
      if (sel) sel.disabled = true;
      return;
    }
    const data = await r.json();
    const devices = (data.devices || []).filter((d) => typeof d === "string");
    if (!devices.length) {
      if (sel) sel.disabled = true;
      return;
    }
    ANALYSIS.availableDevices = devices;
    // Preserve the user's current selection if it's still in the list; otherwise fall
    // back to the server-recommended default, then to first.
    if (!devices.includes(ANALYSIS.deviceKey)) {
      ANALYSIS.deviceKey = data.default || devices[0];
    }
    if (sel) {
      sel.innerHTML = devices
        .map((d) => `<option value="${d}"${d === ANALYSIS.deviceKey ? " selected" : ""}>Device ${d}</option>`)
        .join("");
      sel.disabled = false;
    }
  } catch {
    if (sel) sel.disabled = true;
  }
}

// ---- analysis: range picker + click handlers -----------------------------

document.addEventListener("click", (e) => {
  // Tab buttons (top nav).
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) {
    e.preventDefault();
    switchTab(tabBtn.dataset.tab);
    return;
  }
  // Range preset buttons.
  const preset = e.target.closest("[data-range-preset]");
  if (preset) {
    e.preventDefault();
    // Active state on the join group.
    for (const b of $$('[data-range-preset]')) b.classList.toggle("btn-active", b === preset);
    const v = preset.dataset.rangePreset;
    const custom = document.querySelector("[data-range-custom]");
    if (v === "custom") {
      ANALYSIS.rangeMode = "custom";
      if (custom) custom.classList.remove("hidden");
      // Pre-fill with last 10 minutes so the user has a starting point to nudge.
      const now = new Date();
      const ago = new Date(now.getTime() - 600 * 1000);
      const fromI = document.querySelector("[data-range-from]");
      const toI = document.querySelector("[data-range-to]");
      if (fromI && !fromI.value) fromI.value = toLocalDtInputSafe(ago);
      if (toI && !toI.value) toI.value = toLocalDtInputSafe(now);
    } else {
      ANALYSIS.rangeMode = "preset";
      ANALYSIS.presetSec = parseInt(v, 10);
      if (custom) custom.classList.add("hidden");
      loadAnalysis();
    }
    return;
  }
  // Refresh button.
  const refresh = e.target.closest('[data-action="analysis-refresh"]');
  if (refresh) {
    e.preventDefault();
    loadAnalysis();
  }
});

// Device-key dropdown: a separate `change` handler (the click delegator above doesn't fire
// on <select>). Re-runs loadAnalysis() with the new device picked.
document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-analysis-device]");
  if (!sel) return;
  ANALYSIS.deviceKey = sel.value;
  loadAnalysis();
});

// Fallback datetime-local formatter when toLocalDtInput is not in scope (it's defined in the
// CSV dialog wiring above; we keep a tiny stub here so the analysis section is self-contained).
function toLocalDtInputSafe(d) {
  if (typeof toLocalDtInput === "function") return toLocalDtInput(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- boot ----------------------------------------------------------------
buildPanel();
renderSourceLists();
wireCsvDialog();
wireRecDialog();
wireChartCfgDialog();
// Arm calibration so the first samples — whether the server started with an active source
// (STARTUP_SOURCE) or the user picks one later — establish a fresh baseline. selectSource /
// clearBuf re-arm too, so this is idempotent.
startCalibration();
// Sync charts + button to the theme the FOUC script already set from localStorage.
applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
pollSamples();
pollStatus();
startLoops();
