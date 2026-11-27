"""Contrato de `GET /api/v1/orders/admin` y `GET /api/v1/orders/admin/{order_id}` en el OpenAPI
(T-078; CA-ORDERS-25, SPEC §7). Sin BD. Si cambia un campo, estas pruebas fallan: son la red de
seguridad de lo que consumirá la interfaz de administración (T-084). También fija el orden de
registro: las rutas `admin` van antes que `/{order_id}`."""

import json
from typing import Any

import pytest

from tests.orders.orders_admin_helpers import (
    ADMIN_DETAIL_KEYS,
    ADMIN_HISTORY_KEYS,
    ADMIN_SUMMARY_KEYS,
)
from tests.orders.orders_create_helpers import DETAIL_KEYS, SUMMARY_KEYS
from tests.orders.orders_read_helpers import ALL_STATUSES
from valmont.main import create_app

LIST = "/api/v1/orders/admin"
DETAIL = "/api/v1/orders/admin/{order_id}"
CUSTOMER_DETAIL = "/api/v1/orders/{order_id}"


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


def schema(spec: dict[str, Any], name: str) -> dict[str, Any]:
    return spec["components"]["schemas"][name]


def ref_name(node: dict[str, Any]) -> str:
    found = [
        part["$ref"]
        for key in ("anyOf", "oneOf", "allOf")
        for part in node.get(key, [])
        if "$ref" in part
    ]
    ref = node.get("$ref") or node.get("items", {}).get("$ref") or found[0]
    return ref.rsplit("/", 1)[1]


def params(operation: dict[str, Any], where: str) -> dict[str, dict[str, Any]]:
    return {p["name"]: p for p in operation["parameters"] if p["in"] == where}


def nullable(node: dict[str, Any]) -> bool:
    return any(part.get("type") == "null" for part in node.get("anyOf", []))


def non_null(node: dict[str, Any]) -> dict[str, Any]:
    parts = [p for p in node.get("anyOf", []) if p.get("type") != "null"]
    return parts[0] if parts else node


def response_schema(spec: dict[str, Any], path: str, status: str = "200") -> dict[str, Any]:
    return spec["paths"][path]["get"]["responses"][status]["content"]["application/json"]["schema"]


# --------------------------------------------------------------------------------------------
# Rutas y orden de registro
def test_both_admin_reads_are_get_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert set(spec["paths"][LIST]) == {"get"} and set(spec["paths"][DETAIL]) == {"get"}
    assert LIST + "/" not in spec["paths"]


def test_the_admin_routes_are_registered_before_the_customer_order_id_route(
    spec: dict[str, Any],
) -> None:
    # El OpenAPI conserva el orden de registro de las rutas (esta versión de FastAPI no expone
    # `app.routes` plano); `GET /orders/admin` no debe quedar capturado por `/{order_id}`.
    paths = list(spec["paths"])

    assert paths.index(LIST) < paths.index(CUSTOMER_DETAIL)
    assert paths.index(DETAIL) < paths.index(CUSTOMER_DETAIL)


def test_the_customer_routes_keep_their_shape(spec: dict[str, Any]) -> None:
    assert set(schema(spec, "OrderSummaryOut")["properties"]) == SUMMARY_KEYS
    assert set(schema(spec, "OrderDetailOut")["properties"]) == DETAIL_KEYS
    assert "get" in spec["paths"]["/api/v1/orders"] and "post" in spec["paths"]["/api/v1/orders"]
    assert "get" in spec["paths"][CUSTOMER_DETAIL]


# --------------------------------------------------------------------------------------------
# Parámetros del listado
def test_the_list_takes_exactly_the_six_filters_and_no_user_id_nor_body(
    spec: dict[str, Any],
) -> None:
    operation = spec["paths"][LIST]["get"]

    assert set(params(operation, "query")) == {
        "status",
        "q",
        "created_from",
        "created_to",
        "page",
        "page_size",
    }
    assert not params(operation, "path") and not params(operation, "header")
    assert "requestBody" not in operation


def test_every_filter_is_optional(spec: dict[str, Any]) -> None:
    for name, parameter in params(spec["paths"][LIST]["get"], "query").items():
        assert parameter.get("required", False) is False, name


def test_status_is_a_single_value_of_the_eight_states_not_a_list(spec: dict[str, Any]) -> None:
    status = params(spec["paths"][LIST]["get"], "query")["status"]

    assert "OrderStatus" in json.dumps(status["schema"])
    assert "array" not in json.dumps(status["schema"])  # §7: un solo valor
    assert set(schema(spec, "OrderStatus")["enum"]) == set(ALL_STATUSES)


def test_q_is_text_of_at_most_100_characters(spec: dict[str, Any]) -> None:
    q = non_null(params(spec["paths"][LIST]["get"], "query")["q"]["schema"])

    assert q["type"] == "string" and q["maxLength"] == 100


@pytest.mark.parametrize("name", ["created_from", "created_to"])
def test_the_date_filters_are_plain_dates(spec: dict[str, Any], name: str) -> None:
    node = non_null(params(spec["paths"][LIST]["get"], "query")[name]["schema"])

    assert node["type"] == "string" and node["format"] == "date"


def test_page_and_page_size_document_their_limits_and_defaults(spec: dict[str, Any]) -> None:
    query = params(spec["paths"][LIST]["get"], "query")

    page, size = query["page"]["schema"], query["page_size"]["schema"]
    assert (page.get("minimum"), page.get("maximum"), page.get("default")) == (1, 1000, 1)
    assert (size.get("minimum"), size.get("maximum"), size.get("default")) == (1, 50, 20)


# --------------------------------------------------------------------------------------------
# Respuestas
def test_the_list_responds_with_admin_order_page_out(spec: dict[str, Any]) -> None:
    assert ref_name(response_schema(spec, LIST)) == "AdminOrderPageOut"
    page = schema(spec, "AdminOrderPageOut")
    assert set(page["properties"]) == {"items", "total", "page", "page_size"}
    assert ref_name(page["properties"]["items"]) == "AdminOrderSummaryOut"
    assert page["properties"]["total"]["type"] == "integer"


def test_the_admin_summary_is_the_customer_summary_plus_user_and_recipient(
    spec: dict[str, Any],
) -> None:
    summary = schema(spec, "AdminOrderSummaryOut")

    assert set(summary["properties"]) == ADMIN_SUMMARY_KEYS
    assert ref_name(summary["properties"]["total"]).startswith("Money")
    assert summary["properties"]["user_id"]["format"] == "uuid"
    assert nullable(summary["properties"]["expires_at"])
    dumped = json.dumps(summary)
    for internal in ("phone", "address_line", "reference", "idempotency_key", "note", "actor_id"):
        assert internal not in dumped, internal


def test_the_detail_takes_only_the_order_id_path_parameter_as_a_uuid(spec: dict[str, Any]) -> None:
    operation = spec["paths"][DETAIL]["get"]

    path = params(operation, "path")
    assert set(path) == {"order_id"} and path["order_id"]["required"] is True
    assert path["order_id"]["schema"].get("format") == "uuid"
    assert not params(operation, "query") and "requestBody" not in operation


def test_the_detail_responds_with_admin_order_detail_out(spec: dict[str, Any]) -> None:
    assert ref_name(response_schema(spec, DETAIL)) == "AdminOrderDetailOut"

    detail = schema(spec, "AdminOrderDetailOut")["properties"]

    assert set(detail) == ADMIN_DETAIL_KEYS
    assert detail["user_id"]["format"] == "uuid"
    assert detail["can_transition_to"]["type"] == "array"
    assert ref_name(detail["can_transition_to"]) == "OrderStatus"


def test_the_admin_history_has_actor_id_and_the_internal_note(spec: dict[str, Any]) -> None:
    detail = schema(spec, "AdminOrderDetailOut")["properties"]
    entry = schema(spec, ref_name(detail["history"]))

    assert set(entry["properties"]) == ADMIN_HISTORY_KEYS
    assert nullable(entry["properties"]["actor_id"]) and nullable(entry["properties"]["note"])
    assert nullable(entry["properties"]["from_status"])


def test_the_customer_history_still_has_no_actor_id_nor_note(spec: dict[str, Any]) -> None:
    detail = schema(spec, "OrderDetailOut")["properties"]
    entry = schema(spec, ref_name(detail["history"]))

    assert set(entry["properties"]).isdisjoint({"actor_id", "note"})
    assert "user_id" not in detail and "can_transition_to" not in detail


def test_the_admin_detail_keeps_money_and_the_delivery_of_the_customer_detail(
    spec: dict[str, Any],
) -> None:
    detail = schema(spec, "AdminOrderDetailOut")["properties"]

    assert ref_name(detail["total"]).startswith("Money")
    assert ref_name(detail["subtotal"]).startswith("Money")
    assert ref_name(detail["delivery"]) == "DeliveryOut"
    assert nullable(detail["refund"]) and nullable(detail["paid_at"])


# --------------------------------------------------------------------------------------------
# Errores del contrato
@pytest.mark.parametrize(
    ("path", "codes"),
    [(LIST, ("401", "403", "422", "503")), (DETAIL, ("401", "403", "404", "422", "503"))],
)
def test_every_error_of_the_contract_is_declared_with_the_common_format(
    spec: dict[str, Any], path: str, codes: tuple[str, ...]
) -> None:
    responses = spec["paths"][path]["get"]["responses"]

    for status in codes:
        assert ref_name(response_schema(spec, path, status)) == "ErrorOut", (path, status)
    assert "HTTPValidationError" not in json.dumps(responses)


def test_the_403_is_documented_as_forbidden_and_the_404_as_not_found(spec: dict[str, Any]) -> None:
    assert "forbidden" in json.dumps(spec["paths"][LIST]["get"]["responses"]["403"])
    assert "forbidden" in json.dumps(spec["paths"][DETAIL]["get"]["responses"]["403"])
    assert "not_found" in json.dumps(spec["paths"][DETAIL]["get"]["responses"]["404"])
    assert "404" not in spec["paths"][LIST]["get"]["responses"]


def test_the_admin_user_id_exists_only_in_the_admin_output_schemas(spec: dict[str, Any]) -> None:
    holders = {
        name
        for name, node in spec["components"]["schemas"].items()
        if "user_id" in node.get("properties", {})
    }

    assert {"AdminOrderSummaryOut", "AdminOrderDetailOut"} <= holders
    assert not holders & {"OrderSummaryOut", "OrderDetailOut", "OrderPageOut", "CreateOrderIn"}
    # ninguna ruta de pedidos recibe `user_id` como parámetro
    for path, item in spec["paths"].items():
        if path.startswith("/api/v1/orders"):
            for operation in item.values():
                assert "user_id" not in {p["name"] for p in operation.get("parameters", [])}
