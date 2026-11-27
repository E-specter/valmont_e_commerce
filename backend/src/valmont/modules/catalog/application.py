import logging
from collections.abc import Callable, Iterable, Mapping, Set
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol
from uuid import UUID, uuid4

# AuditEntry forma parte de la firma del puerto público de audit (modules.md §3, excepción 2).
from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.catalog.domain import (
    ALT_MAX,
    IMAGE_EXTENSION,
    IMAGE_MAX_BYTES,
    AdminProductPage,
    AdminProductQuery,
    AdminProductView,
    AttributeKind,
    AttributeValue,
    CatalogNotFound,
    Category,
    CategoryInUse,
    ImageTooLarge,
    InvalidReference,
    Product,
    ProductImage,
    ProductPage,
    ProductQuery,
    ProductStatus,
    ProductSummary,
    clean_text,
    image_format,
    order_images,
    slugify,
)

logger = logging.getLogger(__name__)

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

    def update_image_alt(self, product_id: UUID, image_id: UUID, alt: str) -> ProductImage | None:
        """None si la imagen no existe o es de otro producto."""
        ...

    def delete_image(self, image_id: UUID) -> None: ...

    def set_image_order(self, product_id: UUID, image_ids: list[UUID]) -> None:
        """Posiciones 0…n-1 en el orden recibido (todos los ids del producto)."""
        ...


class StorageUnavailable(Exception):
    """Storage no respondió o rechazó la operación: 503 storage_unavailable, sin detalles."""


class ImageStorage(Protocol):
    """Archivos de imagen del bucket products (D-019). Fallos → StorageUnavailable."""

    def put(self, path: str, data: bytes, content_type: str) -> None: ...

    def delete(self, path: str) -> None: ...


@dataclass(frozen=True)
class OptimizedImage:
    data: bytes
    width: int
    height: int
    content_type: str = "image/webp"


class ImageOptimizer(Protocol):
    def optimize(self, data: bytes) -> OptimizedImage:
        """InvalidImage, ImageDimensionsExceeded o AnimatedImage. La salida no lleva metadatos."""
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
    """Quién hace la operación: sale del token, nunca del cuerpo (SPEC §9). Nulo = sistema
    (AUDIT-R5), p. ej. las semillas de desarrollo."""

    user_id: UUID | None
    role: str | None


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


# --- Imágenes (T-029). Subir, ordenar y retirar bloquean el producto: así se serializan las
# posiciones (UNIQUE product_id, position) y CATALOG-R11 frente a una publicación concurrente.


def discard_file(storage: ImageStorage, path: str) -> None:
    """Borra un archivo que ya no tiene fila. Si Storage falla, queda huérfano: aviso y sigue."""
    try:
        storage.delete(path)
    except StorageUnavailable:
        logger.warning("No se pudo borrar de Storage la imagen %s; queda huérfana.", path)


class AddProductImage:
    def __init__(
        self, products: ProductRepository, storage: ImageStorage, optimizer: ImageOptimizer
    ) -> None:
        self._products = products
        self._storage = storage
        self._optimizer = optimizer

    def __call__(self, product_id: UUID, data: bytes, alt: str) -> ProductImage:
        image_format(data)  # 413/415 antes de tocar nada
        optimized = self._optimizer.optimize(data)  # CPU: antes de bloquear la fila
        if len(optimized.data) > IMAGE_MAX_BYTES:
            raise ImageTooLarge(f"La imagen no puede superar {IMAGE_MAX_BYTES // 2**20} MiB.")
        _lock(self._products, product_id)
        positions = [image.position for image in self._products.list_images(product_id)]
        image_id = uuid4()
        image = ProductImage(
            id=image_id,
            product_id=product_id,
            storage_path=f"{product_id}/{image_id}.{IMAGE_EXTENSION}",
            alt=alt,
            position=max(positions, default=-1) + 1,
        )
        self._storage.put(image.storage_path, optimized.data, optimized.content_type)
        try:
            self._products.add_image(image)
        except Exception:
            discard_file(self._storage, image.storage_path)
            raise
        return image


class UpdateProductImage:
    def __init__(self, products: ProductRepository) -> None:
        self._products = products

    def __call__(self, product_id: UUID, image_id: UUID, alt: str) -> ProductImage:
        alt = clean_text(alt, ALT_MAX)  # mismo criterio que ProductImage
        if (image := self._products.update_image_alt(product_id, image_id, alt)) is None:
            raise CatalogNotFound
        return image


class ReorderProductImages:
    def __init__(self, products: ProductRepository) -> None:
        self._products = products

    def __call__(self, product_id: UUID, image_ids: list[UUID]) -> list[ProductImage]:
        _lock(self._products, product_id)
        ordered = order_images(self._products.list_images(product_id), image_ids)
        self._products.set_image_order(product_id, [image.id for image in ordered])
        return ordered


class RemoveProductImage:
    def __init__(self, products: ProductRepository) -> None:
        self._products = products

    def __call__(self, product_id: UUID, image_id: UUID) -> str:
        """Borra la fila y devuelve la ruta del archivo, que se borra después del commit."""
        product = _lock(self._products, product_id)
        images = self._products.list_images(product_id)
        if (image := next((i for i in images if i.id == image_id), None)) is None:
            raise CatalogNotFound
        product.ensure_image_can_be_removed(len(images))
        self._products.delete_image(image_id)
        return image.storage_path


# --- Limpieza de archivos huérfanos de Storage (T-018f, D-047 D-H4) ---------------------------

ORPHAN_GRACE = timedelta(hours=24)  # un archivo más joven puede estar a medio subir
MAX_ORPHAN_DELETIONS = 50  # más que esto huele a un fallo de lectura, no a huérfanos


@dataclass(frozen=True)
class StoredFile:
    path: str
    created_at: datetime


class ImageInventory(Protocol):
    def list_files(self) -> Iterable[StoredFile]: ...


class ImagePathReader(Protocol):
    def referenced_paths(self) -> set[str]: ...


@dataclass(frozen=True)
class OrphanReport:
    scanned: int
    orphans: tuple[str, ...]
    deleted: int
    failed: int


class OrphanLimitExceeded(Exception):
    """Hay más huérfanos que el tope: no se borra nada hasta que una persona lo revise."""

    def __init__(self, found: int, limit: int) -> None:
        super().__init__(f"{found} huérfanos superan el tope de {limit}")
        self.found, self.limit = found, limit


def find_orphan_files(
    files: Iterable[StoredFile],
    referenced: Set[str],
    now: datetime,
    grace: timedelta = ORPHAN_GRACE,
) -> list[StoredFile]:
    cutoff = now - grace
    return [f for f in files if f.path not in referenced and f.created_at < cutoff]


class CleanupOrphanImages:
    def __init__(
        self,
        inventory: ImageInventory,
        reader: ImagePathReader,
        storage: ImageStorage,
        clock: Callable[[], datetime],
    ) -> None:
        self._inventory = inventory
        self._reader = reader
        self._storage = storage
        self._clock = clock

    def __call__(
        self,
        *,
        apply: bool = False,
        grace: timedelta = ORPHAN_GRACE,
        max_deletions: int = MAX_ORPHAN_DELETIONS,
    ) -> OrphanReport:
        if (
            grace < timedelta(0) or max_deletions < 0
        ):  # una gracia negativa borraría lo recién subido
            raise ValueError("grace y max_deletions no pueden ser negativos")
        # Primero Storage y luego la BD: un archivo subido entre medias es más joven que la gracia.
        files = list(self._inventory.list_files())
        referenced = self._reader.referenced_paths()
        orphans = [f.path for f in find_orphan_files(files, referenced, self._clock(), grace)]
        if len(orphans) > max_deletions:
            raise OrphanLimitExceeded(len(orphans), max_deletions)
        deleted = failed = 0
        if apply:
            for path in orphans:
                try:
                    self._storage.delete(path)
                    deleted += 1
                except StorageUnavailable:
                    failed += 1
                    logger.warning("No se pudo borrar el huérfano %s.", path)
        return OrphanReport(len(files), tuple(orphans), deleted, failed)
