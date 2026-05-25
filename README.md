# Moon Walk Software

Moon Walk is an attachable sensor box for an ordinary walking stick or walker.
This repository contains the early software pieces for collecting motion data,
labeling cane-posture samples, and preparing datasets for later gait trend
analysis.

Moon Walk is a wellness self-monitoring product. It measures and trends gait
signals for user awareness; it does not diagnose, treat, predict disease, or
predict fall risk.

## Repository Layout

```text
.
├── CONTEXT.md                 Product language, scope, architecture, and safety rules
├── docs/                      PRD, feature notes, and architecture decision records
├── hardware/                  Arduino sketch plus Python bridge/protocol utilities
├── collection_interface/      External Streamlit data collection UI
└── ml_pipeline/               Notebook and Python environment for model experiments
```

## Data Flow

The current hardware path is focused on cane posture data collection:

1. `hardware/sketch/sketch.ino` reads a Modulino Movement IMU.
2. The sketch emits raw protocol lines:

   ```text
   MWALK_MOTION_RAW {"protocol":"cane-posture.motion.v1","kind":"raw",...}
   ```

3. `hardware/python/main.py` can receive Bridge updates, classify posture, and
   print enriched sample lines:

   ```text
   MWALK_MOTION_SAMPLE {"protocol":"cane-posture.motion.v1","kind":"sample",...}
   ```

4. `collection_interface` reads raw or enriched lines, applies labels/notes,
   visualizes signals, and exports datasets.

## Protocol Fields

Raw frames contain:

- `protocol`: `cane-posture.motion.v1`
- `kind`: `raw`
- `timestamp_ms`
- `ax_g`, `ay_g`, `az_g`
- `roll_dps`, `pitch_dps`, `yaw_dps`

Sample frames add derived collection fields:

- `timestamp`
- `accel_magnitude_g`
- `tilt_deg`
- `posture`: `upright`, `leaning`, or `moving`
- `label`
- `note`

## Hardware

The hardware module stays focused on streaming and protocol utilities.

Upload the sketch from:

```text
hardware/sketch/sketch.ino
```

Then run the Python bridge from `hardware`:

```powershell
cd hardware
uv run python python/main.py
```

Run hardware tests:

```powershell
cd hardware
uv run python -m unittest discover -s python/tests
```

If the Arduino linker reports missing `LSM6DSOXClass` symbols, make sure the
sketch includes `Arduino_LSM6DSOX.h` and `hardware/sketch/sketch.yaml` declares
`Arduino_LSM6DSOX`.

## Collection Interface

The Streamlit UI is intentionally outside `hardware`.

Run with the batch file:

```powershell
.\collection_interface\run_streamlit.bat
```

Or run manually:

```powershell
cd collection_interface
uv run streamlit run src/collection_interface/app.py
```

The interface supports:

- live serial collection from the Arduino stream;
- live WebSocket collection from a local or forwarded stream;
- pasted `MWALK_MOTION_RAW` or `MWALK_MOTION_SAMPLE` lines;
- uploaded `.jsonl`, `.log`, `.txt`, or `.csv` files;
- demo sample generation when hardware is unavailable;
- labels and notes for dataset collection;
- signal charts, posture distribution, row inspection, and exports;
- CSV, JSONL replay, and manifest downloads.

Run collection-interface tests:

```powershell
cd collection_interface
uv run python -m unittest discover -s tests
```

## ML Pipeline

The `ml_pipeline` folder is for dataset exploration and later model experiments.
It currently contains a uv Python environment and a notebook:

```text
ml_pipeline/notebooks/cane_imu_training.ipynb
```

Set up and run the placeholder script:

```powershell
cd ml_pipeline
uv run python main.py
```

## Development Checks

Recommended checks before sharing changes:

```powershell
cd hardware
uv run python -m unittest discover -s python/tests

cd ..\collection_interface
uv run python -m unittest discover -s tests
```

## Safety Language

Use the vocabulary in `CONTEXT.md` and `docs/adr/0005-*` for UI and docs.

Say:

- wellness cue
- self-monitoring
- behavior awareness
- "your walking has changed"

Avoid:

- diagnosis
- treatment
- fall risk
- "your condition is worsening"

Every dashboard or alert-like surface should carry the disclaimer:

```text
a wellness awareness cue, not a medical assessment
```
