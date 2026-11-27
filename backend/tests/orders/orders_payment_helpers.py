"""Ayudantes de las pruebas de integración y de concurrencia del puerto de pago (T-077): el mundo
de datos confirmados, `ConfirmOrderPayment` y `GetPayableOrder` con los adaptadores reales (solo la
auditoría es en memoria) y lo que se mira en la BD tras cada prueba. Reutilizan los de T-074 y
T-076. Los datos se confirman: cada prueba borra lo suyo, incluidos los movimientos `venta`.
Datos ficticios."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.inventory.inventory_helpers import consume_reservations
from tests.orders.orders_create_helpers import Calls, FakeAudit
from tests.orders.test_cancel_order_concurrency import CountingRelease, Result
from tests.orders.test_create_order_concurrency import World
from valmont.modules.inventory.adapters.persistence import SqlReservationRepository
from valmont.modules.inventory.application import ReleaseReservations
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import (
    Clock,
    ConfirmOrderPayment,
    ExpireOverdueOrders,
    GetPayableOrder,
)
from valmont.modules.orders.domain import OrderNotFound, OrderNotPayable


def committed_world(db_engine: Engine) -> Iterator[World]:
    """Cuerpo del fixture `world` de cada módulo (un fixture importado chocaría con el lint)."""
    made = World(db_engine)
    yield made
    with Session(db_engine) as session, session.begin():  # los movimientos `venta` del pago
        session.execute(
            text("DELETE FROM app.stock_movements WHERE product_id = ANY(:p)"),
            {"p": made.products},
        )
    made.cleanup()


@dataclass
class At:
    """Un reloj fijo (la hora de la BD tomada antes): `expires_at == now` exacto."""

    moment: datetime

    def now(self) -> datetime:
        return self.moment


def db_now(engine: Engine) -> datetime:
    with Session(engine) as session:
        return session.execute(text("SELECT clock_timestamp()")).scalar_one()


def use_cases(
    session: Session, clock: Clock | None = None
) -> tuple[ConfirmOrderPayment, GetPayableOrder, CountingRelease, FakeAudit]:
    orders, real_clock = SqlOrderRepository(session), SqlClock(session)
    release = CountingRelease(ReleaseReservations(SqlReservationRepository(session)))
    audit = FakeAudit(Calls())
    expire = ExpireOverdueOrders(orders, release, audit, real_clock)  # type: ignore[arg-type]
    confirm = ConfirmOrderPayment(
        orders,
        consume_reservations(session),
        release,
        audit,  # type: ignore[arg-type]
        clock or real_clock,
    )
    return confirm, GetPayableOrder(orders, expire), release, audit  # type: ignore[arg-type]


def confirm(user: UUID, order_id: UUID, clock: Clock | None = None) -> Callable[[Session], Result]:
    """Un pago. Devuelve el error de negocio (`OrderNotPayable`, `OrderNotFound`) en vez de
    lanzarlo, para que la transacción termine y la carrera se pueda observar; cualquier otro error
    (un interbloqueo, un 500) se propaga."""

    def work(session: Session) -> Result:
        use_case, _, release, audit = use_cases(session, clock)
        try:
            outcome: object = use_case(user, order_id)
        except (OrderNotPayable, OrderNotFound) as error:
            outcome = error
        return Result(outcome, release.released, audit)  # type: ignore[arg-type]

    return work


def set_expiry(engine: Engine, order_id: UUID, expires_at: datetime) -> None:
    """Pedido y reservas con el mismo vencimiento (R6); `created_at` coherente con el CHECK."""
    with Session(engine) as session, session.begin():
        session.execute(
            text("UPDATE app.orders SET created_at = :c, expires_at = :e WHERE id = :id"),
            {"id": order_id, "c": expires_at - timedelta(minutes=30), "e": expires_at},
        )
        session.execute(
            text("UPDATE app.stock_reservations SET expires_at = :e WHERE order_id = :id"),
            {"id": order_id, "e": expires_at},
        )


def expire_reservations_only(engine: Engine, order_id: UUID) -> None:
    """Las reservas vencidas y el pedido aún vigente (lo que INVENTORY-R8 debe detectar)."""
    with Session(engine) as session, session.begin():
        session.execute(
            text(
                "UPDATE app.stock_reservations SET expires_at = now() - interval '1 minute'"
                " WHERE order_id = :id"
            ),
            {"id": order_id},
        )


def movements(engine: Engine, order_id: UUID) -> list[tuple[str, int, int]]:
    """(kind, quantity_delta, on_hand_after) de los movimientos del pedido, por producto."""
    with Session(engine) as session:
        rows = session.execute(
            text(
                "SELECT kind, quantity_delta, on_hand_after FROM app.stock_movements"
                " WHERE order_id = :id ORDER BY product_id"
            ),
            {"id": order_id},
        ).all()
    return sorted(tuple(r) for r in rows)  # type: ignore[arg-type]


def total_of(engine: Engine, order_id: UUID) -> tuple[int, int, int]:
    with Session(engine) as session:
        row = session.execute(
            text(
                "SELECT subtotal_amount, shipping_amount, total_amount FROM app.orders"
                " WHERE id = :id"
            ),
            {"id": order_id},
        ).one()
    return tuple(row)  # type: ignore[return-value]
