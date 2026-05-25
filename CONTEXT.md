# Moon Walk

A sensor module that attaches to an ordinary walking stick or walker. It does two
things: (1) **tracks a user's gait over time** to surface how a mobility-affecting
condition is progressing or improving, and (2) acts as a **Speaking Stick** — on
demand it sees the user's surroundings and speaks a description aloud, with an
instant obstacle warning. See [ADR-0003] (see-and-speak layer) and [ADR-0004]
(two-board architecture).

## Language

**Moon Walk**:
The attachable sensor box itself — the device being built. Not the stick.
_Avoid_: "the stick", "the walker" (those are the host, see **Host Aid**).

**Host Aid**:
The ordinary walking stick or walker that Moon Walk clips onto. Moon Walk does not
replace it; it instruments it. Comes in two kinds requiring **different sensing
models** — see **Cane Mode** / **Walker Mode**.
_Avoid_: calling it "Moon Walk".

**Cane Mode**:
For a single swinging stick. Distance via **Pendulum Model** anchored by **Handle
Load** (ZUPT). Plant-and-swing **Stick Cycle**.

**Walker Mode**:
For a wheeled rollator. No pendulum (it rolls, not swings). Distance via **wheel
encoder** odometry (primary). Limp measured directly as **left-vs-right grip-load
asymmetry** from dual grips — the asymmetry signal a single cane cannot give.

**Gait**:
The pattern of a person's walking — cadence, symmetry, swing, loading. The thing
Moon Walk is ultimately trying to characterise.

**Weight Bearing**:
The load transmitted through the Host Aid (and by inference, how much the user
is offloading from an affected limb). Sensed via **Handle Load**.
_Avoid_: confusing with the user's body weight.

**Sensor suite (resolved):** two multi-channel sensors — the **IMU** (6-axis) and a
**multi-FSR Handle Load** grip (grip-pressure distribution + axial load), plus a
single-channel **Distance** (ToF) for Stick Cycle phase detection. Temp/humidity
(Thermo) was dropped as not gait-relevant.

**Stick Cycle**:
One plant-to-plant period of the Host Aid, detected from the IMU/handle force.
Used to derive cadence (cycles/min) and rhythm variability. A proxy for the gait
cycle, **not** identical to it.
_Avoid_: calling it "gait cycle" without qualification.

**Stick Duty Factor**:
Fraction of a Stick Cycle during which the handle is loaded (stick planted).
_Avoid_: confusing with **leg stance time**, which Moon Walk cannot directly measure.

**Handle Load**:
Force the user pushes through the handle, sensed by a **multi-FSR grip** (several
force points → axial load + grip-pressure distribution). This — not ground reaction
force — is Moon Walk's measure of **Weight Bearing** and its strongest limp/offload
signal. In cane mode it **doubles as the stance anchor** that resets the Pendulum
Model's drift each footfall (ZUPT).
_Avoid_: "ground force", "weight" (body weight).

**Pendulum Model**:
The method Moon Walk uses to get distance metrics: stride length ≈ stick length ×
sin(rotation angle from the gyroscope). Avoids acceleration double-integration drift.
Requires a one-time **stick-length calibration**.

**Stride Length** / **Gait Velocity**:
Derived via the **Pendulum Model** (cane) / odometry (walker). **Spatial metrics are
trend-only**: walking-aid sensors systematically underestimate them (Werner et al.
2019: ~25–42% error) but track *change* reliably (ICC ≈ 0.72–0.76). Never present
as clinical absolutes; require per-user calibration.

**Temporal metrics** (cadence, stance/swing, **Stick Duty Factor**, asymmetry) are
the robust, headline numbers (ICC 0.72–0.97). Lead with these; spatial metrics are
secondary trends.

**Alert**:
An in-app wellness nudge raised when tracked metrics drift (e.g. "your walking has
changed — you may want to mention it to your doctor"). An awareness cue, explicitly
**not** a diagnosis or medical advice. Every Alert carries the **MEDICAL CLAIM
SAFETY** disclaimer inline (see **Claim Safety**).
_Avoid_: "diagnosis", "fall risk", "warning", anything implying clinical certainty.

**Baseline**:
A user's own normal gait profile, learned over time on-device. Moon Walk trends
and Alerts are relative to *this user's* Baseline, not a population norm.

**Drift**:
A sustained departure of current metrics from the **Baseline**. Sustained Drift is
what raises an **Alert**.

## Language — See-and-Speak layer

**Speaking Stick**:
Moon Walk's see-and-speak capability layer: on demand it captures the user's
surroundings and speaks a description aloud. A name for the *capability*, not a
separate device — the same Moon Walk box that does gait monitoring.
_Avoid_: treating it as a different product from the gait layer.

**Look Gesture**:
The IMU-detected motion (stick raised / pointed) that triggers a scene capture.
The hands-free way to ask "what's in front of me?". A button is the manual fallback.
_Avoid_: confusing with the gait **Stick Cycle**, which the same IMU also detects.

**Scene Description**:
The natural-language sentence describing the user's surroundings (obstacles,
doorways, people), produced by a cloud **VLM** and voiced via **TTS**. Open-ended
prose, not a fixed list of object classes.
_Avoid_: "object detection" (that's the offline fallback, not the headline).

**Proximity Alert**:
An instant, **cloud-independent** obstacle warning (ToF distance → buzzer/haptic),
e.g. "object ~1 m ahead". Works with no network; complements the richer **Scene
Description**.
_Avoid_: confusing with the gait **Alert** (which is about Drift, not obstacles).

**VLM** (Vision-Language Model):
The cloud model (**Gemini 2.5 Flash**) that turns a camera frame into a **Scene
Description**. Reached over Wi-Fi. See [ADR-0003].

**TTS** (Text-to-Speech):
Voices the **Scene Description** through the speaker. Cloud TTS for quality, with the
UNO Q's offline TTS Brick as a fallback.

**Compute Brain** (UNO Q):
The board that runs the see-and-speak pipeline (camera → VLM → TTS → speaker) and the
on-device gait intelligence (**Baseline**, **Drift**). See [ADR-0004].

**Sensor Node** (Nano):
The stick-mounted board that owns the always-on, real-time sensors (IMU, ToF, Handle
Load) and tactile feedback, streaming to the **Compute Brain** over wired UART.

## Scope (resolved)

Moon Walk is a **consumer-wellness self-monitoring** product first: it **measures
and trends** gait metrics for the **User** and may raise non-medical **Alerts**.
Sharing a trend report with a doctor is an *optional* support step — not the
centre of gravity. It does **not** diagnose, treat, predict disease, or predict
fall risk; a clinician, never the device, interprets any data. See [ADR-0001] and
[ADR-0005].

## Claim Safety (language discipline — normative)

Moon Walk lives in **wellness, not medicine**. The system may suggest cues,
reminders, and awareness. It must not diagnose, treat, or replace professional
judgement. This vocabulary is normative for all UI copy and docs — see [ADR-0005].

**Say** (awareness & guidance): wellness cue · behaviour awareness ·
self-monitoring · support · reminder · guidance · "your walking has changed".

**Do not say** (claims Moon Walk cannot back): diagnosis · treatment · medical
decision · **fall risk / "likely to fall"** · "your condition is worsening" · any
causal or clinical claim. (Moon Walk senses gait and handle load only — it does
**not** sense stress or affect, so "stress detection" is not a Moon Walk concept.)

**MEDICAL CLAIM SAFETY disclaimer** — "a wellness awareness cue, not a medical
assessment" — renders **inline on every Alert** and as a **persistent dashboard
footer**. It is **distinct** from the Speaking Stick's assistive-safety disclosure
("not a navigation or safety guarantee", see [ADR-0003] / US-33); the two guard
different failure modes and are never substituted for one another.

The **Speaking Stick** layer additionally **describes surroundings and warns of
obstacles** on demand (**Scene Description** + **Proximity Alert**). It is an
assistive convenience, **not** a navigation/safety guarantee or a substitute for the
user's own attention. See [ADR-0003].

**User**:
The person using the Host Aid. Owns their own data and is the only mandatory
reader of Moon Walk's app — Moon Walk is, first, a self-monitoring tool for them.
_Avoid_: "Patient" (reasserts a medical frame Moon Walk deliberately avoids — see
[ADR-0005]).

**Clinician** (a.k.a. "your doctor"):
The professional a **User** may *optionally* share a trend report with for support.
Sees data only when the User chooses to export it; not a live consumer, and not
required for Moon Walk to be useful.
_Avoid_: implying the Clinician is the primary audience.

## Architecture (resolved)

Two boards over wired UART — see [ADR-0004].

- **Sensor Node (Arduino Nano)** — stick-mounted, always-on, real-time. Captures the
  IMU, ToF distance, and Handle Load (multi-FSR); computes the gait **Stick Cycle**
  and detects the **Look Gesture**; fires the **Proximity Alert** and tactile feedback
  locally. Streams events/metrics to the Compute Brain.
- **Compute Brain (UNO Q)** — two halves:
  - *STM32 MCU* — UART bridge to the Sensor Node + any UNO-Q-local actuation.
  - *Linux side (Qualcomm)* — runs the see-and-speak pipeline (USB camera → cloud
    **VLM** **Scene Description** → **TTS** → speaker) **and** the gait intelligence:
    stores history, learns the user **Baseline**, runs the **Drift** model
    on-device, raises **Alerts**. The on-device intelligence is what distinguishes
    Moon Walk from a plain instrumented stick.
- **Data flow** —
  - *Gait/health data*: on-device + **User**'s phone over local BLE/Wi-Fi.
    **No cloud for health data.** User explicitly exports a report to a
    **Clinician**. Privacy-first (the inverse of the 2014 device's weakness).
  - *See-and-speak*: camera frames go to a **cloud VLM** over Wi-Fi — a deliberate,
    scoped exception (surroundings imagery, not health records), see [ADR-0003]. The
    **Proximity Alert** path is fully offline.

<!-- Resolved during grilling: -->
<!-- - IMU on the stick reflects gait via the Stick Cycle proxy (not leg stance directly). -->
<!-- - Two multi-channel sensors = IMU (6-axis) + multi-FSR Handle Load; ToF is single-channel. -->

[ADR-0001]: ./docs/adr/0001-measure-and-trend-not-diagnostic.md
[ADR-0002]: ./docs/adr/0002-dual-mode-sensing-models.md
[ADR-0003]: ./docs/adr/0003-add-see-and-speak-assistive-layer.md
[ADR-0004]: ./docs/adr/0004-two-board-uno-q-brain-nano-sensor-node.md
[ADR-0005]: ./docs/adr/0005-wellness-positioning-and-claim-safety-vocabulary.md
