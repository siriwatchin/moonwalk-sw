"""Parse raw Nano CSV payload lines into ImuSample objects."""

from .config import FIELD_COUNT, PAYLOAD_TAG
from .models import ImuSample


def parse_line(raw: str) -> ImuSample | None:
    """Parse one CSV payload line; return None for malformed input."""
    parts = raw.strip().split(",")
    if len(parts) != FIELD_COUNT or parts[0] != PAYLOAD_TAG:
        return None

    try:
        return ImuSample(
            timestamp_ms=int(parts[1]),
            ax=float(parts[2]), ay=float(parts[3]), az=float(parts[4]),
            gx=float(parts[5]), gy=float(parts[6]), gz=float(parts[7]),
            acc_norm=float(parts[8]),
            gyro_norm=float(parts[9]),
            phase=int(parts[10]),
        )
    except ValueError:
        return None
