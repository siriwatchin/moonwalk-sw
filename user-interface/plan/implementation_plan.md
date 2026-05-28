# Moon Walk Mobile Behavior App Implementation Plan

## Summary

Build a mobile-first Moon Walk app that tracks assisted-walking behavior, session history, device connection state, and baseline-relative progress for cane, walker, crutch, rollator, and future equipment-mounted modules.

The app uses the existing `user-interface` stack: Next.js web app, Elysia API, shared UI primitives, and the existing `arduino_uno_q` BLE/WebUI bridge as the first hardware source.

## Product Shape

- `Today`: live connection state, session controls, cadence, stick cycle time, duty factor, rhythm score, and session duration.
- `History`: prior sessions, weekly trends, baseline-relative change, adherence, and user notes.
- `Device`: Bluetooth/UNO Q bridge status, sample rate, lost/bad samples, live flag, and scan/connect actions.
- `Equipment`: equipment profiles for cane, walker, crutch, rollator, or custom aids; each profile owns its calibration.
- `Coach`: claim-safe setup guidance, readiness checks, data quality nudges, and personal progress summaries.

## Hardware And Data Flow

- Use `arduino_uno_q` as the first Bluetooth gateway.
- Read its existing bridge endpoints through the product API facade:
  - `GET /api/status`
  - `GET /api/latest`
  - `GET /api/series`
  - `POST /api/ble/scan`
  - `POST /api/slot/set`
  - `POST /api/reset`
  - `POST /api/clear`
- Keep the hot path live and low latency by reading recent bridge samples.
- Persist product history separately from the bridge:
  - user profile
  - device/module profile
  - equipment profile
  - calibration profile
  - walking session
  - derived metric summary
  - behavior events
  - user notes

## Metrics Scope

- Ship IMU-only metrics first:
  - stick cycle time
  - cadence
  - stick duty factor
  - stride trend
  - gait velocity trend
  - step rhythm and symmetry score
- Gate pressure/load features until the pneumatic handle load sensor is built and validated:
  - relative handle load
  - weight-support target compliance
  - session weight-support training load
  - cane-reliance trend
- Keep all metrics self-referenced to the user's own baseline.
- Use equipment-neutral internal names, with equipment-specific labels in the UI.

## Mobile UX Redesign Plan

### Design Goal

Redesign the current app into a modern mobile-first assistive-walking companion that feels calm, trustworthy, and easy to use while walking, setting up equipment, or reviewing progress after a session.

The visual direction should be a refined medical-field interface: soft surfaces, clear status color, large readable live metrics, and minimal distraction. The app should feel more like a connected health device dashboard than a generic admin panel.

### UX Problems To Fix

- The current first screen gives equal weight to too many panels; mobile users need one primary status and one primary action.
- Session controls are present, but the flow does not guide the user through readiness, start, active recording, and review states.
- Device, equipment, and calibration are separated conceptually, but the UI does not make their dependency obvious.
- Metrics are shown as standalone cards without enough hierarchy between live-critical values and secondary trend values.
- The bottom navigation works, but labels and sections need stronger task-based grouping for mobile.

### New Mobile Information Architecture

- `Walk`: primary recording screen, replacing `Today`.
  - Shows readiness state, selected equipment, connection state, primary live metric, and start/stop control.
  - During recording, prioritizes elapsed time, cadence, rhythm, and data quality.
- `Progress`: history and trends, replacing `History`.
  - Shows weekly session count, minutes, rhythm trend, and recent sessions.
  - Uses personal baseline language only.
- `Setup`: combines equipment, calibration, and device readiness.
  - Shows selected equipment profile, Bluetooth/UNO Q connection, setup walk status, and module placement.
  - Makes it clear that changing equipment may require calibration.
- `Coach`: guided support and gated load features.
  - Shows safe next-step guidance, data-quality nudges, and unavailable pressure/load features.
- Optional future `Profile`: user preferences, clinician name, privacy/export, and accessibility settings.

### Walk Screen Redesign

- Replace the current header card with a compact live status bar:
  - selected equipment
  - connection status
  - calibration status
  - data quality status
- Add a large central “session dial” card:
  - idle state: “Ready to walk” with selected equipment and one primary `Start` button.
  - recording state: elapsed time in the center, cadence/rhythm as supporting values, `Pause` and `Stop` actions.
  - attention state: connection or calibration issue with a clear fix action.
- Use one thumb-reachable sticky action area above the bottom nav.
- Keep secondary metrics in a horizontal swipe row:
  - cadence
  - cycle time
  - duty factor
  - rhythm consistency
- Use a compact sparkline or bar rhythm strip only after the primary session state is clear.

### Progress Screen Redesign

- Replace table-like history with a timeline of session cards.
- Add a weekly summary panel at the top:
  - sessions completed
  - total walking minutes
  - rhythm change vs personal baseline
  - most-used equipment
- Session cards should show:
  - equipment icon/name
  - duration
  - cycles
  - rhythm score
  - note/context
- Add filters as segmented controls:
  - week
  - month
  - equipment
- Avoid dense charts on mobile; use compact bars and sparklines with a detailed view later.

### Setup Screen Redesign

- Merge current Device and Gear concepts into a setup checklist:
  - `Module connected`
  - `Equipment selected`
  - `Mount position confirmed`
  - `Setup walk complete`
  - `Pressure sensor unavailable` when gated
- Equipment profiles should become large selectable rows with visual affordances:
  - cane
  - walker
  - crutch
  - rollator
  - custom aid
- Each profile row should show calibration status and last-used date.
- Bluetooth actions should be contextual:
  - scan when disconnected
  - reconnect when bridge unavailable
  - view diagnostics when connected
- UNO Q diagnostics should be tucked behind an expandable details section so normal users are not overwhelmed by sample-rate internals.

### Coach Screen Redesign

- Convert guardrails into contextual guidance cards:
  - before walk
  - during walk
  - after walk
- Add “Why this is unavailable” cards for gated pressure/load metrics.
- Use careful copy:
  - “Personal rhythm consistency”
  - “Compared with your setup walk”
  - “Device needs attention”
  - “Pressure module not ready”
- Do not use diagnostic, fall-risk, body-weight, force, or population-normal wording.

### Visual System

- Use a modern, warm clinical palette:
  - neutral background: near-white or soft graphite in dark mode
  - primary action: deep teal
  - live/connected: emerald
  - attention: amber
  - unavailable/gated: neutral gray
  - destructive stop: restrained red
- Avoid a one-note green or blue interface by using teal for primary action, emerald for status, amber for warnings, and slate/graphite for structure.
- Cards should use `8px` radius, subtle borders, and soft elevation only for active/selected states.
- Use larger type only for live session values; keep secondary card headings compact.
- Bottom nav should use icons plus short labels:
  - Walk
  - Progress
  - Setup
  - Coach
- Prefer lucide icons:
  - `Footprints` or `Activity` for Walk
  - `ChartNoAxesCombined` for Progress
  - `Bluetooth` or `Settings2` for Setup
  - `ShieldCheck` for Coach

### Interaction States

- Idle:
  - primary message: ready/not ready
  - primary action: start walk or fix setup
- Recording:
  - lock primary screen to live state
  - show pause/stop
  - avoid accidental stop with a confirmation sheet if needed
- Paused:
  - show resume/finish
  - preserve session metrics
- Review:
  - show short summary immediately after stop
  - allow note entry
  - save session
- Offline:
  - keep history accessible
  - show setup action to reconnect
- Gated:
  - show unavailable pressure/load features without suggesting they are active.

### Accessibility And Mobile Ergonomics

- Minimum touch target: `44px`.
- Sticky primary action should sit above the bottom navigation and safe area.
- Avoid horizontally cramped cards with long text.
- Use responsive wrapping for metric units and labels.
- Use color plus text/icon, never color alone.
- Ensure all live values remain readable at `360px` width.
- Support reduced-motion users by keeping animations subtle and non-essential.

## Claim Safety

- Do not display diagnosis, fall-risk claims, population-normal grading, clinical certainty, absolute force, Newtons, kgf, or percent body weight.
- Frame every result as personal training, personal baseline, device quality, or session history.
- Show pressure/load features as unavailable until the sensor, tare, calibration, and validation path are complete.

## Implementation Phases

1. Create the plan document and mobile app shell.
2. Add a server facade over the UNO Q bridge.
3. Add live IMU-only session metrics and state.
4. Add persistence for sessions, equipment profiles, calibration state, and notes.
5. Add gated pressure-channel types and UI only after hardware validation.

## Test Plan

- Run `bun run check-types` from `user-interface`.
- Run `bun run build` from `user-interface`.
- Verify mobile, tablet, and desktop widths.
- Test against `arduino_uno_q` mock normal/injured streams.
- Test disconnected bridge, bad samples, lost samples, and scan failure states.
- Search UI copy for banned clinical or force-related claims before release.

## Assumptions

- The first app target is responsive web, optimized for mobile browsers.
- The same module can be moved between equipment types, so calibration belongs to the equipment profile.
- `arduino_uno_q` remains the first hardware bridge.
- Load metrics remain gated until the pneumatic pressure sensor path is ready.
