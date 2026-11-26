"""Administración de promotions sin BD: autorización, parámetros y OpenAPI (SPEC §7, CA-05, CA-15).

La sesión falla si se usa: ningún rechazo de estas pruebas llega a la BD."""

import json
from dataclasses import replace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.db import get_session

ADMIN, CUSTOMER = uuid4(), uuid4()
BASE = "/api/v1/promotions/admin"
ANY_ID = str(uuid4())
VALID_BODY = {
    "name": "Temporada de prueba",
    "kind": "percent",
    "percent_off": 15,
    "scope": "catalog",
    "starts_at": "2030-01-01T05:00:00Z",
    "ends_at": "2030-02-01T05:00:00Z",
}
ROUTES = [
    ("GET", "/promotions", None),
    ("POST", "/promotions", VALID_BODY),
    ("GET", f"/promotions/{ANY_ID}", None),
    ("PATCH", f"/promotions/{ANY_ID}", {"name": "Otro nombre"}),
    ("POST", f"/promotions/{ANY_ID}/activate", None),
    ("POST", f"/promotions/{ANY_ID}/deactivate", None),
]
SUMMARY_KEYS = {
    "id",
    "name",
    "kind",
    "percent_off",
    "amount_off",
    "scope",
    "category",
    "starts_at",
    "ends_at",
    "is_active",
    "status",
    "product_count",
    "created_at",
    "updated_at",
}


class Untouchable:
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
    # CA-PROMOTIONS-05: sin token → 401 en las 6 rutas.
    response = call(client, method, path, body, user=None)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize(("method", "path", "body"), ROUTES)
def test_every_admin_route_rejects_a_customer_with_403(
    client: TestClient, method: str, path: str, body: object
) -> None:
    # CA-PROMOTIONS-05, RF13.02: un cliente no administra promociones (la sesión ni se toca).
    response = call(client, method, path, body, user=CUSTOMER)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/promotions/no-uuid", None),
        ("PATCH", "/promotions/no-uuid", {"name": "Otro nombre"}),
        ("POST", "/promotions/no-uuid/activate", None),
        ("POST", "/promotions/no-uuid/deactivate", None),
    ],
)
def test_malformed_promotion_id_is_422(
    client: TestClient, method: str, path: str, body: object
) -> None:
    # SPEC §7: un id de ruta mal formado → 422 con el loc del parámetro.
    response = call(client, method, path, body)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert [d["loc"][0] for d in response.json()["error"]["details"]] == ["path"]


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"status": "vigente"}, "status"),
        ({"status": ""}, "status"),
        ({"scope": "tienda"}, "scope"),
        ({"page": 0}, "page"),
        ({"page": 1001}, "page"),
        ({"page_size": 0}, "page_size"),
        ({"page_size": 49}, "page_size"),
        ({"page": "x"}, "page"),
    ],
)
def test_list_parameters_are_validated(
    client: TestClient, params: dict[str, object], field: str
) -> None:
    # CA-PROMOTIONS-04: status o scope inválido, y paginación fuera de rango (1–1000, 1–48) → 422.
    response = call(client, "GET", "/promotions", params=params)

    assert response.status_code == 422
    assert [d["loc"] for d in response.json()["error"]["details"]] == [["query", field]]


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param({**VALID_BODY, "percent_off": "15"}, "percent_off", id="porcentaje-texto"),
        pytest.param({**VALID_BODY, "percent_off": 15.5}, "percent_off", id="porcentaje-decimal"),
        pytest.param({**VALID_BODY, "percent_off": True}, "percent_off", id="porcentaje-booleano"),
        pytest.param({**VALID_BODY, "name": 7}, "name", id="nombre-no-texto"),
        pytest.param({**VALID_BODY, "kind": "regalo"}, "kind", id="tipo-desconocido"),
        pytest.param({**VALID_BODY, "scope": "tienda"}, "scope", id="alcance-desconocido"),
        pytest.param({**VALID_BODY, "price": 100}, "price", id="campo-extra-precio"),
        pytest.param({**VALID_BODY, "status": "active"}, "status", id="campo-extra-status"),
        pytest.param({**VALID_BODY, "starts_at": "mañana"}, "starts_at", id="fecha-no-iso"),
        pytest.param(
            {**VALID_BODY, "starts_at": "2030-01-01T05:00:00"}, "starts_at", id="fecha-sin-zona"
        ),
        pytest.param(
            {**VALID_BODY, "ends_at": "2030-02-01T05:00:00"}, "ends_at", id="fin-sin-zona"
        ),
        pytest.param(
            {k: v for k, v in VALID_BODY.items() if k != "ends_at"}, "ends_at", id="sin-fin"
        ),
        pytest.param(
            {k: v for k, v in VALID_BODY.items() if k != "starts_at"}, "starts_at", id="sin-inicio"
        ),
        pytest.param({k: v for k, v in VALID_BODY.items() if k != "name"}, "name", id="sin-nombre"),
        pytest.param(
            {
                **{k: v for k, v in VALID_BODY.items() if k != "percent_off"},
                "kind": "fixed_amount",
                "amount_off": "200",
            },
            "amount_off",
            id="monto-texto",
        ),
        pytest.param(
            {
                **{k: v for k, v in VALID_BODY.items() if k != "percent_off"},
                "kind": "fixed_amount",
                "amount_off": {"amount": "200", "currency": "PEN"},
            },
            "amount_off",
            id="monto-importe-texto",
        ),
        pytest.param(
            {
                **{k: v for k, v in VALID_BODY.items() if k != "percent_off"},
                "kind": "fixed_amount",
                "amount_off": {"amount": 2.5, "currency": "PEN"},
            },
            "amount_off",
            id="monto-decimal",
        ),
    ],
)
def test_create_body_types_are_validated_with_the_loc_of_their_field(
    client: TestClient, body: dict[str, object], field: str
) -> None:
    # CA-PROMOTIONS-01 y la seguridad del plan §11: tipos estrictos y campo extra → 422.
    response = call(client, "POST", "/promotions", body)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"][:2] for d in error["details"]] == [["body", field]]


def test_openapi_declares_the_contract_and_common_errors() -> None:
    # CA-PROMOTIONS-15: las 6 rutas, los códigos y los esquemas de la §7.
    document = create_app().openapi()
    admin = {path: ops for path, ops in document["paths"].items() if path.startswith(BASE)}
    routes = {
        (method.upper(), path.removeprefix(BASE)) for path, ops in admin.items() for method in ops
    }

    assert routes == {
        ("GET", "/promotions"),
        ("POST", "/promotions"),
        ("GET", "/promotions/{promotion_id}"),
        ("PATCH", "/promotions/{promotion_id}"),
        ("POST", "/promotions/{promotion_id}/activate"),
        ("POST", "/promotions/{promotion_id}/deactivate"),
    }
    for operations in admin.values():
        for operation in operations.values():
            assert {"401", "403", "503"} <= set(operation["responses"])
            for status, response in operation["responses"].items():
                if not status.startswith("2"):
                    schema = response["content"]["application/json"]["schema"]
                    assert schema == {"$ref": "#/components/schemas/ErrorOut"}
    common = {"401", "403", "503"}
    statuses = {
        (method, path): set(admin[f"{BASE}{path}"][method]["responses"])
        for method, path in (
            ("get", "/promotions"),
            ("post", "/promotions"),
            ("get", "/promotions/{promotion_id}"),
            ("patch", "/promotions/{promotion_id}"),
            ("post", "/promotions/{promotion_id}/activate"),
            ("post", "/promotions/{promotion_id}/deactivate"),
        )
    }
    assert statuses == {
        ("get", "/promotions"): common | {"200", "422"},
        ("post", "/promotions"): common | {"201", "422"},
        ("get", "/promotions/{promotion_id}"): common | {"200", "404", "422"},
        ("patch", "/promotions/{promotion_id}"): common | {"200", "404", "422"},
        ("post", "/promotions/{promotion_id}/activate"): common | {"200", "404", "422"},
        ("post", "/promotions/{promotion_id}/deactivate"): common | {"200", "404", "422"},
    }
    assert "HTTPValidationError" not in json.dumps(document)
    schemas = document["components"]["schemas"]
    assert set(schemas["PromotionSummaryOut"]["required"]) == SUMMARY_KEYS
    assert set(schemas["PromotionDetailOut"]["required"]) == SUMMARY_KEYS | {"products"}
    assert set(schemas["PromotionProductOut"]["required"]) == {
        "id",
        "sku",
        "name",
        "list_price",
        "price",
    }
    # Los enums van como $ref a su esquema (los usan salida y entrada).
    assert schemas["PromotionStatus"]["enum"] == ["inactive", "scheduled", "active", "expired"]
    assert schemas["PromotionKind"]["enum"] == ["percent", "fixed_amount"]
    assert schemas["PromotionScope"]["enum"] == ["products", "category", "catalog"]
    for field, enum in (("status", "Status"), ("kind", "Kind"), ("scope", "Scope")):
        ref = schemas["PromotionSummaryOut"]["properties"][field]["$ref"]
        assert ref == f"#/components/schemas/Promotion{enum}"
    # El cuerpo de alta lleva los campos de la §7 y ningún precio final ni estado.
    assert set(schemas["PromotionIn"]["properties"]) == {
        "name",
        "kind",
        "percent_off",
        "amount_off",
        "scope",
        "product_ids",
        "category_id",
        "starts_at",
        "ends_at",
    }
    assert set(schemas["PromotionIn"]["required"]) >= {
        "name",
        "kind",
        "scope",
        "starts_at",
        "ends_at",
    }
    assert set(schemas["PromotionUpdateIn"]["properties"]) == set(
        schemas["PromotionIn"]["properties"]
    )
    assert not schemas["PromotionUpdateIn"].get("required")
