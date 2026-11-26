"""Datos de prueba de promotions. Ficticios; productos y categorías se insertan por SQL porque
promotions no usa el código de catalog. Las vigencias se dan en segundos respecto de now() de la
transacción de la BD, la misma fuente que usa la vista (R3)."""

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import event, text
from sqlalchemy.orm import Session

from valmont.modules.promotions.adapters.persistence import SqlEffectivePriceReader
from valmont.modules.promotions.application import EffectivePrice

HOUR = 3600


def add_category(session: Session, *, is_active: bool = True) -> UUID:
    category_id, tag = uuid4(), uuid4().hex[:8]
    session.execute(
        text(
            "INSERT INTO app.categories (id, slug, name, is_active)"
            " VALUES (:id, :slug, 'Promociones', :active)"
        ),
        {"id": category_id, "slug": f"promociones-{tag}", "active": is_active},
    )
    return category_id


def add_product(
    session: Session,
    price: int = 100000,
    *,
    category_id: UUID | None = None,
    status: str = "draft",
) -> UUID:
    """Producto mínimo en app.products; sin category_id crea su propia categoría."""
    product_id, tag = uuid4(), uuid4().hex[:8]
    category_id = category_id or add_category(session)
    session.execute(
        text(
            "INSERT INTO app.products (id, sku, slug, name, description, category_id,"
            " price_cents, status) VALUES (:id, :sku, :slug, 'Reloj de prueba',"
            " 'Reloj ficticio.', :category, :price, :status)"
        ),
        {
            "id": product_id,
            "sku": f"TST-PRM-{tag}",
            "slug": f"promociones-{tag}",
            "category": category_id,
            "price": price,
            "status": status,
        },
    )
    return product_id


def add_promotion(
    session: Session,
    *,
    kind: str = "percent",
    value: int = 10,
    scope: str = "catalog",
    category_id: UUID | None = None,
    product_ids: Iterable[UUID] = (),
    starts: int = -HOUR,
    ends: int = HOUR,
    is_active: bool = True,
    id: UUID | None = None,
) -> UUID:
    """Promoción por SQL; `starts` y `ends` en segundos desde now() (0 = exactamente now())."""
    promotion_id = id or uuid4()
    session.execute(
        text(
            "INSERT INTO app.promotions (id, name, kind, percent_off, amount_off_cents, scope,"
            " category_id, starts_at, ends_at, is_active) VALUES (:id, 'Promoción de prueba',"
            " :kind, :percent, :amount, :scope, :category,"
            " now() + make_interval(secs => CAST(:starts AS double precision)),"
            " now() + make_interval(secs => CAST(:ends AS double precision)), :active)"
        ),
        {
            "id": promotion_id,
            "kind": kind,
            "percent": value if kind == "percent" else None,
            "amount": value if kind == "fixed_amount" else None,
            "scope": scope,
            "category": category_id,
            "starts": starts,
            "ends": ends,
            "active": is_active,
        },
    )
    for product_id in product_ids:
        session.execute(
            text(
                "INSERT INTO app.promotion_products (promotion_id, product_id)"
                " VALUES (:promotion, :product)"
            ),
            {"promotion": promotion_id, "product": product_id},
        )
    return promotion_id


def effective(session: Session, product_id: UUID) -> EffectivePrice:
    [row] = SqlEffectivePriceReader(session).get_many([product_id])
    return row


def view_row(session: Session, product_id: UUID) -> tuple[Any, ...]:
    """La fila cruda de la vista (nombres de columna de la SPEC §6)."""
    return session.execute(
        text(
            "SELECT product_id, list_price_cents, effective_price_cents, discount_amount_cents,"
            " promotion_id FROM app.product_effective_price WHERE product_id = :id"
        ),
        {"id": product_id},
    ).one()


@contextmanager
def captured(session: Session) -> Iterator[list[str]]:
    """Las sentencias SQL que la sesión envía dentro del bloque."""
    connection = session.connection()
    statements: list[str] = []

    def capture(*args: Any) -> None:
        statements.append(args[2])

    event.listen(connection, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(connection, "before_cursor_execute", capture)
