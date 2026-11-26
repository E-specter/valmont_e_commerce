"""Lector compartido de productos (SPEC wishlist §8, D-039.4): cart y wishlist."""

from collections.abc import Collection
from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID

from sqlalchemy import Integer, Text, Uuid, column, select, table, true
from sqlalchemy.orm import Session

from valmont.shared.config import Settings, get_settings


@dataclass(frozen=True)
class ProductSnapshot:
    product_id: UUID
    sku: str
    slug: str
    name: str
    image_path: str | None
    alt: str | None
    order_policy: str
    available: int
    availability_status: str
    lead_time_days: int | None
    list_price: int
    price: int
    discount_amount: int
    promotion_id: UUID | None


def image_url(storage_path: str, settings: Settings | None = None) -> str:
    """URL pública de Storage; `settings` solo para quien ya lo resuelve (catalog)."""
    settings = settings or get_settings()
    base = settings.storage_public_url or settings.supabase_url
    if not base:
        raise RuntimeError("Falta STORAGE_PUBLIC_URL o SUPABASE_URL en el entorno (backend/.env).")
    return f"{base.rstrip('/')}/storage/v1/object/public/products/{quote(storage_path)}"


# Lectura de otros módulos (modules.md §3, excepción 6): tablas ligeras de solo lectura, nunca
# sus modelos; mismo patrón que catalog para las vistas de inventory y promotions.
_PRODUCT = table(
    "products",
    column("id", Uuid),
    column("sku", Text),
    column("slug", Text),
    column("name", Text),
    column("status", Text),
    column("order_policy", Text),
    schema="app",
)
_IMAGE = table(
    "product_images",
    column("product_id", Uuid),
    column("storage_path", Text),
    column("alt", Text),
    column("position", Integer),
    schema="app",
)
_AVAILABILITY = table(
    "product_availability",
    column("product_id", Uuid),
    column("available", Integer),
    column("status", Text),
    column("lead_time_days", Integer),
    schema="app",
)
_PRICE_VIEW = table(
    "product_effective_price",
    column("product_id", Uuid),
    column("list_price_cents", Integer),
    column("effective_price_cents", Integer),
    column("discount_amount_cents", Integer),
    column("promotion_id", Uuid),
    schema="app",
)


class SqlProductSnapshots:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]:
        ids = set(product_ids)
        if not ids:
            return {}
        image = (
            select(_IMAGE.c.storage_path, _IMAGE.c.alt)
            .where(_IMAGE.c.product_id == _PRODUCT.c.id)
            .order_by(_IMAGE.c.position)
            .limit(1)
            .lateral("image")
        )
        price = (
            select(_PRICE_VIEW).where(_PRICE_VIEW.c.product_id == _PRODUCT.c.id).lateral("price")
        )
        stmt = (
            select(
                _PRODUCT.c.id, _PRODUCT.c.sku, _PRODUCT.c.slug, _PRODUCT.c.name,
                _PRODUCT.c.order_policy, image.c.storage_path, image.c.alt,
                _AVAILABILITY.c.available, _AVAILABILITY.c.status, _AVAILABILITY.c.lead_time_days,
                price.c.list_price_cents, price.c.effective_price_cents,
                price.c.discount_amount_cents, price.c.promotion_id,
            )
            .join(_AVAILABILITY, _AVAILABILITY.c.product_id == _PRODUCT.c.id)
            .join(price, true())
            .outerjoin(image, true())
            .where(_PRODUCT.c.id.in_(ids), _PRODUCT.c.status == "published")
        )  # fmt: skip
        return {
            r[0]: ProductSnapshot(
                product_id=r[0], sku=r[1], slug=r[2], name=r[3], order_policy=r[4],
                image_path=r[5], alt=r[6], available=r[7], availability_status=r[8],
                lead_time_days=r[9], list_price=r[10], price=r[11], discount_amount=r[12],
                promotion_id=r[13],
            )
            for r in self._session.execute(stmt)
        }  # fmt: skip

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]:
        ids = set(product_ids)
        if not ids:
            return {}
        stmt = select(_PRODUCT.c.id, _PRODUCT.c.name, _PRODUCT.c.slug).where(_PRODUCT.c.id.in_(ids))
        return {r[0]: (r[1], r[2]) for r in self._session.execute(stmt)}
