"""`GetPayableOrder` y `ConfirmOrderPayment` con cart, inventory y orders reales (T-077;
CA-ORDERS-14, 20, 21 y 22; SPEC §3 UC-06, §4 R6, R7, R11, R16 y R18; INVENTORY-R8 y R11): una
transacción por llamada, contra valmont_test, y se mira en la BD lo que quedó: estado, `paid_at`,
historial, reservas, `on_hand` y movimientos `venta`. Los datos se confirman, así que cada prueba
borra lo suyo (la auditoría es en memoria: `app.audit_log` no admite DELETE). Datos ficticios."""

from collections.abc import Iterator
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import in_transaction
from tests.inventory.inventory_helpers import release_reservations
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from tests.orders.orders_payment_helpers import (
    At,
    committed_world,
    confirm,
    db_now,
    expire_reservations_only,
    movements,
    set_expiry,
    total_of,
    use_cases,
)
from tests.orders.test_cancel_order_concurrency import (
    Result,
    cancel,
    overdue,
    placed,
    read_expiring,
    state,
)
from tests.orders.test_create_order_concurrency import World, create_order, key
from valmont.modules.orders.application import Clock, PaymentOutcome
from valmont.modules.orders.domain import OrderNotFound, OrderNotPayable, OrderStatus

pytestmark = pytest.mark.integration


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_world(db_engine)


PERSONAL = ("Ana", "Pérez", "987654321", "Larco", "Miraflores", "Frente al parque")
PAID_HISTORY = [("pendiente_pago", "customer"), ("pagado", "customer")]
EXPIRED_HISTORY = [("pendiente_pago", "customer"), ("expirado", "system")]


def pay(engine: Engine, user: UUID, order_id: UUID, clock: Clock | None = None) -> Result:
    return in_transaction(engine, confirm(user, order_id, clock))


def stock(world: World, *products: UUID) -> tuple[int, ...]:
    return tuple(world.on_hand(p) for p in products)


# --------------------------------------------------------------------------------------------
# CA-ORDERS-14 / 20 / 21: pagar un pendiente_pago vigente del dueño
def test_paying_consumes_the_reservations_and_drops_on_hand_once(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.PAID
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == ["consumed", "consumed"]
    assert stock(world, a, b) == (3, 4)  # baja en lo reservado, una sola vez
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)
    assert result.released == []  # pagar no libera


def test_paying_creates_one_sale_movement_per_reserved_line(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=7)
    user, order_id = placed(world, db_engine, (a, 2), (b, 3))

    pay(db_engine, user, order_id)

    by_delta = sorted(movements(db_engine, order_id), key=lambda m: m[1])
    assert by_delta == [("venta", -3, 4), ("venta", -2, 3)]
    assert state(db_engine, order_id)["sales"] == 2


def test_paying_leaves_one_customer_history_row_and_one_audit_entry(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))

    result = pay(db_engine, user, order_id)

    assert state(db_engine, order_id)["history"] == PAID_HISTORY  # CA-ORDERS-20
    with Session(db_engine) as session:
        actor = session.scalar(
            text(
                "SELECT actor_id FROM app.order_status_history"
                " WHERE order_id = :id AND to_status = 'pagado'"
            ),
            {"id": order_id},
        )
    assert actor == user
    [entry] = result.audit.entries
    assert entry.action == "orders.status_changed" and entry.entity_id == str(order_id)
    assert (entry.actor_id, entry.actor_role) == (user, "customer")
    assert entry.before["status"] == "pendiente_pago" and entry.after["status"] == "pagado"
    for personal in PERSONAL:
        assert personal not in repr(result.audit.entries), personal  # CA-ORDERS-21, R18


def test_paying_never_changes_the_amounts(world: World, db_engine: Engine) -> None:
    product = world.product(on_hand=5, price=123_450)
    user, order_id = placed(world, db_engine, (product, 3))
    before = total_of(db_engine, order_id)

    pay(db_engine, user, order_id)

    assert total_of(db_engine, order_id) == before and before[2] >= 123_450 * 3


def test_paying_one_order_does_not_touch_another_order_with_the_same_product(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    first_user, first = placed(world, db_engine, (product, 2))
    _, second = placed(world, db_engine, (product, 1))

    pay(db_engine, first_user, first)

    assert state(db_engine, second)["status"] == "pendiente_pago"
    assert state(db_engine, second)["reservations"] == ["active"]
    assert world.on_hand(product) == 3 and world.active_reservations(product) == 1
    assert state(db_engine, second)["sales"] == 0


def test_a_failure_after_confirming_rolls_everything_back_the_use_case_does_not_commit(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))

    def payment_then_failure(session: Session) -> None:
        use_case, _, _, _ = use_cases(session)
        assert use_case(user, order_id) == PaymentOutcome.PAID
        raise RuntimeError("payments falló después de confirmar el pedido")

    with pytest.raises(RuntimeError, match="payments"):
        in_transaction(db_engine, payment_then_failure)

    final = state(db_engine, order_id)  # R4: el caso de uso no hace commit
    assert final["status"] == "pendiente_pago" and final["paid_at"] is None
    assert final["reservations"] == ["active"] and final["sales"] == 0
    assert final["history"] == [("pendiente_pago", "customer")]
    assert world.on_hand(product) == 5


# --------------------------------------------------------------------------------------------
# CA-ORDERS-14 / RF05.03: repetir el pago
def test_repeating_the_payment_is_already_paid_with_no_effect(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    pay(db_engine, user, order_id)
    before, before_movements = state(db_engine, order_id), movements(db_engine, order_id)

    again = pay(db_engine, user, order_id)

    assert again.outcome == PaymentOutcome.ALREADY_PAID
    assert state(db_engine, order_id) == before  # mismo paid_at, historial y reservas
    assert movements(db_engine, order_id) == before_movements
    assert stock(world, a, b) == (3, 4)  # sin doble consumo
    assert again.released == [] and again.audit.entries == []  # sin doble auditoría


def test_repeating_the_payment_many_times_never_consumes_twice(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=9)
    user, order_id = placed(world, db_engine, (product, 4))

    outcomes = [pay(db_engine, user, order_id).outcome for _ in range(4)]

    assert outcomes == [PaymentOutcome.PAID] + [PaymentOutcome.ALREADY_PAID] * 3
    final = state(db_engine, order_id)
    assert final["history"] == PAID_HISTORY and final["sales"] == 1
    assert world.on_hand(product) == 5


@pytest.mark.parametrize(
    ("target", "pickup"),
    [
        ("en_preparacion", False),
        ("enviado", False),
        ("entregado", False),
        ("listo_para_recojo", True),
    ],
)
def test_every_state_after_paid_answers_already_paid_without_touching_anything(
    world: World, db_engine: Engine, target: str, pickup: bool
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 2))
    with Session(db_engine) as session, session.begin():
        order_id = create_order(session)(
            user, key(), pickup_delivery() if pickup else shipping_delivery()
        ).order.id
    pay(db_engine, user, order_id)
    with Session(db_engine) as session, session.begin():  # lo que hará el administrador
        session.execute(
            text("UPDATE app.orders SET status = :s WHERE id = :id"), {"s": target, "id": order_id}
        )
    sold_before = (state(db_engine, order_id)["sales"], world.on_hand(product))

    again = pay(db_engine, user, order_id)

    assert again.outcome == PaymentOutcome.ALREADY_PAID
    final = state(db_engine, order_id)
    assert final["status"] == target and (final["sales"], world.on_hand(product)) == sold_before
    assert final["history"] == PAID_HISTORY and again.audit.entries == []


# --------------------------------------------------------------------------------------------
# Bajo pedido y mixtos
def test_a_made_to_order_only_order_is_paid_without_consuming_stock(
    world: World, db_engine: Engine
) -> None:
    on_request = world.product(on_hand=None, policy="made_to_order")
    user, order_id = placed(world, db_engine, (on_request, 2))

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.PAID
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == [] and final["sales"] == 0  # nada que consumir
    assert final["history"] == PAID_HISTORY and len(result.audit.entries) == 1


def test_a_mixed_order_consumes_only_the_stocked_line(world: World, db_engine: Engine) -> None:
    stocked = world.product(on_hand=5)
    on_request = world.product(on_hand=None, policy="made_to_order")
    user, order_id = placed(world, db_engine, (stocked, 2), (on_request, 1))

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.PAID
    final = state(db_engine, order_id)
    assert final["status"] == "pagado"
    assert final["reservations"] == ["consumed"] and final["sales"] == 1
    assert world.on_hand(stocked) == 3
    assert movements(db_engine, order_id) == [("venta", -2, 3)]


# --------------------------------------------------------------------------------------------
# R6 / R7 / R16: vencido (también en el límite exacto) → EXPIRED, sin cobro ni consumo
def test_an_overdue_pending_order_is_expired_and_released_not_paid(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    overdue(db_engine, order_id)

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.EXPIRED  # la transacción terminó: se confirmó
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["paid_at"] is None
    assert final["history"] == EXPIRED_HISTORY  # una fila del sistema
    assert final["reservations"] == ["released", "released"] and final["sales"] == 0
    assert stock(world, a, b) == (5, 5)  # sin consumo
    assert (world.active_reservations(a), world.active_reservations(b)) == (0, 0)
    assert result.released == [order_id]
    [entry] = result.audit.entries
    assert entry.actor_id is None and entry.before["status"] == "pendiente_pago"
    assert entry.after["status"] == "expirado"


def test_the_exact_expiry_instant_expires_and_a_second_before_pays(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    late_user, late = placed(world, db_engine, (product, 1))
    early_user, early = placed(world, db_engine, (product, 2))
    moment = db_now(db_engine)
    set_expiry(db_engine, late, moment)  # expires_at == now
    set_expiry(db_engine, early, moment + timedelta(seconds=1))  # un segundo de margen

    expired = pay(db_engine, late_user, late, At(moment))
    paid = pay(db_engine, early_user, early, At(moment))

    assert expired.outcome == PaymentOutcome.EXPIRED
    assert state(db_engine, late)["status"] == "expirado" and state(db_engine, late)["sales"] == 0
    assert paid.outcome == PaymentOutcome.PAID
    assert state(db_engine, early)["status"] == "pagado"
    assert world.on_hand(product) == 3  # solo descontó el que pagó a tiempo
    assert world.active_reservations(product) == 0


def test_after_expiring_a_new_payment_is_not_payable_and_changes_nothing_more(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    overdue(db_engine, order_id)
    pay(db_engine, user, order_id)
    before = state(db_engine, order_id)

    again = pay(db_engine, user, order_id)

    assert (
        isinstance(again.outcome, OrderNotPayable) and again.outcome.status == OrderStatus.EXPIRED
    )
    assert state(db_engine, order_id) == before and again.audit.entries == []


# --------------------------------------------------------------------------------------------
# INVENTORY-R8 / R11: ReservationExpired → expira el pedido y devuelve EXPIRED
def test_expired_reservations_on_a_current_order_expire_it_without_charging(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))
    expire_reservations_only(db_engine, order_id)

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.EXPIRED
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["paid_at"] is None
    assert final["history"] == EXPIRED_HISTORY and final["sales"] == 0
    assert set(final["reservations"]) == {"released"} and stock(world, a, b) == (5, 5)
    assert [e.after["status"] for e in result.audit.entries] == ["expirado"]


def test_reservations_released_by_someone_else_make_the_payment_expire_the_order(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    with Session(db_engine) as session, session.begin():
        release_reservations(session)(order_id)

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.EXPIRED
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["sales"] == 0 and final["paid_at"] is None
    assert world.on_hand(product) == 5  # nunca se cobra sin reservas


def test_stock_that_no_longer_covers_the_reservations_expires_the_order_inventory_r11(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    with (
        Session(db_engine) as session,
        session.begin(),
    ):  # otra transacción ya dio por perdido el stock
        session.execute(
            text("UPDATE app.inventory_items SET on_hand = 1 WHERE product_id = :p"),
            {"p": product},
        )

    result = pay(db_engine, user, order_id)

    assert result.outcome == PaymentOutcome.EXPIRED
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["sales"] == 0 and final["paid_at"] is None
    assert world.on_hand(product) == 1  # no se descontó (ni quedó negativo)
    assert set(final["reservations"]) == {"released"}


# --------------------------------------------------------------------------------------------
# cancelado o expirado → OrderNotPayable, sin ningún efecto
def test_a_cancelled_order_is_not_payable_and_nothing_changes(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    in_transaction(db_engine, cancel(user, order_id))
    before = state(db_engine, order_id)

    result = pay(db_engine, user, order_id)

    assert isinstance(result.outcome, OrderNotPayable)
    assert result.outcome.status == OrderStatus.CANCELLED
    assert state(db_engine, order_id) == before and before["sales"] == 0
    assert world.on_hand(product) == 5 and result.audit.entries == [] and result.released == []


def test_an_already_materialized_expired_order_is_not_payable(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    overdue(db_engine, order_id)
    in_transaction(db_engine, read_expiring(user, order_id))  # una lectura lo caduca
    before = state(db_engine, order_id)

    result = pay(db_engine, user, order_id)

    assert isinstance(result.outcome, OrderNotPayable)
    assert result.outcome.status == OrderStatus.EXPIRED
    assert state(db_engine, order_id) == before and world.on_hand(product) == 5


def test_a_not_payable_rejection_leaves_the_transaction_clean_for_payments(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    in_transaction(db_engine, cancel(user, order_id))

    def raising(session: Session) -> None:
        use_case, _, _, _ = use_cases(session)
        use_case(user, order_id)

    with pytest.raises(OrderNotPayable):  # payments la captura y deshace
        in_transaction(db_engine, raising)

    assert state(db_engine, order_id)["status"] == "cancelado"


# --------------------------------------------------------------------------------------------
# CA-ORDERS-22 / R12: ajeno = inexistente
def test_a_foreign_order_cannot_be_paid_and_nothing_changes(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = placed(world, db_engine, (product, 2))
    intruder = world.user((product, 1))
    before = state(db_engine, order_id)

    result = pay(db_engine, intruder, order_id)

    assert isinstance(result.outcome, OrderNotFound)
    assert state(db_engine, order_id) == before and before["status"] == "pendiente_pago"
    assert before["reservations"] == ["active"] and world.on_hand(product) == 5
    assert result.audit.entries == [] and result.released == []


def test_a_foreign_overdue_order_is_not_expired_by_the_attempt(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = placed(world, db_engine, (product, 1))
    overdue(db_engine, order_id)
    intruder = world.user()

    result = pay(db_engine, intruder, order_id)

    assert isinstance(result.outcome, OrderNotFound)
    assert state(db_engine, order_id)["status"] == "pendiente_pago"  # nadie lo caducó


def test_a_missing_order_and_a_foreign_one_fail_the_same_way(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = placed(world, db_engine, (product, 1))
    intruder = world.user()

    foreign = pay(db_engine, intruder, order_id).outcome
    missing = pay(db_engine, intruder, UUID(int=1)).outcome

    assert type(foreign) is type(missing) is OrderNotFound
    assert str(foreign) == str(missing)


# --------------------------------------------------------------------------------------------
# GetPayableOrder (CA-ORDERS-14, 22) con la BD real
def test_the_payable_order_matches_the_row_of_the_own_order(
    world: World, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=5, price=250_000), world.product(on_hand=5, price=99_900)
    user, order_id = placed(world, db_engine, (a, 2), (b, 1))

    with Session(db_engine) as session:
        _, payable_case, _, _ = use_cases(session)
        payable = payable_case(user, order_id)
        row = session.execute(
            text("SELECT order_number, total_amount, expires_at FROM app.orders WHERE id = :id"),
            {"id": order_id},
        ).one()

    assert payable.order_id == order_id and payable.status == OrderStatus.PENDING_PAYMENT
    assert payable.total_amount == row.total_amount >= 250_000 * 2 + 99_900
    assert payable.expires_at == row.expires_at
    assert payable.number == f"VAL-{row.order_number:06d}"


def test_the_payable_read_of_an_overdue_order_materializes_the_expiry(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    overdue(db_engine, order_id)

    def read(session: Session) -> OrderStatus:
        _, payable_case, release, _ = use_cases(session)
        status = payable_case(user, order_id).status
        assert release.released == [order_id]
        return status

    assert in_transaction(db_engine, read) == OrderStatus.EXPIRED
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["history"] == EXPIRED_HISTORY
    assert final["reservations"] == ["released"]


@pytest.mark.parametrize("status", ["pagado", "cancelado"])
def test_the_payable_read_reports_any_state_so_payments_decides(
    world: World, db_engine: Engine, status: str
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    if status == "pagado":
        pay(db_engine, user, order_id)
    else:
        in_transaction(db_engine, cancel(user, order_id))

    with Session(db_engine) as session:
        _, payable_case, _, _ = use_cases(session)
        assert payable_case(user, order_id).status.value == status


def test_the_payable_read_of_a_foreign_order_is_order_not_found_and_expires_nothing(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    _, order_id = placed(world, db_engine, (product, 1))
    overdue(db_engine, order_id)
    intruder = world.user()

    def read(session: Session) -> None:
        _, payable_case, _, _ = use_cases(session)
        payable_case(intruder, order_id)

    with pytest.raises(OrderNotFound):
        in_transaction(db_engine, read)
    assert state(db_engine, order_id)["status"] == "pendiente_pago"


def test_payments_flow_read_then_confirm_in_one_transaction_keeps_the_charged_total(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5, price=180_000)
    user, order_id = placed(world, db_engine, (product, 2))

    def flow(session: Session) -> tuple[int, PaymentOutcome]:
        confirm_case, payable_case, _, _ = use_cases(session)
        to_charge = payable_case(user, order_id).total_amount
        return to_charge, confirm_case(user, order_id)

    charged, outcome = in_transaction(db_engine, flow)

    assert outcome == PaymentOutcome.PAID
    assert charged == total_of(db_engine, order_id)[2]  # el importe sale del pedido, no del cliente
