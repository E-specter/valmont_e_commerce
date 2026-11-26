"""Contrato de `POST /api/v1/orders` en el OpenAPI (T-074; CA-ORDERS-25, SPEC §7) y la boutique de
`Settings` (`SettingsPickupStore`, CA-ORDERS-26, H-1, H-5). Sin BD. Si cambia un campo, estas
pruebas fallan: son la red de seguridad del contrato que consumirá la interfaz (T-082)."""

import json
from typing import Any

import pytest

from tests.orders.orders_create_helpers import DETAIL_KEYS, LINE_KEYS
from valmont.main import create_app
from valmont.modules.orders.adapters.pickup import SettingsPickupStore
from valmont.modules.orders.application import PickupStore
from valmont.shared.config import Settings

PATH = "/api/v1/orders"
CODES_409 = [
    "empty_selection",
    "checkout_blocked",
    "insufficient_stock",
    "too_many_pending_orders",
    "pickup_unavailable",
    "idempotency_conflict",
]


@pytest.fixture(autouse=True)
def clean_pickup_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in ("PICKUP_STORE_NAME", "PICKUP_STORE_ADDRESS", "PICKUP_STORE_HOURS"):
        monkeypatch.delenv(variable, raising=False)


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
# CA-ORDERS-25
def test_the_route_is_post_on_the_collection_without_a_trailing_slash(spec: dict[str, Any]) -> None:
    assert "post" in spec["paths"][PATH]
    assert PATH + "/" not in spec["paths"]  # un 307 de redirección no es un contrato


def test_idempotency_key_is_a_required_header(spec: dict[str, Any]) -> None:
    [header] = [p for p in post(spec)["parameters"] if p["in"] == "header"]

    assert header["name"].lower() == "idempotency-key"
    assert header["required"] is True
    assert not [p for p in post(spec)["parameters"] if p["in"] in ("query", "path")]


def test_the_header_documents_the_length_and_charset(spec: dict[str, Any]) -> None:
    [header] = [p for p in post(spec)["parameters"] if p["in"] == "header"]
    node = header["schema"]

    assert (node.get("minLength"), node.get("maxLength")) == (16, 64)
    assert node.get("pattern") is not None and "A-Za-z0-9" in node["pattern"]


def test_the_request_body_is_create_order_in_and_is_closed(spec: dict[str, Any]) -> None:
    body = post(spec)["requestBody"]["content"]["application/json"]["schema"]

    assert ref_name(body) == "CreateOrderIn"
    create = schema(spec, "CreateOrderIn")
    assert create["additionalProperties"] is False
    assert set(create["properties"]) == {"delivery"} and create["required"] == ["delivery"]


def test_delivery_is_a_closed_union_discriminated_by_delivery_method(spec: dict[str, Any]) -> None:
    delivery = schema(spec, "CreateOrderIn")["properties"]["delivery"]

    assert delivery["discriminator"]["propertyName"] == "delivery_method"
    variants = {ref_name({"$ref": ref}) for ref in delivery["discriminator"]["mapping"].values()}
    assert variants == {"ShippingIn", "PickupIn"}
    assert set(delivery["discriminator"]["mapping"]) == {"shipping", "pickup"}
    for name in variants:
        assert schema(spec, name)["additionalProperties"] is False, name


def test_each_delivery_variant_has_exactly_its_fields(spec: dict[str, Any]) -> None:
    shipping, pickup = schema(spec, "ShippingIn"), schema(spec, "PickupIn")

    assert set(shipping["properties"]) == {
        "delivery_method",
        "recipient_name",
        "phone",
        "department",
        "province",
        "district",
        "address_line",
        "reference",
    }
    assert set(shipping["required"]) == {
        "delivery_method",
        "recipient_name",
        "phone",
        "department",
        "province",
        "district",
        "address_line",
    }
    assert set(pickup["properties"]) == {"delivery_method", "recipient_name", "phone"}
    assert set(pickup["required"]) == {"delivery_method", "recipient_name", "phone"}


def test_no_amount_or_user_field_can_be_sent_in_the_request(spec: dict[str, Any]) -> None:
    sent = {
        field
        for name in ("CreateOrderIn", "ShippingIn", "PickupIn")
        for field in schema(spec, name)["properties"]
    }

    assert not sent & {"user_id", "total", "subtotal", "shipping", "price", "unit_price"}
    assert not sent & {"amount", "status", "lines", "items", "discount_amount"}


def test_success_is_201_with_order_detail_and_200_for_a_repeated_key(spec: dict[str, Any]) -> None:
    responses = post(spec)["responses"]

    for status in ("201", "200"):
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "OrderDetailOut", status


def test_errors_401_409_422_and_503_are_declared_with_the_common_error_format(
    spec: dict[str, Any],
) -> None:
    responses = post(spec)["responses"]

    for status in ("401", "409", "422", "503"):
        node = responses[status]["content"]["application/json"]["schema"]
        assert ref_name(node) == "ErrorOut", status
    assert "HTTPValidationError" not in json.dumps(responses)


def test_the_409_documents_every_code_of_the_contract(spec: dict[str, Any]) -> None:
    conflict = json.dumps(post(spec)["responses"]["409"])

    for code in CODES_409:
        assert code in conflict, code


def test_the_409_documents_the_details_of_the_codes_that_carry_them(spec: dict[str, Any]) -> None:
    # CA-ORDERS-25: cada error con su `code` y sus `details` (SPEC §7, "Detalles que cierran").
    conflict = json.dumps(post(spec)["responses"]["409"])

    assert "max" in conflict  # too_many_pending_orders
    assert "product_ids" in conflict  # insufficient_stock
    assert "issues" in conflict  # checkout_blocked


def test_order_detail_has_exactly_the_contract_fields_and_money_amounts(
    spec: dict[str, Any],
) -> None:
    detail = schema(spec, "OrderDetailOut")["properties"]

    assert set(detail) == DETAIL_KEYS
    for name in ("total", "subtotal", "shipping"):
        assert ref_name(detail[name]).startswith("Money"), name
    assert set(schema(spec, "Money-Output")["properties"]) == {"amount", "currency"}


def test_order_line_has_the_contract_fields_with_money_and_image(spec: dict[str, Any]) -> None:
    line = schema(spec, "OrderLineOut")["properties"]

    assert set(line) == LINE_KEYS
    for name in ("list_price", "unit_price", "discount_amount", "line_total"):
        assert ref_name(line[name]).startswith("Money"), name
    assert set(schema(spec, "OrderImageOut")["properties"]) == {"url", "alt"}
    nullable = {p.get("$ref", p.get("type")) for p in line["image"]["anyOf"]}
    assert "null" in nullable  # D-041 P-7: null si no hay imagen o no está publicado


def test_delivery_out_history_and_refund_have_the_contract_fields(spec: dict[str, Any]) -> None:
    assert set(schema(spec, "DeliveryOut")["properties"]) == {
        "delivery_method",
        "recipient_name",
        "phone",
        "department",
        "province",
        "district",
        "address_line",
        "reference",
        "pickup_store",
        "carrier",
        "tracking_code",
        "shipped_at",
    }
    assert set(schema(spec, "HistoryEntryOut")["properties"]) == {
        "from_status",
        "status",
        "at",
        "actor",
    }
    assert set(schema(spec, "RefundOut")["properties"]) == {"amount", "at"}


def test_the_response_schemas_do_not_expose_internal_fields(spec: dict[str, Any]) -> None:
    out = json.dumps([schema(spec, n) for n in ("OrderDetailOut", "HistoryEntryOut")])

    for internal in ("user_id", "actor_id", '"note"', "idempotency_key", "order_number"):
        assert internal not in out, internal


# --------------------------------------------------------------------------------------------
# CA-ORDERS-26: SettingsPickupStore (H-1, H-5)
FULL = {
    "pickup_store_name": "Boutique Valmont Miraflores",
    "pickup_store_address": "Av. Larco 1234, Miraflores",
    "pickup_store_hours": "Lunes a sábado, 10:00 a 19:00",
}


def provider(**changes: str | None) -> SettingsPickupStore:
    return SettingsPickupStore(Settings(_env_file=None, **(FULL | changes)))


def test_the_store_comes_from_the_three_settings() -> None:
    assert provider().get() == PickupStore(
        "Boutique Valmont Miraflores", "Av. Larco 1234, Miraflores", "Lunes a sábado, 10:00 a 19:00"
    )


@pytest.mark.parametrize("field", list(FULL))
@pytest.mark.parametrize("missing", [None, "", "   ", "\t\n"])
def test_a_missing_empty_or_blank_setting_means_no_store(field: str, missing: str | None) -> None:
    # Settings lee una variable vacía como "" y no como ausente: se trata igual (Leader, T-071).
    assert provider(**{field: missing}).get() is None


def test_with_no_setting_at_all_there_is_no_store() -> None:
    assert SettingsPickupStore(Settings(_env_file=None)).get() is None
