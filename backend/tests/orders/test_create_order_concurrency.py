"""Concurrencia de `CreateOrder` (T-074; CA-ORDERS-06, 08 y 24; SPEC §4 R4 y R8): dos conexiones
reales, cada una en su transacción, contra valmont_test, con cart, inventory y orders reales. Los
datos se confirman, así que cada prueba borra lo suyo al final (pedidos, reservas, existencias,
perfiles —con sus carritos por CASCADE—, productos y categorías). La auditoría es en memoria:
`app.audit_log` no admite DELETE. Reutiliza `race` de cart: la primera transacción no confirma
hasta que la segunda espera un bloqueo, así que la carrera ocurre siempre y no solo con suerte."""

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_cart, add_item, add_listed, add_profile
from tests.cart.test_concurrency import TIMEOUT, in_transaction, race
from tests.inventory.inventory_helpers import reserve_stock
from tests.inventory.test_concurrency import PausingStock
from tests.orders.orders_age_helpers import ADULT_BIRTH, set_birth_date
from tests.orders.orders_create_helpers import NOW, Calls, FakeAudit, FakeStore
from tests.orders.orders_helpers import shipping_delivery
from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import (
    CheckoutBlocked,
    EmptySelection,
    PrepareCheckout,
    RemoveCheckedOutItems,
)
from valmont.modules.identity.adapters.persistence import SqlProfileRepository
from valmont.modules.identity.application import EnsureAdult
from valmont.modules.inventory.adapters.persistence import (
    SqlProductPolicies,
    SqlReservationRepository,
)
from valmont.modules.inventory.application import InsufficientStock, ReserveStock
from valmont.modules.orders.adapters.persistence import SqlClock, SqlOrderRepository
from valmont.modules.orders.application import CreatedOrder, CreateOrder
from valmont.modules.orders.domain import IdempotencyConflict, TooManyPendingOrders

pytestmark = pytest.mark.integration

BUSINESS_ERRORS = (
    EmptySelection,
    CheckoutBlocked,
    InsufficientStock,
    TooManyPendingOrders,
    IdempotencyConflict,
)
Outcome = CreatedOrder | Exception


class World:
    """Datos confirmados de una prueba; `cleanup` los borra."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.users: list[UUID] = []
        self.products: list[UUID] = []

    def product(self, on_hand: int | None = 5, **options: Any) -> UUID:
        with Session(self.engine) as session, session.begin():
            product_id = add_listed(session, on_hand=on_hand, **options)
        self.products.append(product_id)
        return product_id

    def user(self, *lines: tuple[UUID, int], birth_date: date | None = ADULT_BIRTH) -> UUID:
        """Cliente con carrito y estas líneas seleccionadas, en este orden de creación. Por
        defecto es mayor de edad (T-139); `birth_date=None` lo deja sin fecha."""
        with Session(self.engine) as session, session.begin():
            user_id = add_profile(session)
            set_birth_date(session, user_id, birth_date)
            cart_id = add_cart(session, user_id)
            for n, (product, quantity) in enumerate(lines):
                add_item(
                    session,
                    cart_id,
                    product,
                    quantity,
                    created_at=NOW + timedelta(minutes=n),
                )
        self.users.append(user_id)
        return user_id

    def count(self, query: str, **params: Any) -> int:
        with Session(self.engine) as session:
            return session.scalar(text(query), params) or 0

    def orders_of(self, user: UUID) -> int:
        return self.count("SELECT count(*) FROM app.orders WHERE user_id = :u", u=user)

    def active_reservations(self, product: UUID) -> int:
        return self.count(
            "SELECT coalesce(sum(quantity), 0) FROM app.stock_reservations"
            " WHERE product_id = :p AND status = 'active'",
            p=product,
        )

    def on_hand(self, product: UUID) -> int:
        return self.count(
            "SELECT on_hand FROM app.inventory_items WHERE product_id = :p", p=product
        )

    def cart_lines(self, user: UUID) -> int:
        return self.count(
            "SELECT count(*) FROM app.cart_items i JOIN app.carts c ON c.id = i.cart_id"
            " WHERE c.user_id = :u",
            u=user,
        )

    def cleanup(self) -> None:
        with Session(self.engine) as session, session.begin():
            ids = {"p": self.products, "u": self.users}
            categories = session.scalars(
                text("SELECT category_id FROM app.products WHERE id = ANY(:p)"), ids
            ).all()
            session.execute(text("DELETE FROM app.orders WHERE user_id = ANY(:u)"), ids)
            session.execute(
                text("DELETE FROM app.stock_reservations WHERE product_id = ANY(:p)"), ids
            )
            session.execute(text("DELETE FROM app.profiles WHERE user_id = ANY(:u)"), ids)
            session.execute(text("DELETE FROM app.inventory_items WHERE product_id = ANY(:p)"), ids)
            session.execute(text("DELETE FROM app.products WHERE id = ANY(:p)"), ids)
            session.execute(
                text("DELETE FROM app.categories WHERE id = ANY(:c)"), {"c": list(categories)}
            )


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    made = World(db_engine)
    yield made
    made.cleanup()


def create_order(session: Session, reserve: ReserveStock | None = None) -> CreateOrder:
    """`CreateOrder` con los adaptadores reales; solo la auditoría y la boutique son en memoria."""
    carts = SqlCartRepository(session)
    calls = Calls()
    return CreateOrder(
        SqlOrderRepository(session),
        PrepareCheckout(carts, SqlCartCatalog(session)),
        RemoveCheckedOutItems(carts),
        reserve or reserve_stock(session),
        FakeStore(calls),
        SqlClock(session),
        FakeAudit(calls),
        EnsureAdult(SqlProfileRepository(session)),
    )


def attempt(
    user: UUID, key: str, reserve: Callable[[Session], ReserveStock] | None = None
) -> Callable[[Session], Outcome]:
    """Un intento de crear el pedido. Devuelve el error de negocio en vez de lanzarlo, para que la
    transacción termine y la carrera se pueda observar; cualquier otro error (un 500) se propaga."""

    def work(session: Session) -> Outcome:
        use_case = create_order(session, reserve(session) if reserve else None)
        try:
            return use_case(user, key, shipping_delivery())
        except BUSINESS_ERRORS as error:
            return error

    return work


def key() -> str:
    return f"key-{uuid4().hex}"


# --------------------------------------------------------------------------------------------
# CA-ORDERS-06: la última unidad pedida a la vez por dos clientes
@pytest.mark.parametrize(
    ("on_hand", "quantity"), [(1, 1), (3, 2), (5, 5)], ids=["una", "tres-pido-dos", "cinco"]
)
def test_two_customers_asking_for_the_same_last_stock_get_exactly_one_order(
    world: World, db_engine: Engine, on_hand: int, quantity: int
) -> None:
    product = world.product(on_hand=on_hand)
    first_user = world.user((product, quantity))
    second_user = world.user((product, quantity))

    first, second = race(db_engine, attempt(first_user, key()), attempt(second_user, key()))

    assert isinstance(first, CreatedOrder) and first.created
    assert isinstance(second, InsufficientStock), second  # esperó el commit y ya no alcanza
    assert second.product_ids == (product,)
    assert (world.orders_of(first_user), world.orders_of(second_user)) == (1, 0)
    assert world.active_reservations(product) == quantity
    assert world.on_hand(product) == on_hand  # reservar no descuenta
    assert world.cart_lines(first_user) == 0  # el que ganó, sin lo comprado
    assert world.cart_lines(second_user) == 1  # el que perdió, con el carrito intacto


def test_the_loser_of_the_race_leaves_no_partial_reservation_for_the_other_lines(
    world: World, db_engine: Engine
) -> None:
    contested, spare = world.product(on_hand=1), world.product(on_hand=9)
    first_user = world.user((contested, 1))
    second_user = world.user((spare, 2), (contested, 1))

    first, second = race(db_engine, attempt(first_user, key()), attempt(second_user, key()))

    assert isinstance(first, CreatedOrder) and isinstance(second, InsufficientStock)
    assert world.active_reservations(spare) == 0  # lo de la otra línea se deshizo con el error
    assert world.orders_of(second_user) == 0 and world.cart_lines(second_user) == 2


# --------------------------------------------------------------------------------------------
# CA-ORDERS-08 / R8: la misma clave desde dos conexiones
def test_two_simultaneous_requests_with_the_same_key_leave_one_order_and_no_error(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 2))
    same = key()

    first, second = race(db_engine, attempt(user, same), attempt(user, same))

    assert isinstance(first, CreatedOrder) and first.created
    assert isinstance(second, (CreatedOrder, IdempotencyConflict)), second
    if isinstance(second, CreatedOrder):  # 201 + 200
        assert second.created is False and second.order.id == first.order.id
    assert world.orders_of(user) == 1
    assert world.active_reservations(product) == 2  # una sola reserva, no dos
    assert world.cart_lines(user) == 0


def test_two_simultaneous_requests_with_different_keys_never_buy_the_same_cart_twice(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user = world.user((product, 1))

    first, second = race(db_engine, attempt(user, key()), attempt(user, key()))

    assert isinstance(first, CreatedOrder) and first.created
    assert isinstance(second, EmptySelection), second  # el carrito está bloqueado: se serializan
    assert world.orders_of(user) == 1 and world.active_reservations(product) == 1


def test_the_same_key_of_two_different_customers_creates_two_orders(
    world: World, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    a, b = world.user((product, 1)), world.user((product, 1))
    same = key()

    with ThreadPoolExecutor(2) as pool:
        results = [
            pool.submit(in_transaction, db_engine, attempt(a, same)),
            pool.submit(in_transaction, db_engine, attempt(b, same)),
        ]
        outcomes = [r.result(TIMEOUT) for r in results]

    assert all(isinstance(o, CreatedOrder) and o.created for o in outcomes)
    assert (world.orders_of(a), world.orders_of(b)) == (1, 1)
    assert world.active_reservations(product) == 2


# --------------------------------------------------------------------------------------------
# CA-ORDERS-24 / R4: mismos productos en distinto orden, sin interbloqueo
def test_two_orders_with_the_same_products_in_opposite_order_do_not_deadlock(
    world: World, db_engine: Engine
) -> None:
    # Sin bloqueos ordenados, cada pedido tomaría un producto y pediría el del otro. `PausingStock`
    # espera a que la otra transacción tenga el suyo: si el orden no es el mismo, se bloquean.
    a, b = world.product(on_hand=5), world.product(on_hand=5)
    first_user = world.user((a, 1), (b, 1))
    second_user = world.user((b, 1), (a, 1))
    barrier = threading.Barrier(2)

    def paused(session: Session) -> ReserveStock:
        return ReserveStock(
            SqlProductPolicies(session),
            PausingStock(session, barrier),
            SqlReservationRepository(session),
        )

    with ThreadPoolExecutor(2) as pool:
        futures = [
            pool.submit(in_transaction, db_engine, attempt(first_user, key(), paused)),
            pool.submit(in_transaction, db_engine, attempt(second_user, key(), paused)),
        ]
        outcomes = [f.result(TIMEOUT) for f in futures]  # un interbloqueo sería un error aquí

    assert all(isinstance(o, CreatedOrder) and o.created for o in outcomes), outcomes
    assert (world.orders_of(first_user), world.orders_of(second_user)) == (1, 1)
    assert (world.active_reservations(a), world.active_reservations(b)) == (2, 2)
    assert (world.on_hand(a), world.on_hand(b)) == (5, 5)


def test_many_customers_buying_the_same_products_in_shuffled_orders_all_finish(
    world: World, db_engine: Engine
) -> None:
    products = [world.product(on_hand=20) for _ in range(4)]
    orders = [
        [products[i], products[(i + 1) % 4], products[(i + 2) % 4], products[(i + 3) % 4]]
        for i in range(4)
    ]
    users = [world.user(*((p, 1) for p in order)) for order in orders]

    with ThreadPoolExecutor(4) as pool:
        futures = [pool.submit(in_transaction, db_engine, attempt(u, key())) for u in users]
        outcomes = [f.result(TIMEOUT) for f in futures]

    assert all(isinstance(o, CreatedOrder) and o.created for o in outcomes), outcomes
    assert [world.active_reservations(p) for p in products] == [4, 4, 4, 4]
