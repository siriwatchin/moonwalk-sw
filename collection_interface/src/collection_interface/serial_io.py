from __future__ import annotations

from dataclasses import dataclass

from .utils import ImportResult, parse_protocol_text


@dataclass(frozen=True)
class SerialPortInfo:
    device: str
    description: str


def list_serial_ports() -> list[SerialPortInfo]:
    try:
        import serial.tools.list_ports
    except ImportError:
        return []

    return [
        SerialPortInfo(device=port.device, description=port.description)
        for port in serial.tools.list_ports.comports()
    ]


def open_serial(port: str, baud_rate: int):
    import serial

    return serial.Serial(port, baud_rate, timeout=0.05)


def read_available_lines(serial_connection, *, max_lines: int) -> ImportResult:
    lines: list[str] = []
    errors: list[str] = []

    for _ in range(max_lines):
        try:
            raw = serial_connection.readline()
        except Exception as error:
            errors.append(str(error))
            break

        if not raw:
            break

        lines.append(raw.decode("utf-8", errors="replace"))

    result = parse_protocol_text("".join(lines))
    return ImportResult(
        samples=result.samples,
        errors=errors + result.errors,
        ignored=result.ignored,
    )
