"""Ayudas de las pruebas de T-018a/b: comprobación de cabeceras y un conductor ASGI a mano.

Datos ficticios. El conductor ASGI permite lo que un cliente HTTP no: varios mensajes de cuerpo,
un `Content-Length` que miente y scopes que no son HTTP."""

import asyncio
import json
import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

HEX32 = re.compile(r"[0-9a-f]{32}")
NO_STORE = "no-store"
NOSNIFF = "nosniff"

Scope = dict[str, Any]
Message = dict[str, Any]
ASGIApp = Callable[
    [Scope, Callable[[], Awaitable[Message]], Callable[[Message], Awaitable[None]]], Awaitable[None]
]


def assert_hardened(response: Any, *, request_id: bool = True) -> None:
    """Respuesta de `/api/`: `no-store`, `nosniff` y, salvo que se pida lo contrario, id."""
    assert response.headers["x-content-type-options"] == NOSNIFF, response.status_code
    assert response.headers["cache-control"] == NO_STORE, response.status_code
    if request_id:
        assert response.headers["x-request-id"], response.status_code


@dataclass
class AsgiResult:
    status: int | None
    headers: dict[str, str]
    body: bytes
    responses_started: int

    def json(self) -> Any:
        return json.loads(self.body)


def asgi_call(
    app: ASGIApp,
    *,
    chunks: Iterable[bytes] = (),
    headers: Iterable[tuple[str, str]] = (),
    method: str = "POST",
    path: str = "/api/v1/test/echo",
    scope_type: str = "http",
) -> AsgiResult:
    """Una solicitud ASGI cruda: `chunks` llegan como mensajes `http.request` sucesivos."""
    scope: Scope = {
        "type": scope_type,
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    pending = list(chunks)
    sent: list[Message] = []

    async def receive() -> Message:
        if pending:
            body = pending.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(pending)}
        if not sent and not pending:
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.sleep(0)
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    start = [m for m in sent if m["type"] == "http.response.start"]
    status = start[-1]["status"] if start else None
    response_headers = {
        k.decode().lower(): v.decode() for k, v in (start[-1]["headers"] if start else [])
    }
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return AsgiResult(status, response_headers, body, len(start))
