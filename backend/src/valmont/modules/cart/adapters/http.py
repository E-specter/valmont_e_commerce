from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import (
    AddToCart,
    CartItemNotFound,
    CartLineView,
    CartView,
    GetCart,
    ItemInsufficientStock,
    ItemOutOfStock,
    ProductNotAvailable,
    RemoveFromCart,
    UpdateCartItem,
)
from valmont.modules.cart.domain import (
    CART_ITEM_MAX_QUANTITY,
    CART_MAX_LINES,
    CartFull,
    CartLineStatus,
    QuantityLimit,
)
from valmont.modules.identity.adapters.http import current_user
from valmont.modules.identity.domain import CurrentUser
from valmont.shared.config import get_settings
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut
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


# --- Escritura (SPEC §7) ---
_CONFLICT = {
    "model": ErrorOut,
    "description": "`quantity_limit`, `out_of_stock`, `insufficient_stock` o `cart_full`.",
}


class CartItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: UUID
    quantity: StrictInt = Field(default=1, ge=1, le=CART_ITEM_MAX_QUANTITY)


class CartItemUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: StrictInt | None = Field(default=None, ge=1, le=CART_ITEM_MAX_QUANTITY)
    selected: StrictBool | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> CartItemUpdateIn:
        if self.quantity is None and self.selected is None:
            raise ValueError("Indica quantity o selected.")
        return self


def _conflict(code: str, message: str, details: dict[str, int]) -> AppError:
    return AppError(code, message, 409, details)


@contextmanager
def _translated() -> Iterator[None]:
    """Errores de dominio y aplicación a HTTP (formato común de error)."""
    try:
        yield
    except ProductNotAvailable:
        field = {"loc": ["body", "product_id"], "type": "value_error", "msg": "No disponible."}
        raise AppError("validation_error", "Datos de entrada no válidos.", 422, [field]) from None
    except CartItemNotFound:
        raise AppError("not_found", "El artículo no está en el carrito.", 404) from None
    except ItemOutOfStock as exc:
        raise _conflict(
            "out_of_stock", "Sin unidades disponibles.", {"max_quantity": exc.max_quantity}
        ) from None
    except ItemInsufficientStock as exc:
        raise _conflict(
            "insufficient_stock", "No hay unidades suficientes.", {"max_quantity": exc.max_quantity}
        ) from None
    except QuantityLimit:
        raise _conflict(
            "quantity_limit",
            "Supera la cantidad máxima por artículo.",
            {"max_quantity": CART_ITEM_MAX_QUANTITY},
        ) from None
    except CartFull:
        raise _conflict(
            "cart_full", "El carrito está lleno.", {"max_lines": CART_MAX_LINES}
        ) from None


def get_add_use_case(session: SessionDep) -> AddToCart:
    return AddToCart(SqlCartRepository(session), SqlCartCatalog(session))


def get_update_use_case(session: SessionDep) -> UpdateCartItem:
    return UpdateCartItem(SqlCartRepository(session), SqlCartCatalog(session))


def get_remove_use_case(session: SessionDep) -> RemoveFromCart:
    return RemoveFromCart(SqlCartRepository(session), SqlCartCatalog(session))


@router.post(
    "/items",
    response_model=CartOut,
    responses={**{s: ERROR_RESPONSES[s] for s in (401, 422, 503)}, 409: _CONFLICT},
)
def add_item(
    body: CartItemIn,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[AddToCart, Depends(get_add_use_case)],
) -> CartOut:
    with _translated():
        view = use_case(user.user_id, body.product_id, body.quantity)
    return CartOut.from_view(view)


@router.patch(
    "/items/{product_id}",
    response_model=CartOut,
    responses={**{s: ERROR_RESPONSES[s] for s in (401, 404, 422, 503)}, 409: _CONFLICT},
)
def update_item(
    product_id: UUID,
    body: CartItemUpdateIn,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[UpdateCartItem, Depends(get_update_use_case)],
) -> CartOut:
    with _translated():
        view = use_case(user.user_id, product_id, body.quantity, body.selected)
    return CartOut.from_view(view)


@router.delete(
    "/items/{product_id}",
    response_model=CartOut,
    responses={s: ERROR_RESPONSES[s] for s in (401, 422, 503)},
)
def remove_item(
    product_id: UUID,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[RemoveFromCart, Depends(get_remove_use_case)],
) -> CartOut:
    return CartOut.from_view(use_case(user.user_id, product_id))
