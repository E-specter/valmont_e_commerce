"""Concurrencia del puerto de cart para orders (T-059; CA-CART-14, R10, R11): dos conexiones reales,
cada una en su transacción, contra valmont_test. Los datos se confirman, así que cada prueba borra
lo suyo (el perfil arrastra su carrito y sus líneas por CASCADE). Reutiliza `race` de
test_concurrency.py: la primera trabaja sin confirmar hasta que la segunda espera un bloqueo."""

from collections.abc import Callable, Iterator
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_cart, add_item, add_listed, add_profile, lines_of
from tests.cart.test_concurrency import race
from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import (
    AddToCart,
    CheckoutBlocked,
    CheckoutCart,
    EmptySelection,
    PrepareCheckout,
    RemoveCheckedOutItems,
)

pytestmark = pytest.mark.integration

Lines = tuple[tuple[int, bool], ...]  # (cantidad, seleccionado) por producto
Committed = Callable[[Lines], tuple[UUID, UUID, list[UUID]]]


@pytest.fixture
def committed(db_engine: Engine) -> Iterator[Committed]:
    """Confirma un perfil, su carrito con las líneas dadas y un producto publicado con 20 en stock
    por línea (más un producto libre al final, fuera del carrito); al final borra lo suyo."""
    made: list[tuple[UUID, list[UUID]]] = []

    def create(lines: Lines) -> tuple[UUID, UUID, list[UUID]]:
        with Session(db_engine) as session, session.begin():
            user = add_profile(session)
            cart_id = add_cart(session, user)
            products = [add_listed(session, on_hand=20) for _ in range(len(lines) + 1)]
            for product, (quantity, selected) in zip(products, lines, strict=False):
                add_item(session, cart_id, product, quantity, selected=selected)
        made.append((user, products))
        return user, cart_id, products

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


def checkout(user: UUID) -> Callable[[Session], CheckoutCart | Exception]:
    """`PrepareCheckout` + `RemoveCheckedOutItems` como los usaría orders. Devuelve el error del
    paquete en vez de lanzarlo, para que la transacción termine y la carrera se pueda observar."""

    def work(session: Session) -> CheckoutCart | Exception:
        carts = SqlCartRepository(session)
        try:
            result = PrepareCheckout(carts, SqlCartCatalog(session))(user)
        except (EmptySelection, CheckoutBlocked) as error:
            return error
        RemoveCheckedOutItems(carts)(user, [ln.product_id for ln in result.lines])
        return result

    return work


def add_to_cart(user: UUID, product: UUID, quantity: int) -> Callable[[Session], Any]:
    def work(session: Session) -> Any:
        return AddToCart(SqlCartRepository(session), SqlCartCatalog(session))(
            user, product, quantity
        )

    return work


def stored(engine: Engine, cart_id: UUID) -> dict[UUID, tuple[int, bool]]:
    with Session(engine) as session:
        return lines_of(session, cart_id)


# CA-CART-14: dos confirmaciones simultáneas del mismo cliente
def test_second_checkout_waits_for_the_first_and_gets_an_empty_selection(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (a, b, _) = committed(((2, True), (1, True)))

    first, second = race(db_engine, checkout(user), checkout(user))

    assert isinstance(first, CheckoutCart)
    assert {ln.product_id for ln in first.lines} == {a, b}
    assert isinstance(second, EmptySelection)  # esperó el commit y ya no encuentra nada
    assert stored(db_engine, cart_id) == {}


def test_second_checkout_does_not_buy_the_lines_of_the_first_twice_but_keeps_unselected(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (bought, unselected, _) = committed(((1, True), (3, False)))

    first, second = race(db_engine, checkout(user), checkout(user))

    assert isinstance(first, CheckoutCart) and isinstance(second, EmptySelection)
    assert [ln.product_id for ln in first.lines] == [bought]
    assert stored(db_engine, cart_id) == {unselected: (3, False)}


# CA-CART-14: una escritura del carrito en paralelo con PrepareCheckout se serializa
def test_an_add_waits_for_a_checkout_in_progress_and_its_line_is_not_lost(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (a, b, extra) = committed(((2, True), (1, True)))

    first, second = race(db_engine, checkout(user), add_to_cart(user, extra, 2))

    assert isinstance(first, CheckoutCart)
    assert {ln.product_id for ln in first.lines} == {a, b}  # la compra no incluye la línea nueva
    assert second.can_checkout is True
    assert stored(db_engine, cart_id) == {extra: (2, True)}  # la nueva sobrevive al retirar


def test_a_checkout_waits_for_an_add_in_progress_and_sees_its_line(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (a, b, extra) = committed(((1, True), (1, True)))

    _, second = race(db_engine, add_to_cart(user, extra, 3), checkout(user))

    assert isinstance(second, CheckoutCart)  # ve la línea que la primera aún no había confirmado
    assert {(ln.product_id, ln.quantity) for ln in second.lines} == {(a, 1), (b, 1), (extra, 3)}
    assert stored(db_engine, cart_id) == {}  # lo comprado, incluida la línea nueva, se retiró


def test_a_readded_product_during_a_checkout_is_a_fresh_line_not_a_mix(
    db_engine: Engine, committed: Committed
) -> None:
    # El agregado espera la compra; cuando entra, el producto ya no está: línea nueva de 1.
    user, cart_id, (bought, _) = committed(((4, True),))

    first, _ = race(db_engine, checkout(user), add_to_cart(user, bought, 1))

    assert isinstance(first, CheckoutCart)
    assert [(ln.product_id, ln.quantity) for ln in first.lines] == [(bought, 4)]
    assert stored(db_engine, cart_id) == {bought: (1, True)}


# R11: si la transacción de orders se deshace, el carrito queda igual
def test_rolling_back_the_callers_transaction_leaves_the_cart_untouched(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (a, b, _) = committed(((2, True), (3, False)))

    with Session(db_engine) as session:
        result = checkout(user)(session)
        assert isinstance(result, CheckoutCart)
        assert lines_of(session, cart_id) == {b: (3, False)}  # dentro de la transacción
        session.rollback()  # orders la deshace

    assert stored(db_engine, cart_id) == {a: (2, True), b: (3, False)}


def test_a_blocked_checkout_commits_with_the_cart_intact(
    db_engine: Engine, committed: Committed
) -> None:
    user, cart_id, (a, _) = committed(((2, True),))
    with Session(db_engine) as session, session.begin():
        session.execute(
            text("UPDATE app.inventory_items SET on_hand = 0 WHERE product_id = :p"), {"p": a}
        )

    with Session(db_engine) as session, session.begin():
        result = checkout(user)(session)

    assert isinstance(result, CheckoutBlocked)
    assert stored(db_engine, cart_id) == {a: (2, True)}
