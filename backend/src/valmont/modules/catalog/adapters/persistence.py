from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ColumnElement,
    Computed,
    DateTime,
    Executable,
    ForeignKey,
    Index,
    Numeric,
    Select,
    Text,
    UniqueConstraint,
    func,
    insert,
    select,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, aliased, mapped_column

from valmont.modules.catalog.domain import (
    RELATED_MAX,
    AttributeKind,
    AttributeValue,
    CatalogConflict,
    Category,
    OrderPolicy,
    Product,
    ProductImage,
    ProductPage,
    ProductQuery,
    ProductSort,
    ProductStatus,
    ProductSummary,
    SpecEntry,
)
from valmont.shared.db import Base

# Tablas de la SPEC catalog §6. Solo las escribe catalog.


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class CategoryRow(Base):
    __tablename__ = "categories"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(server_default=text("0"))
    is_active: Mapped[bool] = mapped_column(server_default=true())
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class _AttributeValueColumns:
    code: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(server_default=text("0"))
    is_active: Mapped[bool] = mapped_column(server_default=true())


class MovementTypeRow(_AttributeValueColumns, Base):
    __tablename__ = "movement_types"


class CaseMaterialRow(_AttributeValueColumns, Base):
    __tablename__ = "case_materials"


class ProductRow(Base):
    __tablename__ = "products"
    __table_args__ = (
        CheckConstraint("price_cents >= 0", name="price_cents"),
        CheckConstraint("status IN ('draft', 'published')", name="status"),
        CheckConstraint(
            "order_policy IN ('stock', 'made_to_order', 'backorder')", name="order_policy"
        ),
        CheckConstraint("lead_time_days > 0", name="lead_time_days"),
        CheckConstraint("case_diameter_mm > 0", name="case_diameter_mm"),
        CheckConstraint("water_resistance_m >= 0", name="water_resistance_m"),
        CheckConstraint("jsonb_typeof(specs) = 'array'", name="specs_array"),
        Index("ix_products_search", "search", postgresql_using="gin"),
        Index("ix_products_status_published_at", "status", "published_at"),
        Index("ix_products_category_id", "category_id"),
        Index("ix_products_price_cents", "price_cents"),
        Index("ix_products_movement_code", "movement_code"),
        Index("ix_products_case_material_code", "case_material_code"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(Text, unique=True)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    category_id: Mapped[UUID] = mapped_column(ForeignKey(CategoryRow.id, ondelete="RESTRICT"))
    price_cents: Mapped[int]
    status: Mapped[str] = mapped_column(Text, server_default="draft")
    order_policy: Mapped[str] = mapped_column(Text, server_default="stock")  # D-023
    lead_time_days: Mapped[int | None]
    movement_code: Mapped[str | None] = mapped_column(
        ForeignKey(MovementTypeRow.code, ondelete="RESTRICT")
    )
    case_material_code: Mapped[str | None] = mapped_column(
        ForeignKey(CaseMaterialRow.code, ondelete="RESTRICT")
    )
    case_diameter_mm: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    water_resistance_m: Mapped[int | None]
    specs: Mapped[list[dict[str, str]]] = mapped_column(JSONB, server_default=text("'[]'"))
    # La calcula PostgreSQL; deferred: no se lee al cargar la fila. app.f_unaccent (migración
    # 0004) quita las tildes: "automatico" encuentra "Automático" (CA-CATALOG-02).
    search: Mapped[str] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('spanish', app.f_unaccent("
            "name || ' ' || sku || ' ' || coalesce(description, '')))",
            persisted=True,
        ),
        deferred=True,
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class ProductImageRow(Base):
    __tablename__ = "product_images"
    __table_args__ = (UniqueConstraint("product_id", "position"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    product_id: Mapped[UUID] = mapped_column(ForeignKey(ProductRow.id, ondelete="RESTRICT"))
    storage_path: Mapped[str] = mapped_column(Text)  # la URL pública se calcula (C-9)
    alt: Mapped[str] = mapped_column(Text)
    position: Mapped[int]
    created_at: Mapped[datetime] = _now()


# Restricción violada → campo del CatalogConflict. Cualquier otra se relanza tal cual.
_CONFLICT_FIELDS = {
    "uq_products_sku": "sku",
    "uq_products_slug": "slug",
    "uq_categories_slug": "slug",
    "pk_movement_types": "code",
    "pk_case_materials": "code",
    "uq_product_images_product_id": "position",
}

_ATTRIBUTE_ROWS: dict[AttributeKind, type[MovementTypeRow | CaseMaterialRow]] = {
    AttributeKind.MOVEMENT: MovementTypeRow,
    AttributeKind.CASE_MATERIAL: CaseMaterialRow,
}

_IS_PUBLISHED = ProductRow.status == ProductStatus.PUBLISHED  # CATALOG-R1
# CATALOG-R8: los empates se resuelven por id para que la paginación sea estable.
_NEWEST = (ProductRow.published_at.desc(), ProductRow.id)


def _insert(session: Session, stmt: Executable) -> None:
    # Unicidad decidida por la BD (modules.md §4.8): sin "¿existe?" previo.
    try:
        session.execute(stmt)
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if (field := _CONFLICT_FIELDS.get(constraint)) is None:
            raise
        raise CatalogConflict(field) from exc


def _category(row: CategoryRow) -> Category:
    return Category(row.id, row.slug, row.name, row.description, row.position, row.is_active)


def _attribute(row: MovementTypeRow | CaseMaterialRow) -> AttributeValue:
    return AttributeValue(row.code, row.label, row.position, row.is_active)


def _image(row: ProductImageRow) -> ProductImage:
    return ProductImage(row.id, row.product_id, row.storage_path, row.alt, row.position)


def _product(row: ProductRow) -> Product:
    return Product(
        id=row.id,
        sku=row.sku,
        slug=row.slug,
        name=row.name,
        description=row.description,
        category_id=row.category_id,
        price=row.price_cents,
        status=ProductStatus(row.status),
        order_policy=OrderPolicy(row.order_policy),
        lead_time_days=row.lead_time_days,
        movement_code=row.movement_code,
        case_material_code=row.case_material_code,
        case_diameter_mm=row.case_diameter_mm,
        water_resistance_m=row.water_resistance_m,
        specs=tuple(SpecEntry(**entry) for entry in row.specs),
        published_at=row.published_at,
    )


def _summary(row: Any) -> ProductSummary:
    product, category, movement, material, image = row
    return ProductSummary(
        product=_product(product),
        category=_category(category),
        movement=_attribute(movement) if movement else None,
        case_material=_attribute(material) if material else None,
        main_image=_image(image) if image else None,
    )


def _summaries() -> Select[Any]:
    """Productos publicados con su categoría, sus valores de atributo y su primera imagen."""
    first_image = (
        select(ProductImageRow)
        .where(ProductImageRow.product_id == ProductRow.id)
        .order_by(ProductImageRow.position)
        .limit(1)
        .lateral()
    )
    main_image = aliased(ProductImageRow, first_image)
    return (
        select(ProductRow, CategoryRow, MovementTypeRow, CaseMaterialRow, main_image)
        .join(CategoryRow, ProductRow.category_id == CategoryRow.id)
        .outerjoin(MovementTypeRow, ProductRow.movement_code == MovementTypeRow.code)
        .outerjoin(CaseMaterialRow, ProductRow.case_material_code == CaseMaterialRow.code)
        .outerjoin(main_image, true())
        .where(_IS_PUBLISHED)
    )


def _tsquery(q: str) -> ColumnElement[Any]:
    # SPEC §9: el texto del usuario viaja como parámetro, nunca concatenado. Sin tildes, como
    # la columna search.
    return func.websearch_to_tsquery("spanish", func.app.f_unaccent(q))


def _filters(query: ProductQuery) -> list[ColumnElement[bool]]:
    # Un NULL no cumple ninguna comparación: sin el atributo, fuera del filtro (CATALOG-R5).
    conditions = []
    if query.category is not None:
        category_id = select(CategoryRow.id).filter_by(slug=query.category).scalar_subquery()
        conditions.append(ProductRow.category_id == category_id)
    if query.movement is not None:
        conditions.append(ProductRow.movement_code == query.movement)
    if query.case_material is not None:
        conditions.append(ProductRow.case_material_code == query.case_material)
    ranges = (
        (ProductRow.case_diameter_mm, query.diameter_min, query.diameter_max),
        (ProductRow.water_resistance_m, query.water_resistance_min, None),
        (ProductRow.price_cents, query.price_min, query.price_max),
    )
    for column, low, high in ranges:
        if low is not None:
            conditions.append(column >= low)
        if high is not None:
            conditions.append(column <= high)
    if query.q is not None:
        conditions.append(ProductRow.search.op("@@")(_tsquery(query.q)))
    return conditions


def _order(query: ProductQuery) -> tuple[Any, ...]:
    match query.sort:
        case ProductSort.PRICE_ASC:
            return (ProductRow.price_cents, ProductRow.id)
        case ProductSort.PRICE_DESC:
            return (ProductRow.price_cents.desc(), ProductRow.id)
        case ProductSort.RELEVANCE:
            return (func.ts_rank(ProductRow.search, _tsquery(query.q)).desc(), ProductRow.id)
    return _NEWEST


class SqlProductRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, product: Product) -> None:
        values = asdict(product)
        values["price_cents"] = values.pop("price")
        _insert(self._session, insert(ProductRow).values(**values))

    def add_image(self, image: ProductImage) -> None:
        _insert(self._session, insert(ProductImageRow).values(**asdict(image)))

    def list_published(self, query: ProductQuery) -> ProductPage:
        conditions = _filters(query)
        count = select(func.count()).select_from(ProductRow).where(_IS_PUBLISHED, *conditions)
        page = (
            _summaries()
            .where(*conditions)
            .order_by(*_order(query))
            .limit(query.page_size)
            .offset((query.page - 1) * query.page_size)
        )
        items = [_summary(row) for row in self._session.execute(page)]
        return ProductPage(items, self._session.scalar(count) or 0)

    def get_published(self, slug: str) -> ProductSummary | None:
        row = self._session.execute(_summaries().where(ProductRow.slug == slug)).one_or_none()
        return _summary(row) if row else None

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        stmt = select(ProductImageRow).filter_by(product_id=product_id)
        return [_image(row) for row in self._session.scalars(stmt.order_by("position"))]

    def related(self, product: Product) -> list[ProductSummary]:
        stmt = (
            _summaries()
            .where(ProductRow.category_id == product.category_id, ProductRow.id != product.id)
            .order_by(*_NEWEST)
            .limit(RELATED_MAX)
        )
        return [_summary(row) for row in self._session.execute(stmt)]


class SqlCategoryRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, category: Category) -> None:
        _insert(self._session, insert(CategoryRow).values(**asdict(category)))

    def list_active(self) -> list[Category]:
        stmt = select(CategoryRow).filter_by(is_active=True).order_by("position", "name")
        return [_category(row) for row in self._session.scalars(stmt)]


class SqlAttributeRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, kind: AttributeKind, value: AttributeValue) -> None:
        _insert(self._session, insert(_ATTRIBUTE_ROWS[kind]).values(**asdict(value)))

    def list_active(self, kind: AttributeKind) -> list[AttributeValue]:
        stmt = select(_ATTRIBUTE_ROWS[kind]).filter_by(is_active=True).order_by("position", "code")
        return [_attribute(row) for row in self._session.scalars(stmt)]
