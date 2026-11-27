"""Contrato de `POST /api/v1/orders/admin/{order_id}/transitions` en el OpenAPI (T-079;
CA-ORDERS-25, SPEC §7 "Transiciones" y R19). Sin BD. Si cambia un campo, estas pruebas fallan: son
la red de seguridad de lo que consumirá la interfaz de administración (T-084)."""

import json
from typing import Any

import pytest

from tests.orders.orders_transition_helpers import TYPED_TARGETS, UNTYPED_TARGETS
from tests.orders.test_admin_orders_contract import (
    CUSTOMER_DETAIL,
    DETAIL,
    LIST,
    non_null,
    nullable,
    params,
    ref_name,
    schema,
)
from valmont.main import create_app

TRANSITIONS = "/api/v1/orders/admin/{order_id}/transitions"
CANCEL = "/api/v1/orders/{order_id}/cancel"


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


@pytest.fixture(scope="module")
def operation(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["paths"][TRANSITIONS]["post"]


def test_the_route_exists_only_as_post_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert set(spec["paths"][TRANSITIONS]) == {"post"}
    assert TRANSITIONS + "/" not in spec["paths"]


def test_the_route_is_in_the_orders_group_and_requires_a_bearer_token(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    assert operation["tags"] == ["orders"]
    assert operation["security"] == spec["paths"][DETAIL]["get"]["security"] != []


def test_the_only_parameter_is_the_order_id_path_as_a_uuid(operation: dict[str, Any]) -> None:
    path = params(operation, "path")

    assert set(path) == {"order_id"} and path["order_id"]["required"] is True
    assert path["order_id"]["schema"].get("format") == "uuid"
    assert not params(operation, "query") and not params(operation, "header")
    assert not params(operation, "cookie")


def test_the_request_body_is_required_json_transition_in(operation: dict[str, Any]) -> None:
    body = operation["requestBody"]

    assert body["required"] is True
    assert set(body["content"]) == {"application/json"}
    assert ref_name(body["content"]["application/json"]["schema"]) == "TransitionIn"


def test_transition_in_has_exactly_four_fields_and_only_to_is_required(
    spec: dict[str, Any],
) -> None:
    node = schema(spec, "TransitionIn")

    assert set(node["properties"]) == {"to", "note", "carrier", "tracking_code"}
    assert node["required"] == ["to"]
    assert node["additionalProperties"] is False  # extra="forbid"


def test_the_destination_admits_only_the_five_targets_of_the_contract(spec: dict[str, Any]) -> None:
    to = schema(spec, "TransitionIn")["properties"]["to"]
    values = to.get("enum") or schema(spec, ref_name(to))["enum"]

    assert set(values) == set(TYPED_TARGETS) and len(values) == 5
    for rejected in UNTYPED_TARGETS:  # R19: pagado, expirado y pendiente_pago no son destino
        assert rejected not in values


def test_the_note_is_optional_text_of_one_to_five_hundred_characters(spec: dict[str, Any]) -> None:
    note = non_null(schema(spec, "TransitionIn")["properties"]["note"])

    assert note["type"] == "string" and (note["minLength"], note["maxLength"]) == (1, 500)
    assert nullable(schema(spec, "TransitionIn")["properties"]["note"])


@pytest.mark.parametrize("name", ["carrier", "tracking_code"])
def test_carrier_and_tracking_code_are_optional_text_of_one_to_sixty_characters(
    spec: dict[str, Any], name: str
) -> None:
    node = schema(spec, "TransitionIn")["properties"][name]

    assert nullable(node)
    assert non_null(node)["type"] == "string"
    assert (non_null(node)["minLength"], non_null(node)["maxLength"]) == (1, 60)


def test_the_input_never_takes_a_user_an_amount_a_status_or_a_date(spec: dict[str, Any]) -> None:
    dumped = json.dumps(
        [schema(spec, "TransitionIn"), spec["paths"][TRANSITIONS]["post"]["parameters"]]
    )

    for forbidden in ("user_id", "actor", "amount", "refund", "total", "status", "shipped_at"):
        assert forbidden not in dumped, forbidden


def test_it_responds_200_with_the_same_admin_detail_as_the_read(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    node = operation["responses"]["200"]["content"]["application/json"]["schema"]
    read = spec["paths"][DETAIL]["get"]["responses"]["200"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "AdminOrderDetailOut" == ref_name(read)
    assert "201" not in operation["responses"]  # una transición no crea nada


@pytest.mark.parametrize("status", ["401", "403", "404", "409", "422", "503"])
def test_each_error_of_the_contract_uses_the_common_error_format(
    operation: dict[str, Any], status: str
) -> None:
    node = operation["responses"][status]["content"]["application/json"]["schema"]

    assert ref_name(node) == "ErrorOut"


def test_the_409_documents_invalid_transition_with_from_to_and_allowed(
    operation: dict[str, Any],
) -> None:
    documented = json.dumps(operation["responses"]["409"])

    for word in ("invalid_transition", "from", "to", "allowed"):
        assert word in documented, word
    for other in ("not_cancellable", "empty_selection", "idempotency_conflict"):
        assert other not in documented, other  # solo los errores de esta ruta


def test_the_403_and_the_404_are_documented_like_the_admin_detail(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    reads = spec["paths"][DETAIL]["get"]["responses"]

    for status in ("401", "403", "404", "503"):
        assert operation["responses"][status] == reads[status], status


def test_only_the_documented_statuses_are_declared_and_none_uses_the_framework_format(
    operation: dict[str, Any],
) -> None:
    assert set(operation["responses"]) == {"200", "401", "403", "404", "409", "422", "503"}
    assert "HTTPValidationError" not in json.dumps(operation["responses"])


def test_the_response_exposes_the_admin_fields_only_through_the_admin_schema(
    spec: dict[str, Any],
) -> None:
    holders = {
        name
        for name, node in spec["components"]["schemas"].items()
        if {"actor_id", "note"} & set(node.get("properties", {}))
    }

    assert "AdminHistoryEntryOut" in holders and "TransitionIn" in holders
    assert not holders & {"OrderDetailOut", "HistoryEntryOut", "OrderSummaryOut"}


def test_the_other_order_routes_keep_their_contract(spec: dict[str, Any]) -> None:
    assert set(spec["paths"][LIST]) == {"get"} and set(spec["paths"][DETAIL]) == {"get"}
    assert set(spec["paths"][CANCEL]) == {"post"} and set(spec["paths"][CUSTOMER_DETAIL]) == {"get"}
    assert set(spec["paths"]["/api/v1/orders"]) == {"get", "post"}
