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
_VALID_REQUEST_ID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}"
)
QUIET_LOGGERS = ("sqlalchemy.engine", "httpcore")
# Hasta la siguiente marca de SQLAlchemy o el final: un valor puede traer saltos de línea.
_DB_END = r"(?=\n\s*(?:\[SQL:|\[parameters:|\(Background on this error)|\Z)"
_DB_KEY = re.compile(r"Key \(([^)]*)\)=\(.*?" + _DB_END, re.DOTALL)
_DB_ROW = re.compile(r"Failing row contains \(.*?" + _DB_END, re.DOTALL)
_DB_DETAIL = re.compile(r"^(\s*)DETAIL:.*?" + _DB_END, re.DOTALL | re.MULTILINE)

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
logger = logging.getLogger(__name__)


def redact_db_detail(text: str) -> str:
    """Quita de una traza los valores de columnas que PostgreSQL pone en `DETAIL` (RNF10)."""
    text = _DB_KEY.sub(r"Key (\1)=([omitido])", text)
    text = _DB_ROW.sub("Failing row contains ([omitido])", text)
    return _DB_DETAIL.sub(r"\1DETAIL: [omitido]", text)


def _db_errors(exc: BaseException | None) -> list[BaseException]:
    found: list[BaseException] = []
    stack = [exc]
    while stack and len(found) < 20:
        current = stack.pop()
        if current is None or any(current is seen for seen in found):
            continue
        found.append(current)
        stack += [current.__cause__, current.__context__, getattr(current, "orig", None)]
    return found


class SafeFormatter(logging.Formatter):
    def formatException(self, ei) -> str:  # noqa: ANN001
        lines = []
        for exc in _db_errors(ei[1]):
            diag = getattr(exc, "diag", None)
            if diag is not None:
                sqlstate = getattr(diag, "sqlstate", None) or getattr(exc, "sqlstate", None)
                constraint = getattr(diag, "constraint_name", None) or "-"
                lines.append(f"[BD] sqlstate={sqlstate or '-'} constraint={constraint}")
        return "\n".join([redact_db_detail(super().formatException(ei)), *lines])


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
        handler.setFormatter(SafeFormatter(LOG_FORMAT))
        root.addHandler(handler)
    root.setLevel(level)
    for name in QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


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
