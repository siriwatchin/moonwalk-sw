# Moon Walk ML Pipeline

Workspace for exploring collected cane-posture datasets and later training
models from Moon Walk motion samples.

The current pipeline is intentionally lightweight. Data collection lives in
`../collection_interface`, while this folder holds notebooks and Python
dependencies for analysis.

## Setup

From this directory:

```powershell
uv sync
```

## Run

```powershell
uv run python main.py
```

## Notebook

```text
notebooks/cane_imu_training.ipynb
```

Use exported CSV files from the collection interface as notebook inputs.

## Dependencies

The uv project includes:

- `pandas`
- `numpy`
- `scikit-learn`
- `matplotlib`
- `joblib`

## Safety

Models and charts in this folder are for wellness self-monitoring experiments.
Do not frame outputs as diagnosis, treatment, medical decisions, or fall-risk
prediction.
