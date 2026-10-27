"""Administración de inventory sin BD: autorización, validación de entrada, traducción de los
errores del dominio y OpenAPI (SPEC §7)."""

import json
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.modules.inventory.adapters import admin_http
from valmont.modules.inventory.domain import (
    InsufficientStock,
    InvalidMovement,
    NoChange,
    ProductNotFound,
    StockReserved,
)
from valmont.shared.db import get_session

ADMIN, CUSTOMER = uuid4(), uuid4()
BASE = "/api/v1/inventory/admin"
ANY_ID = str(uuid4())
MOVEMENTS = f"/stock/{ANY_ID}/movements"
VALID_MOVEMENT = {"kind": "entrada", "quantity": 1}
ROUTES = [
    ("GET", "/stock", None),
    ("GET", f"/stock/{ANY_ID}", None),
    ("POST", MOVEMENTS, VALID_MOVEMENT),
    ("GET", "/settings", None),
    ("PATCH", "/settings", {"low_stock_threshold": 3}),
]


class Untouchable:
    """Sesión que falla si se usa: las respuestas de estas pruebas no llegan a la BD."""

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"no debía llamarse a {name}")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    profiles = InMemoryProfiles()
    for user_id, role in ((ADMIN, Role.ADMIN), (CUSTOMER, Role.CUSTOMER)):
        profiles.rows[user_id] = replace(Profile(user_id, Role.CUSTOMER, T0, T0), role=role)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles
    app.dependency_overrides[get_session] = Untouchable
    return TestClient(app, raise_server_exceptions=False)


def call(
    client: TestClient,
    method: str,
    path: str,
    body: object = None,
    user: UUID | None = ADMIN,
    params: dict[str, object] | None = None,
) -> object:
    headers = {} if user is None else {"Authorization": f"Bearer {make_token(str(user))}"}
    return client.request(method, f"{BASE}{path}", json=body, headers=headers, params=params)


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_admin_route_requires_a_token(
    client: TestClient, method: str, path: str, body: object
) -> None:
    response = call(client, method, path, body, user=None)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_admin_route_rejects_a_customer_with_403(
    client: TestClient, method: str, path: str, body: object
) -> None:
    response = call(client, method, path, body, user=CUSTOMER)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param({"kind": "venta", "quantity": 1}, "kind", id="venta"),  # solo el sistema
        pytest.param({"kind": "robo", "quantity": 1}, "kind", id="motivo-desconocido"),
        pytest.param({"quantity": 1}, "kind", id="sin-motivo"),
        pytest.param({"kind": "entrada"}, "quantity", id="sin-cantidad"),
        pytest.param({"kind": "entrada", "quantity": -1}, "quantity", id="negativa"),
        pytest.param({"kind": "entrada", "quantity": 2**31}, "quantity", id="mayor-que-integer"),
        pytest.param({"kind": "entrada", "quantity": "1"}, "quantity", id="texto"),
        pytest.param({"kind": "entrada", "quantity": 1.0}, "quantity", id="decimal"),
        pytest.param({"kind": "entrada", "quantity": True}, "quantity", id="booleano"),
        pytest.param({"kind": "merma", "quantity": 1, "note": 7}, "note", id="nota-no-texto"),
        pytest.param(VALID_MOVEMENT | {"actor_id": ANY_ID}, "actor_id", id="campo-extra"),
        pytest.param(VALID_MOVEMENT | {"order_id": ANY_ID}, "order_id", id="pedido"),
    ],
)
def test_movement_body_is_validated_with_the_loc_of_its_field(
    client: TestClient, body: dict[str, object], field: str
) -> None:
    response = call(client, "POST", MOVEMENTS, body)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [detail["loc"][:2] for detail in error["details"]] == [["body", field]]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [("GET", "/stock/no-uuid", None), ("POST", "/stock/no-uuid/movements", VALID_MOVEMENT)],
)
def test_malformed_product_id_is_422(
    client: TestClient, method: str, path: str, body: object
) -> None:
    response = call(client, method, path, body)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["path", "product_id"]]


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"status": "agotado"}, "status"),
        ({"status": "draft"}, "status"),  # es el estado de catalog, no el de stock
        ({"page": 0}, "page"),
        ({"page": 1001}, "page"),
        ({"page_size": 0}, "page_size"),
        ({"page_size": 49}, "page_size"),
        ({"q": "x" * 101}, "q"),
        ({"q": "reloj\x00"}, "q"),
    ],
)
def test_list_parameters_are_validated(
    client: TestClient, params: dict[str, object], field: str
) -> None:
    response = call(client, "GET", "/stock", params=params)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["query", field]]


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"low_stock_threshold": 0}, "low_stock_threshold"),  # INVENTORY-R3: ≥ 1
        ({"low_stock_threshold": -1}, "low_stock_threshold"),
        ({"low_stock_threshold": 2**31}, "low_stock_threshold"),
        ({"low_stock_threshold": "2"}, "low_stock_threshold"),
        ({"low_stock_threshold": 2.0}, "low_stock_threshold"),
        ({"low_stock_threshold": True}, "low_stock_threshold"),
        ({"low_stock_threshold": None}, "low_stock_threshold"),
        ({}, "low_stock_threshold"),
        ({"low_stock_threshold": 3, "id": 1}, "id"),
    ],
)
def test_threshold_body_is_validated(
    client: TestClient, body: dict[str, object], field: str
) -> None:
    response = call(client, "PATCH", "/settings", body)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"] for d in error["details"]] == [["body", field]]


@pytest.mark.parametrize(
    ("error", "status", "code", "details"),
    [
        pytest.param(ProductNotFound(), 404, "not_found", None, id="404"),
        # R9: código propio, sin details; no es un validation_error.
        pytest.param(NoChange("Sin cambio."), 422, "no_change", None, id="no_change"),
        pytest.param(
            InvalidMovement("Falta la nota.", "note"),
            422,
            "validation_error",
            [{"loc": ["body", "note"], "type": "value_error", "msg": "Falta la nota."}],
            id="nota",
        ),
        pytest.param(
            InvalidMovement("Cantidad.", "quantity"),
            422,
            "validation_error",
            [{"loc": ["body", "quantity"], "type": "value_error", "msg": "Cantidad."}],
            id="cantidad",
        ),
        pytest.param(
            InsufficientStock(on_hand=2, reserved=1),
            409,
            "insufficient_stock",
            {"on_hand": 2, "reserved": 1},
            id="insufficient_stock",
        ),
        pytest.param(
            StockReserved(3, 2), 409, "stock_reserved", {"on_hand": 3, "reserved": 2}, id="reserved"
        ),
    ],
)
def test_domain_errors_of_a_movement_follow_the_contract(
    client: TestClient, error: Exception, status: int, code: str, details: object
) -> None:
    def failing_record(*args: object) -> None:
        raise error

    client.app.dependency_overrides[admin_http.get_record_movement] = lambda: failing_record

    response = call(client, "POST", MOVEMENTS, VALID_MOVEMENT)

    assert response.status_code == status
    body = response.json()["error"]
    assert (body["code"], body["details"]) == (code, details)


STOCK_ITEM_KEYS = {
    "product_id",
    "sku",
    "name",
    "product_status",
    "on_hand",
    "reserved",
    "available",
    "status",
}
MOVEMENT_KEYS = {
    "id",
    "product_id",
    "kind",
    "quantity_delta",
    "on_hand_after",
    "note",
    "actor_id",
    "order_id",
    "created_at",
}


def test_openapi_declares_the_contract_and_common_errors() -> None:
    document = create_app().openapi()
    admin = {path: ops for path, ops in document["paths"].items() if path.startswith(BASE)}
    routes = {
        (method.upper(), path.removeprefix(BASE)) for path, ops in admin.items() for method in ops
    }

    assert routes == {
        ("GET", "/stock"),
        ("GET", "/stock/{product_id}"),
        ("POST", "/stock/{product_id}/movements"),
        ("GET", "/settings"),
        ("PATCH", "/settings"),
    }
    for operations in admin.values():
        for operation in operations.values():
            assert {"401", "403", "503"} <= set(operation["responses"])
            for status, response in operation["responses"].items():
                if not status.startswith("2"):
                    schema = response["content"]["application/json"]["schema"]
                    assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    statuses = {
        (method, path): set(admin[f"{BASE}{path}"][method]["responses"])
        for method, path in (
            ("get", "/stock"),
            ("get", "/stock/{product_id}"),
            ("post", "/stock/{product_id}/movements"),
            ("get", "/settings"),
            ("patch", "/settings"),
        )
    }
    common = {"401", "403", "503"}
    assert statuses == {
        ("get", "/stock"): common | {"200", "422"},
        ("get", "/stock/{product_id}"): common | {"200", "404", "422"},
        ("post", "/stock/{product_id}/movements"): common | {"201", "404", "409", "422"},
        ("get", "/settings"): common | {"200"},
        ("patch", "/settings"): common | {"200", "422"},
    }
    movement = admin[f"{BASE}/stock/{{product_id}}/movements"]["post"]["responses"]
    assert "`insufficient_stock`" in movement["409"]["description"]
    assert "`stock_reserved`" in movement["409"]["description"]
    assert "`no_change`" in movement["422"]["description"]
    assert "HTTPValidationError" not in json.dumps(document)
    schemas = document["components"]["schemas"]
    assert set(schemas["MovementIn"]["properties"]) == {"kind", "quantity", "note"}
    assert schemas["MovementIn"]["properties"]["kind"]["enum"] == [
        "entrada",
        "ajuste_inventario",
        "merma",
        "devolucion",
    ]
    assert set(schemas["StockItemOut"]["required"]) == STOCK_ITEM_KEYS
    assert schemas["StockItemOut"]["properties"]["product_status"]["enum"] == [
        "draft",
        "published",
    ]
    assert set(schemas["StockItemDetailOut"]["required"]) == STOCK_ITEM_KEYS | {"movements"}
    assert set(schemas["StockMovementOut"]["required"]) == MOVEMENT_KEYS
    assert set(schemas["SettingsIn"]["required"]) == {"low_stock_threshold"}
