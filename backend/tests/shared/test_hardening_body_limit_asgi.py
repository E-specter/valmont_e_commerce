"""`BodyLimitMiddleware` y `body_limit_for` aislados (T-018a, reglas 1 a 3 del paquete).

Se prueban con una app ASGI mínima y un conductor a mano (`asgi_call`): varios mensajes de
cuerpo, `Content-Length` que miente y scopes que no son HTTP. Datos ficticios."""

import json
from pathlib import Path
from typing import Any

import pytest

from tests.shared.hardening_helpers import ASGIApp, AsgiResult, asgi_call
from valmont.shared import hardening
from valmont.shared.hardening import (
    MAX_BODY_BYTES,
    MAX_MULTIPART_BODY_BYTES,
    NO_STORE_PREFIX,
    BodyLimitMiddleware,
    body_limit_for,
)

SMALL, BIG = 100, 1000  # límites de las pruebas con un middleware pequeño
MULTIPART = "multipart/form-data; boundary=frontera"
EXPECTED_MESSAGE = "El cuerpo de la solicitud supera el tamaño permitido."


class Inner:
    """App interna que lee el cuerpo entero y responde 200 con los bytes recibidos."""

    def __init__(self) -> None:
        self.calls = 0
        self.received = 0

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        self.calls += 1
        while True:
            message = await receive()
            self.received += len(message.get("body", b""))
            if not message.get("more_body"):
                break
        await respond(send, 200, {"received": self.received})


class SwallowingInner(Inner):
    """Como FastAPI: si `receive` falla, la excepción no sale; se responde un 400."""

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        self.calls += 1
        try:
            while True:
                message = await receive()
                self.received += len(message.get("body", b""))
                if not message.get("more_body"):
                    break
        except Exception:
            await respond(send, 400, {"error": "cuerpo ilegible"})
            return
        await respond(send, 200, {"received": self.received})


async def respond(send: Any, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})


def wrap(inner: ASGIApp, small: int = SMALL, big: int = BIG) -> BodyLimitMiddleware:
    return BodyLimitMiddleware(inner, max_body_bytes=small, max_multipart_bytes=big)


def assert_413(result: AsgiResult, limit: int) -> None:
    assert result.status == 413, result.body
    assert result.responses_started == 1
    assert result.headers["content-type"].startswith("application/json")
    assert result.json() == {
        "error": {
            "code": "payload_too_large",
            "message": EXPECTED_MESSAGE,
            "details": {"max_bytes": limit},
        }
    }


def test_limits_match_the_decisions_d_h3_and_caddy() -> None:
    assert MAX_BODY_BYTES == 256 * 1024
    assert MAX_MULTIPART_BODY_BYTES == 6 * 1024 * 1024
    assert NO_STORE_PREFIX == "/api/"


@pytest.mark.parametrize(
    ("content_type", "expected"),
    [
        (None, SMALL),
        ("", SMALL),
        ("application/json", SMALL),
        ("application/json; charset=utf-8", SMALL),
        ("application/x-www-form-urlencoded", SMALL),
        ("text/plain", SMALL),
        ("multipart/form-data", BIG),
        (MULTIPART, BIG),
    ],
)
def test_body_limit_for_picks_the_multipart_limit_only_for_form_data(
    content_type: str | None, expected: int
) -> None:
    assert body_limit_for(content_type, max_body_bytes=SMALL, max_multipart_bytes=BIG) == expected


def test_default_constructor_applies_the_default_limits() -> None:
    app = BodyLimitMiddleware(Inner())

    at_limit = asgi_call(app, chunks=[b"x" * MAX_BODY_BYTES])
    over = asgi_call(app, chunks=[b"x" * (MAX_BODY_BYTES + 1)])

    assert at_limit.status == 200
    assert_413(over, MAX_BODY_BYTES)


# --- Regla 1: Content-Length numérico mayor que el límite -> 413 sin leer el cuerpo ---


def test_declared_length_over_the_limit_is_413_without_running_the_app() -> None:
    inner = Inner()

    result = asgi_call(wrap(inner), headers=[("Content-Length", str(SMALL + 1))], chunks=[b"x"])

    assert_413(result, SMALL)
    assert inner.calls == 0


def test_declared_length_over_the_limit_wins_even_if_the_real_body_is_tiny() -> None:
    inner = Inner()

    result = asgi_call(wrap(inner), headers=[("content-length", "1000000")], chunks=[b"hola"])

    assert_413(result, SMALL)
    assert inner.calls == 0


def test_declared_length_exactly_at_the_limit_passes() -> None:
    result = asgi_call(
        wrap(Inner()), headers=[("Content-Length", str(SMALL))], chunks=[b"x" * SMALL]
    )

    assert result.status == 200 and result.json() == {"received": SMALL}


def test_the_413_does_not_echo_anything_the_client_sent() -> None:
    result = asgi_call(
        wrap(Inner()),
        headers=[("Content-Length", "5000"), ("X-Dato", "valor-del-cliente")],
        chunks=[b"cuerpo-del-cliente"],
    )

    assert result.status == 413
    assert b"valor-del-cliente" not in result.body and b"cuerpo-del-cliente" not in result.body


# --- Regla 2: sin Content-Length o con uno falso -> se cuentan los bytes recibidos ---


def test_a_body_exactly_at_the_limit_passes_and_one_more_byte_is_413() -> None:
    ok = asgi_call(wrap(Inner()), chunks=[b"x" * SMALL])
    over = asgi_call(wrap(Inner()), chunks=[b"x" * (SMALL + 1)])

    assert ok.status == 200 and ok.json() == {"received": SMALL}
    assert_413(over, SMALL)


def test_chunks_are_added_up_across_messages() -> None:
    parts = [b"x" * 40, b"y" * 40, b"z" * 40]  # 120 > 100, ninguna pieza lo supera sola

    assert_413(asgi_call(wrap(Inner()), chunks=parts), SMALL)


def test_many_tiny_chunks_exactly_at_the_limit_pass() -> None:
    result = asgi_call(wrap(Inner()), chunks=[b"x"] * SMALL)

    assert result.status == 200 and result.json() == {"received": SMALL}


def test_a_lying_content_length_smaller_than_the_real_body_is_413() -> None:
    result = asgi_call(wrap(Inner()), headers=[("Content-Length", "10")], chunks=[b"x" * 300])

    assert_413(result, SMALL)


def test_overflow_is_413_even_if_the_app_swallows_the_receive_error() -> None:
    # FastAPI convierte una excepción de `receive` en 400: el 413 debe prevalecer.
    result = asgi_call(wrap(SwallowingInner()), chunks=[b"x" * 60, b"y" * 60])

    assert_413(result, SMALL)


def test_overflow_is_413_and_not_an_error_when_the_app_does_not_catch() -> None:
    result = asgi_call(wrap(Inner()), chunks=[b"x" * 60, b"y" * 60, b"z" * 60])

    assert_413(result, SMALL)


# --- Regla 3: Content-Length no numérico -> se ignora y rige el recuento ---


@pytest.mark.parametrize("declared", ["abc", "-5", "1e9", "", "12 34"])
def test_a_non_numeric_content_length_is_ignored_for_a_small_body(declared: str) -> None:
    result = asgi_call(wrap(Inner()), headers=[("Content-Length", declared)], chunks=[b"x" * 10])

    assert result.status == 200 and result.json() == {"received": 10}


@pytest.mark.parametrize("declared", ["abc", "-5", "1e9", ""])
def test_a_non_numeric_content_length_does_not_hide_a_big_body(declared: str) -> None:
    result = asgi_call(wrap(Inner()), headers=[("Content-Length", declared)], chunks=[b"x" * 300])

    assert_413(result, SMALL)


# --- Multipart: otro límite ---


def test_multipart_has_its_own_larger_limit() -> None:
    ok = asgi_call(
        wrap(Inner()), headers=[("Content-Type", MULTIPART)], chunks=[b"x" * (SMALL * 5)]
    )
    json_same_size = asgi_call(
        wrap(Inner()),
        headers=[("Content-Type", "application/json")],
        chunks=[b"x" * (SMALL * 5)],
    )

    assert ok.status == 200 and ok.json() == {"received": SMALL * 5}
    assert_413(json_same_size, SMALL)


def test_multipart_exactly_at_its_limit_passes_and_one_more_is_413_with_that_limit() -> None:
    headers = [("Content-Type", MULTIPART)]

    at_limit = asgi_call(wrap(Inner()), headers=headers, chunks=[b"x" * BIG])
    over = asgi_call(wrap(Inner()), headers=headers, chunks=[b"x" * (BIG + 1)])
    declared = asgi_call(
        wrap(Inner()), headers=[*headers, ("Content-Length", str(BIG + 1))], chunks=[b"x"]
    )

    assert at_limit.status == 200
    assert_413(over, BIG)
    assert_413(declared, BIG)


# --- Lo que no es una solicitud con cuerpo no cambia ---


def test_a_get_without_a_body_passes_through() -> None:
    inner = Inner()

    result = asgi_call(wrap(inner), method="GET", path="/api/v1/test/echo")

    assert result.status == 200 and result.json() == {"received": 0}
    assert inner.calls == 1


@pytest.mark.parametrize("scope_type", ["lifespan", "websocket"])
def test_scopes_that_are_not_http_go_straight_to_the_app(scope_type: str) -> None:
    seen: list[str] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        seen.append(scope["type"])

    asgi_call(wrap(inner), scope_type=scope_type)

    assert seen == [scope_type]


def test_the_module_does_not_import_other_modules_of_the_app() -> None:
    # Capas: shared/ no depende de modules/.
    source = Path(hardening.__file__).read_text(encoding="utf-8")

    assert "valmont.modules" not in source
