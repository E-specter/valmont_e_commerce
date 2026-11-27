"""Cabeceras de seguridad y límite de tamaño del cuerpo (T-018a). ASGI puro, sin dependencias."""

from collections.abc import Awaitable, Callable

from fastapi import Request, Response
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from valmont.shared.errors import error_response

MAX_BODY_BYTES = 256 * 1024
# Igual al `request_body max_size` de Caddy; por encima del `_BODY_MAX` de catalog, que sigue
# siendo quien responde `file_too_large` entre 5 MiB + 64 KiB y 6 MiB.
MAX_MULTIPART_BODY_BYTES = 6 * 1024 * 1024
NO_STORE_PREFIX = "/api/"


def body_limit_for(
    content_type: str | None, *, max_body_bytes: int, max_multipart_bytes: int
) -> int:
    if content_type and content_type.lower().startswith("multipart/form-data"):
        return max_multipart_bytes
    return max_body_bytes


class BodyLimitMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: int = MAX_BODY_BYTES,
        max_multipart_bytes: int = MAX_MULTIPART_BODY_BYTES,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.max_multipart_bytes = max_multipart_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        limit = body_limit_for(
            headers.get("content-type"),
            max_body_bytes=self.max_body_bytes,
            max_multipart_bytes=self.max_multipart_bytes,
        )
        declared = headers.get("content-length", "")
        if declared.isascii() and declared.isdigit() and int(declared) > limit:
            await self._reject(scope, receive, send, limit)
            return

        received = 0
        overflow = False
        replied = False

        async def counting_receive() -> Message:
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    overflow = True
                    # El body() de la app falla y FastAPI lo traduciría a 400: se sustituye abajo.
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal replied
            if not overflow:
                await send(message)
            elif not replied:
                replied = True
                await self._reject(scope, receive, send, limit)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not overflow:
                raise
        if overflow and not replied:
            await self._reject(scope, receive, send, limit)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send, limit: int) -> None:
        response = error_response(
            413,
            "payload_too_large",
            "El cuerpo de la solicitud supera el tamaño permitido.",
            {"max_bytes": limit},
        )
        await response(scope, receive, send)


async def security_headers_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith(NO_STORE_PREFIX) and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response
