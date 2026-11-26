"""Falsos de wishlist para las pruebas de aplicación (sin BD): repositorio y catálogo en memoria
con la semántica de los puertos (`WishlistRepository`, `WishlistCatalog`)."""

from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from valmont.modules.wishlist.application import WishlistEntry
from valmont.shared.product_snapshots import ProductSnapshot

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
USER = uuid4()
RETIRED = ("Reloj retirado", "reloj-retirado")


class FakeWishlists:
    """Más reciente primero (R8): `add` inserta al principio. `read_only` hace fallar toda
    escritura (la lectura no escribe, UC-WISH-01)."""

    def __init__(
        self, lists: dict[UUID, list[WishlistEntry]] | None = None, *, read_only: bool = False
    ) -> None:
        self.lists = lists if lists is not None else {}
        self.read_only = read_only
        self.writes: list[tuple[str, UUID, UUID]] = []

    def list_for_user(self, user_id: UUID) -> tuple[WishlistEntry, ...]:
        return tuple(self.lists.get(user_id, ()))

    def add(self, user_id: UUID, product_id: UUID, now: datetime) -> bool:
        assert not self.read_only, "la lectura no escribe"
        self.writes.append(("add", user_id, product_id))
        entries = self.lists.setdefault(user_id, [])
        if any(e.product_id == product_id for e in entries):
            return False
        entries.insert(0, WishlistEntry(product_id, now))
        return True

    def remove(self, user_id: UUID, product_id: UUID) -> bool:
        assert not self.read_only, "la lectura no escribe"
        self.writes.append(("remove", user_id, product_id))
        entries = self.lists.get(user_id, [])
        kept = [e for e in entries if e.product_id != product_id]
        self.lists[user_id] = kept
        return len(kept) != len(entries)

    def products_of(self, user_id: UUID) -> list[UUID]:
        return [e.product_id for e in self.lists.get(user_id, [])]


class FakeCatalog:
    def __init__(
        self, *snapshots: ProductSnapshot, hidden: dict[UUID, tuple[str, str]] | None = None
    ) -> None:
        self.published = {s.product_id: s for s in snapshots}
        self.hidden = hidden or {}
        self.published_calls: list[set[UUID]] = []
        self.names_calls: list[set[UUID]] = []

    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]:
        self.published_calls.append(set(product_ids))
        return {i: self.published[i] for i in product_ids if i in self.published}

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]:
        self.names_calls.append(set(product_ids))
        names = {i: (s.name, s.slug) for i, s in self.published.items()} | self.hidden
        return {i: names[i] for i in product_ids if i in names}


def snapshot(
    *,
    price: int = 100000,
    list_price: int | None = None,
    availability: str = "in_stock",
    lead: int | None = None,
    promotion: UUID | None = None,
    image: str | None = "p/frontal.jpg",
) -> ProductSnapshot:
    product_id = uuid4()
    list_price = price if list_price is None else list_price
    return ProductSnapshot(
        product_id=product_id,
        sku=f"SKU-{product_id.hex[:6]}",
        slug=f"slug-{product_id.hex[:6]}",
        name=f"Reloj {product_id.hex[:6]}",
        image_path=image,
        alt="Vista frontal" if image else None,
        order_policy="stock",
        available=7,
        availability_status=availability,
        lead_time_days=lead,
        list_price=list_price,
        price=price,
        discount_amount=list_price - price,
        promotion_id=promotion,
    )


def entries(*product_ids: UUID) -> list[WishlistEntry]:
    """Entradas en el orden dado (la primera, la más reciente), un minuto entre sí."""
    return [WishlistEntry(p, NOW - timedelta(minutes=n)) for n, p in enumerate(product_ids)]
