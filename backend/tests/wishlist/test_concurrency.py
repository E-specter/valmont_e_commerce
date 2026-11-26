"""Concurrencia del repositorio de wishlist (CA-WISH-03, WISH-R1): dos conexiones reales, cada una
en su transacción y en su hilo, contra valmont_test. Los datos se confirman, así que cada prueba
borra al final lo suyo (el perfil arrastra su lista por CASCADE)."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import race
from tests.wishlist.wishlist_helpers import add_product, add_profile, entries_of
from valmont.modules.wishlist.adapters.persistence import SqlWishlistRepository

pytestmark = pytest.mark.integration

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Callable[[], tuple[UUID, UUID]]]:
    """Confirma un perfil y un producto; al final borra lo suyo."""
    made: list[tuple[UUID, UUID]] = []

    def create() -> tuple[UUID, UUID]:
        with Session(db_engine) as session, session.begin():
            made.append((add_profile(session), add_product(session)))
        return made[-1]

    yield create
    with Session(db_engine) as session, session.begin():
        for user, product in made:
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})
            category = session.scalar(
                text("SELECT category_id FROM app.products WHERE id = :id"), {"id": product}
            )
            session.execute(text("DELETE FROM app.products WHERE id = :id"), {"id": product})
            session.execute(text("DELETE FROM app.categories WHERE id = :id"), {"id": category})


def test_two_connections_adding_the_same_product_end_with_one_row_and_no_error(
    db_engine: Engine, committed: Callable[[], tuple[UUID, UUID]]
) -> None:
    # CA-WISH-03: la segunda espera al INSERT de la primera; ON CONFLICT DO NOTHING no falla.
    user, product = committed()

    first, second = race(
        db_engine,
        lambda session: SqlWishlistRepository(session).add(user, product, NOW),
        lambda session: SqlWishlistRepository(session).add(user, product, NOW),
    )

    assert (first, second) == (True, False)
    with Session(db_engine) as session:
        assert entries_of(session, user) == {product: NOW}
