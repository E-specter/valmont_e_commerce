import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

PAGE_SIZE_DEFAULT = 24  # CATALOG-R9
PAGE_SIZE_MAX = 48
RELATED_MAX = 4  # CATALOG-R6
DIAMETER_MAX = Decimal("999.9")  # numeric(4,1) de la SPEC §6
_ONE_DECIMAL = Decimal("0.1")
# Longitudes de la SPEC §5 (solo dominio; la BD guarda text).
SKU_MAX = 40
NAME_MAX = 120
DESCRIPTION_MAX = 5000
SLUG_MAX = 60  # slugs y códigos
CATEGORY_NAME_MAX = 60
CATEGORY_DESCRIPTION_MAX = 500
LABEL_MAX = 60  # AttributeValue.label
SPECS_MAX = 40
SPEC_LABEL_MAX = 60
SPEC_VALUE_MAX = 200
ALT_MAX = 150

_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


class CatalogError(ValueError):
    """Dato de catálogo no válido. Hereda de ValueError: Pydantic lo convierte en un 422."""


class CatalogConflict(Exception):
    """SKU, slug, código o posición repetidos (CATALOG-R3): 409. Lo decide un UNIQUE de la BD."""

    def __init__(self, field: str) -> None:
        super().__init__(f"Ya existe un registro con ese {field}.")
        self.field = field


class NotPublishable(Exception):
    """El producto no cumple CATALOG-R2: 409."""

    def __init__(self, missing: tuple[str, ...]) -> None:
        super().__init__(f"Faltan requisitos de publicación: {', '.join(missing)}.")
        self.missing = missing


class ProductStatus(StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"


class OrderPolicy(StrEnum):
    """Política de venta (D-023). La disponibilidad que resulta llega con inventory (T-030)."""

    STOCK = "stock"  # solo se vende con stock
    MADE_TO_ORDER = "made_to_order"  # siempre bajo pedido
    BACKORDER = "backorder"  # con stock y, agotado, bajo pedido


class ProductSort(StrEnum):  # CATALOG-R8
    NEWEST = "newest"
    PRICE_ASC = "price_asc"
    PRICE_DESC = "price_desc"
    RELEVANCE = "relevance"


class AttributeKind(StrEnum):
    """Listas de valores de los atributos filtrables (D-020)."""

    MOVEMENT = "movement"
    CASE_MATERIAL = "case_material"


def clean_text(
    value: str, max_length: int | None = None, *, required: bool = True, multiline: bool = False
) -> str:
    """Recorta un texto de entrada; mismo criterio que identity (SPEC §5).

    multiline (CATALOG-R12): admite saltos de línea; \r\n y \r pasan a \n.
    """
    if multiline:
        value = value.replace("\r\n", "\n").replace("\r", "\n")
    allowed = "\n" if multiline else ""
    # Cc: \x00 rompe un text de PostgreSQL. Cs: un sustituto suelto no se codifica en UTF-8.
    # Se comprueba antes de recortar: si no, un \t o \n en los extremos pasaría desapercibido.
    if any(unicodedata.category(c) in ("Cc", "Cs") and c not in allowed for c in value):
        raise CatalogError("El texto contiene caracteres de control no permitidos.")
    text = value.strip()
    if required and not text:
        raise CatalogError("El texto no puede estar vacío.")
    if max_length is not None and len(text) > max_length:
        raise CatalogError(f"El texto admite como máximo {max_length} caracteres.")
    return text


def check_slug(value: str) -> str:
    """Slugs y códigos de las listas de valores: minúsculas ASCII, dígitos y guiones simples."""
    if len(value) > SLUG_MAX or not _SLUG.fullmatch(value):
        raise CatalogError(f"Hasta {SLUG_MAX} minúsculas sin acentos, dígitos y guiones simples.")
    return value


def slugify(name: str) -> str:
    """CATALOG-R3: el slug se genera del nombre (minúsculas, sin acentos, guiones).

    Un nombre largo (hasta 120) se corta a SLUG_MAX sin dejar un guion al final.
    """
    ascii_name = unicodedata.normalize("NFKD", clean_text(name)).encode("ascii", "ignore")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.decode().lower()).strip("-")
    slug = slug[:SLUG_MAX].rstrip("-")
    if not slug:
        raise CatalogError("El nombre no tiene letras ni dígitos con los que formar un slug.")
    return slug


def _set(obj: object, name: str, value: object) -> None:
    object.__setattr__(obj, name, value)  # frozen: la normalización se asigna así


@dataclass(frozen=True)
class Category:
    id: UUID
    slug: str
    name: str
    description: str | None = None
    position: int = 0
    is_active: bool = True

    def __post_init__(self) -> None:
        check_slug(self.slug)
        _set(self, "name", clean_text(self.name, CATEGORY_NAME_MAX))
        if self.description is not None:
            description = clean_text(self.description, CATEGORY_DESCRIPTION_MAX, required=False)
            _set(self, "description", description or None)


@dataclass(frozen=True)
class AttributeValue:
    code: str
    label: str
    position: int = 0
    is_active: bool = True

    def __post_init__(self) -> None:
        check_slug(self.code)
        _set(self, "label", clean_text(self.label, LABEL_MAX))


@dataclass(frozen=True)
class ProductImage:
    """La URL pública no se guarda: se calcula al responder a partir de storage_path (C-9)."""

    id: UUID
    product_id: UUID
    storage_path: str
    alt: str
    position: int

    def __post_init__(self) -> None:
        _set(self, "storage_path", clean_text(self.storage_path))
        _set(self, "alt", clean_text(self.alt, ALT_MAX))


@dataclass(frozen=True)
class SpecEntry:
    """Una fila de la ficha técnica (D-020, C-1): se muestra en orden editorial y no filtra."""

    label: str
    value: str

    def __post_init__(self) -> None:
        _set(self, "label", clean_text(self.label, SPEC_LABEL_MAX))
        _set(self, "value", clean_text(self.value, SPEC_VALUE_MAX))


@dataclass(frozen=True)
class Product:
    id: UUID
    sku: str
    slug: str
    name: str
    description: str  # vacía en un borrador; obligatoria para publicar (CATALOG-R2)
    category_id: UUID
    price: int  # céntimos de PEN con IGV incluido (D-022)
    status: ProductStatus = ProductStatus.DRAFT
    order_policy: OrderPolicy = OrderPolicy.STOCK
    lead_time_days: int | None = None  # plazo estimado de "Bajo pedido"
    movement_code: str | None = None
    case_material_code: str | None = None
    case_diameter_mm: Decimal | None = None
    water_resistance_m: int | None = None
    specs: tuple[SpecEntry, ...] = ()
    published_at: datetime | None = None

    def __post_init__(self) -> None:
        _set(self, "sku", clean_text(self.sku, SKU_MAX))
        _set(self, "name", clean_text(self.name, NAME_MAX))
        description = clean_text(self.description, DESCRIPTION_MAX, required=False, multiline=True)
        _set(self, "description", description)
        check_slug(self.slug)
        for code in (self.movement_code, self.case_material_code):
            if code is not None:
                check_slug(code)
        _set(self, "specs", tuple(self.specs))
        if len(self.specs) > SPECS_MAX:
            raise CatalogError(f"La ficha técnica admite como máximo {SPECS_MAX} filas.")
        if len({entry.label.casefold() for entry in self.specs}) < len(self.specs):
            raise CatalogError("La ficha técnica no puede repetir una etiqueta.")
        _set(self, "status", ProductStatus(self.status))
        _set(self, "order_policy", OrderPolicy(self.order_policy))
        if self.lead_time_days is not None and self.lead_time_days <= 0:
            raise CatalogError("El plazo de entrega debe ser de al menos un día.")
        if self.price < 0:
            raise CatalogError("El precio no puede ser negativo.")
        if self.water_resistance_m is not None and self.water_resistance_m < 0:
            raise CatalogError("La resistencia al agua no puede ser negativa.")
        diameter = self.case_diameter_mm
        if diameter is not None and not (
            diameter.is_finite()
            and 0 < diameter <= DIAMETER_MAX
            and diameter == diameter.quantize(_ONE_DECIMAL)
        ):
            raise CatalogError("El diámetro debe ser mayor que 0, hasta 999.9 mm y con un decimal.")
        if self.status is ProductStatus.PUBLISHED and self.published_at is None:
            raise CatalogError("Un producto publicado necesita su fecha de publicación.")

    def ensure_publishable(self, category: Category, image_count: int) -> None:
        """CATALOG-R2 (ampliada por D-023). El nombre ya es obligatorio en cualquier estado."""
        checks = (
            ("description", bool(self.description)),
            ("category", category.is_active),
            ("price", self.price > 0),
            ("image", image_count > 0),
            ("lead_time_days", self.order_policy is OrderPolicy.STOCK or bool(self.lead_time_days)),
        )
        if missing := tuple(name for name, ok in checks if not ok):
            raise NotPublishable(missing)


@dataclass(frozen=True)
class ProductSummary:
    """Producto publicado con lo que muestra un listado (SPEC §7, ProductSummary)."""

    product: Product
    category: Category
    movement: AttributeValue | None
    case_material: AttributeValue | None
    main_image: ProductImage | None  # la de menor posición


@dataclass(frozen=True)
class ProductPage:
    items: list[ProductSummary]
    total: int  # todos los que cumplen los filtros, no solo los de la página


@dataclass(frozen=True)
class ProductQuery:
    """Filtros, orden y página del listado público (UC-CATALOG-01 y 02)."""

    q: str | None = None
    category: str | None = None  # slug
    movement: str | None = None  # código
    case_material: str | None = None
    diameter_min: Decimal | None = None
    diameter_max: Decimal | None = None
    water_resistance_min: int | None = None
    price_min: int | None = None  # céntimos
    price_max: int | None = None
    sort: ProductSort | None = None  # None: relevance con q (UC-CATALOG-02); si no, newest
    page: int = 1
    page_size: int = PAGE_SIZE_DEFAULT

    def __post_init__(self) -> None:
        for name in ("category", "movement", "case_material"):
            if (value := getattr(self, name)) is not None:
                _set(self, name, clean_text(value))
        if self.q is not None:
            _set(self, "q", clean_text(self.q, required=False) or None)
        if self.sort is None:
            _set(self, "sort", ProductSort.RELEVANCE if self.q else ProductSort.NEWEST)
        elif self.sort not in ProductSort:
            raise CatalogError(f"Orden no permitido: {', '.join(ProductSort)}.")
        _set(self, "sort", ProductSort(self.sort))
        if self.sort is ProductSort.RELEVANCE and self.q is None:
            raise CatalogError("El orden relevance necesita q (CATALOG-R8).")
        if self.page < 1:
            raise CatalogError("La página empieza en 1.")
        if not 1 <= self.page_size <= PAGE_SIZE_MAX:
            raise CatalogError(f"page_size debe estar entre 1 y {PAGE_SIZE_MAX}.")
