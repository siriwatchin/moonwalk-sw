# Modulino Movement Cane Posture Collector

Reads accelerometer and gyroscope/orientation-rate data from a Modulino Movement
node for cane posture data collection. The hardware module exposes a streaming
protocol only; use a separate Streamlit app or notebook to visualize and label
the stream.

The sketch publishes six values through Bridge:

```text
motion_update(ax_g, ay_g, az_g, roll_dps, pitch_dps, yaw_dps)
```

It also prints raw JSON Lines that external tools can consume:

```text
MWALK_MOTION_RAW {"protocol":"cane-posture.motion.v1","kind":"raw","timestamp_ms":1234,"ax_g":0.0,"ay_g":0.0,"az_g":1.0,"roll_dps":0.0,"pitch_dps":0.0,"yaw_dps":0.0}
```

The Python bridge enriches frames with derived posture fields and writes:

```text
MWALK_MOTION_SAMPLE {"protocol":"cane-posture.motion.v1","kind":"sample","timestamp":...,"ax_g":0.0,"ay_g":0.0,"az_g":1.0,"roll_dps":0.0,"pitch_dps":0.0,"yaw_dps":0.0,"accel_magnitude_g":1.0,"tilt_deg":0.0,"posture":"upright","label":"","note":""}
```

## Run the bridge app

Upload `sketch/sketch.ino` to the board, then run the Python bridge app:

```powershell
uv run python python/main.py
```

## Run tests

```powershell
uv run python -m unittest discover -s python/tests
```

## Use External Streamlit

Keep Streamlit outside this hardware module. A separate app can either:

- read `MWALK_MOTION_RAW` lines from the board serial monitor, then classify with
  `python/stream_protocol.py` and `python/motion.py`;
- read `MWALK_MOTION_SAMPLE` lines from `uv run python python/main.py` stdout
  when it wants already-classified posture samples.

The frame schema is versioned with `protocol: cane-posture.motion.v1` so an
external Streamlit collector can validate incoming rows before charting or saving
labels.
