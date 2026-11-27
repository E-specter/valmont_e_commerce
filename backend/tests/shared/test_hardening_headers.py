"""`Cache-Control: no-store` y `X-Content-Type-Options: nosniff` en la app real (T-018a).

Sin BD: identity, catalog público y de administración con repositorios en memoria. Las rutas
con BD (orders, payments) están en `test_hardening_db.py`. Datos ficticios."""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from tests.catalog.catalog_helpers import InMemoryStorage, tiny_png
from tests.catalog.test_domain import make_product
from tests.catalog.test_http import CATEGORY, FakeAttributes, FakeCategories
from tests.catalog.test_images_http import ADMIN, BASE, CDN, OneProduct, upload
from tests.identity.birth_date_helpers import BirthDateProfiles
from tests.identity.identity_helpers import T0, make_token, use_test_auth
from tests.shared.hardening_helpers import HEX32, NO_STORE, NOSNIFF, assert_hardened
from valmont.main import create_app
from valmont.modules.catalog.adapters import admin_http, http
from valmont.modules.catalog.domain import ProductPage, ProductQuery
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings
from valmont.shared.errors import AppError

ME = "/api/v1/identity/me"
CUSTOMER = uuid4()
OWN_CACHE = "private, max-age=60"


class Repo(OneProduct):
    """Un solo repositorio para la parte pública (vacía) y la de administración (un producto)."""

    def list_published(self, query: ProductQuery) -> ProductPage:
        return ProductPage([], 0)

    def get_published(self, slug: str) -> None:
        return None


@dataclass
class World:
    client: TestClient
    admin: TestClient
    storage: InMemoryStorage
    product: Repo
    profiles: BirthDateProfiles
    boom_calls: list[str]


def token_for(user: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(str(user))}"}


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> Iterator[World]:
    use_test_auth(monkeypatch)
    monkeypatch.setattr(
        http, "get_settings", lambda: Settings(_env_file=None, storage_public_url=CDN)
    )
    profiles = BirthDateProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    profiles.rows[CUSTOMER] = Profile(CUSTOMER, Role.CUSTOMER, T0, T0)
    storage, product = InMemoryStorage(), Repo(make_product())
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    app.dependency_overrides[http.get_product_repository] = lambda: product
    app.dependency_overrides[http.get_category_repository] = lambda: FakeCategories([CATEGORY])
    app.dependency_overrides[http.get_attribute_repository] = FakeAttributes
    app.dependency_overrides[admin_http.get_image_storage] = lambda: storage
    boom_calls: list[str] = []
    add_probe_routes(app, boom_calls)
    client = TestClient(app, raise_server_exceptions=False)
    admin = TestClient(app, raise_server_exceptions=False, headers=token_for(ADMIN))
    yield World(client, admin, storage, product, profiles, boom_calls)


def add_probe_routes(app: FastAPI, boom_calls: list[str]) -> None:
    @app.get("/api/v1/test/boom")
    def boom() -> None:
        boom_calls.append("boom")
        raise RuntimeError("fallo forzado de prueba")

    @app.get("/api/v1/test/conflict")
    def conflict() -> None:
        raise AppError("conflicto_de_prueba", "Conflicto de prueba.", 409)

    @app.get("/api/v1/test/own-cache")
    def own_cache(response: Response) -> dict[str, str]:
        response.headers["Cache-Control"] = OWN_CACHE
        return {"ok": "si"}

    @app.get("/test/outside-api")
    def outside() -> dict[str, str]:
        return {"ok": "si"}


# --- Matriz de estados en rutas reales de varios módulos ---


def test_200_in_identity_and_public_catalog(world: World) -> None:
    world.profiles.add_if_absent(CUSTOMER)

    responses = [
        world.client.get(ME, headers=token_for(CUSTOMER)),
        world.client.get("/api/v1/catalog/products"),
        world.client.get("/api/v1/catalog/categories"),
        world.client.get("/api/v1/catalog/attributes"),
    ]

    for response in responses:
        assert response.status_code == 200, response.text
        assert_hardened(response)


def test_201_in_catalog_admin_image_upload(world: World) -> None:
    response = upload(
        world.admin,
        tiny_png(),
        product_id=world.product.product.id,
    )

    assert response.status_code == 201, response.text
    assert_hardened(response)


def test_401_without_a_token_in_identity_and_admin(world: World) -> None:
    responses = [
        world.client.get(ME),
        world.client.get(ME, headers={"Authorization": "Bearer no-es-un-token"}),
        world.client.get(f"{BASE}/products"),
        world.client.post(f"{BASE}/categories", json={"name": "Pruebas"}),
    ]

    for response in responses:
        assert response.status_code == 401, response.text
        assert_hardened(response)


def test_403_for_a_customer_on_admin_routes(world: World) -> None:
    responses = [
        world.client.get(f"{BASE}/products", headers=token_for(CUSTOMER)),
        world.client.post(
            f"{BASE}/categories", json={"name": "Pruebas"}, headers=token_for(CUSTOMER)
        ),
    ]

    for response in responses:
        assert response.status_code == 403, response.text
        assert_hardened(response)


def test_404_unknown_product_unknown_route_and_missing_upload_target(world: World) -> None:
    responses = [
        world.client.get("/api/v1/catalog/products/no-existe-este-reloj"),
        world.client.get("/api/v1/no-existe"),
        upload(world.admin, tiny_png(), product_id=uuid4()),
    ]

    for response in responses:
        assert response.status_code == 404, response.text
        assert_hardened(response)


def test_405_wrong_method(world: World) -> None:
    response = world.client.delete(ME, headers=token_for(CUSTOMER))

    assert response.status_code == 405
    assert_hardened(response)


def test_409_from_a_domain_rule_and_from_a_real_route(world: World) -> None:
    headers = token_for(CUSTOMER)
    first = world.client.patch(
        ME, json={"birth_date": date(1990, 5, 17).isoformat()}, headers=headers
    )
    locked = world.client.patch(ME, json={"birth_date": "1991-01-01"}, headers=headers)
    synthetic = world.client.get("/api/v1/test/conflict")

    assert first.status_code == 200, first.text
    for response in (locked, synthetic):
        assert response.status_code == 409, response.text
        assert_hardened(response)


def test_413_carries_the_same_headers_and_a_request_id(world: World) -> None:
    response = world.client.patch(
        ME,
        content=b"x" * (300 * 1024),
        headers=token_for(CUSTOMER) | {"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert_hardened(response)
    assert HEX32.fullmatch(response.headers["x-request-id"])


def test_422_validation_error(world: World) -> None:
    responses = [
        world.client.patch(ME, json={"full_name": "x" * 500}, headers=token_for(CUSTOMER)),
        world.client.patch(ME, json={"inventado": 1}, headers=token_for(CUSTOMER)),
        world.client.post(f"{BASE}/categories", json={}, headers=token_for(ADMIN)),
    ]

    for response in responses:
        assert response.status_code == 422, response.text
        assert_hardened(response)


def test_500_unhandled_error_is_json_without_trace_and_hardened(world: World) -> None:
    response = world.client.get("/api/v1/test/boom")

    assert response.status_code == 500
    assert world.boom_calls == ["boom"]
    assert response.json()["error"]["code"] == "internal_error"
    assert "fallo forzado" not in response.text and "Traceback" not in response.text
    assert_hardened(response)
    assert HEX32.fullmatch(response.headers["x-request-id"])


def test_503_when_auth_or_storage_is_down(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.storage.fails = True
    storage_down = upload(
        world.admin,
        tiny_png(),
        product_id=world.product.product.id,
    )
    use_test_auth(monkeypatch, jwks=None)
    auth_down = world.client.get(ME, headers=token_for(CUSTOMER))

    assert storage_down.status_code == 503 and auth_down.status_code == 503
    assert auth_down.json()["error"]["code"] == "auth_unavailable"
    assert_hardened(storage_down)
    assert_hardened(auth_down)


# --- Reglas del paquete ---


def test_a_route_that_sets_its_own_cache_control_keeps_it(world: World) -> None:
    response = world.client.get("/api/v1/test/own-cache")

    assert response.status_code == 200
    assert response.headers["cache-control"] == OWN_CACHE
    assert response.headers["x-content-type-options"] == NOSNIFF


@pytest.mark.parametrize("path", ["/health", "/docs", "/openapi.json", "/test/outside-api"])
def test_outside_api_gets_nosniff_but_not_no_store(world: World, path: str) -> None:
    response = world.client.get(path)

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == NOSNIFF
    assert response.headers.get("cache-control") != NO_STORE


def test_an_unknown_route_outside_api_is_404_with_nosniff_and_no_no_store(world: World) -> None:
    response = world.client.get("/no-existe")

    assert response.status_code == 404
    assert response.headers["x-content-type-options"] == NOSNIFF
    assert response.headers.get("cache-control") != NO_STORE


def test_the_prefix_is_api_slash_not_any_path_starting_with_api(world: World) -> None:
    response = world.client.get("/apix/v1/loquesea")

    assert response.status_code == 404
    assert response.headers.get("cache-control") != NO_STORE


def test_get_without_a_body_does_not_change(world: World) -> None:
    response = world.client.get("/api/v1/catalog/products")

    assert response.status_code == 200
    assert set(response.json()) == {"items", "total", "page", "page_size"}
