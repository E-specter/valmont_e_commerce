from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistFull, WishlistItemStatus
from valmont.shared.product_snapshots import ProductSnapshot


@dataclass(frozen=True)
class WishlistEntry:
    product_id: UUID
    added_at: datetime


class WishlistRepository(Protocol):
    def list_for_user(self, user_id: UUID) -> tuple[WishlistEntry, ...]:
        """Más reciente primero y `product_id` (R8); sin bloqueo."""
        ...

    def add(self, user_id: UUID, product_id: UUID, now: datetime) -> bool:
        """True si insertó, False si ya estaba; InvalidReference si el producto no existe."""
        ...

    def remove(self, user_id: UUID, product_id: UUID) -> bool:
        """True si borró una fila, False si no había."""
        ...


class ProductNotAvailable(Exception):
    """R3: inexistente o no publicado (mismo error para ambos)."""


class WishlistCatalog(Protocol):
    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]: ...

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]: ...


@dataclass(frozen=True)
class WishlistItemView:
    product_id: UUID
    slug: str
    name: str
    added_at: datetime
    status: WishlistItemStatus
    sku: str | None = None
    image_path: str | None = None
    alt: str | None = None
    availability_status: str | None = None
    lead_time_days: int | None = None
    unit_price: int | None = None
    original_price: int | None = None
    discount_amount: int | None = None


@dataclass(frozen=True)
class WishlistView:
    items: tuple[WishlistItemView, ...]
    max_items: int


class GetWishlist:
    def __init__(self, wishlist: WishlistRepository, catalog: WishlistCatalog) -> None:
        self._wishlist = wishlist
        self._catalog = catalog

    def __call__(self, user_id: UUID) -> WishlistView:
        entries = self._wishlist.list_for_user(user_id)
        ids = [e.product_id for e in entries]
        published = self._catalog.get_published(ids)
        names = self._catalog.get_names([i for i in ids if i not in published])
        items: list[WishlistItemView] = []
        for e in entries:
            snap = published.get(e.product_id)
            if snap is None:  # R6: solo nombre y slug
                name, slug = names.get(e.product_id, ("", ""))
                items.append(
                    WishlistItemView(
                        e.product_id, slug, name, e.added_at, WishlistItemStatus.UNAVAILABLE
                    )
                )
                continue
            promoted = snap.promotion_id is not None
            items.append(
                WishlistItemView(
                    e.product_id, snap.slug, snap.name, e.added_at, WishlistItemStatus.AVAILABLE,
                    sku=snap.sku, image_path=snap.image_path, alt=snap.alt,
                    availability_status=snap.availability_status,
                    lead_time_days=snap.lead_time_days, unit_price=snap.price,
                    original_price=snap.list_price if promoted else None,
                    discount_amount=snap.discount_amount if promoted else None,
                )
            )  # fmt: skip
        return WishlistView(tuple(items), WISHLIST_MAX_ITEMS)


class AddToWishlist:
    def __init__(self, wishlist: WishlistRepository, catalog: WishlistCatalog) -> None:
        self._wishlist = wishlist
        self._catalog = catalog

    def __call__(self, user_id: UUID, product_id: UUID) -> WishlistView:
        if product_id not in self._catalog.get_published([product_id]):
            raise ProductNotAvailable(product_id)
        current = self._wishlist.list_for_user(user_id)
        if all(e.product_id != product_id for e in current):
            if len(current) >= WISHLIST_MAX_ITEMS:  # D-039: tope blando, sin bloqueo
                raise WishlistFull
            self._wishlist.add(user_id, product_id, datetime.now(UTC))
        return GetWishlist(self._wishlist, self._catalog)(user_id)


class RemoveFromWishlist:
    def __init__(self, wishlist: WishlistRepository, catalog: WishlistCatalog) -> None:
        self._wishlist = wishlist
        self._catalog = catalog

    def __call__(self, user_id: UUID, product_id: UUID) -> WishlistView:
        self._wishlist.remove(user_id, product_id)
        return GetWishlist(self._wishlist, self._catalog)(user_id)
