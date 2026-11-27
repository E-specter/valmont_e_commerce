"""Contrato de `GET /api/v1/orders` y `GET /api/v1/orders/{order_id}` en el OpenAPI (T-075;
CA-ORDERS-25, SPEC §7, D-041 P-6 y P-7, R-11). Sin BD. Si cambia un campo, estas pruebas fallan:
son la red de seguridad de lo que consumirá la interfaz (T-083)."""

import json
from typing import Any

import pytest

from tests.orders.orders_create_helpers import DETAIL_KEYS, SUMMARY_KEYS
from tests.orders.orders_read_helpers import ALL_STATUSES
from valmont.main import create_app

LIST = "/api/v1/orders"
DETAIL = "/api/v1/orders/{order_id}"


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


# --------------------------------------------------------------------------------------------
# CA-ORDERS-25: rutas
def test_both_reads_are_get_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert "get" in spec["paths"][LIST] and "get" in spec["paths"][DETAIL]
    assert LIST + "/" not in spec["paths"]


def test_the_list_takes_status_page_and_page_size_and_nothing_else(spec: dict[str, Any]) -> None:
    operation = spec["paths"][LIST]["get"]

    assert set(params(operation, "query")) == {"status", "page", "page_size"}
    assert not params(operation, "path")
    assert "requestBody" not in operation  # ni cuerpo ni user_id


def test_the_status_filter_is_a_repeatable_optional_parameter_of_the_eight_states(
    spec: dict[str, Any],
) -> None:
    status = params(spec["paths"][LIST]["get"], "query")["status"]

    assert status.get("required", False) is False
    assert "array" in json.dumps(status["schema"])  # D-041 P-6: `status=a&status=b`
    assert "OrderStatus" in json.dumps(status["schema"])
    assert set(schema(spec, "OrderStatus")["enum"]) == set(ALL_STATUSES)


def test_page_and_page_size_document_their_limits_and_defaults(spec: dict[str, Any]) -> None:
    query = params(spec["paths"][LIST]["get"], "query")

    page, size = query["page"]["schema"], query["page_size"]["schema"]
    assert (page.get("minimum"), page.get("maximum"), page.get("default")) == (1, 1000, 1)
    assert (size.get("minimum"), size.get("maximum"), size.get("default")) == (1, 50, 20)


def test_the_list_responds_with_order_page_out(spec: dict[str, Any]) -> None:
    node = spec["paths"][LIST]["get"]["responses"]["200"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "OrderPageOut"
    page = schema(spec, "OrderPageOut")
    assert set(page["properties"]) == {"items", "total", "page", "page_size"}
    assert ref_name(page["properties"]["items"]) == "OrderSummaryOut"


def test_the_summary_has_exactly_the_contract_fields_and_no_internal_ones(
    spec: dict[str, Any],
) -> None:
    summary = schema(spec, "OrderSummaryOut")

    assert set(summary["properties"]) == SUMMARY_KEYS
    assert ref_name(summary["properties"]["total"]).startswith("Money")
    assert nullable(summary["properties"]["expires_at"])  # solo pendiente_pago; si no, null
    dumped = json.dumps(summary)
    for internal in ("user_id", "recipient_name", "district", "phone", "idempotency_key", "note"):
        assert internal not in dumped, internal


def test_the_detail_takes_only_the_order_id_path_parameter_as_a_uuid(spec: dict[str, Any]) -> None:
    operation = spec["paths"][DETAIL]["get"]

    path = params(operation, "path")
    assert set(path) == {"order_id"} and path["order_id"]["required"] is True
    assert path["order_id"]["schema"].get("format") == "uuid"
    assert not params(operation, "query")


def test_the_detail_responds_with_order_detail_out(spec: dict[str, Any]) -> None:
    node = spec["paths"][DETAIL]["get"]["responses"]["200"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "OrderDetailOut"
    assert set(schema(spec, "OrderDetailOut")["properties"]) == DETAIL_KEYS


def test_can_cancel_and_the_countdown_are_in_the_detail_and_the_countdown_is_nullable(
    spec: dict[str, Any],
) -> None:
    detail = schema(spec, "OrderDetailOut")["properties"]

    assert detail["can_cancel"]["type"] == "boolean"
    assert nullable(detail["expires_in_seconds"]) and nullable(detail["expires_at"])


def test_the_shipment_fields_are_nullable_in_delivery_out(spec: dict[str, Any]) -> None:
    delivery = schema(spec, "DeliveryOut")["properties"]

    for name in ("carrier", "tracking_code", "shipped_at", "pickup_store"):
        assert nullable(delivery[name]), name
    assert "date-time" in json.dumps(delivery["shipped_at"])


@pytest.mark.parametrize(
    ("path", "codes"), [(LIST, ("401", "422", "503")), (DETAIL, ("401", "404", "422", "503"))]
)
def test_every_error_of_the_contract_is_declared_with_the_common_format(
    spec: dict[str, Any], path: str, codes: tuple[str, ...]
) -> None:
    responses = spec["paths"][path]["get"]["responses"]

    for status in codes:
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "ErrorOut", (path, status)
    assert "HTTPValidationError" not in json.dumps(responses)


def test_the_list_declares_no_404_and_the_detail_documents_not_found(spec: dict[str, Any]) -> None:
    assert "404" not in spec["paths"][LIST]["get"]["responses"]
    assert "not_found" in json.dumps(spec["paths"][DETAIL]["get"]["responses"]["404"])


def test_neither_read_exposes_user_id_or_notes_anywhere_in_its_response(
    spec: dict[str, Any],
) -> None:
    names = ("OrderPageOut", "OrderSummaryOut", "OrderDetailOut", "HistoryEntryOut", "DeliveryOut")
    out = json.dumps([schema(spec, n) for n in names])

    for internal in ("user_id", "actor_id", '"note"', "idempotency_key", "order_number"):
        assert internal not in out, internal


def test_the_post_contract_of_t074_is_still_there(spec: dict[str, Any]) -> None:
    assert "post" in spec["paths"][LIST] and "post" not in spec["paths"][DETAIL]
