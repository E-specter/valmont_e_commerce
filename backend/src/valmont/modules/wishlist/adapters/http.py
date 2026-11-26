from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from valmont.modules.identity.adapters.http import current_user
from valmont.modules.identity.domain import CurrentUser
from valmont.modules.wishlist.adapters.persistence import InvalidReference, SqlWishlistRepository
from valmont.modules.wishlist.application import (
    AddToWishlist,
    GetWishlist,
    ProductNotAvailable,
    RemoveFromWishlist,
    WishlistItemView,
    WishlistView,
)
from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistFull, WishlistItemStatus
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut
from valmont.shared.money import Money
from valmont.shared.product_snapshots import SqlProductSnapshots, image_url

router = APIRouter(prefix="/api/v1/wishlist", tags=["wishlist"])


def _money(cents: int | None) -> Money | None:
    return None if cents is None else Money(amount=cents)


class WishlistImageOut(BaseModel):
    url: str
    alt: str


class WishlistAvailabilityOut(BaseModel):
    status: Literal["in_stock", "low_stock", "out_of_stock", "on_request"]
    lead_time_days: int | None


class WishlistItemOut(BaseModel):
    product_id: UUID
    sku: str | None
    slug: str
    name: str
    status: WishlistItemStatus
    added_at: datetime
    image: WishlistImageOut | None
    availability: WishlistAvailabilityOut | None
    unit_price: Money | None
    original_price: Money | None
    discount_amount: Money | None

    @classmethod
    def from_view(cls, item: WishlistItemView) -> WishlistItemOut:
        image = (
            WishlistImageOut(url=image_url(item.image_path), alt=item.alt or "")
            if item.image_path
            else None
        )
        availability = (
            WishlistAvailabilityOut.model_validate(
                {"status": item.availability_status, "lead_time_days": item.lead_time_days}
            )
            if item.availability_status
            else None
        )
        return cls(
            product_id=item.product_id,
            sku=item.sku,
            slug=item.slug,
            name=item.name,
            status=item.status,
            added_at=item.added_at,
            image=image,
            availability=availability,
            unit_price=_money(item.unit_price),
            original_price=_money(item.original_price),
            discount_amount=_money(item.discount_amount),
        )


class WishlistOut(BaseModel):
    items: list[WishlistItemOut]
    item_count: int
    max_items: int

    @classmethod
    def from_view(cls, view: WishlistView) -> WishlistOut:
        return cls(
            items=[WishlistItemOut.from_view(i) for i in view.items],
            item_count=len(view.items),
            max_items=view.max_items,
        )


class WishlistItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: UUID


_CONFLICT = {"model": ErrorOut, "description": "`wishlist_full`: la lista alcanzó el tope."}


@contextmanager
def _translated() -> Iterator[None]:
    """Errores de dominio y aplicación a HTTP (formato común de error)."""
    try:
        yield
    except ProductNotAvailable, InvalidReference:
        field = {"loc": ["body", "product_id"], "type": "value_error", "msg": "No disponible."}
        raise AppError("validation_error", "Datos de entrada no válidos.", 422, [field]) from None
    except WishlistFull:
        raise AppError(
            "wishlist_full",
            "La lista de deseos está llena.",
            409,
            {"max_items": WISHLIST_MAX_ITEMS},
        ) from None


def get_wishlist_use_case(session: SessionDep) -> GetWishlist:
    return GetWishlist(SqlWishlistRepository(session), SqlProductSnapshots(session))


def get_add_use_case(session: SessionDep) -> AddToWishlist:
    return AddToWishlist(SqlWishlistRepository(session), SqlProductSnapshots(session))


def get_remove_use_case(session: SessionDep) -> RemoveFromWishlist:
    return RemoveFromWishlist(SqlWishlistRepository(session), SqlProductSnapshots(session))


@router.get("", response_model=WishlistOut, responses={s: ERROR_RESPONSES[s] for s in (401, 503)})
def read_wishlist(
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[GetWishlist, Depends(get_wishlist_use_case)],
) -> WishlistOut:
    return WishlistOut.from_view(use_case(user.user_id))


@router.post(
    "/items",
    response_model=WishlistOut,
    responses={**{s: ERROR_RESPONSES[s] for s in (401, 422, 503)}, 409: _CONFLICT},
)
def add_item(
    body: WishlistItemIn,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[AddToWishlist, Depends(get_add_use_case)],
) -> WishlistOut:
    with _translated():
        view = use_case(user.user_id, body.product_id)
    return WishlistOut.from_view(view)


@router.delete(
    "/items/{product_id}",
    response_model=WishlistOut,
    responses={s: ERROR_RESPONSES[s] for s in (401, 422, 503)},
)
def remove_item(
    product_id: UUID,
    user: Annotated[CurrentUser, Depends(current_user)],
    use_case: Annotated[RemoveFromWishlist, Depends(get_remove_use_case)],
) -> WishlistOut:
    return WishlistOut.from_view(use_case(user.user_id, product_id))
