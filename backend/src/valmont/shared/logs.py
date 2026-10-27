import logging
import re
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from uuid import uuid4

from fastapi import Request, Response

from valmont.shared.errors import error_response

REQUEST_ID_HEADER = "X-Request-ID"
LOG_FORMAT = "%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s"
_HANDLER_NAME = "valmont"
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9-]{1,64}")

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
logger = logging.getLogger(__name__)


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


def configure_logging(level: str) -> None:
    root = logging.getLogger()
    # Sin basicConfig: no actúa si la raíz ya tiene handlers (pytest); create_app puede repetirse.
    if not any(handler.get_name() == _HANDLER_NAME for handler in root.handlers):
        handler = logging.StreamHandler()
        handler.set_name(_HANDLER_NAME)
        handler.addFilter(RequestIdFilter())
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(handler)
    root.setLevel(level)


async def request_id_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    incoming = request.headers.get(REQUEST_ID_HEADER, "")
    request_id = incoming if _VALID_REQUEST_ID.fullmatch(incoming) else uuid4().hex
    token = request_id_var.set(request_id)
    try:
        response = await call_next(request)
    except Exception:
        # Aquí y no en exception_handler(Exception): Starlette lo ejecuta fuera de los middlewares.
        logger.exception("Error no controlado")
        response = error_response(500, "internal_error", "Error interno del servidor.")
    logger.info("%s %s %s", request.method, request.url.path, response.status_code)
    request_id_var.reset(token)
    response.headers[REQUEST_ID_HEADER] = request_id
    return response
