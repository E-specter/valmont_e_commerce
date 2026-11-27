"""`PaymentMethod` y sus errores (T-092; PAYMENTS-R7, D-043; CA-PAYMENTS-07). Dominio puro, sin BD.
El único dato de tarjeta es `card_last4`: exactamente 4 dígitos ASCII, sin espacios ni salto de
línea final. Ningún mensaje de error repite el valor recibido."""

import dataclasses

import pytest

from valmont.modules.payments.domain import (
    GatewayUnavailable,
    IdempotencyKeyReused,
    InvalidPaymentMethod,
    OrderAlreadyPaid,
    PaymentError,
    PaymentMethod,
    TooManyAttempts,
)

INVALID = [
    "",  # vacío
    "424",  # 3 dígitos
    "42424",  # 5 dígitos
    "4",
    "abcd",  # letras
    "42a2",
    "4 42",
    " 4242",  # espacios
    "4242 ",
    "42 42",
    "4242\n",  # salto de línea final: `$` lo dejaría pasar, `fullmatch` no
    "\n4242",
    "4242\r\n",
    "4242 4242 4242 4242",  # número completo
    "٤٢٤٢",  # dígitos árabe-índicos (Unicode no ASCII)
    "４２４２",  # dígitos de ancho completo
    "²²²²",  # superíndices
    "-424",
    "+424",
    "4.24",
    "0x42",
]


@pytest.mark.parametrize("last4", ["4242", "0002", "9995", "0069", "0119", "0000", "9999"])
def test_a_four_digit_string_is_a_valid_method(last4: str) -> None:
    assert PaymentMethod(last4).card_last4 == last4
    assert PaymentMethod(card_last4=last4) == PaymentMethod(last4)


@pytest.mark.parametrize("value", INVALID)
def test_anything_but_exactly_four_ascii_digits_is_rejected(value: str) -> None:
    with pytest.raises(InvalidPaymentMethod):
        PaymentMethod(value)


@pytest.mark.parametrize("value", [None, 4242, 4.2, b"4242", ["4242"]])
def test_a_non_string_is_rejected_too(value: object) -> None:
    with pytest.raises(InvalidPaymentMethod):
        PaymentMethod(value)  # type: ignore[arg-type]


def test_the_method_is_frozen_and_only_carries_the_last_four_digits() -> None:
    method = PaymentMethod("4242")
    assert [f.name for f in dataclasses.fields(PaymentMethod)] == ["card_last4"]
    with pytest.raises(dataclasses.FrozenInstanceError):
        method.card_last4 = "0002"  # type: ignore[misc]
    assert hash(method) == hash(PaymentMethod("4242"))


def test_invalid_payment_method_is_both_a_payment_error_and_a_value_error() -> None:
    assert issubclass(InvalidPaymentMethod, PaymentError)
    assert issubclass(InvalidPaymentMethod, ValueError)
    with pytest.raises(ValueError):
        PaymentMethod("12")
    with pytest.raises(PaymentError):
        PaymentMethod("12")


@pytest.mark.parametrize(
    "error", [InvalidPaymentMethod, OrderAlreadyPaid, TooManyAttempts, IdempotencyKeyReused]
)
def test_every_domain_error_derives_from_payment_error(error: type[Exception]) -> None:
    assert issubclass(error, PaymentError)
    assert issubclass(GatewayUnavailable, PaymentError)
    assert issubclass(PaymentError, Exception)


def test_too_many_attempts_carries_the_limit() -> None:
    error = TooManyAttempts(max_attempts=5)
    assert error.max_attempts == 5
    assert TooManyAttempts().max_attempts == 5  # por defecto, el tope de D-043
    assert TooManyAttempts(max_attempts=3).max_attempts == 3


@pytest.mark.parametrize("value", ["12x4", "98765", "2424\n", "١٢٣٤", "7 7 7", "abcde", "4242 9"])
def test_the_error_message_never_repeats_the_received_value(value: str) -> None:
    with pytest.raises(InvalidPaymentMethod) as exc:
        PaymentMethod(value)
    shown = [str(exc.value), repr(exc.value), *map(str, exc.value.args)]
    assert all(value not in text for text in shown)
    assert all(value.strip() not in text for text in shown)
    assert exc.value.__cause__ is None
