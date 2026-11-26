from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    UniqueConstraint,
    delete,
    func,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.cart.domain import Cart, CartItem
from valmont.shared.db import Base
from valmont.shared.product_snapshots import SqlProductSnapshots

# SPEC cart §6. Solo las escribe cart; app.profiles y app.products son de identity y catalog y
# aquí solo se referencian con FK (modules.md §3, excepción 6).


class InvalidReference(Exception):
    """El producto no existe (FK); `field` es el campo del cuerpo."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


_PRODUCT_FK = "fk_cart_items_product_id_products"


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class CartRow(Base):
    __tablename__ = "carts"
    __table_args__ = (UniqueConstraint("user_id"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("app.profiles.user_id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class CartItemRow(Base):
    __tablename__ = "cart_items"
    __table_args__ = (
        CheckConstraint("quantity BETWEEN 1 AND 100", name="quantity"),
        UniqueConstraint("cart_id", "product_id", name="uq_cart_items_cart_id_product_id"),
        Index("ix_cart_items_product_id", "product_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    cart_id: Mapped[UUID] = mapped_column(ForeignKey("app.carts.id", ondelete="CASCADE"))
    product_id: Mapped[UUID] = mapped_column(ForeignKey("app.products.id", ondelete="RESTRICT"))
    quantity: Mapped[int] = mapped_column(SmallInteger)
    selected: Mapped[bool] = mapped_column(server_default=true())
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class SqlCartRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def lock_for_user(self, user_id: UUID) -> Cart:
        # R1: ON CONFLICT espera a quien esté creando el carrito; después, FOR UPDATE.
        self._session.execute(
            pg_insert(CartRow)
            .values(id=uuid4(), user_id=user_id)
            .on_conflict_do_nothing(index_elements=["user_id"])
        )
        row = self._session.execute(
            select(CartRow).filter_by(user_id=user_id).with_for_update()
        ).scalar_one()
        return self._load(row)

    def find_for_user(self, user_id: UUID) -> Cart | None:
        stmt = select(CartRow).filter_by(user_id=user_id)
        row = self._session.execute(stmt).scalar_one_or_none()
        return None if row is None else self._load(row)

    def _load(self, row: CartRow) -> Cart:
        stmt = (
            select(CartItemRow)
            .filter_by(cart_id=row.id)
            .order_by(CartItemRow.created_at, CartItemRow.product_id)  # R15
        )
        items = tuple(
            CartItem(i.product_id, i.quantity, i.selected, i.created_at)
            for i in self._session.scalars(stmt)
        )
        return Cart(row.id, row.user_id, items)

    def save(self, cart: Cart) -> None:
        kept = [i.product_id for i in cart.items]
        try:
            self._session.execute(
                delete(CartItemRow).where(
                    CartItemRow.cart_id == cart.id, CartItemRow.product_id.not_in(kept)
                )
            )
            if cart.items:
                insert = pg_insert(CartItemRow).values(
                    [
                        {
                            "id": uuid4(),
                            "cart_id": cart.id,
                            "product_id": i.product_id,
                            "quantity": i.quantity,
                            "selected": i.selected,
                            "created_at": i.created_at,
                        }
                        for i in cart.items
                    ]
                )
                self._session.execute(
                    insert.on_conflict_do_update(
                        index_elements=["cart_id", "product_id"],
                        set_={
                            "quantity": insert.excluded.quantity,
                            "selected": insert.excluded.selected,
                            "updated_at": func.now(),
                        },
                        where=(CartItemRow.quantity != insert.excluded.quantity)
                        | (CartItemRow.selected != insert.excluded.selected),
                    )
                )
        except IntegrityError as exc:
            constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
            if constraint == _PRODUCT_FK:
                raise InvalidReference("product_id") from exc
            raise
        stmt = update(CartRow).where(CartRow.id == cart.id).values(updated_at=func.now())
        self._session.execute(stmt)


# Lectura de productos: lector compartido (D-039.4); el nombre se conserva para cart.
SqlCartCatalog = SqlProductSnapshots
