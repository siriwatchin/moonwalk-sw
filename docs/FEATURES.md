# Features & Measurable Metrics: Moon Walk

> Companion to [`PRD.md`](./PRD.md). Glossary: [`CONTEXT.md`](../CONTEXT.md).
> Decisions: [`docs/adr/`](./adr). Capitalised terms (Host Aid, Stick Cycle,
> Handle Load, Baseline, Drift, Alert, …) are defined in the glossary and used
> precisely here.

This document is the canonical reference for **what Moon Walk measures, what it
does not, and why**. It exists to prevent the recurring expectation gap: Moon
Walk instruments the **stick**, not the leg, and it has **no force plate**.

---

## 1. Feature List

### 1.1 Gait Monitoring (primary)
| Feature | Description | PRD ref |
|---|---|---|
| Automatic recording | Records walking whenever the Host Aid is used — no start/stop | US-6 |
| Cane Mode sensing | Stick Cycle detection (plant/swing), cadence, rhythm variability | US-17, 21 |
| Pendulum-model distance | Stride length + velocity, ZUPT-anchored to bound drift | US-18, 20 |
| Handle Load measurement | How hard the patient leans on the stick (offload signal) | US-19 |
| Walker Mode sensing | Wheel-encoder odometry for distance/velocity | US-22 |
| Dual-grip asymmetry | Left-vs-right grip-load asymmetry → direct limp signal | US-23 |
| Temporal metrics | Cadence, Stick Duty Factor, asymmetry — headline reliable figures | US-14, 24 |
| Spatial trend metrics | Stride/velocity as relative trends only (labelled, not absolutes) | US-15 |
| Baseline learning | Learns the individual patient's normal, on-device | US-25 |
| Drift detection + Alert | Non-medical Alert only on **sustained** Drift | US-9, 26 |
| Non-medical framing | Alerts phrased as "consider contacting your clinician" | US-9, 10 |

### 1.2 Speaking Stick (secondary — the demo headline)
| Feature | Description | PRD ref |
|---|---|---|
| Look Gesture trigger | Raise/point the stick to ask "what's in front of me?" | US-28 |
| Button trigger | Manual fallback if gesture isn't detected | US-29 |
| Scene Description (cloud VLM) | Camera frame → Gemini 2.5 Flash → spoken description via TTS | US-30 |
| Proximity Alert | Always-on, fully offline ToF → buzzer/haptic obstacle warning | US-31 |
| Graceful degradation | Offline proximity + canned fallback when cloud is slow/unreachable | US-32 |
| Assistive-only disclosure | Clear that it's a convenience, not a safety guarantee | US-33 |

### 1.3 Supporting features
| Feature | Description | PRD ref |
|---|---|---|
| Clip-on form factor | Attaches to existing stick/walker; battery-powered, unobtrusive | US-1, 7 |
| Mode selection | Patient sets cane vs walker at setup (manual; auto-detect out of scope) | US-2 |
| Guided calibration | Stick-length entry + brief walk to tune stride/loading | US-3 |
| Per-patient grip calibration | Calibrates personal FSR thresholds (mandatory) | US-4 |
| BLE phone pairing | Pairs over Bluetooth, no internet account | US-5 |
| Activity view (app) | Patient sees recent walking activity | US-8 |
| Trend report export | Patient exports a report to share with clinician | US-11, 13 |
| Baseline comparison view | Clinician sees current vs the patient's own Baseline | US-16 |
| On-device privacy posture | Gait/health data on device + phone; only camera frames go to cloud | US-12, 34 |

---

## 2. Measurable Metrics

Moon Walk's sensing: a stick-mounted **IMU** (6-axis), a **multi-FSR handle grip**,
a **ToF distance** sensor, and — in Walker Mode — a **wheel encoder**. Every metric
below derives from those. The organising principle:

> **Moon Walk gives you timing (trustworthy), distance/speed trends (directional),
> and relative lean/loading (per-patient) — built from a stick, about the stick.
> It does not give ground forces or leg-segment kinetics.**

### Tier 1 — Reliable headline metrics (temporal) · ICC 0.72–0.97
Pure functions of Stick Cycle detection. Lead with these.

| Metric | Source | Notes |
|---|---|---|
| Cadence (cycles/min) | Stick Cycle period | The "cycles/minute" figure |
| Stick Cycle time | Plant-to-plant interval | Proxy for gait cycle time — **not** identical (CONTEXT.md:47) |
| Stick Duty Factor | Fraction of cycle handle is loaded | **Not** leg-stance duty factor (CONTEXT.md:51–53) |
| Loaded / unloaded duration | Handle Load timing within a cycle | Honest stand-in for "stance/swing" (stick-loaded time) |
| Rhythm variability | Cycle-to-cycle timing spread | Captures unsteady gait |
| Cycle count | Count of plant events | Honest "number of stance" = count of stick plants |
| Asymmetry | L/R timing (cane) or dual-grip load (walker) | Direct limp signal |

### Tier 2 — Trend-only metrics (spatial) · ICC 0.72–0.76, ~25–42% absolute error
Real and useful, but **never presented as clinical absolutes** — change-over-time only.

| Metric | Source | Notes |
|---|---|---|
| Stride length | Pendulum Model (cane) / wheel odometry (walker) | Trend only |
| Gait velocity | stride length × cadence | Trend only |
| Distance walked | Accumulated stride / encoder | Trend only |

### Tier 3 — Loading metrics (relative, per-patient) · NOT Newtons or %BW
Closest Moon Walk gets to force data — but this is **handle force, not ground
reaction force** (CONTEXT.md:55–61).

| Metric | Source | Honest framing |
|---|---|---|
| Handle Load (relative) | Multi-FSR grip | "How hard the patient leans on the stick" |
| Peak handle load per cycle | FSR peak | Relative units, per-patient baseline |
| Grip-pressure distribution | Multi-point FSR | Grip asymmetry indicator |
| L/R load asymmetry (Walker) | Dual-grip FSRs | Direct uneven-loading signal |

---

## 3. Out of Scope / Out of Physical Reach

Documented so the boundary is explicit. The following are **not deliverable** with
the current architecture and contradict ADR-0001 (measure-and-trend) and ADR-0004
(stick-mounted, two-board):

- **True leg stance time** — Moon Walk knows when the *handle* is loaded, not when a
  *foot* is on the ground (CONTEXT.md:53).
- **Ground reaction forces** of any axis (vertical / anterior-posterior /
  medial-lateral) — requires a force plate or pressure insoles.
- **Forces in Newtons** — FSRs are relative/per-patient, not lab-calibrated.
- **Forces in %body-weight** — the device never knows the patient's body weight.
- **Braking / propulsion phases & their forces** — require the A-P GRF axis.
- **Impulses (Ns), impact/active peaks, times-to-peak, force-derived velocity
  changes** — all force-plate curve features.

Delivering any of these would be a **scope change** requiring new sensing hardware
(pressure insoles, foot-mounted IMUs, or a force plate) and a new ADR.
