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
const PEAK_DEFAULT = { enabled: true, multiplier: 5, calibrationMs: 5000 };
const peakCfg = { ...PEAK_DEFAULT };
const calib = { active: false, anchorT: null, samples: {}, baseline: {} };
const peaks = {};   // field -> [{x, y, mid}]  (x = Nano timestamp_ms — must be "x" not "t"
                    // because baseOptions sets parsing:false; mid = baseline mean for label placement)
for (const ch of CHANNELS) {
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
    <!-- Peak detection controls. Baseline is per-channel MAD calibrated over the first
         calibrationMs of data; the multiplier slider re-detects across the whole buffer so the
         new threshold applies instantly. Markers + value labels live on the charts below
         (datasets[1] + peakLabelPlugin). -->
    <div class="flex flex-wrap items-center gap-2 mb-2 shrink-0 text-xs">
      <span class="text-[10px] uppercase tracking-wider opacity-60">Peak</span>
      <label class="cursor-pointer flex items-center gap-1">
        <input type="checkbox" data-peak-enabled class="checkbox checkbox-xs" checked />
        <span>on</span>
      </label>
      <span class="opacity-60">×</span>
      <input type="range" data-peak-mult min="2" max="20" step="0.5" value="5"
             class="range range-xs w-28" aria-label="Peak threshold multiplier" />
      <span class="font-semibold tabular-nums w-10" data-peak-mult-val>5.0×</span>
      <button class="btn btn-ghost btn-xs" data-action="recalibrate"
              aria-label="Recalibrate baseline">↻ recalibrate</button>
      <span class="text-[var(--muted)]" data-peak-status>—</span>
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
        // {x: Nano timestamp_ms, y: value} — same x-space as the line, so markers scroll
        // with the trace as the 10 s window slides.
        { data: [], showLine: false, pointRadius: 4, pointHoverRadius: 4,
          pointBackgroundColor: "rgba(239,68,68,0.9)", pointBorderColor: "rgba(239,68,68,1)",
          pointBorderWidth: 1.5, borderColor: "rgba(0,0,0,0)" },
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

function ingestForPeaks(s) {
  if (calib.active) {
    if (calib.anchorT === null) calib.anchorT = s.t;
    for (const ch of CHANNELS) calib.samples[ch.f].push(s[ch.f]);
    if (s.t - calib.anchorT >= peakCfg.calibrationMs) finalizeBaseline();
    return;
  }
  if (!peakCfg.enabled) return;
  for (const ch of CHANNELS) {
    const b = calib.baseline[ch.f];
    if (!b.ready) continue;
    if (Math.abs(s[ch.f] - b.mean) > peakCfg.multiplier * b.amp) {
      peaks[ch.f].push({ x: s.t, y: s[ch.f], mid: b.mean });
    }
  }
}

// Re-detect peaks across the WHOLE in-memory buffer. Called when the multiplier slider
// changes (so the user sees the new threshold applied immediately, not from the next sample
// onward) and after finalizeBaseline (to backfill peaks from the warmup window).
function recomputePeaks() {
  for (const ch of CHANNELS) peaks[ch.f].length = 0;
  if (!peakCfg.enabled) return;
  const n = buf.t.length;
  if (!n) return;
  for (const ch of CHANNELS) {
    const b = calib.baseline[ch.f];
    if (!b.ready) continue;
    const arr = buf[ch.f];
    const threshold = peakCfg.multiplier * b.amp;
    for (let i = 0; i < n; i++) {
      if (Math.abs(arr[i] - b.mean) > threshold) {
        peaks[ch.f].push({ x: buf.t[i], y: arr[i], mid: b.mean });
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

// Chart.js v4 core has no datalabels plugin, so we hook afterDatasetsDraw and paint value
// labels directly. We reach into datasets[1] (the peak scatter) only — datasets[0] (the line)
// gets no labels. Position above/below the dot is chosen from the baseline mean (pt.mid).
const peakLabelPlugin = {
  id: "peakLabel",
  afterDatasetsDraw(chart) {
    const ds = chart.data.datasets[1];
    if (!ds || !ds.data || !ds.data.length) return;
    const xs = chart.scales.x, ys = chart.scales.y;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "10px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.fillStyle = "rgba(239,68,68,1)";
    ctx.textAlign = "center";
    for (const pt of ds.data) {
      if (pt.x < xs.min || pt.x > xs.max) continue;
      const px = xs.getPixelForValue(pt.x);
      const py = ys.getPixelForValue(pt.y);
      const above = pt.y >= (pt.mid ?? 0);
      ctx.textBaseline = above ? "bottom" : "top";
      ctx.fillText(fmt(pt.y), px, above ? py - 5 : py + 5);
    }
    ctx.restore();
  },
};
Chart.register(peakLabelPlugin);

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
    // Empty state: clear pts + peak markers + show no-data overlays.
    for (const ch of CHANNELS) {
      charts[ch.f].data.datasets[0].data.length = 0;
      charts[ch.f].data.datasets[1].data.length = 0;
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
    chart.data.datasets[1].data = peaks[ch.f].slice();
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
      btn.textContent = "⏹ Stop";
      btn.className = "btn btn-sm btn-error" + tail;
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

// Wire the peak-detection controls inside the panel. Built once after buildPanel() — there's
// only one set of these inputs (panel-local, not duplicated in the drawer).
function wirePeakControls() {
  for (const el of $$("[data-peak-enabled]")) {
    el.addEventListener("change", (e) => {
      peakCfg.enabled = e.target.checked;
      // Disabled ⇒ wipe markers immediately. Enabled ⇒ retro-detect over the buffer so the
      // user sees the toggle take effect without waiting for the next sample.
      if (!peakCfg.enabled) for (const ch of CHANNELS) peaks[ch.f].length = 0;
      else recomputePeaks();
      render();
    });
  }
  for (const el of $$("[data-peak-mult]")) {
    el.addEventListener("input", (e) => {
      peakCfg.multiplier = parseFloat(e.target.value);
      for (const v of $$("[data-peak-mult-val]")) v.textContent = peakCfg.multiplier.toFixed(1) + "×";
      recomputePeaks();
      render();
    });
  }
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

// ---- boot ----------------------------------------------------------------
buildPanel();
renderSourceLists();
wireCsvDialog();
wireRecDialog();
wirePeakControls();
// Arm calibration so the first samples — whether the server started with an active source
// (STARTUP_SOURCE) or the user picks one later — establish a fresh baseline. selectSource /
// clearBuf re-arm too, so this is idempotent.
startCalibration();
// Sync charts + button to the theme the FOUC script already set from localStorage.
applyTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
pollSamples();
pollStatus();
startLoops();
