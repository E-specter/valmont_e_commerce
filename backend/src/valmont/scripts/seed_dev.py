"""Catálogo ficticio de demostración para desarrollo (T-031, P-CATALOG-1).

    uv run python -m valmont.scripts.seed_dev

Crea 4 categorías, 2 movimientos, 4 materiales y 12 relojes publicados, cada uno con una imagen
de marcador, y el stock de demostración con el que aparecen los cuatro estados de disponibilidad
(T-030). Es idempotente: lo que ya existe (por sku, slug o code) no se vuelve a crear ni a
subir, y el stock solo se fija en los productos sin fila de stock. Se niega a correr con
ENVIRONMENT=prod. Nada de lo que crea es un producto ni un activo real de Valmont: los SKU
empiezan por DEMO- y los nombres llevan "Demo".
"""

import colorsys
import struct
import sys
import zlib
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from valmont.modules.audit.adapters.persistence import SqlAuditRecorder
from valmont.modules.catalog.adapters.admin_http import get_image_storage
from valmont.modules.catalog.adapters.persistence import (
    SqlAttributeRepository,
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.application import (
    Actor,
    AddProductImage,
    CreateCategory,
    CreateProduct,
    ImageStorage,
    ProductRepository,
    PublishProduct,
)
from valmont.modules.catalog.domain import (
    PAGE_SIZE_MAX,
    AdminProductQuery,
    AdminProductView,
    AttributeKind,
    AttributeValue,
    OrderPolicy,
    ProductStatus,
    SpecEntry,
)
from valmont.modules.inventory.adapters.persistence import (
    InventoryItemRow,
    SqlAvailabilityReader,
    SqlMovementRepository,
    SqlStockRepository,
)
from valmont.modules.inventory.application import Actor as InventoryActor
from valmont.modules.inventory.application import RecordMovement
from valmont.modules.inventory.domain import MovementKind
from valmont.modules.promotions.adapters.persistence import PromotionRow, SqlPromotionRepository
from valmont.modules.promotions.application import Actor as PromotionActor
from valmont.modules.promotions.application import CreatePromotion
from valmont.modules.promotions.domain import PromotionKind, PromotionScope
from valmont.shared.config import get_settings
from valmont.shared.db import get_engine

SYSTEM = Actor(None, None)  # AUDIT-R5: actor nulo = sistema
INVENTORY_SYSTEM = InventoryActor(None, None)  # el mismo, para los casos de uso de inventory
PROMOTIONS_SYSTEM = PromotionActor(None, None)  # y para los de promotions
PROMOTION_DAYS = 56  # vigencia de las promociones de demostración: ocho semanas desde hoy
ALT = "Imagen de marcador (demo)"
STOCK_NOTE = "Semilla de demostración"

CATEGORIES: list[dict[str, Any]] = [
    {
        "slug": f"demo-{slug}",
        "name": f"{name} (demo)",
        "description": f"Categoría de demostración: {name.lower()}.",
        "position": n,
    }
    for n, (slug, name) in enumerate(
        [
            ("vestir", "Vestir"),
            ("deportivos", "Deportivos"),
            ("buceo", "Buceo"),
            ("aviador", "Aviador"),
        ]
    )
]

ATTRIBUTES = {
    AttributeKind.MOVEMENT: [
        AttributeValue("automatic", "Automático", 0),
        AttributeValue("manual", "Manual", 1),
    ],
    AttributeKind.CASE_MATERIAL: [
        AttributeValue("steel", "Acero", 0),
        AttributeValue("gold-18k", "Oro de 18 k", 1),
        AttributeValue("titanium", "Titanio", 2),
        AttributeValue("ceramic", "Cerámica", 3),
    ],
}

STOCK, MADE, BACK = OrderPolicy.STOCK, OrderPolicy.MADE_TO_ORDER, OrderPolicy.BACKORDER
# nombre, categoría, precio (céntimos de PEN con IGV), política, plazo, movimiento, material,
# diámetro (mm) y hermeticidad (m). None: sin el atributo (CATALOG-R5).
_TABLE = [
    ("Demo Alba 38", "vestir", 450000, STOCK, None, "automatic", "steel", "38.0", 50),
    ("Demo Brisa 36", "vestir", 380000, STOCK, None, "manual", "gold-18k", "36.0", 30),
    ("Demo Cirro 40", "vestir", 920000, MADE, 60, "manual", "gold-18k", "40.0", None),
    ("Demo Delta 42", "deportivos", 520000, BACK, 21, "automatic", "titanium", "42.0", 100),
    ("Demo Eco 41", "deportivos", 310000, STOCK, None, None, "steel", "41.0", 100),
    ("Demo Faro 44", "deportivos", 680000, BACK, 30, "automatic", "ceramic", "44.0", 200),
    ("Demo Gaviota 42", "buceo", 590000, STOCK, None, "automatic", "steel", "42.0", 300),
    ("Demo Halcón 43", "buceo", 740000, STOCK, None, "automatic", "titanium", "43.5", 500),
    ("Demo Isla 40", "buceo", 1250000, MADE, 90, "automatic", "ceramic", "40.0", 1000),
    ("Demo Jade 39", "aviador", 410000, STOCK, None, "manual", "steel", "39.0", 50),
    ("Demo Kilo 42", "aviador", 560000, BACK, 14, "automatic", "titanium", "42.0", 100),
    ("Demo Lira 37", "aviador", 290000, STOCK, None, None, None, None, None),
]
PRODUCTS: list[dict[str, Any]] = [
    {
        "sku": f"DEMO-{n:03}",
        "name": name,
        "category": f"demo-{category}",
        "description": (
            f"{name} es un reloj ficticio creado para probar la tienda.\n"
            "Sus datos, precios y fotos son de demostración.\n"
            "No es un producto real ni de Valmont."
        ),
        "price": price,
        "order_policy": policy,
        "lead_time_days": lead,
        "movement_code": movement,
        "case_material_code": material,
        "case_diameter_mm": None if diameter is None else Decimal(diameter),
        "water_resistance_m": water,
        "specs": (
            SpecEntry("Calibre", f"Demo C-{n:02}"),
            SpecEntry("Cristal", "Zafiro" if price >= 500000 else "Mineral"),
            SpecEntry("Garantía", "Ficticia (demostración)"),
        ),
    }
    for n, (name, category, price, policy, lead, movement, material, diameter, water) in enumerate(
        _TABLE, start=1
    )
]

# Unidades en stock de demostración (T-030); los demás, sin fila de stock (on_hand 0). Con el
# umbral por defecto (2, D-027) salen los cuatro estados de D-023: in_stock (Alba, Faro, Gaviota
# y Jade; Faro es backorder con stock), low_stock (Brisa y Halcón), out_of_stock (Eco y Lira) y
# on_request (Cirro e Isla por encargo; Delta y Kilo, backorder agotados).
DEMO_STOCK = {
    "DEMO-001": 5,
    "DEMO-002": 2,
    "DEMO-006": 4,
    "DEMO-007": 8,
    "DEMO-008": 1,
    "DEMO-010": 3,
}


def _demo_promotions(by_sku: dict[str, AdminProductView], category_id: Any) -> list[dict[str, Any]]:
    """Un 15 % sobre dos productos y S/ 200 sobre una categoría; Alba (DEMO-001) está en las dos
    y gana el porcentaje (menor precio final, R5)."""
    start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    dates = {"starts_at": start, "ends_at": start + timedelta(days=PROMOTION_DAYS)}
    return [
        {
            "name": "Demo: 15 % en Alba e Isla",
            "kind": PromotionKind.PERCENT,
            "percent_off": 15,
            "amount_off": None,
            "scope": PromotionScope.PRODUCTS,
            "product_ids": [by_sku[sku].product.id for sku in ("DEMO-001", "DEMO-009")],
            "category_id": None,
        }
        | dates,
        {
            "name": "Demo: S/ 200 en Vestir",
            "kind": PromotionKind.FIXED_AMOUNT,
            "percent_off": None,
            "amount_off": 20000,
            "scope": PromotionScope.CATEGORY,
            "product_ids": [],
            "category_id": category_id,
        }
        | dates,
    ]


def placeholder_png(rgb: tuple[int, int, int], size: int = 400) -> bytes:
    """PNG cuadrado de un color liso, generado aquí: ninguna foto real."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data)
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8 bits, RGB
    pixels = zlib.compress((b"\x00" + bytes(rgb) * size) * size, 9)  # filtro 0 en cada fila
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def _color(n: int) -> tuple[int, int, int]:
    red, green, blue = colorsys.hsv_to_rgb(n / len(PRODUCTS), 0.3, 0.85)
    return round(red * 255), round(green * 255), round(blue * 255)


def _products_by_sku(products: ProductRepository) -> dict[str, AdminProductView]:
    found: dict[str, AdminProductView] = {}
    page = 1
    while True:
        result = products.list_all(AdminProductQuery(page=page, page_size=PAGE_SIZE_MAX))
        found |= {view.product.sku: view for view in result.items}
        if page * PAGE_SIZE_MAX >= result.total:
            return found
        page += 1


def seed(session: Session, storage: ImageStorage) -> dict[str, int]:
    """Crea lo que falte y confirma por producto: si algo falla, lo ya hecho se queda."""
    categories, attributes = SqlCategoryRepository(session), SqlAttributeRepository(session)
    products, audit = SqlProductRepository(session), SqlAuditRecorder(session)
    record_movement = RecordMovement(  # caso de uso público de inventory (UC-INVENTORY-01)
        SqlStockRepository(session),
        SqlAvailabilityReader(session),
        SqlMovementRepository(session),
        audit,
    )
    created = {
        "categorías": 0,
        "valores": 0,
        "productos": 0,
        "imágenes": 0,
        "publicados": 0,
        "ajustes de stock": 0,
        "promociones": 0,
    }

    by_slug = {category.slug: category for category in categories.list_all()}
    for fields in CATEGORIES:
        if fields["slug"] not in by_slug:
            by_slug[fields["slug"]] = CreateCategory(categories)(fields)
            created["categorías"] += 1
    for kind, values in ATTRIBUTES.items():
        codes = {value.code for value in attributes.list_all(kind)}
        for value in values:
            if value.code not in codes:
                attributes.add(kind, value)
                created["valores"] += 1
    session.commit()

    by_sku = _products_by_sku(products)
    for n, fields in enumerate(PRODUCTS):
        if (view := by_sku.get(fields["sku"])) is None:
            values = {k: v for k, v in fields.items() if k != "category"}
            values["category_id"] = by_slug[fields["category"]].id
            view = CreateProduct(products, audit)(values, SYSTEM)
            created["productos"] += 1
        if not view.images:
            AddProductImage(products, storage)(view.product.id, placeholder_png(_color(n)), ALT)
            created["imágenes"] += 1
        if view.product.status is not ProductStatus.PUBLISHED:
            PublishProduct(products, categories, audit)(view.product.id, SYSTEM)  # CATALOG-R2
            created["publicados"] += 1
        # Solo sin fila de stock: no pisa lo que haya cambiado el admin ni repite movimientos.
        # Con 0 unidades no hay nada que registrar (sin fila, on_hand ya es 0).
        units = DEMO_STOCK.get(fields["sku"], 0)
        if units and session.get(InventoryItemRow, view.product.id) is None:
            adjust = MovementKind.AJUSTE_INVENTARIO
            record_movement(view.product.id, adjust, units, STOCK_NOTE, INVENTORY_SYSTEM)
            created["ajustes de stock"] += 1
        session.commit()

    # Promociones de demostración: por nombre, sin repetirse (UC-PROMOTIONS-01, AUDIT-R5).
    promotions = SqlPromotionRepository(session)
    existing = set(session.scalars(select(PromotionRow.name)))
    for fields in _demo_promotions(_products_by_sku(products), by_slug["demo-vestir"].id):
        if fields["name"] not in existing:
            CreatePromotion(promotions, audit)(fields, PROMOTIONS_SYSTEM)
            created["promociones"] += 1
    session.commit()
    return created


def main() -> None:
    if get_settings().environment == "prod":
        sys.exit("seed_dev: se niega a correr con ENVIRONMENT=prod; no se ha escrito nada.")
    with Session(get_engine()) as session:
        created = seed(session, get_image_storage())
    summary = ", ".join(f"{count} {name}" for name, count in created.items())
    print(f"seed_dev: {len(PRODUCTS)} productos de demostración listos (nuevos: {summary}).")


if __name__ == "__main__":
    main()
