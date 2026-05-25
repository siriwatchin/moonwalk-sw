# Add a see-and-speak assistive layer (the "Speaking Stick")

Moon Walk gains a second capability layer alongside gait monitoring: on a **Look
Gesture** (or button), it captures a camera frame, obtains a natural-language
**Scene Description** of the patient's surroundings, and **speaks it aloud** through
a small speaker. A cloud Vision-Language Model (**Gemini 2.5 Flash**) produces the
description; text-to-speech voices it. A separate, cloud-independent **Proximity
Alert** (ToF + buzzer/haptic) gives an instant obstacle warning with zero latency.

This is additive: the existing **gait-monitoring** layer (Baseline, Drift, Alerts,
Cane/Walker modes) is unchanged. Moon Walk now does two things — trends gait *and*
narrates surroundings on demand.

**Why.** The project needs a high-impact demo. "Raise the stick → it tells you what
it sees" is an immediately legible, emotionally resonant moment that a metrics
dashboard is not. Open-ended scene description (vs. fixed object classes) is what
delivers the "wow", and only a cloud VLM gives that quality today. The UNO Q can run
on-device object detection (~2–3 FPS, fixed classes) and offline TTS as a fallback,
but the cloud VLM is the headline path and Wi-Fi is assumed available at the venue.

**Considered and rejected.**
- *On-device VLM only* — UNO Q's QRB2210 has modest AI compute (no large NPU);
  fixed-class object detection lacks the richness of a spoken scene description.
  Kept as an **offline fallback**, not the headline.
- *Phone does the seeing/speaking* — fastest to build but the weakest "embedded
  device" story; undercuts the physical-stick demo.
- *Realtime image-in→speech-out APIs (Gemini Live / OpenAI Realtime)* — snappier but
  a persistent WebSocket is fragile on conference Wi-Fi; deferred to a stretch goal.
  The demo uses the resilient stateless two-call path (frame→VLM→TTS).

**Consequences.**
- **Privacy posture splits by data type.** Gait/health data stays on-device per
  [ADR-0001]; the see-and-speak layer **sends camera frames to a cloud VLM**. This is
  a deliberate, scoped exception — surroundings imagery, not health records — and must
  be stated plainly to users. "No cloud by default" now means *no cloud for health
  data*; vision is opt-in and clearly cloud-backed.
- **Network dependency.** The headline path needs Wi-Fi; bring a phone hotspot, never
  trust venue Wi-Fi. Add timeouts and a canned fallback phrase. The **Proximity Alert**
  works offline regardless.
- Frames are downscaled (≤1024px JPEG) for latency/bandwidth; expect ~1–3 s
  end-to-end, well under $0.01 per description.
- Adds hardware: USB-C powered hub, USB webcam, speaker (see [ADR-0004]).
