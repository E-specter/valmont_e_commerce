"""JWKS que no es JSON: 503 `auth_unavailable`, nunca 401 (T-018b, prueba 5; hallazgo de T-016).

`jwt.PyJWKClient.fetch_data` deja escapar el `JSONDecodeError` o el `UnicodeDecodeError` de
`json.load`; ambos son `ValueError`, y antes caían en el 401. El aviso del log nunca lleva el
cuerpo recibido. Datos ficticios."""

import json
import logging
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from uuid import uuid4

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from tests.catalog.test_admin_http import Untouchable
from tests.identity.identity_helpers import (
    JWKS,
    OTHER_KEY,
    T0,
    InMemoryProfiles,
    StaticJWKClient,
    make_token,
    use_test_auth,
)
from valmont.main import create_app
from valmont.modules.audit.adapters.http import get_audit_recorder
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared import auth
from valmont.shared.errors import AppError

USER = uuid4()
ME = "/api/v1/identity/me"
ADMIN_LIST = "/api/v1/catalog/admin/products"
BODY_MARKER = "MARCADOR-DEL-CUERPO-DEL-JWKS"
HTML = f"<html><body><h1>Bad Gateway</h1><p>{BODY_MARKER}</p></body></html>".encode()
NOT_UTF8 = b"\xff\xfe\x00" + BODY_MARKER.encode() + b"\xc3\x28"
UNAVAILABLE = {
    "error": {
        "code": "auth_unavailable",
        "message": "Autenticación no disponible.",
        "details": None,
    }
}


class BrokenJWKClient(StaticJWKClient):
    """El cliente real de PyJWT cuyo `fetch_data` falla con la excepción dada."""

    def __init__(self, error: Exception) -> None:
        super().__init__(JWKS)
        self._error = error

    def fetch_data(self) -> Any:
        raise self._error


def json_error() -> json.JSONDecodeError:
    return json.JSONDecodeError("Expecting value", f"<html>{BODY_MARKER}</html>", 0)


def unicode_error() -> UnicodeDecodeError:
    return UnicodeDecodeError("utf-8", NOT_UTF8, 0, 1, "invalid start byte")


def use_client(monkeypatch: pytest.MonkeyPatch, client: jwt.PyJWKClient) -> None:
    use_test_auth(monkeypatch)
    monkeypatch.setattr(auth, "get_jwks_client", lambda: client)


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    profiles = InMemoryProfiles()
    profiles.rows[USER] = Profile(USER, Role.ADMIN, T0, T0)
    use_test_auth(monkeypatch)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    for dependency in (
        http.get_product_repository,
        get_audit_recorder,
        admin_http.get_image_storage,
    ):
        app.dependency_overrides[dependency] = Untouchable
    return TestClient(app, raise_server_exceptions=False)


def bearer(token: str | None = None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token or make_token(str(USER))}"}


FAILURES = [
    pytest.param(json_error, id="JSONDecodeError"),
    pytest.param(unicode_error, id="UnicodeDecodeError"),
]


# --- verify_token directo ---


@pytest.mark.parametrize("make_error", FAILURES)
def test_verify_token_raises_503_when_the_jwks_is_not_json(
    monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], Exception]
) -> None:
    use_client(monkeypatch, BrokenJWKClient(make_error()))

    with pytest.raises(AppError) as caught:
        auth.verify_token(make_token(str(USER)))

    assert (caught.value.code, caught.value.status_code) == ("auth_unavailable", 503)
    assert caught.value.message == "Autenticación no disponible."
    assert caught.value.__cause__ is None  # `from None`: sin la excepción original encadenada
    assert caught.value.__suppress_context__


@pytest.mark.parametrize("make_error", FAILURES)
def test_the_warning_names_the_error_type_and_never_the_body(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    make_error: Callable[[], Exception],
) -> None:
    use_client(monkeypatch, BrokenJWKClient(make_error()))
    caplog.set_level(logging.DEBUG)

    with pytest.raises(AppError):
        auth.verify_token(make_token(str(USER)))

    warnings = [r for r in caplog.records if r.name == "valmont.shared.auth"]
    assert [r.levelno for r in warnings] == [logging.WARNING]
    assert type(make_error()).__name__ in warnings[0].getMessage()
    assert BODY_MARKER not in caplog.text
    assert warnings[0].exc_info is None  # una traza repetiría el cuerpo en el documento


@pytest.mark.parametrize("make_error", FAILURES)
@pytest.mark.parametrize("garbage", ["no-es-un-token", "a.b.c", "", "x" * 300])
def test_the_same_failing_client_with_a_garbage_token_is_401(
    monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], Exception], garbage: str
) -> None:
    use_client(monkeypatch, BrokenJWKClient(make_error()))

    with pytest.raises(HTTPException) as caught:
        auth.verify_token(garbage)

    assert caught.value.status_code == 401


def test_a_bad_signature_is_still_401_with_a_healthy_jwks(monkeypatch: pytest.MonkeyPatch) -> None:
    use_client(monkeypatch, StaticJWKClient(JWKS))

    with pytest.raises(HTTPException) as caught:
        auth.verify_token(make_token(str(USER), key=OTHER_KEY))

    assert caught.value.status_code == 401


def test_a_connection_failure_is_still_503(monkeypatch: pytest.MonkeyPatch) -> None:
    use_client(monkeypatch, StaticJWKClient(None))

    with pytest.raises(AppError) as caught:
        auth.verify_token(make_token(str(USER)))

    assert (caught.value.code, caught.value.status_code) == ("auth_unavailable", 503)


# --- Por HTTP, en rutas protegidas de dos módulos ---


@pytest.mark.parametrize("path", [ME, ADMIN_LIST])
@pytest.mark.parametrize("make_error", FAILURES)
def test_a_protected_route_answers_503_in_the_common_format(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    make_error: Callable[[], Exception],
    path: str,
) -> None:
    monkeypatch.setattr(auth, "get_jwks_client", lambda: BrokenJWKClient(make_error()))

    response = api.get(path, headers=bearer())

    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    assert BODY_MARKER not in response.text
    assert response.headers["x-request-id"]


@pytest.mark.parametrize("make_error", FAILURES)
def test_a_protected_route_with_garbage_token_is_401_even_if_the_jwks_is_broken(
    api: TestClient, monkeypatch: pytest.MonkeyPatch, make_error: Callable[[], Exception]
) -> None:
    monkeypatch.setattr(auth, "get_jwks_client", lambda: BrokenJWKClient(make_error()))

    response = api.get(ME, headers=bearer("no-es-un-token"))

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"
    assert response.headers["www-authenticate"] == "Bearer"


def test_without_a_token_it_is_401_not_503(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth, "get_jwks_client", lambda: BrokenJWKClient(json_error()))

    assert api.get(ME).status_code == 401


# --- De punta a punta: un servidor local y el urllib real de PyJWT ---


@dataclass
class Remote:
    url: str
    hits: list[str]


@pytest.fixture
def serve() -> Iterator[Callable[[int, bytes, str], Remote]]:
    servers: list[ThreadingHTTPServer] = []

    def start(status: int, body: bytes, content_type: str) -> Remote:
        hits: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - nombre fijado por http.server
                hits.append(self.path)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return Remote(f"http://127.0.0.1:{server.server_address[1]}/auth/v1/jwks.json", hits)

    yield start
    for server in servers:
        server.shutdown()
        server.server_close()


def real_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, timeout=5)


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        pytest.param(HTML, "text/html; charset=utf-8", id="html"),
        pytest.param(NOT_UTF8, "application/octet-stream", id="bytes-no-utf8"),
        pytest.param(b"", "application/json", id="vacio"),
        pytest.param(b"{claves: sin comillas}", "application/json", id="json-roto"),
    ],
)
def test_a_real_jwks_endpoint_that_answers_200_with_something_that_is_not_json_is_503(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    serve: Callable[[int, bytes, str], Remote],
    caplog: pytest.LogCaptureFixture,
    body: bytes,
    content_type: str,
) -> None:
    remote = serve(200, body, content_type)
    monkeypatch.setattr(auth, "get_jwks_client", lambda: real_client(remote.url))
    caplog.set_level(logging.DEBUG)

    response = api.get(ME, headers=bearer())

    assert remote.hits, "el cliente real debía haber consultado el JWKS"
    assert response.status_code == 503
    assert response.json() == UNAVAILABLE
    assert BODY_MARKER not in response.text and BODY_MARKER not in caplog.text
    assert "Bad Gateway" not in caplog.text


def test_a_real_jwks_endpoint_answering_a_server_error_is_503(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    serve: Callable[[int, bytes, str], Remote],
) -> None:
    remote = serve(502, HTML, "text/html")
    monkeypatch.setattr(auth, "get_jwks_client", lambda: real_client(remote.url))

    response = api.get(ME, headers=bearer())

    assert response.status_code == 503 and response.json() == UNAVAILABLE


def test_a_real_jwks_endpoint_with_valid_json_and_the_right_key_authenticates(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    serve: Callable[[int, bytes, str], Remote],
) -> None:
    remote = serve(200, json.dumps(JWKS).encode(), "application/json")
    monkeypatch.setattr(auth, "get_jwks_client", lambda: real_client(remote.url))

    response = api.get(ME, headers=bearer())

    assert response.status_code == 200, response.text


def test_a_real_jwks_with_json_but_no_matching_key_stays_401(
    api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    serve: Callable[[int, bytes, str], Remote],
) -> None:
    # Residual aceptado (R-2 de STATUS): JSON válido sin la clave se trata como `kid` desconocido.
    remote = serve(200, json.dumps({"keys": []}).encode(), "application/json")
    monkeypatch.setattr(auth, "get_jwks_client", lambda: real_client(remote.url))

    response = api.get(ME, headers=bearer())

    assert response.status_code == 401
