"""`GetWishlist` (UC-WISH-01) con repositorio y catálogo falsos: R5, R6, R7, R8 y que la lectura
no escribe (T-067; CA-WISH-01, 07, 08 en su parte de aplicación)."""

from uuid import UUID, uuid4

from tests.wishlist.wishlist_fakes import (
    NOW,
    RETIRED,
    USER,
    FakeCatalog,
    FakeWishlists,
    entries,
    snapshot,
)
from valmont.modules.wishlist.application import GetWishlist, WishlistItemView, WishlistView
from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistItemStatus

AVAILABLE = WishlistItemStatus.AVAILABLE
UNAVAILABLE = WishlistItemStatus.UNAVAILABLE


def read(wishlists: FakeWishlists, catalog: FakeCatalog) -> WishlistView:
    return GetWishlist(wishlists, catalog)(USER)


def item(view: WishlistView, product_id: UUID) -> WishlistItemView:
    return next(entry for entry in view.items if entry.product_id == product_id)


# CA-WISH-01: lista vacía; la lectura no escribe ni consulta el catálogo con ids
def test_a_user_without_rows_gets_an_empty_view_with_the_cap() -> None:
    catalog = FakeCatalog()

    view = read(FakeWishlists(read_only=True), catalog)

    assert view == WishlistView(items=(), max_items=50)
    assert WISHLIST_MAX_ITEMS == 50
    assert not any(catalog.published_calls) and not any(catalog.names_calls)


def test_reading_never_writes() -> None:
    a = snapshot()
    wishlists = FakeWishlists({USER: entries(a.product_id)}, read_only=True)

    read(wishlists, FakeCatalog(a))

    assert wishlists.writes == []


# CA-WISH-01 / R8: el orden lo da el repositorio (más reciente primero), no el catálogo
def test_items_keep_the_repository_order_whatever_the_catalog_returns() -> None:
    a, b, c = snapshot(), snapshot(), snapshot()
    wishlists = FakeWishlists({USER: entries(b.product_id, c.product_id, a.product_id)})

    view = read(wishlists, FakeCatalog(c, a, b))

    assert [e.product_id for e in view.items] == [b.product_id, c.product_id, a.product_id]


def test_added_at_comes_from_the_row() -> None:
    a = snapshot()
    wishlists = FakeWishlists({USER: entries(a.product_id)})

    view = read(wishlists, FakeCatalog(a))

    assert view.items[0].added_at == NOW


# SPEC §8 / CA-WISH-11: una lectura para todos los productos, nombres solo de los no publicados
def test_the_catalog_is_asked_once_with_all_the_product_ids() -> None:
    live = [snapshot() for _ in range(3)]
    gone = uuid4()
    catalog = FakeCatalog(*live, hidden={gone: RETIRED})
    wishlists = FakeWishlists({USER: entries(gone, *(s.product_id for s in live))})

    read(wishlists, catalog)

    assert catalog.published_calls == [{gone, *(s.product_id for s in live)}]


def test_names_are_requested_only_for_unpublished_products() -> None:
    live, gone = snapshot(), uuid4()
    catalog = FakeCatalog(live, hidden={gone: RETIRED})
    wishlists = FakeWishlists({USER: entries(live.product_id, gone)})

    read(wishlists, catalog)

    assert catalog.names_calls == [{gone}]


def test_no_names_are_requested_when_everything_is_published() -> None:
    live = snapshot()
    catalog = FakeCatalog(live)

    read(FakeWishlists({USER: entries(live.product_id)}), catalog)

    assert not any(catalog.names_calls)


# CA-WISH-07: datos de un artículo publicado
def test_an_available_item_carries_the_snapshot_data() -> None:
    a = snapshot(price=250000, availability="low_stock")

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert entry == WishlistItemView(
        product_id=a.product_id,
        slug=a.slug,
        name=a.name,
        added_at=NOW,
        status=AVAILABLE,
        sku=a.sku,
        image_path="p/frontal.jpg",
        alt="Vista frontal",
        availability_status="low_stock",
        lead_time_days=None,
        unit_price=250000,
        original_price=None,
        discount_amount=None,
    )


def test_a_promotion_shows_original_price_and_discount() -> None:
    a = snapshot(price=1062500, list_price=1250000, promotion=uuid4())

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert (entry.unit_price, entry.original_price, entry.discount_amount) == (
        1062500,
        1250000,
        187500,
    )


def test_without_a_promotion_original_price_and_discount_are_none() -> None:
    a = snapshot(price=100000)

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert entry.unit_price == 100000
    assert entry.original_price is None and entry.discount_amount is None


def test_a_product_without_image_has_no_image_path_nor_alt() -> None:
    a = snapshot(image=None)

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert entry.image_path is None and entry.alt is None and entry.status == AVAILABLE


def test_on_request_items_carry_their_lead_time() -> None:
    a = snapshot(availability="on_request", lead=21)

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert (entry.availability_status, entry.lead_time_days) == ("on_request", 21)


# CA-WISH-07 / R5: agotado no es un estado de la lista
def test_a_sold_out_item_stays_available_with_out_of_stock_availability() -> None:
    a = snapshot(availability="out_of_stock")

    [entry] = read(FakeWishlists({USER: entries(a.product_id)}), FakeCatalog(a)).items

    assert entry.status == AVAILABLE
    assert entry.availability_status == "out_of_stock"
    assert entry.unit_price == 100000  # sigue mostrando precio


# CA-WISH-08 / R6: despublicado
def test_an_unpublished_item_is_unavailable_with_only_name_and_slug() -> None:
    gone = uuid4()
    wishlists = FakeWishlists({USER: entries(gone)})

    [entry] = read(wishlists, FakeCatalog(hidden={gone: RETIRED})).items

    assert entry == WishlistItemView(
        product_id=gone,
        slug="reloj-retirado",
        name="Reloj retirado",
        added_at=NOW,
        status=UNAVAILABLE,
        sku=None,
        image_path=None,
        alt=None,
        availability_status=None,
        lead_time_days=None,
        unit_price=None,
        original_price=None,
        discount_amount=None,
    )


def test_unavailable_items_stay_in_place_among_available_ones() -> None:
    first, third = snapshot(), snapshot()
    gone = uuid4()
    catalog = FakeCatalog(first, third, hidden={gone: RETIRED})
    wishlists = FakeWishlists({USER: entries(first.product_id, gone, third.product_id)})

    view = read(wishlists, catalog)

    assert [(e.product_id, e.status) for e in view.items] == [
        (first.product_id, AVAILABLE),
        (gone, UNAVAILABLE),
        (third.product_id, AVAILABLE),
    ]


def test_an_unavailable_item_has_no_data_beyond_name_and_slug() -> None:
    live, gone = snapshot(), uuid4()
    wishlists = FakeWishlists({USER: entries(live.product_id, gone)})

    view = read(wishlists, FakeCatalog(live, hidden={gone: RETIRED}))

    assert item(view, live.product_id).unit_price is not None
    hidden = item(view, gone)
    assert hidden.status == UNAVAILABLE
    assert hidden.sku is None and hidden.unit_price is None and hidden.availability_status is None


# RN-10: solo la lista del usuario pedido
def test_only_the_requested_users_rows_are_read() -> None:
    mine, theirs = snapshot(), snapshot()
    other = uuid4()
    wishlists = FakeWishlists({USER: entries(mine.product_id), other: entries(theirs.product_id)})
    catalog = FakeCatalog(mine, theirs)

    view = read(wishlists, catalog)

    assert [e.product_id for e in view.items] == [mine.product_id]
    assert catalog.published_calls == [{mine.product_id}]
