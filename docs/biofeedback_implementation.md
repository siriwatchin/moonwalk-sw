# Biofeedback Implementation Plan

WHOOP is useful as a product reference because it turns noisy physiological streams into a few baseline-relative scores, then gives immediate coaching. We should copy that product pattern, not the exact metrics. Our current Nano payload has IMU and pressure, not heart rate, HRV, SpO2, skin temperature, or sleep. The biofeedback system should therefore focus on gait readiness, gait strain, load control, rhythm, and trend-based coaching.

## Research Notes

WHOOP's main patterns to adapt:

- Recovery is a readiness score that compares current physiology to a personal baseline and categorizes low, moderate, and high readiness. WHOOP uses HRV, resting heart rate, respiratory rate, sleep, skin temperature, and SpO2 for this.
- Strain is a personalized 0-21 exertion score. WHOOP combines cardiovascular load and muscular load, and the score is non-linear so harder effort accumulates faster than easy effort.
- Stress Monitor is real-time and baseline-relative. It compares current HR/HRV to the user's recent baseline, accounts for motion, and uses a compact 0-3 scale.
- Health Monitor is a compact dashboard for quickly scanning key vitals against typical range.
- Sleep Performance is not just hours slept. It combines sufficiency, consistency, efficiency, and sleep stress.
- Healthspan pushes the product toward long-term behavior metrics: sleep consistency, activity time, steps, VO2 max, resting heart rate, and lean body mass.
- Recovery Impacts / Journal is a behavior-correlation loop: log habits or context, then show which behaviors improve or hurt outcomes over time.

Sources:

- WHOOP Recovery: https://support.whoop.com/s/article/WHOOP-Recovery
- WHOOP Strain: https://support.whoop.com/s/article/WHOOP-Strain
- WHOOP Stress Monitor: https://www.whoop.com/us/en/thelocker/introducing-stress-monitor-a-new-way-to-monitor-manage-stress/
- WHOOP Health Monitor: https://www.whoop.com/im/en/thelocker/health-monitor-feature/
- WHOOP Sleep: https://support.whoop.com/s/article/WHOOP-Sleep
- WHOOP Healthspan guide: https://support.whoop.com/s/article/Healthspan-WHOOP-Age-Pace-of-Aging-Guide
- WHOOP Recovery Impacts: https://support.whoop.com/s/article/Recovery-Insights

## Product Direction

Build a "Gait Coach" model:

1. Real-time page answers: "What is happening right now?"
2. Session page answers: "Was this walk stable, safe, and within target?"
3. History page answers: "Is the user's mobility trending better or worse?"
4. Recommendation system answers: "What should the user do next?"

The UI should avoid clinical overload. Most users should see 3-5 summary states, while clinicians or developers can inspect raw signal detail on the live signal page.

## Metrics To Add

### 1. Gait Readiness

WHOOP inspiration: Recovery.

Purpose: show whether the user should do a normal walk, short walk, or rest/check equipment.

Inputs available now:

- cadence trend vs personal baseline
- rhythm score vs baseline
- duty factor vs baseline
- symmetry ratio
- gyro noise during standing
- pressure/load trend
- recent session fatigue slope

Formula:

```text
readiness =
  0.30 * rhythm_baseline_score +
  0.20 * cadence_stability_score +
  0.20 * symmetry_score +
  0.15 * load_control_score +
  0.15 * fatigue_score
```

Bands:

- 67-100: พร้อมเดิน
- 34-66: เดินแบบระวัง
- 0-33: ตรวจอุปกรณ์หรือพักก่อน

Implementation detail:

- Use a 7-session rolling baseline.
- If fewer than 3 sessions exist, show "กำลังสร้าง baseline" and lower confidence.
- Do not call this medical recovery because we do not have physiological sensors.

### 2. Mobility Strain

WHOOP inspiration: Strain.

Purpose: quantify how demanding the walking session was, independent of simple duration.

Inputs available now:

- duration
- cadence
- cycle count
- load percent
- duty factor
- gyro magnitude
- asymmetry penalty
- high-impact accel spikes

Score:

```text
raw_load =
  walking_minutes * 1.0 +
  high_load_minutes * 1.8 +
  asymmetry_minutes * 1.5 +
  high_swing_minutes * 1.3 +
  impact_spike_count * 0.08

mobility_strain = 21 * log(1 + raw_load) / log(1 + daily_max_reference)
```

Bands:

- 0-9: เบา
- 10-13: ปานกลาง
- 14-17: หนัก
- 18-21: มากเกินไป

UI:

- Small square tile on home.
- Session detail sparkline showing strain accumulation.
- Recommendation: "วันนี้พอแล้ว" when strain is high and readiness is low.

### 3. Real-Time Activation

WHOOP inspiration: Stress Monitor 0-3 scale.

Purpose: show current walking demand without exposing raw signal complexity.

Inputs available now:

- gyro magnitude
- accel magnitude deviation from 1g
- cadence change
- pressure delta
- irregular cycle timing

Formula:

```text
activation =
  weighted_zscore(current_motion, 14_day_motion_baseline)
```

Scale:

- 0.0-0.9: สงบ
- 1.0-1.9: กำลังเดินปกติ
- 2.0-2.6: ใช้แรงสูง
- 2.7-3.0: เสี่ยงล้า / ควรชะลอ

UI:

- Biofeedback page primary state.
- Keep it live and simple: one large number or state, then 2 supporting signals.
- If high activation is caused by motion but pressure is low, label it "แกว่งเร็ว".
- If high activation is caused by pressure, label it "ลงน้ำหนักมาก".

### 4. Load Control

WHOOP inspiration: Health Monitor baseline range.

Purpose: teach the user to stay within a target support range.

Inputs available now:

- pressure_pa
- pressure tare
- baseline pressure delta
- per-step peak load percent

Metrics:

- current load %
- per-step peak load %
- in-target %
- overload streak
- underload streak

UI:

- Compact horizontal band: under target / target / over target.
- Use direct cue text:
  - "กดมากไป"
  - "อยู่ในเป้าหมาย"
  - "เบาเกินไป"

### 5. Rhythm Consistency

WHOOP inspiration: trends over isolated values.

Purpose: reduce focus on one noisy step.

Inputs:

- plant intervals
- side A/B alternating intervals
- cadence rolling mean
- coefficient of variation per side

Metrics:

- rhythm score
- symmetry ratio
- consistency
- unstable step count

UI:

- Show one score and one cue.
- Avoid showing cadence, rhythm, and duty descriptions in the card.
- Developer detail can remain in a drill-down panel.

### 6. Fatigue Slope

WHOOP inspiration: strain/recovery balance.

Purpose: detect when the walk deteriorates over time.

Inputs:

- first third vs final third of session
- cadence drift
- duty factor drift
- symmetry drift
- load percent drift
- activation drift

Formula:

```text
fatigue_slope =
  0.25 * cadence_drop +
  0.25 * rhythm_drop +
  0.20 * load_increase +
  0.20 * activation_increase +
  0.10 * duty_factor_drift
```

UI:

- "ยังคงที่"
- "เริ่มล้า"
- "ควรพัก"

### 7. Journal And Context

WHOOP inspiration: Journal / Recovery Impacts.

Purpose: explain why metrics changed.

Fields to add:

- pain level 0-10
- perceived fatigue 0-10
- device type: cane / walker / custom
- indoor / outdoor
- terrain: flat / slope / stairs / uneven
- medication taken
- assisted by caregiver
- shoes / orthotic used
- notes

Analysis:

- After enough sessions, compare sessions with and without each context.
- Minimum rule: at least 5 yes and 5 no sessions before showing an impact.
- Show only directional insight:
  - "พื้นไม่เรียบสัมพันธ์กับ rhythm ลดลง"
  - "ใช้ walker ทำให้ load control ดีขึ้น"

## Data Model

### Session Summary

```ts
type BiofeedbackSessionSummary = {
  id: string;
  startedAt: string;
  endedAt: string;
  deviceType: "cane" | "walker" | "custom";
  sampleCount: number;
  stepCount: number;
  readinessScore: number | null;
  mobilityStrain: number | null;
  rhythmScore: number | null;
  symmetryRatio: number | null;
  dutyFactorPercent: number | null;
  cadenceSpm: number | null;
  loadInTargetPercent: number | null;
  fatigueSlope: number | null;
  actionCounts: Record<string, number>;
};
```

### Personal Baseline

```ts
type BiofeedbackBaseline = {
  updatedAt: string;
  sessionCount: number;
  cadenceMedian: number;
  rhythmMedian: number;
  dutyFactorMedian: number;
  loadPercentP90: number;
  activationMedian: number;
  activationMad: number;
};
```

## Utility Changes

Extend `src/lib/biofeedback-metrics.ts` with:

1. `calculateGaitReadiness(samples, baseline)`
2. `calculateMobilityStrain(samples, baseline)`
3. `calculateRealTimeActivation(sampleWindow, baseline)`
4. `calculateLoadControl(samples, config)`
5. `calculateFatigueSlope(sessionWindows)`
6. `summarizeBiofeedbackSession(samples, context, baseline)`
7. `updateBiofeedbackBaseline(previousBaseline, sessionSummary)`

Keep the existing raw CSV conversion path separate:

- `nano-imu.ts`: parse payload only.
- `biofeedback-metrics.ts`: derive metrics from parsed samples.
- Future storage layer: save session summaries and optional downsampled raw samples.

## UI Changes

### Home

Add a WHOOP-like compact status stack:

- Readiness tile: พร้อมเดิน / เดินแบบระวัง / พักก่อน
- Mobility Strain tile: 0-21
- Last session trend: rhythm, load control, fatigue

### Biofeedback

Make the page a live coach:

- Primary state: activation/action
- Secondary row: readiness, load control, rhythm
- Small live timeline: last 30 seconds of action states, not raw signals
- One recommendation at a time

Recommended card order:

1. Action
2. Load control
3. Rhythm
4. Fatigue
5. Confidence

### Live Signal

Keep as engineer/clinician mode:

- raw IMU rows
- normalized plot
- pressure row
- packet quality
- parser status

Do not overload the biofeedback page with raw signal charts.

### History

Add session cards:

- readiness score
- strain score
- rhythm score
- load target %
- fatigue status
- context tags

Add trend view:

- 7-day rhythm trend
- 7-day load control trend
- strain vs readiness balance

## Recommendation Rules

Use deterministic rules before adding ML:

```text
if confidence < 0.45:
  "กำลังเก็บข้อมูล เดินต่ออีกเล็กน้อย"
else if load_percent > target + 15:
  "ลดแรงกดที่ด้ามจับ"
else if rhythm_score < baseline - 12:
  "ชะลอและรักษาจังหวะให้เท่ากัน"
else if fatigue_slope > threshold:
  "พัก 1 นาที ก่อนเดินต่อ"
else if readiness < 34:
  "วันนี้ใช้รอบสั้นและตรวจอุปกรณ์ก่อนเดิน"
else:
  "คงจังหวะนี้ไว้"
```

ML can later predict `action`, but cueing should remain rule-based and explainable for safety.

## Implementation Phases

### Phase 1: Better Real-Time Biofeedback

- Add activation score 0-3.
- Add load control status.
- Add fatigue slope from session thirds.
- Update biofeedback page cards.
- Keep all calculations local in the browser.

### Phase 2: Session Summary

- Start/end session tracking.
- Persist summaries in local storage first.
- Add history cards from real summaries.
- Build 7-session baseline.

### Phase 3: Baseline-Relative Coaching

- Add readiness score.
- Add mobility strain 0-21.
- Add personalized target bands.
- Use confidence states when baseline is immature.

### Phase 4: Journal And Impact Insights

- Add post-session journal.
- Correlate context with rhythm/load/fatigue.
- Show impact only after enough observations.

### Phase 5: Optional Wearable Integration

If we add a heart-rate wearable later, add:

- HR zones
- HRV/recovery import
- respiratory rate import
- sleep/recovery context

Until then, do not imply physiological recovery. Use "gait readiness" and "mobility strain".

## Safety And UX Constraints

- Do not present the app as a diagnostic tool.
- Use confidence labels when data is sparse.
- Avoid telling users to increase load without clinician configuration.
- Keep the primary cue short and Thai-first.
- Keep raw signals away from the main coaching page.
- Make all scores baseline-relative once enough sessions exist.
- Preserve clinician/developer transparency through a detail view.

## Acceptance Criteria

- Biofeedback can show meaningful states from only Nano IMU + pressure.
- App still works without Bluetooth using mock stream.
- Real-time score updates at the Nano cadence without UI jank.
- Session summary is stable across reconnects.
- Recommendations are explainable from visible metrics.
- History page can show trends after multiple sessions.
- Future HR/sleep integrations can plug in without rewriting the gait metrics.
