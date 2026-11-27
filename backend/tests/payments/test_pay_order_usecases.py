"""`PayOrder` con repositorio, pasarela y puertos de orders falsos (T-094; SPEC §11 unitarias;
CA-PAYMENTS-01 a 06, 09, 12 y 13; reglas R2 a R6, R9, R10, R13). Sin BD.

Se prueba solo la interfaz pública: `PayOrder(attempts, gateway, get_payable, confirm, audit)` y
`__call__(user_id, order_id, idempotency_key, method) -> PaymentResult`. Tras cada 409 y cada 503
se comprueba "ningún efecto": ni pasarela (si el error es previo), ni confirmación, ni guardado, ni
auditoría. Los ids y el importe son fijos para que los 4 dígitos de prueba no aparezcan por azar."""

import inspect
from dataclasses import fields

import pytest

from tests.payments.pay_order_helpers import (
    GATEWAY_FAILURES,
    KEY,
    LAST4,
    ORDER,
    OTHER_KEY,
    OTHER_ORDER,
    STRANGER,
    TOTAL,
    USER,
    rig,
    stored,
)
from valmont.modules.orders.application import PaymentOutcome
from valmont.modules.orders.domain import OrderNotFound, OrderNotPayable, OrderStatus
from valmont.modules.payments.application import PaymentResult, PayOrder
from valmont.modules.payments.domain import (
    MAX_REJECTED_ATTEMPTS,
    AttemptStatus,
    FailureCode,
    GatewayUnavailable,
    IdempotencyKeyReused,
    OrderAlreadyPaid,
    PaymentMethod,
    TooManyAttempts,
)

PAID_STATES = [
    OrderStatus.PAID,
    OrderStatus.PREPARING,
    OrderStatus.SHIPPED,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.DELIVERED,
]
DEAD_STATES = [OrderStatus.CANCELLED, OrderStatus.EXPIRED]


def audit_after(entry: object) -> dict[str, object]:
    after = entry.after  # type: ignore[attr-defined]
    assert after is not None
    return after


# --------------------------------------------------------------------------------------------
# Forma pública


def test_the_constructor_takes_the_five_collaborators_in_the_documented_order() -> None:
    assert list(inspect.signature(PayOrder.__init__).parameters) == [
        "self",
        "attempts",
        "gateway",
        "get_payable",
        "confirm",
        "audit",
    ]


def test_the_call_takes_user_order_key_and_method() -> None:
    assert list(inspect.signature(PayOrder.__call__).parameters) == [
        "self",
        "user_id",
        "order_id",
        "idempotency_key",
        "method",
    ]


def test_the_result_carries_the_attempt_and_whether_it_was_created() -> None:
    assert [f.name for f in fields(PaymentResult)] == ["attempt", "created"]


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-01: aprobado


def test_an_approved_payment_records_an_approved_attempt_with_the_order_total() -> None:
    r = rig(total=TOTAL)

    result = r.pay("4242")

    assert result.created is True
    attempt = result.attempt
    assert attempt.status is AttemptStatus.APPROVED and attempt.failure_code is None
    assert (attempt.user_id, attempt.order_id, attempt.idempotency_key) == (USER, ORDER, KEY)
    assert attempt.amount == TOTAL and attempt.card_last4 == "4242"
    assert attempt.gateway == "fake"  # lo da `gateway.name`, no una constante del caso de uso
    assert [a.id for a in r.attempts.added] == [attempt.id]


def test_the_amount_comes_only_from_the_order_never_from_the_request() -> None:
    r = rig(total=1_234_500)

    result = r.pay("4242")

    assert result.attempt.amount == 1_234_500
    [charge] = r.gateway.charges
    assert charge.amount == 1_234_500


def test_the_gateway_receives_only_the_charge_with_the_attempt_id_as_reference() -> None:
    r = rig()

    result = r.pay(LAST4)

    [charge] = r.gateway.charges
    assert charge.reference == result.attempt.id
    assert charge.amount == TOTAL
    assert charge.method == PaymentMethod(LAST4)
    assert {f.name for f in fields(charge)} == {"reference", "amount", "method"}


def test_an_approved_payment_confirms_the_order_exactly_once_for_this_customer() -> None:
    r = rig()

    r.pay("4242")

    assert r.orders.confirmed == [(USER, ORDER)]


def test_the_order_is_read_for_the_session_user_and_the_given_order() -> None:
    r = rig()

    r.pay("4242")

    assert r.orders.payable_for == [(USER, ORDER)]


def test_the_documented_order_of_calls_confirms_the_order_before_saving_the_attempt() -> None:
    # R10: el INSERT del intento va después de la confirmación (su FK bloquearía al pedido).
    r = rig()

    r.pay("4242")

    order = [r.calls.index(c) for c in ("find_by_key", "get_payable", "count_rejected")]
    assert order == sorted(order)
    assert (
        r.calls.index("count_rejected")
        < r.calls.index("authorize")
        < r.calls.index("confirm")
        < r.calls.index("add")
        < r.calls.index("audit")
    )


def test_an_approved_payment_audits_one_entry_with_the_customer_as_actor() -> None:
    r = rig()

    result = r.pay("4242")

    [entry] = r.audit.entries
    assert entry.action == "payments.attempt_recorded"
    assert entry.entity_type == "payment_attempt"
    assert entry.entity_id == str(result.attempt.id)
    assert (entry.actor_id, entry.actor_role) == (USER, "customer")
    assert entry.before is None
    assert set(audit_after(entry)) == {"order_id", "status", "failure_code", "amount"}
    after = audit_after(entry)
    assert str(after["order_id"]) == str(ORDER)
    assert after["status"] == "approved" and after["failure_code"] is None
    assert after["amount"] == TOTAL


def test_the_audit_never_carries_card_data() -> None:
    r = rig()

    r.pay(LAST4)

    [entry] = r.audit.entries
    assert "card_last4" not in repr(entry) and "last4" not in repr(entry)
    assert LAST4 not in repr(entry)


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-02: rechazos de la pasarela


@pytest.mark.parametrize("code", GATEWAY_FAILURES)
def test_a_rejection_is_recorded_with_its_code_and_does_not_touch_the_order(
    code: FailureCode,
) -> None:
    r = rig(result=code)

    result = r.pay("0002")

    assert result.created is True
    assert result.attempt.status is AttemptStatus.REJECTED
    assert result.attempt.failure_code is code
    assert result.attempt.amount == TOTAL and result.attempt.card_last4 == "0002"
    assert "confirm" not in r.calls and r.orders.confirmed == []  # el pedido no se toca (R4)


@pytest.mark.parametrize("code", GATEWAY_FAILURES)
def test_a_rejection_audits_one_entry_with_the_failure_code(code: FailureCode) -> None:
    r = rig(result=code)

    result = r.pay("0002")

    [entry] = r.audit.entries
    after = audit_after(entry)
    assert entry.entity_id == str(result.attempt.id) and entry.actor_id == USER
    assert after["status"] == "rejected" and after["failure_code"] == code.value
    assert after["amount"] == TOTAL
    assert "card_last4" not in after


def test_a_gateway_outage_propagates_and_leaves_no_effect() -> None:
    r = rig(gateway_error=GatewayUnavailable())

    with pytest.raises(GatewayUnavailable):
        r.pay("0119")

    assert "confirm" not in r.calls and "add" not in r.calls and "audit" not in r.calls
    assert r.attempts.rows == []


def test_after_an_outage_the_same_key_pays_normally_with_another_card() -> None:
    down = rig(gateway_error=GatewayUnavailable())
    with pytest.raises(GatewayUnavailable):
        down.pay("0119")
    up = rig()  # nada quedó guardado: el reintento parte de cero con la misma clave

    result = up.pay("4242", key=KEY)

    assert result.created is True and result.attempt.status is AttemptStatus.APPROVED


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-03: idempotencia


@pytest.mark.parametrize("failure", [None, FailureCode.CARD_DECLINED])
def test_a_known_key_returns_the_same_attempt_without_any_effect(
    failure: FailureCode | None,
) -> None:
    original = stored(failure)
    r = rig(rows=(original,))

    result = r.pay("4242", key=KEY)

    assert result.created is False and result.attempt == original
    assert r.effects() == []
    assert "get_payable" not in r.calls and "confirm" not in r.calls
    assert r.gateway.charges == [] and r.audit.entries == []


def test_a_repeated_key_with_another_card_returns_the_original_attempt() -> None:
    # Limitación aceptada (R3): no se compara la huella de la solicitud.
    original = stored(FailureCode.CARD_DECLINED, last4="0002")
    r = rig(rows=(original,))

    result = r.pay("4242", key=KEY)

    assert result.created is False and result.attempt.card_last4 == "0002"
    assert r.gateway.charges == []


def test_a_key_of_another_order_is_reused_and_has_no_effect() -> None:
    r = rig(rows=(stored(order=OTHER_ORDER),))

    with pytest.raises(IdempotencyKeyReused):
        r.pay("4242", key=KEY, order=ORDER)

    assert r.effects() == []
    assert len(r.attempts.rows) == 1


def test_the_same_key_of_another_customer_does_not_collide() -> None:
    foreign = stored(user=STRANGER, order=OTHER_ORDER, key=KEY)
    r = rig(rows=(foreign,))

    result = r.pay("4242", key=KEY)

    assert result.created is True and result.attempt.user_id == USER
    assert r.attempts.lookups[0] == (USER, KEY)  # se busca por (cliente de la sesión, clave)


def test_a_new_key_after_a_rejection_creates_a_new_attempt() -> None:
    first = stored(FailureCode.CARD_DECLINED, key=KEY)
    r = rig(rows=(first,))

    result = r.pay("4242", key=OTHER_KEY)

    assert result.created is True and result.attempt.id != first.id
    assert len(r.attempts.rows) == 2


def test_a_known_key_is_returned_even_after_reaching_the_rejection_limit() -> None:
    original = stored(FailureCode.CARD_DECLINED)
    r = rig(rows=(original,), rejected=MAX_REJECTED_ATTEMPTS)

    result = r.pay("4242", key=KEY)

    assert result.created is False and result.attempt == original
    assert r.effects() == []


def test_losing_the_insert_race_returns_the_winners_attempt_without_auditing() -> None:
    # `ON CONFLICT DO NOTHING` devuelve `None`: otra solicitud con la misma clave ya insertó.
    winner = stored(FailureCode.CARD_DECLINED)
    r = rig(late=winner, result=FailureCode.CARD_DECLINED)

    result = r.pay("0002", key=KEY)

    assert result.created is False and result.attempt == winner
    assert r.audit.entries == []
    assert len(r.attempts.lookups) == 2  # una búsqueda inicial y otra tras el `None`


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-04 y 05: qué pedidos se pueden pagar (R5)


@pytest.mark.parametrize("status", PAID_STATES, ids=lambda s: s.value)
def test_an_already_paid_order_is_order_already_paid_with_no_effect(status: OrderStatus) -> None:
    r = rig(status=status)

    with pytest.raises(OrderAlreadyPaid):
        r.pay("4242")

    assert r.effects() == [] and r.attempts.rows == []


@pytest.mark.parametrize("status", DEAD_STATES, ids=lambda s: s.value)
def test_a_cancelled_or_expired_order_is_not_payable_and_names_its_status(
    status: OrderStatus,
) -> None:
    r = rig(status=status)

    with pytest.raises(OrderNotPayable) as error:
        r.pay("4242")

    assert error.value.status == status
    assert r.effects() == [] and r.attempts.rows == []


def test_a_foreign_or_missing_order_is_not_found_with_no_effect() -> None:
    for user, order in ((STRANGER, ORDER), (USER, OTHER_ORDER)):
        r = rig()
        with pytest.raises(OrderNotFound):
            r.pay("4242", user=user, order=order)
        assert r.effects() == []


def test_the_order_state_is_checked_before_the_rejection_limit() -> None:
    cancelled = rig(status=OrderStatus.CANCELLED, rejected=MAX_REJECTED_ATTEMPTS)
    paid = rig(status=OrderStatus.PAID, rejected=MAX_REJECTED_ATTEMPTS)

    with pytest.raises(OrderNotPayable):
        cancelled.pay("4242")
    with pytest.raises(OrderAlreadyPaid):
        paid.pay("4242")


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-09: tope de rechazos (R9)


@pytest.mark.parametrize("rejected", [5, 6, 100])
def test_from_the_fifth_rejection_the_next_attempt_is_too_many_with_the_max(
    rejected: int,
) -> None:
    r = rig(rejected=rejected)

    with pytest.raises(TooManyAttempts) as error:
        r.pay("4242")

    assert error.value.max_attempts == 5 == MAX_REJECTED_ATTEMPTS
    assert r.effects() == [] and r.gateway.charges == []


@pytest.mark.parametrize("rejected", [0, 1, 4])
def test_below_the_limit_the_attempt_goes_to_the_gateway(rejected: int) -> None:
    r = rig(rejected=rejected)

    result = r.pay("4242")

    assert result.created is True and len(r.gateway.charges) == 1


def test_the_count_is_of_the_session_customer_and_the_given_order() -> None:
    mine = tuple(stored(FailureCode.CARD_DECLINED, key=f"pay-{n:032d}") for n in range(5))
    theirs = tuple(
        stored(FailureCode.CARD_DECLINED, user=STRANGER, key=f"pay-{n:032d}") for n in range(5)
    )
    r = rig(rows=theirs)
    ok = r.pay("4242")  # los cinco rechazos son de otro cliente: no cuentan
    capped = rig(rows=mine)

    with pytest.raises(TooManyAttempts):
        capped.pay("4242", key=OTHER_KEY)

    assert ok.created is True


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-06 y R4: lo que dice orders al confirmar


def test_an_order_that_expires_during_the_payment_is_a_rejection_order_expired() -> None:
    r = rig(outcome=PaymentOutcome.EXPIRED)

    result = r.pay("4242")

    attempt = result.attempt
    assert result.created is True
    assert attempt.status is AttemptStatus.REJECTED
    assert attempt.failure_code is FailureCode.ORDER_EXPIRED
    assert attempt.amount == TOTAL and attempt.card_last4 == "4242"
    assert r.attempts.added and r.calls.index("add") > r.calls.index("confirm")  # se guarda


def test_an_order_expired_rejection_is_audited_as_a_rejected_attempt() -> None:
    r = rig(outcome=PaymentOutcome.EXPIRED)

    result = r.pay("4242")

    [entry] = r.audit.entries
    after = audit_after(entry)
    assert entry.entity_id == str(result.attempt.id) and entry.actor_id == USER
    assert after["status"] == "rejected" and after["failure_code"] == "order_expired"


def test_already_paid_by_confirm_without_an_own_attempt_is_order_already_paid() -> None:
    r = rig(outcome=PaymentOutcome.ALREADY_PAID)

    with pytest.raises(OrderAlreadyPaid):
        r.pay("4242")

    assert "add" not in r.calls and r.audit.entries == [] and r.attempts.rows == []


def test_already_paid_by_confirm_looks_the_key_up_again_and_returns_the_own_attempt() -> None:
    # R3: otra solicitud con la misma clave pagó mientras esta esperaba el bloqueo del pedido.
    winner = stored(None)
    r = rig(late=winner, outcome=PaymentOutcome.ALREADY_PAID)

    result = r.pay("4242", key=KEY)

    assert result.created is False and result.attempt == winner
    assert r.audit.entries == []
    assert len(r.attempts.lookups) == 2


def test_a_cancellation_between_the_read_and_the_confirmation_is_not_payable() -> None:
    r = rig(outcome=OrderNotPayable(OrderStatus.CANCELLED))

    with pytest.raises(OrderNotPayable) as error:
        r.pay("4242")

    assert error.value.status == OrderStatus.CANCELLED
    assert "add" not in r.calls and r.audit.entries == [] and r.attempts.rows == []


def test_an_unexpected_error_in_the_confirmation_is_not_swallowed() -> None:
    r = rig(outcome=RuntimeError("fallo de la BD"))

    with pytest.raises(RuntimeError):
        r.pay("4242")

    assert "add" not in r.calls and r.audit.entries == []


def test_the_database_guard_against_a_second_approval_becomes_order_already_paid() -> None:
    # Última defensa (R4): el índice único parcial rechaza un segundo `approved` del pedido.
    r = rig(add_error=OrderAlreadyPaid())

    with pytest.raises(OrderAlreadyPaid):
        r.pay("4242")

    assert r.audit.entries == []


def test_the_gateway_is_not_called_when_the_key_resolves_to_a_known_attempt() -> None:
    r = rig(rows=(stored(None),))

    r.pay("0002", key=KEY)

    assert r.gateway.charges == []


# --------------------------------------------------------------------------------------------
# Errores sin datos de tarjeta (R7)


@pytest.mark.parametrize(
    "error",
    [OrderAlreadyPaid(), TooManyAttempts(), IdempotencyKeyReused(), GatewayUnavailable()],
    ids=lambda e: type(e).__name__,
)
def test_the_business_errors_do_not_contain_the_card_digits(error: Exception) -> None:
    assert LAST4 not in str(error) and LAST4 not in repr(error)
