from typing import Protocol
from uuid import UUID

from valmont.modules.catalog.domain import (
    AttributeKind,
    AttributeValue,
    Category,
    Product,
    ProductImage,
    ProductPage,
    ProductQuery,
    ProductSummary,
)

# Puertos de catalog. Los casos de uso llegan con la API pública (T-027) y la de
# administración (T-028); las escrituras lanzan CatalogConflict si la BD rechaza un duplicado.


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


class CategoryRepository(Protocol):
    def add(self, category: Category) -> None:
        """CatalogConflict("slug") si ya existe."""
        ...

    def list_active(self) -> list[Category]:
        """Por posición."""
        ...


class AttributeRepository(Protocol):
    def add(self, kind: AttributeKind, value: AttributeValue) -> None:
        """CatalogConflict("code") si ya existe en esa lista."""
        ...

    def list_active(self, kind: AttributeKind) -> list[AttributeValue]:
        """Por posición."""
        ...
