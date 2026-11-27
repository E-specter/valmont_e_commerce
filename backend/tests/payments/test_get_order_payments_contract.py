"""Contrato de `GET /api/v1/payments/orders/{order_id}/attempts` en el OpenAPI (T-095;
CA-PAYMENTS-16, SPEC §7 "Listar", R15) y capas de `GetOrderPayments` (CA-PAYMENTS-12). Sin BD.
Si cambia un campo, estas pruebas fallan: red de seguridad del contrato que consume T-097."""

import ast
import json
from typing import Any

import pytest

from tests.payments.get_order_payments_helpers import OUT_KEYS
from tests.payments.pay_order_helpers import ATTEMPT_KEYS
from tests.payments.test_layers import PAYMENTS, imported_names
from valmont.main import create_app

PATH = "/api/v1/payments/orders/{order_id}/attempts"


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
    ref = node.get("$ref") or found[0]
    return ref.rsplit("/", 1)[1]


def get(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["paths"][PATH]["get"]


def test_the_route_exists_as_get_next_to_the_post_and_has_the_payments_tag(
    spec: dict[str, Any],
) -> None:
    assert set(spec["paths"][PATH]) == {"get", "post"}
    assert get(spec)["tags"] == ["payments"]


def test_the_only_parameter_is_the_uuid_order_id_in_the_path(spec: dict[str, Any]) -> None:
    [param] = get(spec)["parameters"]  # ni query, ni cabeceras: nada de user_id (R8)

    assert (param["name"], param["in"], param["required"]) == ("order_id", "path", True)
    assert param["schema"]["format"] == "uuid"
    assert "requestBody" not in get(spec)


def test_the_200_is_order_payments_out(spec: dict[str, Any]) -> None:
    node = get(spec)["responses"]["200"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "OrderPaymentsOut"


def test_the_errors_of_the_section_7_are_declared_in_the_common_error_format(
    spec: dict[str, Any],
) -> None:
    responses = get(spec)["responses"]

    for status in ("401", "404", "422"):
        assert status in responses, f"falta el {status} declarado"
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "ErrorOut", status
    assert "HTTPValidationError" not in json.dumps(responses)
    assert not {"400", "403", "409"} & set(responses)  # leer no genera conflictos


def test_the_503_auth_unavailable_common_to_every_route_is_declared(spec: dict[str, Any]) -> None:
    # SPEC §7, primer párrafo: "Todas exigen sesión: 401 `unauthenticated` y 503
    # `auth_unavailable`"; el POST de payments y las rutas de orders lo declaran.
    node = get(spec)["responses"]["503"]["content"]["application/json"]["schema"]

    assert ref_name(node) == "ErrorOut"


def test_order_payments_out_has_exactly_the_contract_fields(spec: dict[str, Any]) -> None:
    node = schema(spec, "OrderPaymentsOut")
    props = node["properties"]

    assert set(props) == OUT_KEYS and set(node["required"]) == OUT_KEYS
    assert props["order_id"]["format"] == "uuid"
    assert props["can_pay"]["type"] == "boolean"
    assert props["attempts_left"]["type"] == "integer"
    assert props["attempts"]["type"] == "array"
    assert ref_name(props["attempts"]["items"]) == "PaymentAttemptOut"
    assert set(schema(spec, "PaymentAttemptOut")["properties"]) == ATTEMPT_KEYS


def test_the_output_schemas_expose_neither_user_gateway_nor_card_data(spec: dict[str, Any]) -> None:
    exposed = json.dumps(
        [schema(spec, "OrderPaymentsOut"), schema(spec, "PaymentAttemptOut"), get(spec)],
        default=str,
    )

    for internal in ("user_id", "gateway", "idempotency_key", "cvv", "card_number", "expiry"):
        assert internal not in exposed, internal


def test_the_amount_of_each_attempt_is_money_in_cents_and_currency(spec: dict[str, Any]) -> None:
    amount = schema(spec, "PaymentAttemptOut")["properties"]["amount"]
    money = schema(spec, ref_name(amount))

    assert set(money["properties"]) == {"amount", "currency"}
    assert money["properties"]["amount"]["type"] == "integer"


def test_there_is_still_no_refund_or_admin_route_in_payments(spec: dict[str, Any]) -> None:
    mine = [p for p in spec["paths"] if "payments" in p]

    assert mine == [PATH]


def test_get_order_payments_imports_no_adapter_and_no_gateway() -> None:
    source = (PAYMENTS / "application.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    [node] = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "GetOrderPayments"]
    used = {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}

    assert not used & {"SimulatedGateway", "SqlPaymentAttemptRepository", "Session"}
    assert not [i for i in imported_names(source) if "adapters" in i and "wiring" not in i]
