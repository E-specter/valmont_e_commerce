"""`DeliveryDetails` (T-072; CA-ORDERS-04 y 26, ORDERS-R13, R18). Valida y normaliza al
construirse, según la modalidad. Cada longitud se prueba en su límite y fuera."""

import dataclasses
from collections.abc import Callable

import pytest

from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from valmont.modules.orders.domain import DeliveryDetails, DeliveryInvalid, DeliveryMethod

TEXT_FIELDS_SHIPPING = [
    ("recipient_name", 2, 80),
    ("department", 2, 40),
    ("province", 2, 40),
    ("district", 2, 40),
    ("address_line", 5, 150),
]
CONTROL_CHARS = ["\n", "\t", "\r", "\x00", "\x7f", "\x85", "\ud800"]


Build = Callable[..., DeliveryDetails]


def rejected(build: Callable[[], object], field: str) -> DeliveryInvalid:
    with pytest.raises(DeliveryInvalid) as exc:
        build()
    assert exc.value.field == field
    return exc.value


def test_delivery_invalid_is_a_value_error_with_its_field() -> None:
    error = DeliveryInvalid("phone", "mensaje")
    assert isinstance(error, ValueError)
    assert error.field == "phone"


def test_a_valid_shipping_delivery_keeps_its_data() -> None:
    delivery = shipping_delivery()
    assert delivery.delivery_method == DeliveryMethod.SHIPPING
    assert (delivery.recipient_name, delivery.phone) == ("Ana Pérez", "+51987654321")
    assert (delivery.department, delivery.province, delivery.district) == (
        "Lima",
        "Lima",
        "Miraflores",
    )
    assert (delivery.address_line, delivery.reference) == (
        "Av. Larco 1234, piso 5",
        "Frente al parque",
    )


def test_a_valid_pickup_delivery_has_no_location() -> None:
    delivery = pickup_delivery()
    assert delivery.delivery_method == DeliveryMethod.PICKUP
    assert (delivery.recipient_name, delivery.phone) == ("Ana Pérez", "987654321")
    assert (
        delivery.department,
        delivery.province,
        delivery.district,
        delivery.address_line,
        delivery.reference,
    ) == (None, None, None, None, None)


def test_the_delivery_is_immutable() -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        shipping_delivery().phone = "123456"  # type: ignore[misc]


# --- normalización -------------------------------------------------------------------------


def test_names_and_places_are_trimmed_and_repeated_spaces_collapse() -> None:
    delivery = shipping_delivery(
        recipient_name="  Ana   María   Pérez ",
        department="  Lima  ",
        province="  Lima   Metropolitana",
        district="San   Isidro ",
    )
    assert delivery.recipient_name == "Ana María Pérez"
    assert delivery.department == "Lima"
    assert delivery.province == "Lima Metropolitana"
    assert delivery.district == "San Isidro"


def test_address_and_reference_are_trimmed() -> None:
    delivery = shipping_delivery(address_line="  Av. Larco 1234  ", reference="  Frente al parque ")
    assert (delivery.address_line, delivery.reference) == ("Av. Larco 1234", "Frente al parque")


def test_the_phone_loses_its_spaces_like_identity() -> None:
    assert shipping_delivery(phone=" +51 987 654 321 ").phone == "+51987654321"
    assert pickup_delivery(phone="987 654 321").phone == "987654321"


def test_pickup_name_is_normalized_too() -> None:
    assert pickup_delivery(recipient_name="  Luis   Rojas ").recipient_name == "Luis Rojas"


def test_the_length_is_measured_after_trimming() -> None:
    rejected(lambda: shipping_delivery(recipient_name=" a "), "recipient_name")
    rejected(lambda: shipping_delivery(recipient_name="    "), "recipient_name")
    assert shipping_delivery(recipient_name="  ab  ").recipient_name == "ab"


# --- longitudes en el límite y fuera -------------------------------------------------------


@pytest.mark.parametrize(("field", "low", "high"), TEXT_FIELDS_SHIPPING)
def test_shipping_text_lengths_at_the_limits(field: str, low: int, high: int) -> None:
    assert getattr(shipping_delivery(**{field: "a" * low}), field) == "a" * low
    assert getattr(shipping_delivery(**{field: "a" * high}), field) == "a" * high
    rejected(lambda: shipping_delivery(**{field: "a" * (low - 1)}), field)
    rejected(lambda: shipping_delivery(**{field: "a" * (high + 1)}), field)
    rejected(lambda: shipping_delivery(**{field: ""}), field)


def test_pickup_recipient_name_lengths_at_the_limits() -> None:
    assert pickup_delivery(recipient_name="ab").recipient_name == "ab"
    assert pickup_delivery(recipient_name="a" * 80).recipient_name == "a" * 80
    rejected(lambda: pickup_delivery(recipient_name="a"), "recipient_name")
    rejected(lambda: pickup_delivery(recipient_name="a" * 81), "recipient_name")


def test_reference_is_optional_and_limited_to_150() -> None:
    assert shipping_delivery(reference=None).reference is None
    assert shipping_delivery(reference="a" * 150).reference == "a" * 150
    rejected(lambda: shipping_delivery(reference="a" * 151), "reference")


def test_a_blank_reference_becomes_none() -> None:
    # Decisión del Leader sobre R13: vacía o en blanco no se rechaza, se guarda como None.
    assert shipping_delivery(reference="").reference is None
    assert shipping_delivery(reference="   ").reference is None


# --- teléfono ------------------------------------------------------------------------------


@pytest.mark.parametrize("phone", ["123456", "+123456", "1" * 15, "+" + "1" * 15, "987 654 321"])
@pytest.mark.parametrize("build", [shipping_delivery, pickup_delivery])
def test_valid_phones(phone: str, build: Build) -> None:
    assert build(phone=phone).phone == "".join(phone.split())


@pytest.mark.parametrize(
    "phone",
    [
        "",
        "12345",  # 5 dígitos
        "1" * 16,
        "+" + "1" * 16,
        "+",
        "++123456",
        "12345a",
        "abcdefgh",
        "(01) 234567",
        "123-456-789",
        "123456+",
        "+51 9876 5432 109 876",  # 16 dígitos tras quitar espacios
    ],
)
@pytest.mark.parametrize("build", [shipping_delivery, pickup_delivery])
def test_invalid_phones(phone: str, build: Build) -> None:
    rejected(lambda: build(phone=phone), "phone")


@pytest.mark.parametrize("char", CONTROL_CHARS)
@pytest.mark.parametrize("build", [shipping_delivery, pickup_delivery])
def test_a_phone_with_control_characters_is_rejected_even_at_the_edges(
    char: str, build: Build
) -> None:
    rejected(lambda: build(phone=f"987654321{char}"), "phone")
    rejected(lambda: build(phone=f"{char}987654321"), "phone")


# --- caracteres de control -----------------------------------------------------------------


@pytest.mark.parametrize("char", CONTROL_CHARS)
@pytest.mark.parametrize(
    "field", ["recipient_name", "department", "province", "district", "address_line", "reference"]
)
def test_shipping_text_with_control_characters_is_rejected(field: str, char: str) -> None:
    # Cc y Cs, incluido `\n`; se comprueba antes de recortar, así que un control en el borde
    # (por ejemplo, un salto de línea final) no pasa desapercibido.
    rejected(lambda: shipping_delivery(**{field: f"Texto {char} medio"}), field)
    rejected(lambda: shipping_delivery(**{field: f"Texto válido{char}"}), field)
    rejected(lambda: shipping_delivery(**{field: f"{char}Texto válido"}), field)


@pytest.mark.parametrize("char", CONTROL_CHARS)
def test_pickup_name_with_control_characters_is_rejected(char: str) -> None:
    rejected(lambda: pickup_delivery(recipient_name=f"Luis{char}Rojas"), "recipient_name")
    rejected(lambda: pickup_delivery(recipient_name=f"Luis Rojas{char}"), "recipient_name")


# --- R13: campos obligatorios y prohibidos según la modalidad ------------------------------


@pytest.mark.parametrize("field", ["department", "province", "district", "address_line"])
def test_shipping_requires_the_four_location_fields(field: str) -> None:
    rejected(lambda: shipping_delivery(**{field: None}), field)


@pytest.mark.parametrize(
    "field", ["department", "province", "district", "address_line", "reference"]
)
def test_pickup_forbids_any_location_field(field: str) -> None:
    rejected(lambda: pickup_delivery(**{field: "Lima Centro"}), field)


def test_pickup_forbids_a_location_field_even_when_it_looks_harmless() -> None:
    rejected(lambda: pickup_delivery(reference="a" * 5), "reference")


# --- R18: sin datos personales en los mensajes de error ------------------------------------


@pytest.mark.parametrize(
    ("build", "field", "secret"),
    [
        (lambda: shipping_delivery(phone="9876secreto"), "phone", "9876secreto"),
        (lambda: shipping_delivery(address_line="Calle Secreta\n123"), "address_line", "Secreta"),
        (lambda: shipping_delivery(recipient_name="Zacarías\nQuispe"), "recipient_name", "Zacar"),
        (lambda: pickup_delivery(phone="12345"), "phone", "12345"),
        (lambda: pickup_delivery(district="Barranco"), "district", "Barranco"),
    ],
)
def test_error_messages_do_not_echo_the_submitted_value(
    build: Callable[[], object], field: str, secret: str
) -> None:
    error = rejected(build, field)
    assert secret not in str(error)
    assert secret not in repr(error)
