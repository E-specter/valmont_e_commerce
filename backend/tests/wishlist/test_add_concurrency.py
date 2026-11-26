"""Concurrencia de `AddToWishlist` (CA-WISH-03 y CA-WISH-05; WISH-R1 y R4): dos conexiones reales,
cada una en su transacción y en su hilo, contra valmont_test, con el repositorio y el lector reales.
Los datos se confirman, así que cada prueba borra al final lo suyo.

Mismo producto: una fila y ambos terminan bien. Productos distintos con 49: el tope es blando
(D-039.2), así que se aceptan 50 o 51 filas; no se exige un valor exacto, solo sin error, sin
duplicados y sin pasar de 51."""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed
from tests.cart.test_concurrency import TIMEOUT, in_transaction, race
from tests.wishlist.wishlist_helpers import add_entry, add_profile, entries_of
from valmont.modules.wishlist.adapters.persistence import SqlWishlistRepository
from valmont.modules.wishlist.application import AddToWishlist, WishlistView
from valmont.modules.wishlist.domain import WISHLIST_MAX_ITEMS, WishlistFull
from valmont.shared.product_snapshots import SqlProductSnapshots

pytestmark = pytest.mark.integration


def add(session: Session, user: UUID, product: UUID) -> WishlistView:
    return AddToWishlist(SqlWishlistRepository(session), SqlProductSnapshots(session))(
        user, product
    )


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Callable[[int], tuple[UUID, list[UUID]]]]:
    """Confirma un perfil y `count` productos publicados; al final borra lo suyo (el perfil
    arrastra su lista por CASCADE; productos y categorías se borran después)."""
    made: list[tuple[UUID, list[UUID]]] = []

    def create(count: int) -> tuple[UUID, list[UUID]]:
        with Session(db_engine) as session, session.begin():
            user = add_profile(session)
            products = [add_listed(session, on_hand=3) for _ in range(count)]
        made.append((user, products))
        return user, products

    yield create
    with Session(db_engine) as session, session.begin():
        for user, products in made:
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})
            categories = list(
                session.scalars(
                    text("SELECT category_id FROM app.products WHERE id = ANY(:ids)"),
                    {"ids": products},
                )
            )
            session.execute(
                text("DELETE FROM app.inventory_items WHERE product_id = ANY(:ids)"),
                {"ids": products},
            )
            session.execute(
                text("DELETE FROM app.products WHERE id = ANY(:ids)"), {"ids": products}
            )
            session.execute(
                text("DELETE FROM app.categories WHERE id = ANY(:ids)"), {"ids": categories}
            )


def test_two_simultaneous_adds_of_the_same_product_end_with_one_row_and_no_error(
    db_engine: Engine, committed: Callable[[int], tuple[UUID, list[UUID]]]
) -> None:
    # CA-WISH-03: la segunda espera al INSERT de la primera; ON CONFLICT DO NOTHING no falla.
    user, [product] = committed(1)

    first, second = race(
        db_engine, lambda s: add(s, user, product), lambda s: add(s, user, product)
    )

    for view in (first, second):
        assert [e.product_id for e in view.items] == [product]
    with Session(db_engine) as session:
        assert list(entries_of(session, user)) == [product]


def test_a_repeated_add_after_the_first_commit_keeps_the_original_added_at(
    db_engine: Engine, committed: Callable[[int], tuple[UUID, list[UUID]]]
) -> None:
    user, [product] = committed(1)

    first = in_transaction(db_engine, lambda s: add(s, user, product))
    second = in_transaction(db_engine, lambda s: add(s, user, product))

    assert second.items[0].added_at == first.items[0].added_at
    with Session(db_engine) as session:
        assert len(entries_of(session, user)) == 1


def test_two_simultaneous_adds_of_different_products_with_49_items_never_fail_or_duplicate(
    db_engine: Engine, committed: Callable[[int], tuple[UUID, list[UUID]]]
) -> None:
    # CA-WISH-05: tope blando; en una carrera la lista puede quedar en 51, pero sin 500.
    user, products = committed(WISHLIST_MAX_ITEMS + 1)
    existing, (new_a, new_b) = products[:-2], products[-2:]
    with Session(db_engine) as session, session.begin():
        for product in existing:
            add_entry(session, user, product)
    barrier = threading.Barrier(2, timeout=TIMEOUT)

    def attempt(product: UUID) -> Any:
        def work(session: Session) -> WishlistView | WishlistFull:
            barrier.wait()  # ambos empiezan a la vez para provocar la carrera
            try:
                return add(session, user, product)
            except WishlistFull as exc:
                return exc

        return in_transaction(db_engine, work)

    with ThreadPoolExecutor(2) as pool:
        results = [f.result(TIMEOUT) for f in [pool.submit(attempt, p) for p in (new_a, new_b)]]

    assert all(isinstance(r, WishlistView | WishlistFull) for r in results)
    with Session(db_engine) as session:
        rows = entries_of(session, user)
        total = session.scalar(
            text("SELECT count(*) FROM app.wishlist_items WHERE user_id = :u"), {"u": user}
        )
    assert total == len(rows) and total in (WISHLIST_MAX_ITEMS, WISHLIST_MAX_ITEMS + 1)
    assert set(existing) <= set(rows)  # nada de lo que ya había se pierde
    assert sum(isinstance(r, WishlistView) for r in results) == total - len(existing)


def test_with_50_items_two_simultaneous_adds_of_new_products_are_both_rejected(
    db_engine: Engine, committed: Callable[[int], tuple[UUID, list[UUID]]]
) -> None:
    user, products = committed(WISHLIST_MAX_ITEMS + 2)
    with Session(db_engine) as session, session.begin():
        for product in products[:WISHLIST_MAX_ITEMS]:
            add_entry(session, user, product)

    def attempt(product: UUID) -> object:
        def work(session: Session) -> object:
            try:
                return add(session, user, product)
            except WishlistFull as exc:
                return exc

        return in_transaction(db_engine, work)

    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(attempt, p) for p in products[WISHLIST_MAX_ITEMS:]]
        results = [f.result(TIMEOUT) for f in futures]

    assert all(isinstance(r, WishlistFull) for r in results)  # ya estaba lleno: no hay carrera
    with Session(db_engine) as session:
        assert len(entries_of(session, user)) == WISHLIST_MAX_ITEMS
