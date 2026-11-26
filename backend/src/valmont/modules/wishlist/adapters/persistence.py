from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Index, UniqueConstraint, delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.wishlist.application import WishlistEntry
from valmont.shared.db import Base

# SPEC wishlist §6. app.profiles y app.products son de identity y catalog: solo FK.


class InvalidReference(Exception):
    """El producto no existe (FK); `field` es el campo del cuerpo."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


_PRODUCT_FK = "fk_wishlist_items_product_id_products"


class WishlistItemRow(Base):
    __tablename__ = "wishlist_items"
    __table_args__ = (
        UniqueConstraint("user_id", "product_id", name="uq_wishlist_items_user_id_product_id"),
        Index("ix_wishlist_items_product_id", "product_id"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("app.profiles.user_id", ondelete="CASCADE"))
    product_id: Mapped[UUID] = mapped_column(ForeignKey("app.products.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SqlWishlistRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def list_for_user(self, user_id: UUID) -> tuple[WishlistEntry, ...]:
        stmt = (
            select(WishlistItemRow.product_id, WishlistItemRow.created_at)
            .where(WishlistItemRow.user_id == user_id)
            .order_by(WishlistItemRow.created_at.desc(), WishlistItemRow.product_id)  # R8
        )
        return tuple(WishlistEntry(r[0], r[1]) for r in self._session.execute(stmt))

    def add(self, user_id: UUID, product_id: UUID, now: datetime) -> bool:
        stmt = (
            pg_insert(WishlistItemRow)
            .values(id=uuid4(), user_id=user_id, product_id=product_id, created_at=now)
            .on_conflict_do_nothing(index_elements=["user_id", "product_id"])
            .returning(WishlistItemRow.id)
        )
        try:
            return self._session.execute(stmt).first() is not None
        except IntegrityError as exc:
            constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
            if constraint == _PRODUCT_FK:
                raise InvalidReference("product_id") from exc
            raise

    def remove(self, user_id: UUID, product_id: UUID) -> bool:
        stmt = delete(WishlistItemRow).where(
            WishlistItemRow.user_id == user_id, WishlistItemRow.product_id == product_id
        )
        return self._session.execute(stmt).rowcount == 1
