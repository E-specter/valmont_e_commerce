from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import UUID, uuid4

# AuditEntry forma parte de la firma del puerto público de audit (modules.md §3, excepción 2).
from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.catalog.domain import (
    AdminProductPage,
    AdminProductQuery,
    AdminProductView,
    AttributeKind,
    AttributeValue,
    CatalogNotFound,
    Category,
    CategoryInUse,
    InvalidReference,
    Product,
    ProductImage,
    ProductPage,
    ProductQuery,
    ProductStatus,
    ProductSummary,
    slugify,
)

RowLock = Literal["share", "update"]

# Puertos de catalog. Las escrituras lanzan CatalogConflict si la BD rechaza un duplicado e
# InvalidReference si la categoría o un código no existen (FK).


class ProductRepository(Protocol):
    def add(self, product: Product) -> None:
        """CatalogConflict("sku") o CatalogConflict("slug") si ya existen (CATALOG-R3)."""
        ...

    def add_image(self, image: ProductImage) -> None:
        """CatalogConflict("position") si el producto ya tiene una imagen en esa posición."""
        ...

    def list_published(self, query: ProductQuery) -> ProductPage:
        """Solo publicados (CATALOG-R1), filtrados, ordenados y paginados."""
        ...

    def get_published(self, slug: str) -> ProductSummary | None:
        """None si no existe o es un borrador (CATALOG-R1: no se revela que existe)."""
        ...

    def list_images(self, product_id: UUID) -> list[ProductImage]:
        """Por posición."""
        ...

    def related(self, product: Product) -> list[ProductSummary]:
        """CATALOG-R6: hasta 4 publicados de su categoría, sin él, los más recientes primero."""
        ...

    def get(self, product_id: UUID) -> AdminProductView | None:
        """En cualquier estado (administración)."""
        ...

    def lock(self, product_id: UUID) -> Product | None:
        """Lee y bloquea la fila hasta el fin de la transacción (SELECT … FOR UPDATE)."""
        ...

    def update(self, product: Product) -> None:
        """Reescribe la fila; mismos errores que add."""
        ...

    def list_all(self, query: AdminProductQuery) -> AdminProductPage:
        """Borradores incluidos; los cambiados más recientemente primero."""
        ...


class CategoryRepository(Protocol):
    def add(self, category: Category) -> None:
        """CatalogConflict("slug") si ya existe."""
        ...

    def list_active(self) -> list[Category]:
        """Por posición."""
        ...

    def list_all(self) -> list[Category]:
        """Activas e inactivas, por posición."""
        ...

    def get(self, category_id: UUID, lock: RowLock | None = None) -> Category | None:
        """lock="share" impide desactivarla mientras dure la transacción; "update", publicar."""
        ...

    def update(self, category_id: UUID, values: Mapping[str, object]) -> Category | None:
        """Solo las columnas recibidas; None si no existe. CatalogConflict("slug")."""
        ...

    def has_published_products(self, category_id: UUID) -> bool: ...


class AttributeRepository(Protocol):
    def add(self, kind: AttributeKind, value: AttributeValue) -> None:
        """CatalogConflict("code") si ya existe en esa lista."""
        ...

    def list_active(self, kind: AttributeKind) -> list[AttributeValue]:
        """Por posición."""
        ...

    def list_all(self, kind: AttributeKind) -> list[AttributeValue]:
        """Activos e inactivos, por posición."""
        ...

    def update(
        self, kind: AttributeKind, code: str, values: Mapping[str, object]
    ) -> AttributeValue | None:
        """Solo las columnas recibidas; None si no existe."""
        ...


@dataclass(frozen=True)
class Actor:
    """Quién hace la operación: sale del token, nunca del cuerpo (SPEC §9)."""

    user_id: UUID
    role: str


Clock = Callable[[], datetime]


def _now() -> datetime:
    return datetime.now(UTC)


def _get(products: ProductRepository, product_id: UUID) -> AdminProductView:
    if (view := products.get(product_id)) is None:
        raise CatalogNotFound
    return view


def _lock(products: ProductRepository, product_id: UUID) -> Product:
    if (product := products.lock(product_id)) is None:
        raise CatalogNotFound
    return product


def _entry(action: str, product: Product, actor: Actor, **change: object) -> AuditEntry:
    return AuditEntry(action, "product", str(product.id), actor.user_id, actor.role, **change)


class CreateProduct:
    def __init__(self, products: ProductRepository, audit: AuditRecorder) -> None:
        self._products = products
        self._audit = audit

    def __call__(self, fields: Mapping[str, object], actor: Actor) -> AdminProductView:
        values = dict(fields)
        slug = values.pop("slug", None) or slugify(str(values["name"]))  # CATALOG-R3
        product = Product(id=uuid4(), slug=slug, status=ProductStatus.DRAFT, **values)
        self._products.add(product)
        after = {
            "sku": product.sku,
            "price_cents": product.price,
            "order_policy": product.order_policy.value,
        }
        self._audit.record(_entry("catalog.product_created", product, actor, after=after))
        return _get(self._products, product.id)


def _ensure_publishable(
    products: ProductRepository, categories: CategoryRepository, product: Product
) -> None:
    """CATALOG-R2. Orden de bloqueo único: el producto ya está FOR UPDATE y la categoría se toma
    FOR SHARE, así que nadie la desactiva hasta el commit (CATALOG-R10)."""
    if (category := categories.get(product.category_id, lock="share")) is None:
        raise InvalidReference("category_id")
    product.ensure_publishable(category, len(products.list_images(product.id)))


class UpdateProduct:
    def __init__(
        self, products: ProductRepository, categories: CategoryRepository, audit: AuditRecorder
    ) -> None:
        self._products = products
        self._categories = categories
        self._audit = audit

    def __call__(
        self, product_id: UUID, changes: Mapping[str, object], actor: Actor
    ) -> AdminProductView:
        current = _lock(self._products, product_id)  # dos PATCH a la vez no se pisan
        if "slug" in changes:
            current.ensure_slug_can_change(str(changes["slug"]))
        updated = replace(current, **changes)  # valida el producto entero
        if current.status is ProductStatus.PUBLISHED:
            # CATALOG-R2 es un invariante del publicado: se comprueba antes de escribir nada.
            _ensure_publishable(self._products, self._categories, updated)
        if updated != current:
            self._products.update(updated)
        if updated.price != current.price:
            before, after = {"price_cents": current.price}, {"price_cents": updated.price}
            entry = _entry("catalog.price_changed", updated, actor, before=before, after=after)
            self._audit.record(entry)
        # AUDIT-R2: solo los campos de la política que cambian.
        changed = [
            n
            for n in ("order_policy", "lead_time_days")
            if getattr(updated, n) != getattr(current, n)
        ]
        if changed:
            before = {name: getattr(current, name) for name in changed}
            after = {name: getattr(updated, name) for name in changed}
            action = "catalog.order_policy_changed"
            self._audit.record(_entry(action, updated, actor, before=before, after=after))
        return _get(self._products, product_id)


class PublishProduct:
    def __init__(
        self,
        products: ProductRepository,
        categories: CategoryRepository,
        audit: AuditRecorder,
        clock: Clock = _now,
    ) -> None:
        self._products = products
        self._categories = categories
        self._audit = audit
        self._clock = clock

    def __call__(self, product_id: UUID, actor: Actor) -> AdminProductView:
        product = _lock(self._products, product_id)
        if product.status is not ProductStatus.PUBLISHED:  # ya publicado: sin cambios
            _ensure_publishable(self._products, self._categories, product)
            self._products.update(product.published(self._clock()))
            change = {"before": {"status": "draft"}, "after": {"status": "published"}}
            self._audit.record(_entry("catalog.product_published", product, actor, **change))
        return _get(self._products, product_id)


class UnpublishProduct:
    def __init__(self, products: ProductRepository, audit: AuditRecorder) -> None:
        self._products = products
        self._audit = audit

    def __call__(self, product_id: UUID, actor: Actor) -> AdminProductView:
        product = _lock(self._products, product_id)
        if product.status is ProductStatus.PUBLISHED:  # ya en borrador: sin cambios
            self._products.update(product.unpublished())
            change = {"before": {"status": "published"}, "after": {"status": "draft"}}
            self._audit.record(_entry("catalog.product_unpublished", product, actor, **change))
        return _get(self._products, product_id)


class CreateCategory:
    def __init__(self, categories: CategoryRepository) -> None:
        self._categories = categories

    def __call__(self, fields: Mapping[str, object]) -> Category:
        values = dict(fields)
        slug = values.pop("slug", None) or slugify(str(values["name"]))
        category = Category(id=uuid4(), slug=slug, **values)
        self._categories.add(category)
        return category


class UpdateCategory:
    def __init__(self, categories: CategoryRepository) -> None:
        self._categories = categories

    def __call__(self, category_id: UUID, changes: Mapping[str, object]) -> Category:
        if changes.get("is_active") is False:
            # "update" espera a cualquier publicación o edición en curso que tenga la categoría
            # FOR SHARE. La consulta siguiente ve lo que esa transacción confirmó solo porque
            # get_session usa READ COMMITTED (por defecto en PostgreSQL), donde cada sentencia
            # toma su propia instantánea; con REPEATABLE READ habría que reintentar o fallar.
            # CATALOG-R10, sin "comprobar y después escribir".
            if self._categories.get(category_id, lock="update") is None:
                raise CatalogNotFound
            if self._categories.has_published_products(category_id):
                raise CategoryInUse("La categoría tiene productos publicados.")
        if (category := self._categories.update(category_id, changes)) is None:
            raise CatalogNotFound
        return category


class UpdateAttributeValue:
    def __init__(self, attributes: AttributeRepository) -> None:
        self._attributes = attributes

    def __call__(
        self, kind: AttributeKind, code: str, changes: Mapping[str, object]
    ) -> AttributeValue:
        if (value := self._attributes.update(kind, code, changes)) is None:
            raise CatalogNotFound
        return value
