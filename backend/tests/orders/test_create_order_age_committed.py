"""La comprobación de edad de `CreateOrder` sin red de seguridad (T-139; CA-IDENTITY-15): datos
confirmados en PostgreSQL, adaptadores reales (cart, inventory, orders, identity) y una transacción
que SÍ se confirma tras el rechazo. Si la edad se comprobara tarde (después de reservar, guardar o
vaciar el carrito), lo escrito quedaría en la BD y aquí se vería; un SAVEPOINT deshecho lo
ocultaría. La auditoría es en memoria (`app.audit_log` no admite DELETE): su ausencia la prueban
las pruebas con falsos y las HTTP."""

from collections.abc import Iterator
from datetime import date

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.orders.orders_age_helpers import ADULT_BIRTH, MINOR_BIRTH
from tests.orders.orders_helpers import pickup_delivery, shipping_delivery
from tests.orders.test_create_order_concurrency import World, create_order, key
from valmont.modules.identity.application import BirthDateRequired, Underage

pytestmark = pytest.mark.integration


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    made = World(db_engine)
    yield made
    made.cleanup()


def attempt(engine: Engine, user: object, error: type[Exception], pickup: bool = False) -> None:
    """Un intento que debe rechazarse por edad; la transacción se confirma igualmente."""
    with Session(engine) as session, session.begin():
        use_case = create_order(session)
        delivery = pickup_delivery() if pickup else shipping_delivery()
        with pytest.raises(error):
            use_case(user, key(), delivery)  # type: ignore[arg-type]


@pytest.mark.parametrize(("born", "error"), [(None, BirthDateRequired), (MINOR_BIRTH, Underage)])
def test_a_rejected_age_leaves_nothing_committed_in_the_database(
    world: World, db_engine: Engine, born: date | None, error: type[Exception]
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 2), birth_date=born)

    attempt(db_engine, user, error)

    assert world.orders_of(user) == 0
    assert world.active_reservations(product) == 0
    assert world.on_hand(product) == 5
    assert world.cart_lines(user) == 1  # el carrito intacto


def test_a_minor_with_an_empty_cart_is_rejected_for_age_and_commits_nothing(
    world: World, db_engine: Engine
) -> None:
    user = world.user(birth_date=MINOR_BIRTH)

    attempt(db_engine, user, Underage)

    assert world.orders_of(user) == 0


def test_a_minor_picking_up_with_no_boutique_commits_nothing(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 1), birth_date=MINOR_BIRTH)

    attempt(db_engine, user, Underage, pickup=True)

    assert world.orders_of(user) == 0 and world.active_reservations(product) == 0


def test_a_minor_does_not_take_the_last_unit_from_an_adult(world: World, db_engine: Engine) -> None:
    """Un menor no bloquea stock: el adulto que viene después compra la última unidad."""
    last = world.product(on_hand=1)
    minor = world.user((last, 1), birth_date=MINOR_BIRTH)
    adult = world.user((last, 1), birth_date=ADULT_BIRTH)

    attempt(db_engine, minor, Underage)
    with Session(db_engine) as session, session.begin():
        created = create_order(session)(adult, key(), shipping_delivery())

    assert created.created is True
    assert world.orders_of(minor) == 0 and world.orders_of(adult) == 1
    assert world.active_reservations(last) == 1


def test_an_adult_still_commits_the_order_the_reservation_and_the_empty_cart(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 2), birth_date=ADULT_BIRTH)

    with Session(db_engine) as session, session.begin():
        created = create_order(session)(user, key(), shipping_delivery())

    assert created.created is True
    assert world.orders_of(user) == 1
    assert world.active_reservations(product) == 2
    assert world.cart_lines(user) == 0


def test_the_check_reads_the_profile_in_the_same_transaction_as_the_order(
    world: World, db_engine: Engine
) -> None:
    """Dos sesiones: la fecha corregida y confirmada se ve en la siguiente solicitud."""
    product = world.product(on_hand=5)
    user = world.user((product, 1), birth_date=MINOR_BIRTH)
    attempt(db_engine, user, Underage)

    with Session(db_engine) as session, session.begin():
        session.execute(
            text("UPDATE app.profiles SET birth_date = :b WHERE user_id = :u"),
            {"b": ADULT_BIRTH, "u": user},
        )
    with Session(db_engine) as session, session.begin():
        created = create_order(session)(user, key(), shipping_delivery())

    assert created.created is True
