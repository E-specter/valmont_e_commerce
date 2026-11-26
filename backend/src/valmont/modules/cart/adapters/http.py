from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import CartLineView, CartView, GetCart
from valmont.modules.cart.domain import CartLineStatus
from valmont.modules.identity.adapters.http import current_user
from valmont.modules.identity.domain import CurrentUser
from valmont.shared.config import get_settings
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES
from valmont.shared.money import Money

router = APIRouter(prefix="/api/v1/cart", tags=["cart"])


def _image_url(storage_path: str) -> str:
    """URL pública de Storage, como catalog (SPEC cart §7)."""
    settings = get_settings()
    base = settings.storage_public_url or settings.supabase_url
    if not base:
        raise RuntimeError("Falta STORAGE_PUBLIC_URL o SUPABASE_URL en el entorno (backend/.env).")
    return f"{base.rstrip('/')}/storage/v1/object/public/products/{quote(storage_path)}"


def _money(cents: int | None) -> Money | None:
    return None if cents is None else Money(amount=cents)


class CartImageOut(BaseModel):
    url: str
    alt: str


class CartAvailabilityOut(BaseModel):
    status: Literal["in_stock", "low_stock", "out_of_stock", "on_request"]
    lead_time_days: int | None


class CartItemOut(BaseModel):
    product_id: UUID
    sku: str | None
    slug: str
    name: str
    image: CartImageOut | None
    quantity: int
    selected: bool
    status: CartLineStatus
    availability: CartAvailabilityOut | None
    max_quantity: int
    unit_price: Money | None
    original_price: Money | None
    discount_amount: Money | None
    subtotal: Money | None

    @classmethod
    def from_view(cls, line: CartLineView) -> CartItemOut:
        image = (
            CartImageOut(url=_image_url(line.image_path), alt=line.alt or "")
            if line.image_path
            else None
        )
        availability = (
            CartAvailabilityOut.model_validate(
                {"status": line.availability_status, "lead_time_days": line.lead_time_days}
            )
            if line.availability_status
            else None
        )
        return cls(
            product_id=line.product_id,
            sku=line.sku,
            slug=line.slug,
            name=line.name,
            image=image,
            quantity=line.quantity,
            selected=line.selected,
            status=line.status,
            availability=availability,
            max_quantity=line.max_quantity,
            unit_price=_money(line.unit_price),
            original_price=_money(line.original_price),
            discount_amount=_money(line.discount_amount),
            subtotal=_money(line.subtotal),
        )


class CartOut(BaseModel):
    items: list[CartItemOut]
    item_count: int
    selected_count: int
    total: Money
    can_checkout: bool

    @classmethod
    def from_view(cls, view: CartView) -> CartOut:
        return cls(
            items=[CartItemOut.from_view(line) for line in view.lines],
            item_count=len(view.lines),
            selected_count=view.selected_count,
            total=Money(amount=view.total),
            can_checkout=view.can_checkout,
        )


def get_cart_use_case(session: SessionDep) -> GetCart:
    return GetCart(SqlCartRepository(session), SqlCartCatalog(session))


@router.get("", response_model=CartOut, responses={s: ERROR_RESPONSES[s] for s in (401, 503)})
def read_cart(
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[GetCart, Depends(get_cart_use_case)],
) -> CartOut:
    return CartOut.from_view(use_case(user.user_id))
