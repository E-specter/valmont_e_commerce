"""Proveedores de cart e inventory para orders contra la BD de pruebas (T-071; E-1, excepción (7),
CA-ORDERS-06 y 14 dependen de ello). Cada proveedor se llama con la sesión de la prueba y se
comprueba que el caso de uso construido hace lo mismo que el armado a mano. Datos ficticios; la
transacción de cada prueba se deshace. Los datos no se confirman: que el caso de uso los vea
demuestra que corre en la sesión que recibió."""

import inspect
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, get_type_hints
from uuid import UUID, uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_cart, add_item, add_listed, add_profile, lines_of
from tests.inventory.inventory_helpers import (
    consume_reservations,
    reserve_stock,
)
from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.adapters.wiring import get_prepare_checkout, get_remove_checked_out_items
from valmont.modules.cart.application import (
    EmptySelection,
    PrepareCheckout,
    RemoveCheckedOutItems,
)
from valmont.modules.inventory import application as inventory_application
from valmont.modules.inventory import domain as inventory_domain
from valmont.modules.inventory.adapters.persistence import (
    SqlAvailabilityReader,
    SqlReservationRepository,
)
from valmont.modules.inventory.adapters.wiring import (
    get_consume_reservations,
    get_release_reservations,
    get_reserve_stock,
)
from valmont.modules.inventory.application import (
    ConsumeReservations,
    InsufficientStock,
    OrderLine,
    ReleaseReservations,
    ReservationExpired,
    ReserveStock,
)
from valmont.shared.db import SessionDep, get_session

pytestmark = pytest.mark.integration

BASE = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
PROVIDERS = [
    (get_prepare_checkout, PrepareCheckout),
    (get_remove_checked_out_items, RemoveCheckedOutItems),
    (get_reserve_stock, ReserveStock),
    (get_consume_reservations, ConsumeReservations),
    (get_release_reservations, ReleaseReservations),
]


def db_now(session: Session) -> datetime:
    return session.scalars(select(func.now())).one()


def cart_with(session: Session, *lines: tuple[UUID, int, bool]) -> UUID:
    """Usuario con carrito y líneas (producto, cantidad, seleccionado) por SQL."""
    user = add_profile(session)
    cart_id = add_cart(session, user)
    for n, (product_id, quantity, selected) in enumerate(lines):
        created = BASE + timedelta(minutes=n)
        add_item(session, cart_id, product_id, quantity, selected=selected, created_at=created)
    return user


def cart_of(session: Session, user: UUID) -> dict[UUID, tuple[int, bool]]:
    cart_id = session.scalar(text("SELECT id FROM app.carts WHERE user_id = :u"), {"u": user})
    return lines_of(session, cart_id)


def available(session: Session, product_id: UUID) -> int:
    row = SqlAvailabilityReader(session).get(product_id)
    assert row is not None
    return row.available


def on_hand(session: Session, product_id: UUID) -> int:
    return session.scalar(
        text("SELECT on_hand FROM app.inventory_items WHERE product_id = :p"), {"p": product_id}
    )


def statuses(session: Session, order_id: UUID) -> list[str]:
    return [str(r.status) for r in SqlReservationRepository(session).for_order(order_id)]


def sales(session: Session, order_id: UUID) -> list[tuple[str, int, int]]:
    rows = session.execute(
        text(
            "SELECT kind, quantity_delta, on_hand_after FROM app.stock_movements"
            " WHERE order_id = :o ORDER BY id"
        ),
        {"o": order_id},
    )
    return [(kind, delta, after) for kind, delta, after in rows]


# --- forma de los proveedores --------------------------------------------------------------


@pytest.mark.parametrize(("provider", "use_case"), PROVIDERS)
def test_each_provider_builds_the_real_use_case(
    db_session: Session,
    provider,
    use_case: type,  # noqa: ANN001
) -> None:
    assert isinstance(provider(db_session), use_case)


@pytest.mark.parametrize(("provider", "use_case"), PROVIDERS)
def test_each_provider_takes_only_the_request_session(provider, use_case: type) -> None:  # noqa: ANN001
    # Sin lógica ni identidad (SPEC §9, T-071): un único parámetro `session: SessionDep`.
    assert list(inspect.signature(provider).parameters) == ["session"]
    hints = get_type_hints(provider, include_extras=True)
    assert hints["session"] == SessionDep
    assert hints["return"] is use_case


@pytest.mark.parametrize(("provider", "use_case"), PROVIDERS)
def test_a_provider_builds_a_fresh_use_case_per_call(
    db_session: Session,
    provider,
    use_case: type,  # noqa: ANN001
) -> None:
    assert provider(db_session) is not provider(db_session)


def test_the_providers_do_not_commit(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    # Cada caso de uso corre en la transacción de quien lo llama (SPEC §9, ORDERS-R4).
    def forbidden(*_: object) -> None:
        raise AssertionError("un proveedor o su caso de uso hizo commit")

    monkeypatch.setattr(db_session, "commit", forbidden)
    stocked = add_listed(db_session, on_hand=3)
    user = cart_with(db_session, (stocked, 1, True))
    order_id, now = uuid4(), db_now(db_session)

    get_prepare_checkout(db_session)(user)
    get_reserve_stock(db_session)(order_id, [OrderLine(stocked, 1)], now)
    get_consume_reservations(db_session)(order_id, now)
    get_remove_checked_out_items(db_session)(user, [stocked])
    get_release_reservations(db_session)(order_id)


def test_the_providers_work_as_fastapi_dependencies_with_the_request_session(
    db_session: Session,
) -> None:
    stocked = add_listed(db_session, on_hand=3, price=250000)
    user = cart_with(db_session, (stocked, 2, True))
    app = FastAPI()

    @app.get("/probe")
    def probe(
        prepare: Annotated[PrepareCheckout, Depends(get_prepare_checkout)],
        reserve: Annotated[ReserveStock, Depends(get_reserve_stock)],
    ) -> dict[str, int]:
        checkout = prepare(user)
        reserved = reserve(uuid4(), [OrderLine(stocked, 1)], db_now(db_session))
        return {"total": checkout.total, "reserved": len(reserved.reservations)}

    def request_session() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_session] = request_session

    response = TestClient(app).get("/probe")

    assert response.status_code == 200, response.text
    assert response.json() == {"total": 500000, "reserved": 1}


# --- cart ----------------------------------------------------------------------------------


def test_prepare_checkout_returns_the_same_as_the_hand_built_use_case(db_session: Session) -> None:
    a = add_listed(db_session, price=250000, on_hand=10, name="Heritage 38")
    b = add_listed(db_session, price=90000, on_hand=10)
    unselected = add_listed(db_session, price=70000, on_hand=10)
    user = cart_with(db_session, (a, 2, True), (b, 1, True), (unselected, 1, False))

    by_hand = PrepareCheckout(SqlCartRepository(db_session), SqlCartCatalog(db_session))(user)
    via_wiring = get_prepare_checkout(db_session)(user)

    assert via_wiring == by_hand
    assert [line.product_id for line in via_wiring.lines] == [a, b]
    assert via_wiring.total == 2 * 250000 + 90000


def test_prepare_checkout_without_selection_raises_empty_selection(db_session: Session) -> None:
    user = cart_with(db_session, (add_listed(db_session, on_hand=5), 1, False))

    with pytest.raises(EmptySelection):
        get_prepare_checkout(db_session)(user)


def test_remove_checked_out_items_removes_only_the_given_products(db_session: Session) -> None:
    a, b, kept = (add_listed(db_session, on_hand=5) for _ in range(3))
    user = cart_with(db_session, (a, 1, True), (b, 2, True), (kept, 3, False))

    get_remove_checked_out_items(db_session)(user, [a, b])

    assert cart_of(db_session, user) == {kept: (3, False)}


def test_remove_checked_out_items_ignores_absent_products(db_session: Session) -> None:
    a = add_listed(db_session, on_hand=5)
    user = cart_with(db_session, (a, 1, True))

    get_remove_checked_out_items(db_session)(user, [uuid4()])

    assert cart_of(db_session, user) == {a: (1, True)}


# --- inventory -----------------------------------------------------------------------------


def test_reserve_stock_creates_active_reservations_that_expire_in_30_minutes(
    db_session: Session,
) -> None:
    a, b = add_listed(db_session, on_hand=3), add_listed(db_session, on_hand=2)
    order_id, now = uuid4(), db_now(db_session)

    result = get_reserve_stock(db_session)(order_id, [OrderLine(a, 2), OrderLine(b, 1)], now)

    expires_at = now + timedelta(minutes=30)
    assert sorted((r.product_id, r.quantity, r.expires_at) for r in result.reservations) == sorted(
        [(a, 2, expires_at), (b, 1, expires_at)]
    )
    assert result.on_request == []
    assert statuses(db_session, order_id) == ["active", "active"]
    assert (available(db_session, a), available(db_session, b)) == (1, 1)


def test_reserve_stock_via_wiring_behaves_like_the_hand_built_use_case(db_session: Session) -> None:
    # Dos productos idénticos: uno se reserva a mano y el otro con el proveedor.
    manual, wired = (add_listed(db_session, on_hand=4) for _ in range(2))
    now = db_now(db_session)

    by_hand = reserve_stock(db_session)(uuid4(), [OrderLine(manual, 3)], now)
    via_wiring = get_reserve_stock(db_session)(uuid4(), [OrderLine(wired, 3)], now)

    assert [(r.quantity, r.expires_at) for r in via_wiring.reservations] == [
        (r.quantity, r.expires_at) for r in by_hand.reservations
    ]
    assert available(db_session, wired) == available(db_session, manual) == 1


def test_reserve_stock_keeps_made_to_order_lines_out_of_the_reservations(
    db_session: Session,
) -> None:
    # R5: las líneas Bajo pedido no reservan y vuelven en `on_request` con su plazo.
    stocked = add_listed(db_session, on_hand=2)
    made = add_listed(db_session, policy="made_to_order")

    result = get_reserve_stock(db_session)(
        uuid4(), [OrderLine(stocked, 1), OrderLine(made, 1)], db_now(db_session)
    )

    assert [r.product_id for r in result.reservations] == [stocked]
    assert [(line.product_id, line.quantity) for line in result.on_request] == [(made, 1)]
    assert result.on_request[0].lead_time_days == 21


def test_reserve_stock_without_stock_raises_the_exported_insufficient_stock(
    db_session: Session,
) -> None:
    ok, empty = add_listed(db_session, on_hand=1), add_listed(db_session, on_hand=0)
    order_id = uuid4()

    with pytest.raises(InsufficientStock) as exc:
        get_reserve_stock(db_session)(
            order_id, [OrderLine(ok, 1), OrderLine(empty, 1)], db_now(db_session)
        )

    assert exc.value.product_ids == (empty,)
    assert statuses(db_session, order_id) == []  # todo o nada
    assert available(db_session, ok) == 1


def test_insufficient_stock_is_importable_from_inventory_application() -> None:
    # T-071: orders captura la excepción desde `application`, no desde el dominio.
    assert inventory_application.InsufficientStock is inventory_domain.InsufficientStock
    assert issubclass(InsufficientStock, Exception)


def test_the_other_public_inventory_names_are_still_importable_from_application() -> None:
    assert inventory_application.OrderLine is inventory_domain.OrderLine
    assert inventory_application.ReservationExpired is inventory_domain.ReservationExpired


def test_reserve_stock_with_an_unknown_product_is_a_programming_error(db_session: Session) -> None:
    with pytest.raises(LookupError):
        get_reserve_stock(db_session)(uuid4(), [OrderLine(uuid4(), 1)], db_now(db_session))


def test_consume_reservations_sells_the_reserved_stock(db_session: Session) -> None:
    a = add_listed(db_session, on_hand=5)
    order_id, now = uuid4(), db_now(db_session)
    get_reserve_stock(db_session)(order_id, [OrderLine(a, 2)], now)

    get_consume_reservations(db_session)(order_id, now)

    assert on_hand(db_session, a) == 3
    assert statuses(db_session, order_id) == ["consumed"]
    assert sales(db_session, order_id) == [("venta", -2, 3)]


def test_consume_reservations_via_wiring_behaves_like_the_hand_built_use_case(
    db_session: Session,
) -> None:
    manual, wired = (add_listed(db_session, on_hand=5) for _ in range(2))
    now = db_now(db_session)
    manual_order, wired_order = uuid4(), uuid4()
    reserve_stock(db_session)(manual_order, [OrderLine(manual, 2)], now)
    reserve_stock(db_session)(wired_order, [OrderLine(wired, 2)], now)

    consume_reservations(db_session)(manual_order, now)
    get_consume_reservations(db_session)(wired_order, now)

    assert on_hand(db_session, wired) == on_hand(db_session, manual) == 3
    assert statuses(db_session, wired_order) == statuses(db_session, manual_order) == ["consumed"]
    assert sales(db_session, wired_order) == sales(db_session, manual_order)


def test_consume_reservations_of_an_expired_order_raises_reservation_expired(
    db_session: Session,
) -> None:
    a = add_listed(db_session, on_hand=2)
    order_id, now = uuid4(), db_now(db_session)
    get_reserve_stock(db_session)(order_id, [OrderLine(a, 2)], now)

    with pytest.raises(ReservationExpired):
        get_consume_reservations(db_session)(order_id, now + timedelta(minutes=31))

    assert on_hand(db_session, a) == 2  # el consumo fallido no escribe
    assert sales(db_session, order_id) == []


def test_release_reservations_gives_the_stock_back_and_is_idempotent(db_session: Session) -> None:
    a = add_listed(db_session, on_hand=3)
    order_id = uuid4()
    get_reserve_stock(db_session)(order_id, [OrderLine(a, 2)], db_now(db_session))
    assert available(db_session, a) == 1

    get_release_reservations(db_session)(order_id)
    get_release_reservations(db_session)(order_id)  # repetir no falla ni duplica

    assert statuses(db_session, order_id) == ["released"]
    assert available(db_session, a) == 3
    assert on_hand(db_session, a) == 3


def test_release_reservations_of_an_unknown_order_does_nothing(db_session: Session) -> None:
    get_release_reservations(db_session)(uuid4())


# --- de punta a punta con la misma sesión (el camino de UC-01 y UC-06) ---------------------


def test_checkout_flow_prepare_reserve_remove_then_pay_in_one_session(db_session: Session) -> None:
    # CA-ORDERS-06 y 14 dependen de esto: preparar → reservar → quitar del carrito → consumir.
    a = add_listed(db_session, price=250000, on_hand=4)
    b = add_listed(db_session, price=90000, on_hand=2)
    unselected = add_listed(db_session, on_hand=9)
    user = cart_with(db_session, (a, 2, True), (b, 1, True), (unselected, 1, False))
    order_id, now = uuid4(), db_now(db_session)

    checkout = get_prepare_checkout(db_session)(user)
    reserved = get_reserve_stock(db_session)(
        order_id, [OrderLine(line.product_id, line.quantity) for line in checkout.lines], now
    )
    get_remove_checked_out_items(db_session)(user, [line.product_id for line in checkout.lines])

    assert checkout.total == 2 * 250000 + 90000
    assert {r.expires_at for r in reserved.reservations} == {now + timedelta(minutes=30)}
    assert cart_of(db_session, user) == {unselected: (1, False)}
    assert (available(db_session, a), available(db_session, b)) == (2, 1)

    get_consume_reservations(db_session)(order_id, now)

    assert (on_hand(db_session, a), on_hand(db_session, b)) == (2, 1)
    assert statuses(db_session, order_id) == ["consumed", "consumed"]


def test_checkout_flow_release_restores_the_availability(db_session: Session) -> None:
    a = add_listed(db_session, on_hand=4)
    user = cart_with(db_session, (a, 3, True))
    order_id = uuid4()

    checkout = get_prepare_checkout(db_session)(user)
    get_reserve_stock(db_session)(
        order_id,
        [OrderLine(line.product_id, line.quantity) for line in checkout.lines],
        db_now(db_session),
    )
    assert available(db_session, a) == 1

    get_release_reservations(db_session)(order_id)

    assert available(db_session, a) == 4
