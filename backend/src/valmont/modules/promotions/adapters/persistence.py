from collections import defaultdict
from collections.abc import Collection
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ColumnElement,
    DateTime,
    Executable,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Select,
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    and_,
    column,
    delete,
    func,
    insert,
    select,
    table,
    text,
    true,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.promotions.application import EffectivePrice
from valmont.modules.promotions.domain import (
    Promotion,
    PromotionKind,
    PromotionScope,
    PromotionStatus,
)
from valmont.shared.db import Base

# Tablas de la SPEC promotions §6. Solo las escribe promotions. app.products y app.categories
# son de catalog: aquí solo se referencian con FK (modules.md §3, excepción 5 propuesta).


class InvalidReference(Exception):
    """Un producto o la categoría no existen (FK); `field` es el campo del cuerpo."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


# FK violada → campo de la referencia inexistente (422 en ese campo, nunca un 500).
_REFERENCE_FIELDS = {
    "fk_promotion_products_product_id_products": "product_ids",
    "fk_promotions_category_id_categories": "category_id",
}

# Contrato de lectura para catalog y cart/orders (migración 0007). Fuera de Base.metadata: es
# una vista, y autogenerate la tomaría por una tabla que falta.
_effective_price = table(
    "product_effective_price",
    column("product_id", Uuid),
    column("list_price_cents", Integer),
    column("effective_price_cents", Integer),
    column("discount_amount_cents", Integer),
    column("promotion_id", Uuid),
    schema="app",
)


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class PromotionRow(Base):
    __tablename__ = "promotions"
    __table_args__ = (
        CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="name_length"),
        CheckConstraint("kind IN ('percent', 'fixed_amount')", name="kind"),
        CheckConstraint(
            "(kind = 'percent' AND percent_off IS NOT NULL AND percent_off BETWEEN 1 AND 90 "
            "AND amount_off_cents IS NULL) "
            "OR (kind = 'fixed_amount' AND amount_off_cents IS NOT NULL AND amount_off_cents >= 1 "
            "AND percent_off IS NULL)",
            name="value",
        ),
        CheckConstraint("scope IN ('products', 'category', 'catalog')", name="scope"),
        CheckConstraint("(scope = 'category') = (category_id IS NOT NULL)", name="category_scope"),
        CheckConstraint("ends_at > starts_at", name="dates"),
        UniqueConstraint("id", "scope"),  # destino de la FK compuesta de promotion_products
        Index("ix_promotions_is_active_starts_at_ends_at", "is_active", "starts_at", "ends_at"),
        Index(
            "ix_promotions_category_id",
            "category_id",
            postgresql_where=text("category_id IS NOT NULL"),
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    percent_off: Mapped[int | None] = mapped_column(SmallInteger)
    amount_off_cents: Mapped[int | None]
    scope: Mapped[str] = mapped_column(Text)
    category_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("app.categories.id", ondelete="RESTRICT")
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(server_default=true())
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class PromotionProductRow(Base):
    __tablename__ = "promotion_products"
    __table_args__ = (
        CheckConstraint("scope = 'products'", name="scope"),
        # Solo una promoción de alcance products puede tener filas aquí.
        ForeignKeyConstraint(
            ["promotion_id", "scope"],
            ["app.promotions.id", "app.promotions.scope"],
            ondelete="CASCADE",
        ),
        Index("ix_promotion_products_product_id", "product_id"),
    )

    promotion_id: Mapped[UUID] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(Text, server_default="products")
    product_id: Mapped[UUID] = mapped_column(
        ForeignKey("app.products.id", ondelete="RESTRICT"), primary_key=True
    )


def _write(session: Session, stmt: Executable) -> None:
    # Las referencias las decide la BD (modules.md §4.8): sin "¿existe?" previo.
    try:
        session.execute(stmt)
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if field := _REFERENCE_FIELDS.get(constraint):
            raise InvalidReference(field) from exc
        raise


def _values(promotion: Promotion) -> dict[str, object]:
    return {
        "name": promotion.name,
        "kind": promotion.kind,
        "percent_off": promotion.percent_off,
        "amount_off_cents": promotion.amount_off,
        "scope": promotion.scope,
        "category_id": promotion.category_id,
        "starts_at": promotion.starts_at,
        "ends_at": promotion.ends_at,
        "is_active": promotion.is_active,
    }


def _promotion(row: PromotionRow, product_ids: tuple[UUID, ...]) -> Promotion:
    return Promotion(
        id=row.id,
        name=row.name,
        kind=PromotionKind(row.kind),
        percent_off=row.percent_off,
        amount_off=row.amount_off_cents,
        scope=PromotionScope(row.scope),
        category_id=row.category_id,
        product_ids=product_ids,
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        is_active=row.is_active,
    )


class SqlPromotionRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, promotion: Promotion) -> None:
        _write(self._session, insert(PromotionRow).values(id=promotion.id, **_values(promotion)))
        self._insert_products(promotion)

    def get(self, promotion_id: UUID) -> Promotion | None:
        return self._load(select(PromotionRow).filter_by(id=promotion_id))

    def lock(self, promotion_id: UUID) -> Promotion | None:
        return self._load(select(PromotionRow).filter_by(id=promotion_id).with_for_update())

    def update(self, promotion: Promotion) -> None:
        # Las filas de productos se borran antes de cambiar el alcance (la FK compuesta lo
        # impide con filas presentes) y se reinsertan después (R14).
        self._session.execute(
            delete(PromotionProductRow).where(PromotionProductRow.promotion_id == promotion.id)
        )
        stmt = (
            update(PromotionRow)
            .filter_by(id=promotion.id)
            .values(**_values(promotion), updated_at=func.now())
        )
        _write(self._session, stmt.execution_options(synchronize_session=False))
        self._insert_products(promotion)

    def list(
        self,
        status: PromotionStatus | None,
        scope: PromotionScope | None,
        now: datetime,
        page: int,
        page_size: int,
    ) -> tuple[list[Promotion], int]:
        conditions: list[ColumnElement[bool]] = []
        r = PromotionRow
        if status is not None:
            conditions.append(
                {
                    PromotionStatus.INACTIVE: r.is_active.is_(False),
                    PromotionStatus.SCHEDULED: and_(r.is_active, now < r.starts_at),
                    PromotionStatus.ACTIVE: and_(r.is_active, r.starts_at <= now, now < r.ends_at),
                    PromotionStatus.EXPIRED: and_(r.is_active, now >= r.ends_at),
                }[status]
            )
        if scope is not None:
            conditions.append(r.scope == scope)
        total = self._session.scalar(select(func.count()).select_from(r).where(*conditions)) or 0
        stmt = (
            select(r)
            .where(*conditions)
            .order_by(r.starts_at.desc(), r.id)  # id: paginación estable
            .limit(page_size)
            .offset((page - 1) * page_size)
            .execution_options(populate_existing=True)
        )
        rows = list(self._session.scalars(stmt))
        products = self._products_of([row.id for row in rows])
        return [_promotion(row, products.get(row.id, ())) for row in rows], total

    def _load(self, stmt: Select[tuple[PromotionRow]]) -> Promotion | None:
        row = self._session.scalars(stmt.execution_options(populate_existing=True)).one_or_none()
        if row is None:
            return None
        return _promotion(row, self._products_of([row.id]).get(row.id, ()))

    def _products_of(self, promotion_ids: Collection[UUID]) -> dict[UUID, tuple[UUID, ...]]:
        if not promotion_ids:
            return {}
        stmt = (
            select(PromotionProductRow.promotion_id, PromotionProductRow.product_id)
            .where(PromotionProductRow.promotion_id.in_(promotion_ids))
            .order_by(PromotionProductRow.promotion_id, PromotionProductRow.product_id)
        )
        grouped: dict[UUID, list[UUID]] = defaultdict(list)
        for promotion_id, product_id in self._session.execute(stmt):
            grouped[promotion_id].append(product_id)
        return {key: tuple(value) for key, value in grouped.items()}

    def _insert_products(self, promotion: Promotion) -> None:
        if promotion.product_ids:
            rows = [
                {"promotion_id": promotion.id, "product_id": product_id}
                for product_id in promotion.product_ids
            ]
            _write(self._session, insert(PromotionProductRow).values(rows))


class SqlEffectivePriceReader:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get_many(self, product_ids: Collection[UUID]) -> list[EffectivePrice]:
        if not product_ids:
            return []
        v = _effective_price.c
        stmt = select(v).where(v.product_id.in_(product_ids))
        return [
            EffectivePrice(
                product_id=row.product_id,
                list_price=row.list_price_cents,
                price=row.effective_price_cents,
                discount_amount=row.discount_amount_cents,
                promotion_id=row.promotion_id,
            )
            for row in self._session.execute(stmt)
        ]
