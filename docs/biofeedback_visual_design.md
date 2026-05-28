# Biofeedback Page Visual Design Proposal

Goal: make the biofeedback page easier to read at a glance and give it a stronger "wow" moment without adding more metrics. The page should focus on the three headline metrics from `docs/csv-to-metrics.md`:

- เวลาลงไม้เท้า
- จังหวะสมดุล
- ฝึกลงน้ำหนัก

## Design Direction

Use a **clinical command-panel** style:

- square grid only
- no rounded cards
- dark navy base `#0b101f`
- teal accent `#41c3c0`
- clear Thai labels
- very compact mobile layout
- large state readout at the top
- three headline metrics shown as visual instruments, not plain cards

The page should feel like a live instrument cluster for walking, not a report page.

## Main UX Problem

The current page is readable, but all metrics look similar. Users have to compare text cards and bars manually. A better layout should answer these questions immediately:

1. Am I active or idle?
2. Is my current walk quality good?
3. Which of the three headline metrics needs attention?
4. What should I do next?

## Proposed Layout

### 1. Sticky Live State

Keep the existing sticky live panel, but make it the emotional anchor.

Content:

- state: `Idle`, `กำลังเดินปกติ`, `ใช้แรงสูง`, `ควรชะลอ`
- time
- device
- overall quality

Visual:

- overall quality uses a 3-zone bar:
  - red: แย่
  - yellow: ปานกลาง
  - teal/green: ดีเยี่ยม
- show a small vertical marker on the bar
- hide all metric values when connected + idle

### 2. Biofeedback Hero Tile

Replace the plain recommendation card with a stronger square hero tile.

Structure:

```text
┌──────────────────────────────┐
│ ฟีดแบ็กตอนนี้                 │
│ คงจังหวะนี้ไว้ / ชะลอเล็กน้อย │
│ ──────────────────────────── │
│ [micro timeline: last states] │
└──────────────────────────────┘
```

Micro timeline:

- 12 small square cells
- each cell represents a recent state sample
- red/yellow/teal based on overall quality region
- this gives a live feeling without showing raw signal

### 3. Three Headline Metric Instruments

Instead of equal plain cards, use three compact instrument blocks.

#### A. เวลาลงไม้เท้า

Purpose: show how much of each cycle the cane is planted.

Visual:

- horizontal split bar showing `วางไม้เท้า` vs `แกว่ง`
- large percentage
- small label: `รอบล่าสุด`

Example:

```text
เวลาลงไม้เท้า
43%
[████████░░░░░░░]
วางไม้เท้า / แกว่ง
```

Why better:

- duty factor is a ratio, so a split bar is easier than a generic progress bar.

#### B. จังหวะสมดุล

Purpose: show limp/rhythm consistency.

Visual:

- two-column balance meter
- left/right alternating cycle timing represented as equalizer bars
- center score `/100`

Example:

```text
จังหวะสมดุล
86 /100
L ▆▇▆▇
R ▇▆▇▆
```

Why better:

- the user sees "balanced vs uneven" visually.

#### C. ฝึกลงน้ำหนัก

Purpose: show session weight-support training load.

Visual:

- target compliance band
- value as score
- secondary text: `อยู่ในเป้าหมาย 78%`

Example:

```text
ฝึกลงน้ำหนัก
54
[■■■■■■□□□□]
อยู่ในเป้าหมาย 78%
```

Why better:

- this makes it clear that the metric depends on target compliance, not just pressure.

### 4. Idle State

When Bluetooth is connected and the cane is not being held/used:

- hide all metric instruments
- show one large square panel

Text:

```text
Idle
ยังไม่พบการถือหรือใช้งานอุปกรณ์
เริ่มถือไม้เท้าและเดินเพื่อเปิดการคำนวณ
```

Visual:

- dark navy panel
- thin teal border
- no metric numbers
- no fake values

This prevents the user from trusting stale data.

## Suggested Page Order

```text
Sticky device/Bluetooth
Sticky live walking state

Biofeedback hero tile
Three headline instruments
Detailed headline bars
Next recommendation
```

On small phones, avoid long vertical scrolling:

- sticky panel: compact
- hero tile: 1 block
- headline instruments: 3-column grid
- detailed bars: optional lower section

## Interaction Details

### Color Logic

Overall quality:

- `0-33`: แย่, red
- `34-66`: ปานกลาง, yellow
- `67-100`: ดีเยี่ยม, teal/green

Metric-specific:

- duty factor: teal when close to personal baseline, yellow/red when far
- rhythm: teal above 80, yellow 60-79, red below 60
- WS training: teal when target compliance is high, yellow when partial, red when no valid pressure peaks

### Motion

Use minimal CSS animation:

- timeline cells update with a subtle flash
- active walking icon pulses only when not idle
- no large decorative animation

This keeps the interface professional and readable.

## Implementation Notes

### New Small Components

Create these under `apps/web/src/components/moonwalk/`:

- `quality-region-bar.tsx`
- `biofeedback-hero.tsx`
- `duty-factor-instrument.tsx`
- `rhythm-balance-instrument.tsx`
- `weight-support-instrument.tsx`

### Data Needed

Current metrics already provide most values:

- `overallQualityPercent`
- `overallQualityLabel`
- `isIdle`
- `dutyFactorPercent`
- `rhythmScore`
- `symmetryRatio`
- `sessionWeightSupportTrainingLoad`
- `targetCompliancePercent`

Optional future data:

- recent quality history array for the micro timeline
- side A/B recent cycle arrays for the rhythm equalizer
- per-step peak load list for the WS target band

### First Implementation Step

Start with visual-only improvements using current metrics:

1. Replace current headline cards with three instrument components.
2. Replace the recommendation panel with the hero tile.
3. Reuse the current overall quality bar.
4. Keep detailed `UsageMeter` section only if it fits without pushing the page too long.

## Acceptance Criteria

- User can identify current status in under 2 seconds.
- Only the three headline metrics are emphasized.
- Idle state hides metric values.
- All visible labels are Thai-first.
- No rounded cards.
- Mobile viewport does not feel cramped.
- UI still works in demo mode without Bluetooth.
- Bluetooth-connected idle mode shows no fake metric values.
