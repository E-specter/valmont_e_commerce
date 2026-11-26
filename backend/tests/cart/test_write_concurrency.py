"""Concurrencia de las escrituras de cart (T-058; CA-CART-02 y R1): dos conexiones reales, cada una
en su transacción, contra valmont_test. Los datos se confirman, así que cada prueba borra lo suyo
(el perfil arrastra su carrito y sus líneas por CASCADE)."""

from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_listed, add_profile, carts_of, lines_of
from tests.cart.test_concurrency import race
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import AddToCart
from valmont.modules.cart.domain import QuantityLimit
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import get_settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ITEMS = "/api/v1/cart/items"
Committed = Callable[[int], tuple[UUID, list[UUID]]]


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Committed]:
    """Confirma un perfil y `n` productos publicados con 20 en stock; al final borra lo suyo."""
    made: list[tuple[UUID, list[UUID]]] = []

    def create(n: int) -> tuple[UUID, list[UUID]]:
        with Session(db_engine) as session, session.begin():
            user = add_profile(session)
            products = [add_listed(session, on_hand=20) for _ in range(n)]
        made.append((user, products))
        return user, products

    yield create
    with Session(db_engine) as session, session.begin():
        for user, products in made:
            ids = {"ids": products}
            categories = session.scalars(
                text("SELECT category_id FROM app.products WHERE id = ANY(:ids)"), ids
            ).all()
            session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})
            session.execute(
                text("DELETE FROM app.inventory_items WHERE product_id = ANY(:ids)"), ids
            )
            session.execute(text("DELETE FROM app.products WHERE id = ANY(:ids)"), ids)
            session.execute(
                text("DELETE FROM app.categories WHERE id = ANY(:ids)"), {"ids": list(categories)}
            )


def add_to_cart(user: UUID, product: UUID, quantity: int) -> Callable[[Session], Any]:
    """`AddToCart` de la firma pública; devuelve el error del dominio en vez de lanzarlo, para que
    la transacción de la prueba termine y la carrera se pueda observar."""

    def work(session: Session) -> Any:
        use_case = AddToCart(SqlCartRepository(session), SqlCartCatalog(session))
        try:
            return use_case(user, product, quantity)
        except QuantityLimit as error:
            return error

    return work


def test_second_writer_waits_sees_the_first_line_and_the_cap_holds(
    db_engine: Engine, committed: Committed
) -> None:
    # R1: dos agregados de 3 del mismo producto no superan 5: el segundo espera, ve 3 y se
    # rechaza (3 + 3); la línea de la primera no se pierde.
    user, (product,) = committed(1)

    first, second = race(db_engine, add_to_cart(user, product, 3), add_to_cart(user, product, 3))

    assert not isinstance(first, QuantityLimit)
    assert isinstance(second, QuantityLimit)
    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {product: (3, True)}


def test_two_writers_of_the_same_product_sum_both_requests(
    db_engine: Engine, committed: Committed
) -> None:
    user, (product,) = committed(1)

    race(db_engine, add_to_cart(user, product, 2), add_to_cart(user, product, 2))

    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {product: (4, True)}


def test_two_writers_of_different_products_keep_both_lines(
    db_engine: Engine, committed: Committed
) -> None:
    user, (a, b) = committed(2)

    race(db_engine, add_to_cart(user, a, 1), add_to_cart(user, b, 2))

    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {a: (1, True), b: (2, True)}


# HTTP de punta a punta: dos POST simultáneos con conexiones reales (sin SAVEPOINT).
@pytest.fixture
def real_client(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    use_test_auth(monkeypatch)
    get_settings.cache_clear()
    profiles = InMemoryProfiles()
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with Session(db_engine) as session, session.begin():
            yield session

    app.dependency_overrides[get_session] = request_session
    client = TestClient(app, raise_server_exceptions=False)
    client.profiles = profiles  # type: ignore[attr-defined]
    yield client
    get_settings.cache_clear()


def post_twice(client: TestClient, user: UUID, product: UUID, quantity: int) -> list[Any]:
    client.profiles.rows[user] = Profile(user, Role.CUSTOMER, T0, T0)  # type: ignore[attr-defined]
    headers = {"Authorization": f"Bearer {make_token(str(user))}"}
    body = {"product_id": str(product), "quantity": quantity}

    with ThreadPoolExecutor(2) as pool:
        return list(pool.map(lambda _: client.post(ITEMS, headers=headers, json=body), range(2)))


def test_two_simultaneous_posts_sum_once_per_request_without_500(
    db_engine: Engine, real_client: TestClient, committed: Committed
) -> None:
    # CA-CART-02: con 2 + 2 las dos se aplican; un solo carrito.
    user, (product,) = committed(1)

    responses = post_twice(real_client, user, product, 2)

    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {product: (4, True)}


def test_two_simultaneous_posts_never_exceed_the_cap(
    db_engine: Engine, real_client: TestClient, committed: Committed
) -> None:
    # 3 + 3 > 5: exactamente una gana, la otra recibe 409 quantity_limit; nunca 500 ni 6.
    user, (product,) = committed(1)

    responses = post_twice(real_client, user, product, 3)

    assert sorted(r.status_code for r in responses) == [200, 409], [r.text for r in responses]
    loser = next(r for r in responses if r.status_code == 409)
    assert loser.json()["error"]["code"] == "quantity_limit"
    with Session(db_engine) as session:
        (cart_id,) = carts_of(session, user)
        assert lines_of(session, cart_id) == {product: (3, True)}
