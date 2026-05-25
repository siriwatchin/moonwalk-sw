# Two-board split: UNO Q Compute Brain + Nano Sensor Node over wired UART

Moon Walk runs on **two** Arduino boards with a clear division of labour, connected by
a **wired UART/serial** link:

- **UNO Q — Compute Brain.** The Qualcomm Linux side runs the see-and-speak pipeline
  (USB camera → cloud VLM **Scene Description** → TTS → speaker) and the on-device
  gait intelligence (**Baseline**, **Drift**, **Alerts**, **History Store**). Its
  STM32 MCU handles the UART bridge to the Nano and any UNO-Q-local actuation.
- **Nano — Sensor Node** (stick-mounted). Always-on, real-time. Owns:
  1. **IMU** — detects the **Look Gesture** (stick raised/pointed → trigger a scene
     capture) *and* the gait **Stick Cycle** (plant/swing → cadence, rhythm).
  2. **ToF distance** — instant **Proximity Alert** (obstacle ahead → buzzer/haptic,
     no cloud) *and* Stick Cycle phase detection.
  3. **Handle Load** (multi-FSR) — gait Weight-Bearing + the ZUPT stance anchor.
  4. Button + buzzer/haptic for trigger and tactile feedback.

The Nano streams sensor events/metrics to the Compute Brain; the Brain decides when to
look, describe, and speak.

**Why.** Each board does what it is genuinely good at. The Nano is a cheap, low-power,
real-time MCU — ideal for always-on sensing and instant tactile feedback right where
the hand grips the stick. The UNO Q brings the Linux compute, Wi-Fi, camera, and AI
runtime needed for vision and speech. Splitting them keeps the latency-critical
proximity/trigger loop off the busy Linux scheduler and lets the heavy AI work run
without starving the sensors.

**Considered and rejected.**
- *UNO Q alone (use its internal STM32 for sensing)* — workable, but the project
  requires using both boards, and a stick-mounted Nano is a cleaner physical home for
  the always-on sensors than routing everything to the base unit.
- *BLE link between boards* — more "product-like" (the Nano could detach) but adds
  failure points on a noisy conference floor. **Wired UART** is the most reliable,
  debuggable choice for a live demo. I2C was the runner-up.

**Consequences.**
- A physical wire runs along the stick between the Nano and the UNO Q base unit.
- Two firmware targets: a Nano sketch (sensing + UART protocol) and the UNO Q
  App Lab project (Bricks/Python on Linux + STM32 bridge).
- A small UART message protocol must be defined (sensor events, gait metrics,
  trigger signals).
- Extra hardware for the Brain: powered USB-C hub, USB webcam, USB/dongle speaker;
  4 GB UNO Q variant recommended.
