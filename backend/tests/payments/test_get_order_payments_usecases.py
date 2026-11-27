"""`GetOrderPayments` con falsos (T-095; UC-02; CA-PAYMENTS-09, 11 y 12; SPEC §3, §4 R8, R9, R15).
Sin BD: el repositorio de intentos y el puerto `GetPayableOrder` son los falsos de T-094. Se prueba
el contrato de la interfaz pública: el pedido se lee por el puerto (dueño y vencimiento), los
valores `can_pay` y `attempts_left` los calcula el caso de uso, y nada se escribe."""

from uuid import UUID

import pytest

from tests.payments.get_order_payments_helpers import ALL_ORDER_STATUSES, Read
from tests.payments.pay_order_helpers import ORDER, OTHER_ORDER, STRANGER, USER, stored
from valmont.modules.orders.domain import OrderNotFound, OrderStatus
from valmont.modules.payments.domain import MAX_REJECTED_ATTEMPTS, FailureCode

WRITES = ("authorize", "confirm", "add", "audit")


def rejections(count: int, code: FailureCode = FailureCode.CARD_DECLINED) -> tuple:
    return tuple(stored(code, key=f"rej-{n:028d}") for n in range(count))


# --------------------------------------------------------------------------------------------
# Sin intentos y con un aprobado


def test_a_pending_order_without_attempts_can_be_paid_and_has_all_its_attempts_left() -> None:
    result = Read()()

    assert result.attempts == ()
    assert (result.can_pay, result.attempts_left) == (True, MAX_REJECTED_ATTEMPTS)
    assert MAX_REJECTED_ATTEMPTS == 5  # D-043


def test_the_result_carries_the_payable_order_read_through_the_port() -> None:
    read = Read()

    result = read()

    assert result.order.order_id == ORDER and result.order.status is OrderStatus.PENDING_PAYMENT
    assert read.orders.payable_for == [(USER, ORDER)]


def test_an_approved_attempt_does_not_consume_attempts_left() -> None:
    result = Read((stored(None, key="ok-" + "0" * 29),), status=OrderStatus.PAID)()

    assert result.attempts_left == MAX_REJECTED_ATTEMPTS
    assert result.can_pay is False  # el pedido ya está pagado


# --------------------------------------------------------------------------------------------
# Rechazos 0, 4 y 5 en cada estado del pedido (CA-PAYMENTS-09)


@pytest.mark.parametrize("status", ALL_ORDER_STATUSES)
@pytest.mark.parametrize(("count", "left"), [(0, 5), (1, 4), (4, 1), (5, 0)])
def test_can_pay_needs_a_pending_order_and_attempts_left(
    status: OrderStatus, count: int, left: int
) -> None:
    result = Read(rejections(count), status=status)()

    assert result.attempts_left == left
    assert result.can_pay is (status is OrderStatus.PENDING_PAYMENT and left > 0)


@pytest.mark.parametrize("count", [6, 9])
def test_attempts_left_is_never_negative_past_the_soft_limit(count: int) -> None:
    result = Read(rejections(count))()

    assert result.attempts_left == 0 and result.can_pay is False


@pytest.mark.parametrize("code", list(FailureCode))
def test_attempts_left_follows_the_repository_count_for_every_failure_code(
    code: FailureCode,
) -> None:
    # `order_expired` no cuenta (R9): el falso replica la regla del repositorio real.
    result = Read(rejections(5, code))()

    counted = 0 if code is FailureCode.ORDER_EXPIRED else 5
    assert result.attempts_left == 5 - counted
    assert len(result.attempts) == 5  # pero se listan todos


def test_order_expired_attempts_never_close_the_gate_on_their_own() -> None:
    result = Read(rejections(5, FailureCode.ORDER_EXPIRED))()

    assert (result.can_pay, result.attempts_left) == (True, 5)


def test_attempts_left_is_computed_from_count_rejected_not_from_the_listed_rows() -> None:
    result = Read(rejections(1), rejected=4)()  # lo que dice el repositorio manda

    assert result.attempts_left == 1 and result.can_pay is True


def test_the_limit_is_closed_exactly_at_five_and_open_at_four() -> None:
    at_four = Read(rejected=MAX_REJECTED_ATTEMPTS - 1)()
    at_five = Read(rejected=MAX_REJECTED_ATTEMPTS)()

    assert (at_four.can_pay, at_four.attempts_left) == (True, 1)
    assert (at_five.can_pay, at_five.attempts_left) == (False, 0)


# --------------------------------------------------------------------------------------------
# Orden y alcance de los intentos


def test_the_attempts_come_in_the_order_the_repository_gives_them_without_reordering() -> None:
    rows = tuple(stored(FailureCode.CARD_DECLINED, key=f"ord-{n:028d}") for n in (3, 1, 2))

    result = Read(rows)()

    assert result.attempts == rows


def test_only_the_attempts_of_this_order_and_this_user_are_listed() -> None:
    mine = stored(FailureCode.CARD_DECLINED, key="mine-" + "0" * 27)
    other_order = stored(FailureCode.CARD_DECLINED, order=OTHER_ORDER, key="oth-" + "0" * 28)
    other_user = stored(FailureCode.CARD_DECLINED, user=STRANGER, key="usr-" + "0" * 28)
    read = Read((mine, other_order, other_user))

    result = read()

    assert result.attempts == (mine,) and result.attempts_left == 4


# --------------------------------------------------------------------------------------------
# Ajeno o inexistente (R8) y ausencia de efectos


@pytest.mark.parametrize(
    ("user", "order"),
    [(STRANGER, ORDER), (USER, OTHER_ORDER), (UUID(int=7), UUID(int=8))],
    ids=["otro cliente", "pedido inexistente", "ambos desconocidos"],
)
def test_a_foreign_or_missing_order_is_not_found_and_nothing_else_is_read(
    user: UUID, order: UUID
) -> None:
    read = Read(rejections(2))

    with pytest.raises(OrderNotFound):
        read(user, order)

    assert read.calls == ["get_payable"]  # ni intentos ni conteo de un pedido que no es suyo


def test_reading_never_writes_pays_or_audits() -> None:
    read = Read(rejections(3))

    read()
    read()

    assert [c for c in read.calls if c in WRITES] == []
    assert set(read.calls) == {"get_payable", "count_rejected", "list_for_order"}
    assert read.orders.confirmed == []


def test_the_repository_is_asked_with_the_same_user_and_order_as_the_port() -> None:
    read = Read(rejections(1))
    asked: list[tuple[str, UUID, UUID]] = []
    original_list, original_count = read.attempts.list_for_order, read.attempts.count_rejected
    read.attempts.list_for_order = lambda u, o: (asked.append(("list", u, o)), original_list(u, o))[
        1
    ]  # type: ignore[method-assign]
    read.attempts.count_rejected = lambda u, o: (
        asked.append(("count", u, o)),
        original_count(u, o),
    )[1]  # type: ignore[method-assign]

    read(USER, ORDER)

    assert sorted(asked) == sorted([("list", USER, ORDER), ("count", USER, ORDER)])
    assert read.orders.payable_for == [(USER, ORDER)]
