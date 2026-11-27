"""OpenAPI de `POST /api/v1/orders` con la mayoría de edad (T-139; CA-IDENTITY-15, SPEC identity
§13.7): el 409 declara `birth_date_required` y `underage` con su texto y `details` nulo. Sin BD.
Ni el contrato ni los esquemas de orders exponen la fecha de nacimiento (R9)."""

import json
import re
from typing import Any

import pytest

from valmont.main import create_app

PATH = "/api/v1/orders"
MESSAGES = {
    "birth_date_required": "Indica tu fecha de nacimiento para comprar.",
    "underage": "Debes tener 18 años cumplidos para comprar.",
}
OLD_EXAMPLES = {
    "empty_selection",
    "checkout_blocked",
    "insufficient_stock",
    "too_many_pending_orders",
    "pickup_unavailable",
    "idempotency_conflict",
}


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


def conflict(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["paths"][PATH]["post"]["responses"]["409"]


def test_the_409_description_lists_both_age_codes(spec: dict[str, Any]) -> None:
    description = conflict(spec)["description"]

    for code in MESSAGES:
        assert f"`{code}`" in description, code


@pytest.mark.parametrize("code", sorted(MESSAGES))
def test_each_age_code_has_a_409_example_with_its_message_and_null_details(
    spec: dict[str, Any], code: str
) -> None:
    examples = conflict(spec)["content"]["application/json"]["examples"]

    error = examples[code]["value"]["error"]
    # Como los demás ejemplos de orders, OpenAPI omite el `details` nulo; la respuesta real lo
    # lleva como `null` (lo comprueban las pruebas HTTP).
    assert (error["code"], error["message"], error.get("details")) == (code, MESSAGES[code], None)


def test_the_409_keeps_its_previous_examples_and_adds_only_the_two_new_ones(
    spec: dict[str, Any],
) -> None:
    examples = conflict(spec)["content"]["application/json"]["examples"]

    assert set(examples) == OLD_EXAMPLES | set(MESSAGES)


def test_the_409_still_uses_the_common_error_schema(spec: dict[str, Any]) -> None:
    node = conflict(spec)["content"]["application/json"]["schema"]

    assert node["$ref"].endswith("/ErrorOut")


def test_the_age_error_messages_carry_no_date_and_only_the_fixed_legal_age(
    spec: dict[str, Any],
) -> None:
    examples = conflict(spec)["content"]["application/json"]["examples"]

    for code, fixed_numbers in (("birth_date_required", []), ("underage", ["18"])):
        message = examples[code]["value"]["error"]["message"]
        assert re.findall(r"\d+", message) == fixed_numbers, code


def test_the_orders_contract_does_not_expose_the_birth_date_field(spec: dict[str, Any]) -> None:
    orders_text = json.dumps(
        {path: ops for path, ops in spec["paths"].items() if path.startswith("/api/v1/orders")}
    ).replace("birth_date_required", "")
    order_schemas = {
        name: schema
        for name, schema in spec["components"]["schemas"].items()
        if name.startswith(("Order", "Created", "Delivery"))
    }

    assert "birth_date" not in orders_text
    assert "birth_date" not in json.dumps(order_schemas)


def test_the_request_body_still_has_no_age_or_birth_date_field(spec: dict[str, Any]) -> None:
    body = spec["paths"][PATH]["post"]["requestBody"]["content"]["application/json"]["schema"]
    ref = body["$ref"].rsplit("/", 1)[1]
    properties = spec["components"]["schemas"][ref]["properties"]

    assert set(properties) == {"delivery"}  # la edad sale del perfil, nunca del cuerpo


def test_the_age_errors_are_documented_only_on_the_post_of_the_collection(
    spec: dict[str, Any],
) -> None:
    holders = [
        (path, method)
        for path, ops in spec["paths"].items()
        for method, op in ops.items()
        if "underage" in json.dumps(op)
    ]

    assert holders == [(PATH, "post")]  # payments no comprueba la edad (D-045)
