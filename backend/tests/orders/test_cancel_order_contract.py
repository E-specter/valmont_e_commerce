"""Contrato de `POST /api/v1/orders/{order_id}/cancel` en el OpenAPI (T-076; CA-ORDERS-25, SPEC §7
"Cancelar" y R12). Sin BD. Si cambia un campo, estas pruebas fallan: son la red de seguridad de lo
que consumirá la interfaz (T-083)."""

import json
from typing import Any

import pytest

from tests.orders.orders_create_helpers import DETAIL_KEYS
from tests.orders.test_my_orders_contract import nullable, params, ref_name, schema
from valmont.main import create_app

CANCEL = "/api/v1/orders/{order_id}/cancel"
DETAIL = "/api/v1/orders/{order_id}"
LIST = "/api/v1/orders"


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


@pytest.fixture(scope="module")
def operation(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["paths"][CANCEL]["post"]


def test_the_route_exists_only_as_post_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert set(spec["paths"][CANCEL]) == {"post"}
    assert CANCEL + "/" not in spec["paths"]


def test_the_route_is_in_the_orders_group(operation: dict[str, Any]) -> None:
    assert operation["tags"] == ["orders"]


def test_the_only_input_is_the_order_id_path_parameter_as_a_uuid(operation: dict[str, Any]) -> None:
    path = params(operation, "path")

    assert set(path) == {"order_id"} and path["order_id"]["required"] is True
    assert path["order_id"]["schema"].get("format") == "uuid"
    assert not params(operation, "query") and not params(operation, "header")
    assert not params(operation, "cookie")


def test_there_is_no_request_body_so_no_user_id_or_amount_can_be_sent(
    operation: dict[str, Any],
) -> None:
    assert "requestBody" not in operation
    assert "user_id" not in json.dumps(operation)


def test_it_responds_200_with_order_detail_out(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    node = operation["responses"]["200"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "OrderDetailOut"
    assert set(schema(spec, "OrderDetailOut")["properties"]) == DETAIL_KEYS
    assert "201" not in operation["responses"]  # cancelar no crea nada


def test_the_response_is_the_same_schema_as_the_detail_read(spec: dict[str, Any]) -> None:
    read = spec["paths"][DETAIL]["get"]["responses"]["200"]["content"]["application/json"]
    cancel = spec["paths"][CANCEL]["post"]["responses"]["200"]["content"]["application/json"]

    assert ref_name(read["schema"]) == ref_name(cancel["schema"])


@pytest.mark.parametrize("status", ["401", "404", "422", "503"])
def test_each_error_of_the_contract_uses_the_common_error_format(
    operation: dict[str, Any], status: str
) -> None:
    node = operation["responses"][status]["content"]["application/json"]["schema"]

    assert ref_name(node) == "ErrorOut"


def test_the_409_documents_not_cancellable_with_the_status_in_details(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    conflict = operation["responses"]["409"]
    node = conflict["content"]["application/json"]["schema"]

    assert ref_name(node) == "ErrorOut"
    documented = json.dumps(conflict)
    assert "not_cancellable" in documented
    assert '"status"' in documented  # `details {"status": "pagado"}`
    for other_code in ("invalid_transition", "empty_selection", "idempotency_conflict"):
        assert other_code not in documented, other_code  # solo los errores de esta ruta


def test_the_404_documents_the_same_not_found_as_the_detail(
    spec: dict[str, Any], operation: dict[str, Any]
) -> None:
    assert "404" in operation["responses"]
    assert (
        spec["paths"][DETAIL]["get"]["responses"]["404"]["content"]["application/json"]["schema"]
        == operation["responses"]["404"]["content"]["application/json"]["schema"]
    )


def test_no_error_is_declared_with_the_framework_default_format(operation: dict[str, Any]) -> None:
    assert "HTTPValidationError" not in json.dumps(operation["responses"])


def test_only_the_documented_statuses_are_declared(operation: dict[str, Any]) -> None:
    assert set(operation["responses"]) == {"200", "401", "404", "409", "422", "503"}


def test_the_response_never_exposes_the_owner_or_internal_notes(spec: dict[str, Any]) -> None:
    names = ("OrderDetailOut", "HistoryEntryOut", "DeliveryOut")
    out = json.dumps([schema(spec, n) for n in names])

    for internal in ("user_id", "actor_id", '"note"', "idempotency_key"):
        assert internal not in out, internal


def test_the_cancelled_order_fields_that_depend_on_state_are_nullable(
    spec: dict[str, Any],
) -> None:
    detail = schema(spec, "OrderDetailOut")["properties"]

    assert detail["can_cancel"]["type"] == "boolean"
    for name in ("expires_at", "expires_in_seconds", "paid_at", "refund"):
        assert nullable(detail[name]), name


def test_the_routes_of_t074_and_t075_keep_their_contract(spec: dict[str, Any]) -> None:
    assert set(spec["paths"][LIST]) == {"get", "post"}
    assert set(spec["paths"][DETAIL]) == {"get"}
