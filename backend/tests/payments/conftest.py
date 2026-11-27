"""Fixture de las pruebas de payments con la BD: datos confirmados para las pruebas con dos
conexiones. Cada prueba borra al final lo suyo (los intentos primero: sus FK son RESTRICT)."""

from collections.abc import Iterator
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.payments.payments_db_helpers import Factory, user_with_order


@pytest.fixture
def committed_orders(db_engine: Engine) -> Iterator[Factory]:
    """Confirma `count` pares (perfil, pedido suyo); al final borra intentos, pedidos y perfiles."""
    users: list[UUID] = []
    orders: list[UUID] = []

    def create(count: int = 1) -> list[tuple[UUID, UUID]]:
        made: list[tuple[UUID, UUID]] = []
        with Session(db_engine) as session, session.begin():
            for _ in range(count):
                user, order = user_with_order(session)
                users.append(user)
                orders.append(order)
                made.append((user, order))
        return made

    yield create
    with Session(db_engine) as session, session.begin():
        params = {"orders": orders, "users": users}
        session.execute(
            text(
                "DELETE FROM app.payment_attempts"
                " WHERE order_id = ANY(:orders) OR user_id = ANY(:users)"
            ),
            params,
        )
        session.execute(text("DELETE FROM app.orders WHERE id = ANY(:orders)"), params)
        session.execute(text("DELETE FROM app.profiles WHERE user_id = ANY(:users)"), params)
