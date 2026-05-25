# Moon Walk Collection Interface

External Streamlit collector for the `hardware` motion stream. It reads
`MWALK_MOTION_RAW` and `MWALK_MOTION_SAMPLE` protocol lines, reuses the hardware
motion parser/classifier, and keeps the UI outside the firmware/bridge module.

## Run

From the repository root, double-click or run:

```powershell
.\collection_interface\run_streamlit.bat
```

Or from this directory:

```powershell
uv run streamlit run src/collection_interface/app.py
```

## Test

```powershell
uv run python -m unittest discover -s tests
```

## Inputs

- Live serial lines from the Arduino serial monitor or bridge output.
- Pasted protocol lines.
- Uploaded `.jsonl`, `.log`, `.txt`, or `.csv` files.
- Demo samples for UI checks without hardware.

## Outputs

- CSV dataset for notebooks and training.
- JSONL protocol replay using `MWALK_MOTION_SAMPLE` lines.
- Session manifest with summary metrics, label counts, and collection metadata.

## Utilities

- `src/collection_interface/utils.py` parses protocol text, parses CSV, applies
  labels/notes, summarizes sessions, downsamples visualizations, generates demo
  samples, and exports CSV/JSONL/manifests.
- `src/collection_interface/serial_io.py` lists serial ports and reads available
  protocol lines from a connected board.
- `src/collection_interface/hardware_imports.py` adds `hardware/python` to the
  Python path so the app reuses the hardware motion and protocol code.

Moon Walk gait data is for wellness self-monitoring. UI alerts and summaries must
remain awareness cues, not medical assessments.
