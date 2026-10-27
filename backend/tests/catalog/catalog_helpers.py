"""Datos de prueba de catalog. Ficticios: ningún nombre, SKU ni texto es de un producto real."""

import struct
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from sqlalchemy.orm import Session

from valmont.modules.catalog.adapters.persistence import (
    SqlAttributeRepository,
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.application import StorageUnavailable
from valmont.modules.catalog.domain import (
    AttributeKind,
    AttributeValue,
    Category,
    OrderPolicy,
    Product,
    ProductImage,
    ProductPage,
    ProductStatus,
    SpecEntry,
    slugify,
)

AT = datetime(2026, 1, 1, tzinfo=UTC)
AUTOMATIC = AttributeValue("prueba-automatico", "Automático (prueba)", position=1)
QUARTZ = AttributeValue("prueba-cuarzo", "Cuarzo (prueba)", position=0)
STEEL = AttributeValue("prueba-acero", "Acero (prueba)")
GOLD = AttributeValue("prueba-oro", "Oro (prueba)")


@dataclass
class Catalog:
    a: Category
    b: Category
    products: dict[str, Product]


def make_category(name: str, **changes: object) -> Category:
    slug = f"{slugify(name)}-{uuid4().hex[:8]}"
    return Category(**{"id": uuid4(), "slug": slug, "name": name, **changes})


def make_product(
    category: Category, name: str, *, days: int | None = 0, **changes: object
) -> Product:
    """Publicado hace `days` días desde AT; days=None es un borrador."""
    fields: dict[str, object] = {
        "id": uuid4(),
        "sku": f"TST-{slugify(name).upper()}",
        "slug": slugify(name),
        "name": name,
        "description": "Reloj ficticio de prueba.",
        "category_id": category.id,
        "price": 100000,
        "status": ProductStatus.DRAFT if days is None else ProductStatus.PUBLISHED,
        "published_at": None if days is None else AT + timedelta(days=days),
    }
    return Product(**{**fields, **changes})


def make_image(product: Product, position: int) -> ProductImage:
    path = f"products/{product.id}/{uuid4()}.webp"
    return ProductImage(uuid4(), product.id, path, f"Vista {position}", position)


def tiny_png() -> bytes:
    """PNG válido de 1×1 píxel blanco, generado aquí: ninguna imagen real."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data)
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1×1, 8 bits, RGB
    pixels = zlib.compress(b"\x00\xff\xff\xff")  # filtro 0 + un píxel blanco
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


class InMemoryStorage:
    """ImageStorage en memoria; fails=True simula Storage caído."""

    def __init__(self, fails: bool = False) -> None:
        self.files: dict[str, tuple[bytes, str]] = {}
        self.fails = fails

    def put(self, path: str, data: bytes, content_type: str) -> None:
        if self.fails:
            raise StorageUnavailable
        self.files[path] = (data, content_type)

    def delete(self, path: str) -> None:
        if self.fails:
            raise StorageUnavailable
        self.files.pop(path, None)


def names(page: ProductPage) -> list[str]:
    return [item.product.name for item in page.items]


def seed_catalog(session: Session) -> Catalog:
    """Dos categorías, cuatro valores de atributo, cuatro publicados y un borrador; sin imágenes."""
    a, b = make_category("Pruebas A"), make_category("Pruebas B")
    for category in (a, b):
        SqlCategoryRepository(session).add(category)
    attributes = SqlAttributeRepository(session)
    for kind, value in [
        (AttributeKind.MOVEMENT, AUTOMATIC),
        (AttributeKind.MOVEMENT, QUARTZ),
        (AttributeKind.CASE_MATERIAL, STEEL),
        (AttributeKind.CASE_MATERIAL, GOLD),
    ]:
        attributes.add(kind, value)
    products = {
        "aurora": make_product(
            a,
            "Aurora de prueba",
            days=1,
            sku="TST-AUR-38",
            description="Aurora ficticia con esfera azul.\nSegunda línea (CATALOG-R12).",
            movement_code=AUTOMATIC.code,
            case_material_code=STEEL.code,
            case_diameter_mm=Decimal("38.0"),
            water_resistance_m=50,
            specs=(SpecEntry("Cristal", "Zafiro"), SpecEntry("Calibre", "TST-01")),
        ),
        "boreal": make_product(
            a,
            "Boreal de prueba",
            days=2,
            description="Cronógrafo ficticio inspirado en la aurora.",
            price=250000,
            order_policy=OrderPolicy.MADE_TO_ORDER,  # D-023
            lead_time_days=30,
            movement_code=QUARTZ.code,
            case_material_code=GOLD.code,
            case_diameter_mm=Decimal("41.5"),
            water_resistance_m=100,
        ),
        # Sin ningún atributo filtrable (CATALOG-R5).
        "cenit": make_product(
            a,
            "Cenit de prueba",
            days=3,
            sku="TST-CEN-36",
            description="Modelo ficticio de vestir con movimiento Automático.",
            price=175000,
        ),
        "draco": make_product(
            a,
            "Draco borrador",
            days=None,
            description="Aurora en borrador, Automático y de vestir.",
            price=90000,
            movement_code=AUTOMATIC.code,
            case_material_code=STEEL.code,
            case_diameter_mm=Decimal("40.0"),
            water_resistance_m=200,
        ),
        "eclipse": make_product(
            b,
            "Eclipse de prueba",
            days=4,
            description="Aurora de otra categoría.",
            price=300000,
            movement_code=AUTOMATIC.code,
        ),
    }
    repo = SqlProductRepository(session)
    for product in products.values():
        repo.add(product)
    return Catalog(a, b, products)
