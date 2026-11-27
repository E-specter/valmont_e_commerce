"""`PaymentAttempt`, `new_attempt`, `attempts_left` y las constantes (T-092; PAYMENTS-R1, R9, R11;
CA-PAYMENTS-07 y 09). Dominio puro, sin BD. Datos ficticios."""

import dataclasses
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from valmont.modules.payments.domain import (
    GATEWAY_SIMULATED,
    MAX_REJECTED_ATTEMPTS,
    AttemptStatus,
    FailureCode,
    PaymentAttempt,
    PaymentMethod,
    TooManyAttempts,
    attempts_left,
    new_attempt,
)

VALID_KEY = "idem-0123456789abcdef"  # 21 caracteres


def attempt(**changes: object) -> PaymentAttempt:
    values: dict[str, object] = {
        "id": uuid4(),
        "order_id": uuid4(),
        "user_id": uuid4(),
        "idempotency_key": VALID_KEY,
        "status": AttemptStatus.APPROVED,
        "amount": 250000,
        "failure_code": None,
        "card_last4": "4242",
        "gateway": GATEWAY_SIMULATED,
    }
    return PaymentAttempt(**{**values, **changes})  # type: ignore[arg-type]


# --- constantes y enumerados ---------------------------------------------------------------


def test_the_constants_follow_d043() -> None:
    assert MAX_REJECTED_ATTEMPTS == 5
    assert GATEWAY_SIMULATED == "simulated"


def test_the_enums_have_the_contract_values() -> None:
    assert {s.name: s.value for s in AttemptStatus} == {
        "APPROVED": "approved",
        "REJECTED": "rejected",
    }
    assert {c.name: c.value for c in FailureCode} == {
        "CARD_DECLINED": "card_declined",
        "INSUFFICIENT_FUNDS": "insufficient_funds",
        "EXPIRED_CARD": "expired_card",
        "ORDER_EXPIRED": "order_expired",
    }
    assert AttemptStatus.APPROVED == "approved" and FailureCode.EXPIRED_CARD == "expired_card"


# --- invariantes de PaymentAttempt ---------------------------------------------------------


def test_a_valid_approved_attempt_is_built_and_is_frozen() -> None:
    made = attempt()
    assert made.created_at is None  # lo pone la BD
    assert made.status is AttemptStatus.APPROVED and made.failure_code is None
    with pytest.raises(dataclasses.FrozenInstanceError):
        made.amount = 1  # type: ignore[misc]


def test_a_valid_rejected_attempt_for_every_failure_code() -> None:
    for code in FailureCode:
        made = attempt(status=AttemptStatus.REJECTED, failure_code=code)
        assert made.failure_code is code


def test_created_at_is_kept_when_given() -> None:
    stamp = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)
    assert attempt(created_at=stamp).created_at == stamp


@pytest.mark.parametrize("amount", [0, -1, -250000])
def test_the_amount_must_be_at_least_one(amount: int) -> None:
    with pytest.raises(ValueError):
        attempt(amount=amount)


def test_the_minimum_amount_is_accepted() -> None:
    assert attempt(amount=1).amount == 1


def test_a_rejected_attempt_needs_a_failure_code() -> None:
    with pytest.raises(ValueError):
        attempt(status=AttemptStatus.REJECTED, failure_code=None)


def test_an_approved_attempt_cannot_carry_a_failure_code() -> None:
    with pytest.raises(ValueError):
        attempt(status=AttemptStatus.APPROVED, failure_code=FailureCode.CARD_DECLINED)


@pytest.mark.parametrize(
    "key",
    [
        "a" * 16,
        "a" * 64,
        "ABCDEFGHIJKLMNOP",
        "0123456789_-ABCDef",
        str(uuid4()),  # 36 caracteres con guiones
    ],
)
def test_valid_idempotency_keys(key: str) -> None:
    assert attempt(idempotency_key=key).idempotency_key == key


@pytest.mark.parametrize(
    "key",
    [
        "",
        "a" * 15,  # demasiado corta
        "a" * 65,  # demasiado larga
        "a" * 15 + " ",
        "abcdefghijklmnop ",  # espacio al final
        "abcdefghijklmnop\n",  # salto de línea final: `$` lo aceptaría
        "abcdefgh ijklmnop",
        "abcdefghijklmnñp",  # no ASCII
        "abcdefghijklmn.p",
        "abcdefghijklmn/p",
        "abcdefghijklmn;p",
    ],
)
def test_invalid_idempotency_keys_are_rejected(key: str) -> None:
    with pytest.raises(ValueError):
        attempt(idempotency_key=key)


@pytest.mark.parametrize(
    "last4", ["", "424", "42424", "abcd", "4242\n", " 4242", "4 4 2", "٤٢٤٢", "４２４２"]
)
def test_the_attempt_revalidates_card_last4(last4: str) -> None:
    with pytest.raises(ValueError):
        attempt(card_last4=last4)


@pytest.mark.parametrize("gateway", ["", "g" * 31, "g" * 100])
def test_the_gateway_name_must_have_1_to_30_characters(gateway: str) -> None:
    with pytest.raises(ValueError):
        attempt(gateway=gateway)


@pytest.mark.parametrize("gateway", ["x", "simulated", "g" * 30])
def test_valid_gateway_names(gateway: str) -> None:
    assert attempt(gateway=gateway).gateway == gateway


def test_the_attempt_has_exactly_the_contract_fields_and_no_card_data() -> None:
    names = [f.name for f in dataclasses.fields(PaymentAttempt)]
    assert names == [
        "id",
        "order_id",
        "user_id",
        "idempotency_key",
        "status",
        "amount",
        "failure_code",
        "card_last4",
        "gateway",
        "created_at",
    ]
    assert not {"cvv", "cvc", "card_number", "pan", "number", "expiry"} & set(names)


@pytest.mark.parametrize(
    ("changes", "secret"),
    [
        ({"card_last4": "12x4"}, "12x4"),
        ({"idempotency_key": "clave-inventada-con-ñ"}, "clave-inventada-con-ñ"),
        ({"idempotency_key": "corta"}, "corta"),
        ({"amount": -777}, "-777"),
        ({"gateway": "g" * 31}, "g" * 31),
        ({"status": AttemptStatus.REJECTED, "failure_code": None}, "rejected"),
    ],
)
def test_error_messages_never_repeat_the_received_value(
    changes: dict[str, object], secret: str
) -> None:
    with pytest.raises(ValueError) as exc:
        attempt(**changes)
    shown = [str(exc.value), repr(exc.value), *map(str, exc.value.args)]
    assert all(secret not in text for text in shown)


def test_the_messages_do_not_leak_the_valid_card_digits_either() -> None:
    # Con otro campo inválido, el `card_last4` válido tampoco debe aparecer en el mensaje.
    with pytest.raises(ValueError) as exc:
        attempt(amount=0, card_last4="3571")
    assert "3571" not in str(exc.value) and "3571" not in repr(exc.value)


# --- new_attempt ---------------------------------------------------------------------------


def build(code: FailureCode | None, *, last4: str = "4242") -> PaymentAttempt:
    return new_attempt(
        attempt_id=UUID(int=1),
        order_id=UUID(int=2),
        user_id=UUID(int=3),
        idempotency_key=VALID_KEY,
        amount=123400,
        method=PaymentMethod(last4),
        gateway=GATEWAY_SIMULATED,
        failure_code=code,
    )


def test_new_attempt_without_failure_code_is_approved() -> None:
    made = build(None)
    assert made.status is AttemptStatus.APPROVED
    assert made.failure_code is None
    assert (made.id, made.order_id, made.user_id) == (UUID(int=1), UUID(int=2), UUID(int=3))
    assert (made.idempotency_key, made.amount, made.card_last4, made.gateway) == (
        VALID_KEY,
        123400,
        "4242",
        "simulated",
    )
    assert made.created_at is None


@pytest.mark.parametrize("code", list(FailureCode))
def test_new_attempt_with_a_failure_code_is_rejected(code: FailureCode) -> None:
    made = build(code, last4="0002")
    assert made.status is AttemptStatus.REJECTED
    assert made.failure_code is code
    assert made.card_last4 == "0002"


def test_new_attempt_takes_only_keyword_arguments() -> None:
    with pytest.raises(TypeError):
        new_attempt(  # type: ignore[misc]
            UUID(int=1), UUID(int=2), UUID(int=3), VALID_KEY, 1, PaymentMethod("4242"), "x", None
        )


def test_new_attempt_keeps_the_domain_invariants() -> None:
    with pytest.raises(ValueError):
        new_attempt(
            attempt_id=uuid4(),
            order_id=uuid4(),
            user_id=uuid4(),
            idempotency_key="corta",
            amount=1,
            method=PaymentMethod("4242"),
            gateway=GATEWAY_SIMULATED,
            failure_code=None,
        )
    with pytest.raises(ValueError):
        new_attempt(
            attempt_id=uuid4(),
            order_id=uuid4(),
            user_id=uuid4(),
            idempotency_key=VALID_KEY,
            amount=0,
            method=PaymentMethod("4242"),
            gateway=GATEWAY_SIMULATED,
            failure_code=None,
        )


# --- attempts_left y tope ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rejected", "left"),
    [(0, 5), (1, 4), (2, 3), (3, 2), (4, 1), (5, 0), (6, 0), (100, 0)],
)
def test_attempts_left_counts_down_from_five_and_never_goes_negative(
    rejected: int, left: int
) -> None:
    assert attempts_left(rejected) == left


def test_the_cap_is_five_rejections_not_four() -> None:
    # D-043 P-2: a partir del quinto rechazo ya no quedan intentos; con 4 aún queda uno.
    assert attempts_left(MAX_REJECTED_ATTEMPTS - 1) == 1
    assert attempts_left(MAX_REJECTED_ATTEMPTS) == 0
    assert TooManyAttempts().max_attempts == MAX_REJECTED_ATTEMPTS == 5
