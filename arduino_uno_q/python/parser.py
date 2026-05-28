"""Parse raw Nano CSV payload lines into ImuSample objects. No SDK imports."""

import math

from config import FIELD_COUNT, PAYLOAD_TAG, PHASE_LABELS
from models import ImuSample


def parse_line(raw: str) -> ImuSample | None:
    """Parse one CSV payload line; return None for malformed input.

    Beyond field-count/tag checks, reject values that are present but nonsensical: non-finite
    floats (NaN/inf from a sensor glitch or bad formatting) and phase codes outside the known
    set. A None return is counted as a "bad" sample upstream rather than poisoning the charts.
    """
    parts = raw.strip().split(",")
    if len(parts) != FIELD_COUNT or parts[0] != PAYLOAD_TAG:
        return None

    try:
        floats = [float(parts[i]) for i in range(2, 10)]
        if not all(math.isfinite(v) for v in floats):
            return None        # NaN / inf — sensor glitch or corrupt line
        phase = int(parts[10])
        if phase not in PHASE_LABELS:
            return None        # unknown phase code — out of contract
        ax, ay, az, gx, gy, gz, acc_norm, gyro_norm = floats
        return ImuSample(
            timestamp_ms=int(parts[1]),
            ax=ax, ay=ay, az=az,
            gx=gx, gy=gy, gz=gz,
            acc_norm=acc_norm,
            gyro_norm=gyro_norm,
            phase=phase,
        )
    except ValueError:
        return None
