from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException

_HTTP_CODES = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
}


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Any = None


class ErrorOut(BaseModel):
    """Formato común de error (modules.md §4.4), para declararlo en el OpenAPI."""

    error: ErrorBody


# Para `responses=` de las rutas. Declarar 422 sustituye el HTTPValidationError de FastAPI.
ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorOut, "description": description}
    for status, description in {
        401: "`unauthenticated`: falta el token o no es válido.",
        403: "`forbidden`: el rol no basta.",
        422: "`validation_error`: datos de entrada no válidos.",
        503: "`auth_unavailable`: no se pudo verificar el token.",
    }.items()
}


class AppError(Exception):
    def __init__(
        self, code: str, message: str, status_code: int = 400, details: object = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details


def error_response(
    status_code: int, code: str, message: str, details: object = None
) -> JSONResponse:
    error = {"code": code, "message": message, "details": jsonable_encoder(details)}
    return JSONResponse(status_code=status_code, content={"error": error})


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return error_response(exc.status_code, exc.code, exc.message, exc.details)

    @app.exception_handler(HTTPException)
    async def handle_http_error(request: Request, exc: HTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "http_error")
        response = error_response(exc.status_code, code, str(exc.detail))
        response.headers.update(exc.headers or {})
        return response

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Sin "input": no se devuelve al cliente lo que envió (RNF10, p. ej. contraseñas).
        details = [{k: v for k, v in e.items() if k != "input"} for e in exc.errors()]
        return error_response(422, "validation_error", "Datos de entrada no válidos.", details)
