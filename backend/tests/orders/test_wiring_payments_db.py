"""Proveedores de orders para payments contra la BD de pruebas (T-091; SPEC de payments §8,
R-13, CA-PAYMENTS-18 parte de orders). Cada proveedor se llama con la sesión de la prueba y se
comprueba que el caso de uso construido hace lo mismo que el armado a mano. Datos ficticios; la
transacción de cada prueba se deshace, así que nada se confirma: que el caso de uso vea los datos
demuestra que corre en la sesión recibida."""

import inspect
from collections.abc import Iterator
from dataclasses import replace
from datetime import datetime
from typing import Annotated, get_args, get_type_hints
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed
from tests.inventory.inventory_helpers import consume_reservations, release_reservations
from tests.orders.orders_db_helpers import new_order, real_line
from tests.orders.orders_helpers import make_line
from valmont.modules.audit.adapters.http import AuditRecorderDep, get_audit_recorder
from valmont.modules.audit.adapters.persistence import SqlAuditRecorder
from valmont.modules.inventory.adapters.persistence import SqlReservationRepository
from valmont.modules.inventory.adapters.wiring import (
    get_consume_reservations,
    get_release_reservations,
    get_reserve_stock,
)
from valmont.modules.inventory.application import (
    ConsumeReservations,
    ReleaseReservations,
)
from valmont.modules.inventory.application import OrderLine as StockLine
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.adapters.wiring import get_confirm_order_payment, get_get_payable_order
from valmont.modules.orders.application import (
    ConfirmOrderPayment,
    ExpireOverdueOrders,
    GetPayableOrder,
    PayableOrder,
    PaymentOutcome,
)
from valmont.modules.orders.domain import OrderNotFound, OrderStatus
from valmont.shared.db import SessionDep, get_session

pytestmark = pytest.mark.integration


def db_now(session: Session) -> datetime:
    return session.scalars(select(func.now())).one()


def confirm_by_wiring(session: Session) -> ConfirmOrderPayment:
    return get_confirm_order_payment(
        session,
        get_consume_reservations(session),
        get_release_reservations(session),
        get_audit_recorder(session),
    )


def payable_by_wiring(session: Session) -> GetPayableOrder:
    return get_get_payable_order(
        session, get_release_reservations(session), get_audit_recorder(session)
    )


def confirm_by_hand(session: Session) -> ConfirmOrderPayment:
    return ConfirmOrderPayment(
        SqlOrderRepository(session),
        consume_reservations(session),
        release_reservations(session),
        SqlAuditRecorder(session),
        SqlClock(session),
    )


def payable_by_hand(session: Session) -> GetPayableOrder:
    orders = SqlOrderRepository(session)
    expire = ExpireOverdueOrders(
        orders, release_reservations(session), SqlAuditRecorder(session), SqlClock(session)
    )
    return GetPayableOrder(orders, expire)


def placed(session: Session, *, quantity: int = 2, on_hand: int = 5) -> tuple[UUID, UUID, UUID]:
    """Pedido `pendiente_pago` con su reserva activa: (usuario, pedido, producto)."""
    product = add_listed(session, on_hand=on_hand)
    now = db_now(session)
    line = replace(make_line(quantity=quantity), product_id=product)
    order = SqlOrderRepository(session).add(new_order(session, lines=[line], now=now))
    get_reserve_stock(session)(order.id, [StockLine(product, quantity)], now)
    return order.user_id, order.id, product


def stock_on_hand(session: Session, product_id: UUID) -> int:
    return session.scalar(
        text("SELECT on_hand FROM app.inventory_items WHERE product_id = :p"), {"p": product_id}
    )


def reservation_statuses(session: Session, order_id: UUID) -> list[str]:
    return [str(r.status) for r in SqlReservationRepository(session).for_order(order_id)]


def order_status(session: Session, order_id: UUID) -> str:
    return session.scalar(text("SELECT status FROM app.orders WHERE id = :id"), {"id": order_id})


# --- forma de los proveedores --------------------------------------------------------------


def test_get_get_payable_order_signature_is_session_release_and_audit() -> None:
    assert list(inspect.signature(get_get_payable_order).parameters) == [
        "session",
        "release",
        "audit",
    ]
    hints = get_type_hints(get_get_payable_order, include_extras=True)
    assert hints["session"] == SessionDep
    assert hints["audit"] == AuditRecorderDep
    release_type, release_dep = get_args(hints["release"])[:2]
    assert release_type is ReleaseReservations
    assert release_dep.dependency is get_release_reservations
    assert hints["return"] is GetPayableOrder


def test_get_confirm_order_payment_signature_is_session_consume_release_and_audit() -> None:
    assert list(inspect.signature(get_confirm_order_payment).parameters) == [
        "session",
        "consume",
        "release",
        "audit",
    ]
    hints = get_type_hints(get_confirm_order_payment, include_extras=True)
    assert hints["session"] == SessionDep
    assert hints["audit"] == AuditRecorderDep
    consume_type, consume_dep = get_args(hints["consume"])[:2]
    release_type, release_dep = get_args(hints["release"])[:2]
    assert consume_type is ConsumeReservations
    assert consume_dep.dependency is get_consume_reservations
    assert release_type is ReleaseReservations
    assert release_dep.dependency is get_release_reservations
    assert hints["return"] is ConfirmOrderPayment


def test_the_providers_build_the_real_use_cases(db_session: Session) -> None:
    assert isinstance(payable_by_wiring(db_session), GetPayableOrder)
    assert isinstance(confirm_by_wiring(db_session), ConfirmOrderPayment)


def test_each_call_builds_a_fresh_use_case(db_session: Session) -> None:
    assert payable_by_wiring(db_session) is not payable_by_wiring(db_session)
    assert confirm_by_wiring(db_session) is not confirm_by_wiring(db_session)


def test_the_providers_do_not_commit(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    # Corren en la transacción de payments (SPEC §8): ni el proveedor ni el caso de uso confirman.
    def forbidden(*_: object) -> None:
        raise AssertionError("un proveedor o su caso de uso hizo commit")

    user, order_id, _ = placed(db_session)
    monkeypatch.setattr(db_session, "commit", forbidden)

    payable_by_wiring(db_session)(user, order_id)
    confirm_by_wiring(db_session)(user, order_id)


def test_the_providers_work_as_fastapi_dependencies_with_the_request_session(
    db_session: Session,
) -> None:
    user, order_id, product = placed(db_session, quantity=2, on_hand=5)
    app = FastAPI()

    @app.get("/probe")
    def probe(
        payable: Annotated[GetPayableOrder, Depends(get_get_payable_order)],
        confirm: Annotated[ConfirmOrderPayment, Depends(get_confirm_order_payment)],
    ) -> dict[str, object]:
        amount = payable(user, order_id).total_amount
        outcome = confirm(user, order_id)
        return {"amount": amount, "outcome": str(outcome)}

    def request_session() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_session] = request_session

    response = TestClient(app).get("/probe")

    assert response.status_code == 200, response.text
    assert response.json() == {"amount": 200000, "outcome": "paid"}
    assert stock_on_hand(db_session, product) == 3  # misma sesión: el pago consumió la reserva


# --- comportamiento igual al armado a mano -------------------------------------------------


def test_get_payable_order_returns_the_amount_and_state_of_the_real_order(
    db_session: Session,
) -> None:
    user, order_id, _ = placed(db_session, quantity=3)

    via_wiring = payable_by_wiring(db_session)(user, order_id)
    by_hand = payable_by_hand(db_session)(user, order_id)

    assert isinstance(via_wiring, PayableOrder)
    assert via_wiring == by_hand
    assert via_wiring.order_id == order_id
    assert via_wiring.status == OrderStatus.PENDING_PAYMENT
    assert via_wiring.total_amount == 3 * 100_000


def test_get_payable_order_hides_orders_of_other_customers(db_session: Session) -> None:
    _, order_id, _ = placed(db_session)
    stranger = new_order(db_session).user_id

    with pytest.raises(OrderNotFound):
        payable_by_wiring(db_session)(stranger, order_id)
    with pytest.raises(OrderNotFound):
        payable_by_wiring(db_session)(stranger, uuid4())


def test_paying_through_wiring_consumes_the_reservations_like_the_hand_built_use_case(
    db_session: Session,
) -> None:
    wired_user, wired_order, wired_product = placed(db_session, quantity=2, on_hand=5)
    hand_user, hand_order, hand_product = placed(db_session, quantity=2, on_hand=5)

    wired = confirm_by_wiring(db_session)(wired_user, wired_order)
    by_hand = confirm_by_hand(db_session)(hand_user, hand_order)

    assert wired == by_hand == PaymentOutcome.PAID
    assert order_status(db_session, wired_order) == order_status(db_session, hand_order) == "pagado"
    assert reservation_statuses(db_session, wired_order) == ["consumed"]
    assert reservation_statuses(db_session, hand_order) == ["consumed"]
    assert stock_on_hand(db_session, wired_product) == stock_on_hand(db_session, hand_product) == 3


def test_paying_twice_through_wiring_is_idempotent(db_session: Session) -> None:
    user, order_id, product = placed(db_session, quantity=2, on_hand=5)
    confirm = confirm_by_wiring(db_session)

    assert confirm(user, order_id) == PaymentOutcome.PAID
    assert confirm(user, order_id) == PaymentOutcome.ALREADY_PAID
    assert stock_on_hand(db_session, product) == 3  # una sola baja


def test_paying_an_order_of_another_customer_fails_without_effects(db_session: Session) -> None:
    _, order_id, product = placed(db_session, quantity=2, on_hand=5)
    stranger = new_order(db_session, lines=[real_line(db_session)]).user_id

    with pytest.raises(OrderNotFound):
        confirm_by_wiring(db_session)(stranger, order_id)

    assert order_status(db_session, order_id) == "pendiente_pago"
    assert reservation_statuses(db_session, order_id) == ["active"]
    assert stock_on_hand(db_session, product) == 5


def test_an_overdue_order_is_expired_by_the_wired_payable_provider(db_session: Session) -> None:
    # R16: GetPayableOrder vence el pedido y libera sus reservas con la misma sesión.
    user, order_id, product = placed(db_session, quantity=2, on_hand=5)
    db_session.execute(
        text(
            "UPDATE app.orders SET created_at = now() - interval '2 hours',"
            " expires_at = now() - interval '90 minutes' WHERE id = :id"
        ),
        {"id": order_id},
    )

    payable = payable_by_wiring(db_session)(user, order_id)

    assert payable.status == OrderStatus.EXPIRED
    assert order_status(db_session, order_id) == "expirado"
    assert reservation_statuses(db_session, order_id) == ["released"]
    assert stock_on_hand(db_session, product) == 5
