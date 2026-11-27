"""Contrato de `POST /api/v1/payments/orders/{order_id}/attempts` en el OpenAPI (T-094;
CA-PAYMENTS-16, SPEC §7) y capas de `PayOrder` y del router (CA-PAYMENTS-12 y 18). Sin BD. Si
cambia un campo, estas pruebas fallan: son la red de seguridad del contrato que consumirá la
pantalla de pago (T-097, T-098)."""

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

from tests.payments.pay_order_helpers import ATTEMPT_KEYS
from tests.payments.test_layers import PAYMENTS, SRC, imports_of, starts_with_any
from tests.shared.idempotency_key_helpers import IDEMPOTENCY_KEY_PATTERN
from valmont.main import create_app

PATH = "/api/v1/payments/orders/{order_id}/attempts"
CODES_409 = [
    "order_not_payable",
    "order_already_paid",
    "too_many_attempts",
    "idempotency_key_reused",
]
FAILURE_CODES = {"card_declined", "insufficient_funds", "expired_card", "order_expired"}


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    return create_app().openapi()


def schema(spec: dict[str, Any], name: str) -> dict[str, Any]:
    return spec["components"]["schemas"][name]


def ref_name(node: dict[str, Any]) -> str:
    """Nombre del esquema al que apunta `node` (directo, en anyOf/oneOf o en allOf)."""
    found = [
        part["$ref"]
        for key in ("anyOf", "oneOf", "allOf")
        for part in node.get(key, [])
        if "$ref" in part
    ]
    ref = node.get("$ref") or found[0]
    return ref.rsplit("/", 1)[1]


def post(spec: dict[str, Any]) -> dict[str, Any]:
    return spec["paths"][PATH]["post"]


# --------------------------------------------------------------------------------------------
# Ruta y parámetros


def test_the_route_is_post_on_attempts_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert "post" in spec["paths"][PATH]
    assert PATH + "/" not in spec["paths"]


def test_the_order_id_is_a_uuid_path_parameter(spec: dict[str, Any]) -> None:
    [param] = [p for p in post(spec)["parameters"] if p["in"] == "path"]

    assert param["name"] == "order_id" and param["required"] is True
    assert param["schema"]["format"] == "uuid"


def test_idempotency_key_is_a_required_header_that_documents_a_uuid(spec: dict[str, Any]) -> None:
    [header] = [p for p in post(spec)["parameters"] if p["in"] == "header"]
    node = header["schema"]

    assert header["name"].lower() == "idempotency-key" and header["required"] is True
    assert (node.get("minLength"), node.get("maxLength")) == (36, 36)
    assert node.get("pattern") == IDEMPOTENCY_KEY_PATTERN
    assert not [p for p in post(spec)["parameters"] if p["in"] == "query"]


def test_no_parameter_can_carry_the_user_or_the_amount(spec: dict[str, Any]) -> None:
    names = {p["name"].lower() for p in post(spec)["parameters"]}

    assert names == {"order_id", "idempotency-key"}


# --------------------------------------------------------------------------------------------
# Cuerpo cerrado (R7)


def test_the_request_body_is_pay_order_in_and_is_closed(spec: dict[str, Any]) -> None:
    body = post(spec)["requestBody"]["content"]["application/json"]["schema"]

    assert ref_name(body) == "PayOrderIn"
    node = schema(spec, "PayOrderIn")
    assert node["additionalProperties"] is False
    assert set(node["properties"]) == {"card_last4"} and node["required"] == ["card_last4"]


def test_card_last4_is_exactly_four_ascii_digits(spec: dict[str, Any]) -> None:
    node = schema(spec, "PayOrderIn")["properties"]["card_last4"]

    assert node["type"] == "string"
    assert node["pattern"] == "^[0-9]{4}$"


def test_the_request_has_no_field_for_amount_user_result_or_full_card_data(
    spec: dict[str, Any],
) -> None:
    fields = set(schema(spec, "PayOrderIn")["properties"])

    forbidden = {"amount", "total", "user_id", "status", "result", "card_number", "cvv", "expiry"}
    assert not fields & forbidden and not fields & {"holder", "cardholder", "currency"}


# --------------------------------------------------------------------------------------------
# Respuestas


def test_success_is_201_with_the_attempt_and_200_for_a_repeated_key(spec: dict[str, Any]) -> None:
    responses = post(spec)["responses"]

    for status in ("201", "200"):
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "PaymentAttemptOut", status


def test_errors_are_declared_with_the_common_error_format(spec: dict[str, Any]) -> None:
    responses = post(spec)["responses"]

    for status in ("401", "404", "409", "422", "503"):
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "ErrorOut", status
    assert "HTTPValidationError" not in json.dumps(responses)


def test_the_409_documents_every_code_and_its_details(spec: dict[str, Any]) -> None:
    conflict = json.dumps(post(spec)["responses"]["409"])

    for code in CODES_409:
        assert code in conflict, code
    assert "max" in conflict  # too_many_attempts {"max": 5}
    assert "status" in conflict  # order_not_payable {"status": ...}


def test_the_503_documents_the_gateway_outage(spec: dict[str, Any]) -> None:
    assert "payment_gateway_unavailable" in json.dumps(post(spec)["responses"]["503"])


def test_the_attempt_has_exactly_the_contract_fields_with_money(spec: dict[str, Any]) -> None:
    node = schema(spec, "PaymentAttemptOut")

    assert set(node["properties"]) == ATTEMPT_KEYS
    assert set(node["required"]) == ATTEMPT_KEYS
    assert ref_name(node["properties"]["amount"]).startswith("Money")
    assert set(schema(spec, ref_name(node["properties"]["amount"]))["properties"]) == {
        "amount",
        "currency",
    }
    assert node["properties"]["id"]["format"] == "uuid"
    assert node["properties"]["order_id"]["format"] == "uuid"
    assert node["properties"]["created_at"]["format"] == "date-time"


def test_status_and_failure_code_enumerate_exactly_the_contract_values(
    spec: dict[str, Any],
) -> None:
    node = schema(spec, "PaymentAttemptOut")["properties"]
    status = schema(spec, ref_name(node["status"])) if "$ref" in node["status"] else node["status"]
    failure = node["failure_code"]
    enum_ref = ref_name(failure)

    assert set(status["enum"]) == {"approved", "rejected"}
    assert set(schema(spec, enum_ref)["enum"]) == FAILURE_CODES
    assert any(part.get("type") == "null" for part in failure["anyOf"])  # nulo si aprobó


def test_the_response_schemas_do_not_expose_internal_fields(spec: dict[str, Any]) -> None:
    exposed = json.dumps(
        [schema(spec, "PaymentAttemptOut"), post(spec)["responses"]["201"]], default=str
    )

    for internal in ("user_id", "gateway", "idempotency_key", "cvv", "card_number", "expiry"):
        assert internal not in exposed, internal


def test_payments_routes_are_only_under_its_prefix_and_without_refund_or_admin(
    spec: dict[str, Any],
) -> None:
    mine = {p: v for p, v in spec["paths"].items() if "payments" in p}

    assert PATH in mine and all(p.startswith("/api/v1/payments/") for p in mine)
    assert not [p for p in mine if re.search(r"refund|reembolso|admin|void|capture", p, re.I)]
    assert all(set(v) <= {"get", "post"} for v in mine.values())


def test_the_tag_of_the_route_is_payments(spec: dict[str, Any]) -> None:
    assert post(spec)["tags"] == ["payments"]


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-12 y 18: capas y puerto de pasarela

HTTP = PAYMENTS / "adapters" / "http.py"
APPLICATION = PAYMENTS / "application.py"
ALLOWED_FROM_APPLICATION = (
    "valmont.modules.payments.domain",
    "valmont.modules.orders.application",
    "valmont.modules.audit.application",
    "valmont.modules.audit.domain",
)


def test_application_only_imports_its_domain_orders_application_and_the_audit_port() -> None:
    names = [n for n in imports_of(APPLICATION) if n.startswith("valmont")]

    assert [n for n in names if not starts_with_any(n, ALLOWED_FROM_APPLICATION)] == []


def test_the_use_cases_do_not_import_any_adapter_nor_name_the_simulated_gateway() -> None:
    source = APPLICATION.read_text(encoding="utf-8")
    names = imports_of(APPLICATION)

    assert not [n for n in names if ".adapters" in n]
    assert "SimulatedGateway" not in source and "simulated_gateway" not in source


def test_application_stays_free_of_frameworks() -> None:
    frameworks = ("fastapi", "pydantic", "sqlalchemy", "httpx", "starlette", "supabase")

    assert [n for n in imports_of(APPLICATION) if starts_with_any(n, frameworks)] == []


def test_the_simulated_gateway_is_named_only_in_its_module_and_in_the_gateway_provider() -> None:
    users: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        if path.name == "simulated_gateway.py":
            continue
        if "SimulatedGateway" in path.read_text(encoding="utf-8"):
            users.append(str(path.relative_to(SRC)))

    assert users == [str(Path("modules/payments/adapters/http.py"))]


def test_inside_the_router_the_simulated_gateway_is_only_used_by_get_payment_gateway() -> None:
    tree = ast.parse(HTTP.read_text(encoding="utf-8"))
    providers = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "get_payment_gateway"
    ]
    assert len(providers) == 1
    inside = {id(n) for n in ast.walk(providers[0])}
    outside = [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Name) and n.id == "SimulatedGateway" and id(n) not in inside
    ]
    assert outside == []


def test_the_router_only_takes_from_orders_its_application_and_its_wiring() -> None:
    orders = [n for n in imports_of(HTTP) if n.startswith("valmont.modules.orders")]

    allowed = ("valmont.modules.orders.application", "valmont.modules.orders.adapters.wiring")
    assert orders and [n for n in orders if not starts_with_any(n, allowed)] == []


def test_the_router_does_not_import_the_domain_or_persistence_of_other_modules() -> None:
    forbidden = tuple(
        f"valmont.modules.{module}.{inner}"
        for module in ("orders", "cart", "inventory", "catalog", "audit")
        for inner in ("domain", "adapters.persistence")
    ) + ("valmont.modules.orders.adapters.http",)

    assert [n for n in imports_of(HTTP) if starts_with_any(n, forbidden)] == []


def test_the_router_does_not_log_the_body_or_the_card() -> None:
    source = HTTP.read_text(encoding="utf-8")

    assert "logging" not in source and "logger" not in source and "print(" not in source
