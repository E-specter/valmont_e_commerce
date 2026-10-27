from decimal import Decimal
from typing import Annotated, Self
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, Field, model_validator

from valmont.modules.catalog.adapters.persistence import (
    SqlAttributeRepository,
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.application import (
    AttributeRepository,
    CategoryRepository,
    ProductRepository,
)
from valmont.modules.catalog.domain import (
    PAGE_SIZE_DEFAULT,
    PAGE_SIZE_MAX,
    AttributeKind,
    AttributeValue,
    CatalogError,
    ProductImage,
    ProductQuery,
    ProductSort,
    ProductSummary,
    check_slug,
    clean_text,
)
from valmont.shared.config import get_settings
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError
from valmont.shared.money import Money

# --- Dependencias ---


def get_product_repository(session: SessionDep) -> ProductRepository:
    return SqlProductRepository(session)


def get_category_repository(session: SessionDep) -> CategoryRepository:
    return SqlCategoryRepository(session)


def get_attribute_repository(session: SessionDep) -> AttributeRepository:
    return SqlAttributeRepository(session)


Products = Annotated[ProductRepository, Depends(get_product_repository)]
Categories = Annotated[CategoryRepository, Depends(get_category_repository)]
Attributes = Annotated[AttributeRepository, Depends(get_attribute_repository)]


def _image_url(storage_path: str) -> str:
    """URL pública de Storage (SPEC §6); la ruta interna nunca sale en la respuesta."""
    settings = get_settings()
    base = settings.storage_public_url or settings.supabase_url
    if not base:
        raise RuntimeError("Falta STORAGE_PUBLIC_URL o SUPABASE_URL en el entorno (backend/.env).")
    return f"{base.rstrip('/')}/storage/v1/object/public/products/{quote(storage_path)}"


# --- Esquemas de entrada ---

# Validados por campo: un carácter de control da 422 con loc ["query", <parámetro>].
QueryText = Annotated[str, AfterValidator(clean_text)]
SearchText = Annotated[
    str, Field(max_length=100), AfterValidator(lambda v: clean_text(v, required=False))
]


class ProductListIn(BaseModel):
    """Parámetros de GET /products (SPEC §7). Los textos y el orden los valida el dominio."""

    q: SearchText | None = None
    category: QueryText | None = None
    movement: QueryText | None = None
    case_material: QueryText | None = None
    case_diameter_mm_min: Decimal | None = None
    case_diameter_mm_max: Decimal | None = None
    water_resistance_m_min: int | None = None
    price_min: int | None = Field(None, ge=0)  # céntimos
    price_max: int | None = Field(None, ge=0)
    sort: ProductSort | None = None
    page: int = Field(1, ge=1, le=1000)
    page_size: int = Field(PAGE_SIZE_DEFAULT, ge=1, le=PAGE_SIZE_MAX)

    @model_validator(mode="after")
    def _check_ranges_and_query(self) -> Self:
        for low, high in (
            ("case_diameter_mm_min", "case_diameter_mm_max"),
            ("price_min", "price_max"),
        ):
            low_value, high_value = getattr(self, low), getattr(self, high)
            if low_value is not None and high_value is not None and low_value > high_value:
                raise ValueError(f"{low} no puede ser mayor que {high}.")
        self.to_domain()  # CatalogError es un ValueError: 422 con el formato común
        return self

    def to_domain(self) -> ProductQuery:
        return ProductQuery(
            q=self.q,
            category=self.category,
            movement=self.movement,
            case_material=self.case_material,
            diameter_min=self.case_diameter_mm_min,
            diameter_max=self.case_diameter_mm_max,
            water_resistance_min=self.water_resistance_m_min,
            price_min=self.price_min,
            price_max=self.price_max,
            sort=self.sort,
            page=self.page,
            page_size=self.page_size,
        )


# --- Esquemas de salida (SPEC §7; sin status, storage_path ni fechas internas) ---


class CategoryRefOut(BaseModel):
    slug: str
    name: str


class CategoryOut(CategoryRefOut):
    description: str | None


class AttributeValueOut(BaseModel):
    code: str
    label: str

    @classmethod
    def from_domain(cls, value: AttributeValue | None) -> Self | None:
        return None if value is None else cls(code=value.code, label=value.label)


class ProductImageOut(BaseModel):
    id: UUID
    url: str
    alt: str

    @classmethod
    def from_domain(cls, image: ProductImage) -> Self:
        return cls(id=image.id, url=_image_url(image.storage_path), alt=image.alt)


class ProductSummaryOut(BaseModel):
    # Los atributos opcionales siempre aparecen, con null si no aplican (CATALOG-R5).
    id: UUID
    slug: str
    sku: str
    name: str
    category: CategoryRefOut
    price: Money  # precio que se cobra (CATALOG-R13)
    movement: AttributeValueOut | None
    case_material: AttributeValueOut | None
    case_diameter_mm: float | None
    water_resistance_m: int | None
    main_image: ProductImageOut  # nunca null en publicados (CATALOG-R2 y R11)

    @classmethod
    def from_domain(cls, summary: ProductSummary) -> Self:
        product = summary.product
        diameter = product.case_diameter_mm
        return cls(
            id=product.id,
            slug=product.slug,
            sku=product.sku,
            name=product.name,
            category=CategoryRefOut(slug=summary.category.slug, name=summary.category.name),
            price=Money(amount=product.price),
            movement=AttributeValueOut.from_domain(summary.movement),
            case_material=AttributeValueOut.from_domain(summary.case_material),
            case_diameter_mm=None if diameter is None else float(diameter),
            water_resistance_m=product.water_resistance_m,
            main_image=ProductImageOut.from_domain(summary.main_image),
        )


class SpecOut(BaseModel):
    label: str
    value: str


class ProductDetailOut(ProductSummaryOut):
    description: str  # texto plano (CATALOG-R12)
    specs: list[SpecOut]
    images: list[ProductImageOut]
    related: list[ProductSummaryOut]


class ProductPageOut(BaseModel):
    items: list[ProductSummaryOut]
    total: int
    page: int
    page_size: int


class AttributesOut(BaseModel):
    movements: list[AttributeValueOut]
    case_materials: list[AttributeValueOut]


# --- Rutas públicas ---

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])


def _not_found() -> AppError:
    return AppError("not_found", "Producto no encontrado.", 404)


@router.get("/products", responses={422: ERROR_RESPONSES[422]})
def list_products(params: Annotated[ProductListIn, Query()], repo: Products) -> ProductPageOut:
    query = params.to_domain()
    page = repo.list_published(query)
    return ProductPageOut(
        items=[ProductSummaryOut.from_domain(summary) for summary in page.items],
        total=page.total,
        page=query.page,
        page_size=query.page_size,
    )


# 422 solo sustituye el HTTPValidationError que FastAPI añade a toda ruta con parámetros:
# un slug de texto nunca falla la validación, y uno mal formado responde 404.
@router.get("/products/{slug}", responses={s: ERROR_RESPONSES[s] for s in (404, 422)})
def get_product(slug: str, repo: Products) -> ProductDetailOut:
    try:
        check_slug(slug)  # un NUL u otro texto imposible no llega a la BD
    except CatalogError:
        raise _not_found() from None
    summary = repo.get_published(slug)  # CATALOG-R1: borrador e inexistente, mismo 404
    if summary is None:
        raise _not_found()
    product = summary.product
    return ProductDetailOut(
        **dict(ProductSummaryOut.from_domain(summary)),
        description=product.description,
        specs=[SpecOut(label=spec.label, value=spec.value) for spec in product.specs],
        images=[ProductImageOut.from_domain(image) for image in repo.list_images(product.id)],
        related=[ProductSummaryOut.from_domain(item) for item in repo.related(product)],
    )


@router.get("/categories")
def list_categories(repo: Categories) -> list[CategoryOut]:
    return [
        CategoryOut(slug=category.slug, name=category.name, description=category.description)
        for category in repo.list_active()
    ]


@router.get("/attributes")
def list_attributes(repo: Attributes) -> AttributesOut:
    def values(kind: AttributeKind) -> list[AttributeValueOut]:
        return [AttributeValueOut(code=v.code, label=v.label) for v in repo.list_active(kind)]

    return AttributesOut(
        movements=values(AttributeKind.MOVEMENT),
        case_materials=values(AttributeKind.CASE_MATERIAL),
    )
