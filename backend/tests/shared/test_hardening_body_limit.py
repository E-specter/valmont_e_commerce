"""Límite de cuerpo (413 `payload_too_large`) en la app real (T-018a, D-H3 y D-047).

Sin BD. JSON: 256 KiB. Multipart: 6 MiB (la imagen de 5 MiB de catalog sigue funcionando y
catalog responde `file_too_large` entre 5 MiB + 64 KiB y 6 MiB). Datos ficticios."""

from collections.abc import Iterator
from dataclasses import dataclass
from uuid import uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import InMemoryStorage, tiny_png
from tests.catalog.test_domain import make_product
from tests.catalog.test_images_http import ADMIN, BASE, CDN, OneProduct, upload
from tests.identity.birth_date_helpers import BirthDateProfiles
from tests.identity.identity_helpers import T0, make_token, use_test_auth
from tests.shared.hardening_helpers import HEX32, NO_STORE, NOSNIFF, assert_hardened
from valmont.main import create_app
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.catalog.domain import IMAGE_MAX_BYTES
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings
from valmont.shared.hardening import MAX_BODY_BYTES, MAX_MULTIPART_BODY_BYTES

ME = "/api/v1/identity/me"
ECHO = "/api/v1/test/echo"
JSON = {"Content-Type": "application/json"}
MULTIPART = {"Content-Type": "multipart/form-data; boundary=frontera"}
MESSAGE = "El cuerpo de la solicitud supera el tamaño permitido."
USER = uuid4()
FORM_OVERHEAD = 64 * 1024  # el archivo más el resto del multipart (el `_BODY_MAX` de catalog)


@dataclass
class World:
    client: TestClient
    admin: TestClient
    profiles: BirthDateProfiles
    storage: InMemoryStorage
    product: OneProduct
    ran: list[int]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    use_test_auth(monkeypatch)
    settings = Settings(_env_file=None, storage_public_url=CDN)
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    profiles = BirthDateProfiles()
    profiles.rows[USER] = Profile(USER, Role.CUSTOMER, T0, T0)
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    storage, product = InMemoryStorage(), OneProduct(make_product())
    app: FastAPI = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    app.dependency_overrides[http.get_product_repository] = lambda: product
    app.dependency_overrides[admin_http.get_image_storage] = lambda: storage
    ran: list[int] = []

    @app.post(ECHO)
    async def echo(request: Request) -> dict[str, int]:
        size = len(await request.body())
        ran.append(size)
        return {"received": size}

    user = {"Authorization": f"Bearer {make_token(str(USER))}"}
    admin = {"Authorization": f"Bearer {make_token(str(ADMIN))}"}
    yield World(
        TestClient(app, raise_server_exceptions=False, headers=user),
        TestClient(app, raise_server_exceptions=False, headers=admin),
        profiles,
        storage,
        product,
        ran,
    )


def chunked(total: int, piece: int = 16 * 1024) -> Iterator[bytes]:
    """Un generador: httpx lo envía troceado, sin `Content-Length`."""
    sent = 0
    while sent < total:
        size = min(piece, total - sent)
        yield b"x" * size
        sent += size


def assert_413(response: object, limit: int) -> None:
    assert response.status_code == 413, response.text  # type: ignore[attr-defined]
    assert response.json() == {  # type: ignore[attr-defined]
        "error": {
            "code": "payload_too_large",
            "message": MESSAGE,
            "details": {"max_bytes": limit},
        }
    }
    assert_hardened(response)
    assert HEX32.fullmatch(response.headers["x-request-id"])  # type: ignore[attr-defined]


def test_the_default_limits_are_the_ones_decided() -> None:
    assert (MAX_BODY_BYTES, MAX_MULTIPART_BODY_BYTES) == (256 * 1024, 6 * 1024 * 1024)


# --- JSON: justo en el límite pasa, un byte más es 413 ---


def test_json_body_exactly_at_the_limit_passes_with_content_length(world: World) -> None:
    response = world.client.post(ECHO, content=b"x" * MAX_BODY_BYTES, headers=JSON)

    assert response.status_code == 200 and response.json() == {"received": MAX_BODY_BYTES}
    assert world.ran == [MAX_BODY_BYTES]
    assert_hardened(response)


def test_json_body_one_byte_over_with_content_length_is_413_and_the_route_never_runs(
    world: World,
) -> None:
    response = world.client.post(ECHO, content=b"x" * (MAX_BODY_BYTES + 1), headers=JSON)

    assert_413(response, MAX_BODY_BYTES)
    assert world.ran == []


def test_chunked_json_exactly_at_the_limit_passes(world: World) -> None:
    response = world.client.post(ECHO, content=chunked(MAX_BODY_BYTES), headers=JSON)

    assert response.status_code == 200 and response.json() == {"received": MAX_BODY_BYTES}


def test_chunked_json_one_byte_over_without_content_length_is_413_and_the_route_never_runs(
    world: World,
) -> None:
    response = world.client.post(ECHO, content=chunked(MAX_BODY_BYTES + 1), headers=JSON)

    assert_413(response, MAX_BODY_BYTES)
    assert world.ran == []


def test_chunked_json_far_over_the_limit_is_413(world: World) -> None:
    response = world.client.post(ECHO, content=chunked(3 * MAX_BODY_BYTES), headers=JSON)

    assert_413(response, MAX_BODY_BYTES)


def test_a_lying_content_length_does_not_get_a_big_body_through(world: World) -> None:
    response = world.client.post(
        ECHO, content=b"x" * (MAX_BODY_BYTES + 100), headers=JSON | {"Content-Length": "10"}
    )

    assert_413(response, MAX_BODY_BYTES)
    assert world.ran == []


def test_a_non_numeric_content_length_is_ignored_and_the_count_rules(world: World) -> None:
    small = world.client.post(ECHO, content=b"x" * 10, headers=JSON | {"Content-Length": "abc"})
    big = world.client.post(
        ECHO, content=b"x" * (MAX_BODY_BYTES + 1), headers=JSON | {"Content-Length": "abc"}
    )

    assert small.status_code == 200
    assert_413(big, MAX_BODY_BYTES)


def test_the_413_body_never_echoes_the_payload(world: World) -> None:
    marker = "dato-privado-del-cliente"
    payload = marker.encode() * (MAX_BODY_BYTES // len(marker) + 2)

    response = world.client.post(ECHO, content=payload, headers=JSON)

    assert response.status_code == 413
    assert marker not in response.text


def test_the_limit_is_checked_before_the_token(world: World) -> None:
    anonymous = TestClient(world.client.app, raise_server_exceptions=False)

    response = anonymous.patch(ME, content=b"x" * (MAX_BODY_BYTES + 1), headers=JSON)

    assert_413(response, MAX_BODY_BYTES)


def test_the_413_applies_to_real_routes_of_other_modules_and_changes_nothing(
    world: World,
) -> None:
    anonymous = TestClient(world.client.app, raise_server_exceptions=False)
    big = b'{"name": "' + b"x" * MAX_BODY_BYTES + b'"}'

    me = world.client.patch(ME, content=big, headers=JSON)
    orders = anonymous.post("/api/v1/orders", content=big, headers=JSON)
    catalog = world.admin.post(f"{BASE}/categories", content=big, headers=JSON)
    chunked_me = world.client.patch(ME, content=chunked(MAX_BODY_BYTES + 5), headers=JSON)

    for response in (me, orders, catalog, chunked_me):
        assert_413(response, MAX_BODY_BYTES)
    assert world.profiles.rows[USER].full_name is None


def test_a_normal_request_is_untouched(world: World) -> None:
    ok = world.client.patch(ME, json={"full_name": "Ana Torres"})
    plain_get = world.client.get(ME)

    assert ok.status_code == 200 and plain_get.status_code == 200
    assert plain_get.json()["full_name"] == "Ana Torres"


# --- Multipart: 6 MiB ---


def test_multipart_between_the_json_limit_and_six_mib_passes_the_middleware(world: World) -> None:
    near_catalog_limit = IMAGE_MAX_BYTES + FORM_OVERHEAD

    response = world.client.post(ECHO, content=b"x" * near_catalog_limit, headers=MULTIPART)

    assert response.status_code == 200 and response.json() == {"received": near_catalog_limit}


def test_multipart_exactly_six_mib_passes_and_one_more_byte_is_413(world: World) -> None:
    at_limit = world.client.post(ECHO, content=b"x" * MAX_MULTIPART_BODY_BYTES, headers=MULTIPART)
    over = world.client.post(ECHO, content=b"x" * (MAX_MULTIPART_BODY_BYTES + 1), headers=MULTIPART)

    assert at_limit.status_code == 200
    assert_413(over, MAX_MULTIPART_BODY_BYTES)


def test_chunked_multipart_over_six_mib_is_413(world: World) -> None:
    response = world.client.post(
        ECHO, content=chunked(MAX_MULTIPART_BODY_BYTES + 1, 256 * 1024), headers=MULTIPART
    )

    assert_413(response, MAX_MULTIPART_BODY_BYTES)
    assert world.ran == []


# --- La subida de imagen de catalog (T-029) ---


def test_a_five_mib_image_still_uploads_with_201_and_the_hardened_headers(world: World) -> None:
    image = tiny_png().ljust(IMAGE_MAX_BYTES, b"\x00")

    response = upload(world.admin, image, product_id=world.product.product.id)

    assert response.status_code == 201, response.text
    assert_hardened(response)
    # T-018i: Storage recibe el WebP optimizado, no los 5 MiB de relleno de la subida.
    [(data, content_type)] = world.storage.files.values()
    assert content_type == "image/webp" and data[8:12] == b"WEBP" and len(data) < IMAGE_MAX_BYTES


def test_one_byte_over_five_mib_is_file_too_large_from_catalog(world: World) -> None:
    image = tiny_png().ljust(IMAGE_MAX_BYTES + 1, b"\x00")

    response = upload(world.admin, image, product_id=world.product.product.id)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"
    assert_hardened(response)
    assert world.storage.files == {}


def test_between_five_mib_and_six_mib_catalog_still_answers_file_too_large(
    world: World,
) -> None:
    image = tiny_png().ljust(5 * 1024 * 1024 + 512 * 1024, b"\x00")  # 5,5 MiB

    response = upload(world.admin, image, product_id=world.product.product.id)

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"
    assert_hardened(response)


def test_above_six_mib_the_upload_is_payload_too_large(world: World) -> None:
    image = tiny_png().ljust(MAX_MULTIPART_BODY_BYTES + 1024, b"\x00")

    response = upload(world.admin, image, product_id=world.product.product.id)

    assert_413(response, MAX_MULTIPART_BODY_BYTES)
    assert world.storage.files == {}


def test_the_upload_413_is_in_the_common_error_shape(world: World) -> None:
    image = tiny_png().ljust(MAX_MULTIPART_BODY_BYTES + 1024, b"\x00")

    response = upload(world.admin, image, product_id=world.product.product.id)

    body = response.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message", "details"}
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["cache-control"] == NO_STORE
    assert response.headers["x-content-type-options"] == NOSNIFF
