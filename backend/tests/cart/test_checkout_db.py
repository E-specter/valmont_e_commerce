"""Puerto de cart para orders contra la BD de pruebas (T-059): `PrepareCheckout` y
`RemoveCheckedOutItems` con `SqlCartRepository` y `SqlCartCatalog` reales. CA-CART-12 y 13, R10,
R11, RN-04, RN-05 y RN-16. Datos ficticios; la transacción de cada prueba se deshace (el commit y
la carrera real están en test_checkout_concurrency.py)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import (
    LEAD_TIME_DAYS,
    add_cart,
    add_item,
    add_listed,
    add_profile,
    captured,
    identity_of,
    lines_of,
)
from tests.inventory.inventory_helpers import add_reservation
from tests.promotions.promotions_helpers import add_promotion
from valmont.modules.cart.adapters.persistence import SqlCartCatalog, SqlCartRepository
from valmont.modules.cart.application import (
    CartIssue,
    CheckoutBlocked,
    CheckoutCart,
    EmptySelection,
    PrepareCheckout,
    RemoveCheckedOutItems,
)
from valmont.modules.cart.domain import CartLineStatus

pytestmark = pytest.mark.integration


def prepare(session: Session, user: UUID) -> CheckoutCart:
    return PrepareCheckout(SqlCartRepository(session), SqlCartCatalog(session))(user)


def remove(session: Session, user: UUID, product_ids: list[UUID]) -> None:
    RemoveCheckedOutItems(SqlCartRepository(session))(user, product_ids)


def cart_with(session: Session, *lines: tuple[UUID, int, bool]) -> tuple[UUID, UUID]:
    """Usuario y su carrito con las líneas (producto, cantidad, seleccionado) por SQL."""
    user = add_profile(session)
    cart_id = add_cart(session, user)
    start = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)  # R15: el orden lo da created_at
    for n, (product_id, quantity, selected) in enumerate(lines):
        created = start + timedelta(minutes=n)
        add_item(session, cart_id, product_id, quantity, selected=selected, created_at=created)
    return user, cart_id


# CA-CART-12: solo los seleccionados, con datos reales de las vistas
def test_prepare_returns_the_selected_lines_with_data_from_the_database(
    db_session: Session,
) -> None:
    stock = add_listed(db_session, price=250000, on_hand=10, name="Heritage 38")
    unselected = add_listed(db_session, price=90000, on_hand=10)
    user, _ = cart_with(db_session, (stock, 2, True), (unselected, 1, False))
    sku, _, _ = identity_of(db_session, stock)

    result = prepare(db_session, user)

    (line,) = result.lines
    assert (line.product_id, line.sku, line.name) == (stock, sku, "Heritage 38")
    assert (line.quantity, line.list_price, line.price) == (2, 250000, 250000)
    assert (line.discount_amount, line.promotion_id) == (0, None)
    assert (line.availability_status, line.lead_time_days) == ("in_stock", None)
    assert result.total == 500000


def test_prepare_uses_the_current_promotional_price(db_session: Session) -> None:
    watch = add_listed(db_session, price=1250000, on_hand=3)
    promotion = add_promotion(db_session, kind="percent", value=15, scope="catalog")
    user, _ = cart_with(db_session, (watch, 2, True))

    result = prepare(db_session, user)

    (line,) = result.lines
    assert (line.list_price, line.price, line.discount_amount) == (1250000, 1062500, 187500)
    assert line.promotion_id == promotion
    assert result.total == 2 * 1062500


def test_prepare_admits_made_to_order_without_stock_with_its_lead_time(
    db_session: Session,
) -> None:
    custom = add_listed(db_session, price=800000, policy="made_to_order", on_hand=None)
    user, _ = cart_with(db_session, (custom, 5, True))

    (line,) = prepare(db_session, user).lines

    assert line.quantity == 5
    assert (line.availability_status, line.lead_time_days) == ("on_request", LEAD_TIME_DAYS)


# CA-CART-12: bloqueos por estado, con el carrito real
def test_prepare_blocks_with_every_non_ok_status_in_cart_order(db_session: Session) -> None:
    ok = add_listed(db_session, on_hand=10)
    out = add_listed(db_session, on_hand=0)
    short = add_listed(db_session, on_hand=2)
    gone = add_listed(db_session, on_hand=10, status="draft")
    user, _ = cart_with(
        db_session, (out, 1, True), (ok, 1, True), (short, 3, True), (gone, 1, True)
    )

    with pytest.raises(CheckoutBlocked) as caught:
        prepare(db_session, user)

    assert caught.value.issues == (
        CartIssue(out, CartLineStatus.OUT_OF_STOCK),
        CartIssue(short, CartLineStatus.INSUFFICIENT_STOCK),
        CartIssue(gone, CartLineStatus.UNAVAILABLE),
    )


def test_prepare_blocks_when_active_reservations_leave_too_little(db_session: Session) -> None:
    # El disponible de la vista descuenta las reservas activas: es la verdad que ve el carrito.
    watch = add_listed(db_session, on_hand=5)
    add_reservation(db_session, watch, 4)
    user, _ = cart_with(db_session, (watch, 2, True))

    with pytest.raises(CheckoutBlocked) as caught:
        prepare(db_session, user)

    assert caught.value.issues == (CartIssue(watch, CartLineStatus.INSUFFICIENT_STOCK),)


def test_prepare_ignores_broken_lines_that_are_not_selected(db_session: Session) -> None:
    ok = add_listed(db_session, on_hand=10)
    out = add_listed(db_session, on_hand=0)
    gone = add_listed(db_session, status="draft")
    user, _ = cart_with(db_session, (ok, 1, True), (out, 1, False), (gone, 1, False))

    result = prepare(db_session, user)

    assert [ln.product_id for ln in result.lines] == [ok]


def test_nothing_selected_or_no_cart_is_an_empty_selection(db_session: Session) -> None:
    watch = add_listed(db_session, on_hand=10)
    with_lines, _ = cart_with(db_session, (watch, 1, False))
    without_cart = add_profile(db_session)

    with pytest.raises(EmptySelection):
        prepare(db_session, with_lines)
    with pytest.raises(EmptySelection):
        prepare(db_session, without_cart)


def test_blocking_leaves_the_cart_lines_as_they_were(db_session: Session) -> None:
    ok, out = add_listed(db_session, on_hand=10), add_listed(db_session, on_hand=0)
    user, cart_id = cart_with(db_session, (ok, 2, True), (out, 1, True))
    before = lines_of(db_session, cart_id)

    with pytest.raises(CheckoutBlocked):
        prepare(db_session, user)

    assert lines_of(db_session, cart_id) == before == {ok: (2, True), out: (1, True)}


# R10 / R11: bloqueo FOR UPDATE dentro de la transacción de quien llama
def test_prepare_locks_the_cart_for_update(db_session: Session) -> None:
    watch = add_listed(db_session, on_hand=10)
    user, _ = cart_with(db_session, (watch, 1, True))

    with captured(db_session) as statements:
        prepare(db_session, user)

    assert any("FOR UPDATE" in statement.upper() for statement in statements)


def test_remove_locks_the_cart_for_update(db_session: Session) -> None:
    watch = add_listed(db_session, on_hand=10)
    user, _ = cart_with(db_session, (watch, 1, True))

    with captured(db_session) as statements:
        remove(db_session, user, [watch])

    assert any("FOR UPDATE" in statement.upper() for statement in statements)


def test_neither_operation_commits_the_transaction_of_the_caller(db_session: Session) -> None:
    # Corren dentro de la transacción de orders: sin COMMIT propio (R10, R11).
    watch = add_listed(db_session, on_hand=10)
    user, _ = cart_with(db_session, (watch, 1, True))

    with captured(db_session) as statements:
        prepare(db_session, user)
        remove(db_session, user, [watch])

    assert not any(statement.strip().upper().startswith("COMMIT") for statement in statements)


# CA-CART-13 / R11
def test_remove_deletes_only_the_bought_lines_and_keeps_the_unselected(
    db_session: Session,
) -> None:
    bought_a, bought_b, unselected, kept = (add_listed(db_session, on_hand=10) for _ in range(4))
    user, cart_id = cart_with(
        db_session,
        (bought_a, 2, True),
        (unselected, 3, False),
        (bought_b, 1, True),
        (kept, 4, True),
    )

    remove(db_session, user, [bought_a, bought_b])

    assert lines_of(db_session, cart_id) == {unselected: (3, False), kept: (4, True)}


def test_remove_ignores_absent_ids_and_is_idempotent(db_session: Session) -> None:
    bought, kept = add_listed(db_session, on_hand=10), add_listed(db_session, on_hand=10)
    user, cart_id = cart_with(db_session, (bought, 1, True), (kept, 2, False))

    remove(db_session, user, [bought, uuid4()])
    remove(db_session, user, [bought])

    assert lines_of(db_session, cart_id) == {kept: (2, False)}


def test_remove_of_a_user_without_cart_does_not_fail(db_session: Session) -> None:
    remove(db_session, add_profile(db_session), [uuid4()])


def test_remove_never_touches_the_cart_of_another_user(db_session: Session) -> None:
    shared = add_listed(db_session, on_hand=10)
    mine, my_cart = cart_with(db_session, (shared, 1, True))
    _, their_cart = cart_with(db_session, (shared, 2, True))

    remove(db_session, mine, [shared])

    assert lines_of(db_session, my_cart) == {}
    assert lines_of(db_session, their_cart) == {shared: (2, True)}


def test_prepare_sees_only_the_cart_of_the_given_user(db_session: Session) -> None:
    mine, theirs = (
        add_listed(db_session, price=100000, on_hand=10),
        add_listed(db_session, price=500000, on_hand=10),
    )
    me, _ = cart_with(db_session, (mine, 1, True))
    other, _ = cart_with(db_session, (theirs, 2, True))

    own, their = prepare(db_session, me), prepare(db_session, other)

    assert [ln.product_id for ln in own.lines] == [mine]
    assert [ln.product_id for ln in their.lines] == [theirs]
    assert (own.total, their.total) == (100000, 1000000)


def test_prepare_then_remove_then_prepare_again_is_an_empty_selection(
    db_session: Session,
) -> None:
    # El flujo de orders de punta a punta en una transacción: la repetición no encuentra nada.
    a, b, kept = (add_listed(db_session, on_hand=10) for _ in range(3))
    user, cart_id = cart_with(db_session, (a, 1, True), (b, 2, True), (kept, 1, False))

    result = prepare(db_session, user)
    remove(db_session, user, [ln.product_id for ln in result.lines])

    assert lines_of(db_session, cart_id) == {kept: (1, False)}
    with pytest.raises(EmptySelection):
        prepare(db_session, user)
