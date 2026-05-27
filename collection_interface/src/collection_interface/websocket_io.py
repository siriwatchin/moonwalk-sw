from __future__ import annotations

from dataclasses import dataclass

from .utils import ImportResult, parse_protocol_text


@dataclass(frozen=True)
class WebSocketReadConfig:
    max_messages: int
    timeout_s: float


def open_websocket(url: str, *, open_timeout_s: float = 5.0):
    from websockets.sync.client import connect

    return connect(url, open_timeout=open_timeout_s)


def read_available_messages(websocket_connection, *, config: WebSocketReadConfig) -> ImportResult:
    messages: list[str] = []
    errors: list[str] = []

    for _ in range(config.max_messages):
        try:
            message = websocket_connection.recv(timeout=config.timeout_s)
        except TimeoutError:
            break
        except Exception as error:
            errors.append(str(error))
            break

        if isinstance(message, bytes):
            messages.append(message.decode("utf-8", errors="replace"))
        else:
            messages.append(str(message))

    result = parse_protocol_text("\n".join(messages))
    return ImportResult(
        samples=result.samples,
        errors=errors + result.errors,
        ignored=result.ignored,
    )
