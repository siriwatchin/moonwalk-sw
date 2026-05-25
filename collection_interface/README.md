# Moon Walk Collection Interface

External Streamlit collector for the `hardware` motion stream. It reads
`MWALK_MOTION_RAW` and `MWALK_MOTION_SAMPLE` protocol lines, reuses the hardware
motion parser/classifier, and keeps the UI outside the firmware/bridge module.

## Run

From this directory:

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

Moon Walk gait data is for wellness self-monitoring. UI alerts and summaries must
remain awareness cues, not medical assessments.
