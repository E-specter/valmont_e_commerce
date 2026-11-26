"""`AddToWishlist` (UC-WISH-02) y `RemoveFromWishlist` (UC-WISH-03) con repositorio y catálogo
falsos: R1, R3, R4, R10 (T-068; CA-WISH-02 a 06 en su parte de aplicación)."""

from datetime import timedelta
from uuid import uuid4

import pytest

from tests.wishlist.wishlist_fakes import (
    NOW,
    RETIRED,
    USER,
    FakeCatalog,
    FakeWishlists,
    entries,
    snapshot,
)
from valmont.modules.wishlist.application import (
    AddToWishlist,
    ProductNotAvailable,
    RemoveFromWishlist,
    WishlistView,
)
from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistFull, WishlistItemStatus


def ids(view: WishlistView) -> list[object]:
    return [e.product_id for e in view.items]


def full_list(*, extra_hidden: int = 0) -> tuple[FakeWishlists, FakeCatalog, list[object]]:
    """Lista de 50: publicados y, si se pide, `extra_hidden` despublicados."""
    live = [snapshot() for _ in range(WISHLIST_MAX_ITEMS - extra_hidden)]
    hidden = {uuid4(): RETIRED for _ in range(extra_hidden)}
    order = [s.product_id for s in live] + list(hidden)
    return (
        FakeWishlists({USER: entries(*order)}),
        FakeCatalog(*live, hidden=hidden),
        order,
    )


# CA-WISH-02
def test_adding_a_published_product_puts_it_first_and_returns_the_full_list() -> None:
    old, new = snapshot(), snapshot()
    wishlists = FakeWishlists({USER: entries(old.product_id)})

    view = AddToWishlist(wishlists, FakeCatalog(old, new))(USER, new.product_id)

    assert ids(view) == [new.product_id, old.product_id]  # WISH-R10: la lista completa
    assert wishlists.products_of(USER) == [new.product_id, old.product_id]
    added = view.items[0]
    assert added.status == WishlistItemStatus.AVAILABLE
    assert added.unit_price == new.price and added.availability_status == "in_stock"
    assert view.max_items == 50


def test_adding_to_an_empty_list_creates_the_first_row() -> None:
    a = snapshot()
    wishlists = FakeWishlists()

    view = AddToWishlist(wishlists, FakeCatalog(a))(USER, a.product_id)

    assert ids(view) == [a.product_id] and wishlists.products_of(USER) == [a.product_id]


def test_a_sold_out_published_product_can_be_added() -> None:
    a = snapshot(availability="out_of_stock")

    view = AddToWishlist(FakeWishlists(), FakeCatalog(a))(USER, a.product_id)

    assert ids(view) == [a.product_id]  # guardar lo que no se consigue es el uso normal (R5)


# CA-WISH-03 / R1: idempotente, sin escribir
def test_adding_a_product_already_present_changes_nothing_and_does_not_write() -> None:
    a, b = snapshot(), snapshot()
    wishlists = FakeWishlists({USER: entries(b.product_id, a.product_id)})
    before = list(wishlists.lists[USER])

    view = AddToWishlist(wishlists, FakeCatalog(a, b))(USER, a.product_id)

    assert ids(view) == [b.product_id, a.product_id]
    assert wishlists.lists[USER] == before  # mismo orden y mismo added_at
    assert view.items[1].added_at == before[1].added_at
    assert wishlists.writes == []


# CA-WISH-04 / R3: solo publicados, el mismo error para borrador e inexistente, sin escribir
def test_a_product_that_is_not_published_or_does_not_exist_is_not_addable() -> None:
    draft = uuid4()
    wishlists = FakeWishlists()
    use_case = AddToWishlist(wishlists, FakeCatalog(hidden={draft: RETIRED}))

    for product in (draft, uuid4()):
        with pytest.raises(ProductNotAvailable):  # la misma excepción para ambos casos; el
            use_case(USER, product)  # mensaje HTTP idéntico lo cubren las pruebas HTTP (R3)
    assert wishlists.writes == [] and wishlists.products_of(USER) == []


# CA-WISH-05 / R4: tope blando
def test_with_fifty_items_a_new_product_is_rejected_and_nothing_changes() -> None:
    wishlists, catalog, order = full_list()
    new = snapshot()
    catalog.published[new.product_id] = new

    with pytest.raises(WishlistFull):
        AddToWishlist(wishlists, catalog)(USER, new.product_id)

    assert wishlists.products_of(USER) == order and wishlists.writes == []


def test_with_fifty_items_one_already_present_is_a_200_equivalent_not_an_error() -> None:
    wishlists, catalog, order = full_list()

    view = AddToWishlist(wishlists, catalog)(USER, order[10])

    assert ids(view) == order and wishlists.writes == []


def test_with_forty_nine_items_the_fiftieth_is_accepted() -> None:
    live = [snapshot() for _ in range(WISHLIST_MAX_ITEMS - 1)]
    new = snapshot()
    wishlists = FakeWishlists({USER: entries(*(s.product_id for s in live))})

    view = AddToWishlist(wishlists, FakeCatalog(*live, new))(USER, new.product_id)

    assert len(view.items) == WISHLIST_MAX_ITEMS and view.items[0].product_id == new.product_id


def test_unpublished_items_count_toward_the_cap() -> None:
    wishlists, catalog, order = full_list(extra_hidden=5)
    new = snapshot()
    catalog.published[new.product_id] = new

    with pytest.raises(WishlistFull):
        AddToWishlist(wishlists, catalog)(USER, new.product_id)

    assert wishlists.products_of(USER) == order


def test_after_removing_one_another_can_be_added() -> None:
    wishlists, catalog, order = full_list()
    new = snapshot()
    catalog.published[new.product_id] = new

    RemoveFromWishlist(wishlists, catalog)(USER, order[0])
    view = AddToWishlist(wishlists, catalog)(USER, new.product_id)

    assert len(view.items) == WISHLIST_MAX_ITEMS and new.product_id in ids(view)


def test_the_cap_is_per_user_not_global() -> None:
    wishlists, catalog, _ = full_list()
    other, new = uuid4(), snapshot()
    catalog.published[new.product_id] = new

    view = AddToWishlist(wishlists, catalog)(other, new.product_id)

    assert ids(view) == [new.product_id] and len(wishlists.lists[USER]) == WISHLIST_MAX_ITEMS


# RN-10: solo la lista del usuario
def test_adding_never_touches_another_users_list() -> None:
    a = snapshot()
    other = uuid4()
    wishlists = FakeWishlists({other: entries(a.product_id)})
    before = list(wishlists.lists[other])

    view = AddToWishlist(wishlists, FakeCatalog(a))(USER, a.product_id)

    assert ids(view) == [a.product_id]
    assert wishlists.lists[other] == before
    assert all(user == USER for _, user, _ in wishlists.writes)


# CA-WISH-06 / UC-WISH-03: retirar
def test_removing_deletes_the_row_and_returns_the_list_without_it() -> None:
    a, b = snapshot(), snapshot()
    wishlists = FakeWishlists({USER: entries(b.product_id, a.product_id)})

    view = RemoveFromWishlist(wishlists, FakeCatalog(a, b))(USER, b.product_id)

    assert ids(view) == [a.product_id] and wishlists.products_of(USER) == [a.product_id]
    assert view.items[0].added_at == NOW - timedelta(minutes=1)


def test_removing_twice_is_not_an_error() -> None:
    a = snapshot()
    wishlists = FakeWishlists({USER: entries(a.product_id)})
    use_case = RemoveFromWishlist(wishlists, FakeCatalog(a))

    use_case(USER, a.product_id)
    view = use_case(USER, a.product_id)

    assert view.items == () and view.max_items == 50


def test_removing_a_product_that_was_never_there_returns_the_list_unchanged() -> None:
    a = snapshot()
    wishlists = FakeWishlists({USER: entries(a.product_id)})

    view = RemoveFromWishlist(wishlists, FakeCatalog(a))(USER, uuid4())

    assert ids(view) == [a.product_id]


def test_an_unpublished_product_can_be_removed() -> None:
    gone, live = uuid4(), snapshot()
    wishlists = FakeWishlists({USER: entries(gone, live.product_id)})

    view = RemoveFromWishlist(wishlists, FakeCatalog(live, hidden={gone: RETIRED}))(USER, gone)

    assert ids(view) == [live.product_id]


def test_removing_acts_only_on_the_users_own_rows() -> None:
    a = snapshot()
    other = uuid4()
    wishlists = FakeWishlists({other: entries(a.product_id)})

    view = RemoveFromWishlist(wishlists, FakeCatalog(a))(USER, a.product_id)

    assert view.items == ()
    assert wishlists.products_of(other) == [a.product_id]
    assert all(user == USER for _, user, _ in wishlists.writes)
