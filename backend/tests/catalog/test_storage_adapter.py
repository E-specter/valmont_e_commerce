"""SupabaseImageStorage contra un transporte simulado: URL, cabeceras y fallos → 503."""

import logging

import httpx
import pytest

from valmont.modules.catalog.adapters.storage import SupabaseImageStorage
from valmont.modules.catalog.application import StorageUnavailable

KEY = "clave-de-servicio-ficticia"
PATH = "producto/imagen.png"
URL = f"http://supabase.test/storage/v1/object/products/{PATH}"


def storage_with(handler: object) -> tuple[SupabaseImageStorage, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)  # type: ignore[operator]

    transport = httpx.MockTransport(record)
    return SupabaseImageStorage("http://supabase.test/", KEY, transport=transport), seen


def test_put_posts_the_bytes_with_the_service_key_and_the_detected_type() -> None:
    storage, seen = storage_with(lambda request: httpx.Response(200, json={"Key": PATH}))

    storage.put(PATH, b"png", "image/png")

    [request] = seen
    assert (request.method, str(request.url), request.content) == ("POST", URL, b"png")
    assert request.headers["Authorization"] == f"Bearer {KEY}"
    assert request.headers["apikey"] == KEY
    assert request.headers["Content-Type"] == "image/png"


def test_delete_removes_the_object() -> None:
    storage, seen = storage_with(lambda request: httpx.Response(200, json={}))

    storage.delete(PATH)

    [request] = seen
    assert (request.method, str(request.url)) == ("DELETE", URL)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text=f"error interno con {KEY}"),
        httpx.Response(400, json={"statusCode": "403", "error": "Unauthorized"}),
        httpx.Response(302, headers={"Location": "http://otro.test/"}),
    ],
    ids=["500", "400", "redireccion"],
)
def test_unsuccessful_answers_are_storage_unavailable_and_redirects_are_not_followed(
    response: httpx.Response, caplog: pytest.LogCaptureFixture
) -> None:
    storage, seen = storage_with(lambda request: response)

    with caplog.at_level(logging.WARNING), pytest.raises(StorageUnavailable) as error:
        storage.put(PATH, b"png", "image/png")

    assert len(seen) == 1  # la redirección no se siguió
    assert str(error.value) == ""  # sin detalles de Storage
    assert KEY not in caplog.text


def test_network_errors_are_storage_unavailable_without_the_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"sin conexión ({KEY})", request=request)

    storage, _ = storage_with(fail)

    with caplog.at_level(logging.WARNING), pytest.raises(StorageUnavailable):
        storage.delete(PATH)

    assert "ConnectError" in caplog.text
    assert KEY not in caplog.text
