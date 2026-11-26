"""Puerto de cart para orders con repositorio y catálogo falsos (T-059): `PrepareCheckout`
(UC-CART-06, R10, R7, R8) y `RemoveCheckedOutItems` (UC-CART-07, R11). CA-CART-12 y 13 en su parte
de aplicación; la BD y la concurrencia están en test_checkout_db.py y test_checkout_concurrency.py.
"""

import dataclasses
from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from valmont.modules.cart.application import (
    CartIssue,
    CheckoutBlocked,
    CheckoutCart,
    CheckoutLine,
    EmptySelection,
    PrepareCheckout,
    ProductSnapshot,
    RemoveCheckedOutItems,
)
from valmont.modules.cart.domain import Cart, CartItem, CartLineStatus

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
USER, OTHER = uuid4(), uuid4()
INT32_MAX = 2_147_483_647
OUT = CartLineStatus.OUT_OF_STOCK
INSUFFICIENT = CartLineStatus.INSUFFICIENT_STOCK
GONE = CartLineStatus.UNAVAILABLE


class FakeCarts:
    """Como el real: `lock_for_user` crea el carrito si falta (R1). La lectura sin bloqueo está
    prohibida: la decisión firme se toma con el carrito bloqueado (R10)."""

    def __init__(self, *carts: Cart) -> None:
        self.carts = {c.user_id: c for c in carts}
        self.locked: list[UUID] = []
        self.saved: list[Cart] = []

    def lock_for_user(self, user_id: UUID) -> Cart:
        self.locked.append(user_id)
        return self.carts.setdefault(user_id, Cart(uuid4(), user_id, ()))

    def find_for_user(self, user_id: UUID) -> Cart | None:
        raise AssertionError("el puerto de orders bloquea el carrito; no lo lee sin bloqueo")

    def save(self, cart: Cart) -> None:
        self.saved.append(cart)
        self.carts[cart.user_id] = cart


class FakeCatalog:
    def __init__(self, *snapshots: ProductSnapshot) -> None:
        self.published = {s.product_id: s for s in snapshots}

    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]:
        return {i: self.published[i] for i in product_ids if i in self.published}

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]:
        return {i: (self.published[i].name, self.published[i].slug) for i in product_ids}


def snapshot(
    *,
    policy: str = "stock",
    available: int = 10,
    price: int = 100000,
    list_price: int | None = None,
    availability: str = "in_stock",
    lead: int | None = None,
    promotion: UUID | None = None,
) -> ProductSnapshot:
    product_id = uuid4()
    list_price = price if list_price is None else list_price
    return ProductSnapshot(
        product_id=product_id,
        sku=f"SKU-{product_id.hex[:6]}",
        slug=f"slug-{product_id.hex[:6]}",
        name=f"Reloj {product_id.hex[:6]}",
        image_path="p/frontal.jpg",
        alt="Vista frontal",
        order_policy=policy,
        available=available,
        availability_status=availability,
        lead_time_days=lead,
        list_price=list_price,
        price=price,
        discount_amount=list_price - price,
        promotion_id=promotion,
    )


def cart_of(*lines: tuple[UUID, int, bool], user: UUID = USER) -> Cart:
    items = tuple(
        CartItem(product_id, quantity, selected, NOW + timedelta(minutes=n))
        for n, (product_id, quantity, selected) in enumerate(lines)
    )
    return Cart(uuid4(), user, items)


def prepare(carts: FakeCarts, catalog: FakeCatalog, user: UUID = USER) -> CheckoutCart:
    return PrepareCheckout(carts, catalog)(user)


def blocked(carts: FakeCarts, catalog: FakeCatalog) -> CheckoutBlocked:
    with pytest.raises(CheckoutBlocked) as caught:
        prepare(carts, catalog)
    return caught.value


# CA-CART-12: solo los seleccionados, con los datos que tomará orders (RN-04)
def test_returns_only_the_selected_lines_with_quantity_and_current_price() -> None:
    a, b, c = snapshot(price=250000), snapshot(price=90000), snapshot(price=70000)
    carts = FakeCarts(
        cart_of((a.product_id, 2, True), (b.product_id, 1, False), (c.product_id, 3, True))
    )

    result = prepare(carts, FakeCatalog(a, b, c))

    assert [(ln.product_id, ln.quantity, ln.price) for ln in result.lines] == [
        (a.product_id, 2, 250000),
        (c.product_id, 3, 70000),
    ]
    assert result.total == 2 * 250000 + 3 * 70000  # el no seleccionado no suma


def test_each_line_carries_the_snapshot_fields_without_promotion() -> None:
    snap = snapshot(price=125000, availability="low_stock", available=2)
    carts = FakeCarts(cart_of((snap.product_id, 2, True)))

    (checkout_line,) = prepare(carts, FakeCatalog(snap)).lines

    assert checkout_line == CheckoutLine(
        product_id=snap.product_id,
        sku=snap.sku,
        name=snap.name,
        quantity=2,
        list_price=125000,
        price=125000,
        discount_amount=0,
        promotion_id=None,
        availability_status="low_stock",
        lead_time_days=None,
    )


def test_each_line_carries_list_price_discount_and_promotion_when_promoted() -> None:
    promotion = uuid4()
    snap = snapshot(price=1062500, list_price=1250000, promotion=promotion)
    carts = FakeCarts(cart_of((snap.product_id, 1, True)))

    result = prepare(carts, FakeCatalog(snap))

    (checkout_line,) = result.lines
    assert (checkout_line.list_price, checkout_line.price) == (1250000, 1062500)
    assert (checkout_line.discount_amount, checkout_line.promotion_id) == (187500, promotion)
    assert result.total == 1062500  # el total usa el precio vigente, no el de lista


def test_lines_and_total_are_immutable_and_lines_is_a_tuple() -> None:
    snap = snapshot()
    result = prepare(FakeCarts(cart_of((snap.product_id, 1, True))), FakeCatalog(snap))

    assert isinstance(result.lines, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.total = 1  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.lines[0].price = 1  # type: ignore[misc]


def test_lines_keep_the_order_of_the_cart() -> None:
    a, b, c = snapshot(), snapshot(), snapshot()
    carts = FakeCarts(
        cart_of((b.product_id, 1, True), (c.product_id, 1, True), (a.product_id, 1, True))
    )

    result = prepare(carts, FakeCatalog(c, a, b))  # el catálogo devuelve en otro orden

    assert [ln.product_id for ln in result.lines] == [b.product_id, c.product_id, a.product_id]


def test_total_is_computed_in_integers_beyond_int32() -> None:
    snap = snapshot(price=INT32_MAX, available=5)
    carts = FakeCarts(cart_of((snap.product_id, 5, True)))

    assert prepare(carts, FakeCatalog(snap)).total == INT32_MAX * 5


# RN-16: bajo pedido y a pedido se admiten, con su plazo
@pytest.mark.parametrize(
    ("policy", "available", "availability"),
    [
        ("made_to_order", 0, "on_request"),
        ("backorder", 0, "on_request"),
        ("backorder", 9, "in_stock"),
    ],
)
def test_made_to_order_and_backorder_are_accepted_with_their_lead_time(
    policy: str, available: int, availability: str
) -> None:
    snap = snapshot(policy=policy, available=available, availability=availability, lead=21)
    carts = FakeCarts(cart_of((snap.product_id, 5, True)))  # incluso por encima del stock

    (checkout_line,) = prepare(carts, FakeCatalog(snap)).lines

    assert (checkout_line.quantity, checkout_line.lead_time_days) == (5, 21)
    assert checkout_line.availability_status == availability  # nunca out_of_stock


# CA-CART-12: sin seleccionados
def test_a_user_without_cart_gets_empty_selection_and_nothing_is_saved() -> None:
    carts = FakeCarts()

    with pytest.raises(EmptySelection):
        prepare(carts, FakeCatalog())

    assert carts.saved == []


def test_a_cart_without_lines_gets_empty_selection() -> None:
    with pytest.raises(EmptySelection):
        prepare(FakeCarts(cart_of()), FakeCatalog())


def test_a_cart_with_nothing_selected_gets_empty_selection_even_if_lines_are_broken() -> None:
    ok, out = snapshot(), snapshot(available=0)
    carts = FakeCarts(cart_of((ok.product_id, 1, False), (out.product_id, 1, False)))

    with pytest.raises(EmptySelection):
        prepare(carts, FakeCatalog(ok, out))


# CA-CART-12: un seleccionado no `ok` bloquea, con su product_id y su status
def test_a_selected_out_of_stock_line_blocks_with_its_issue() -> None:
    ok, out = snapshot(), snapshot(available=0)
    carts = FakeCarts(cart_of((ok.product_id, 1, True), (out.product_id, 1, True)))

    error = blocked(carts, FakeCatalog(ok, out))

    assert error.issues == (CartIssue(out.product_id, OUT),)


def test_a_selected_line_with_less_stock_than_its_quantity_blocks_as_insufficient() -> None:
    short = snapshot(available=2)
    carts = FakeCarts(cart_of((short.product_id, 3, True)))

    assert blocked(carts, FakeCatalog(short)).issues == (CartIssue(short.product_id, INSUFFICIENT),)


def test_a_selected_unpublished_line_blocks_as_unavailable() -> None:
    gone, ok = uuid4(), snapshot()  # el catálogo no devuelve el despublicado
    carts = FakeCarts(cart_of((gone, 1, True), (ok.product_id, 1, True)))

    assert blocked(carts, FakeCatalog(ok)).issues == (CartIssue(gone, GONE),)


def test_issues_list_every_blocked_line_in_cart_order() -> None:
    gone, out, short, ok = uuid4(), snapshot(available=0), snapshot(available=1), snapshot()
    carts = FakeCarts(
        cart_of(
            (out.product_id, 1, True),
            (ok.product_id, 1, True),
            (gone, 1, True),
            (short.product_id, 2, True),
        )
    )

    error = blocked(carts, FakeCatalog(out, short, ok))

    assert error.issues == (
        CartIssue(out.product_id, OUT),
        CartIssue(gone, GONE),
        CartIssue(short.product_id, INSUFFICIENT),
    )
    assert isinstance(error.issues, tuple)


def test_unselected_broken_lines_do_not_block_nor_appear() -> None:
    ok, out, short = snapshot(), snapshot(available=0), snapshot(available=1)
    gone = uuid4()
    carts = FakeCarts(
        cart_of(
            (ok.product_id, 1, True),
            (out.product_id, 1, False),
            (short.product_id, 4, False),
            (gone, 1, False),
        )
    )

    result = prepare(carts, FakeCatalog(ok, out, short))

    assert [ln.product_id for ln in result.lines] == [ok.product_id]


# CA-CART-12: sin efectos
def test_blocking_changes_nothing_in_the_cart() -> None:
    ok, out = snapshot(), snapshot(available=0)
    cart = cart_of((ok.product_id, 2, True), (out.product_id, 1, True))
    carts = FakeCarts(cart)

    blocked(carts, FakeCatalog(ok, out))

    assert carts.saved == []
    assert carts.carts[USER] == cart


def test_a_successful_preparation_does_not_alter_the_cart() -> None:
    # R11: retirar es de RemoveCheckedOutItems, tras crear el pedido; preparar no consume.
    snap = snapshot()
    cart = cart_of((snap.product_id, 2, True))
    carts = FakeCarts(cart)

    prepare(carts, FakeCatalog(snap))

    assert carts.carts[USER] == cart


# R10: bloquea el carrito del usuario en la transacción de quien llama
def test_the_cart_is_locked_for_the_user() -> None:
    snap = snapshot()
    carts = FakeCarts(cart_of((snap.product_id, 1, True)))

    prepare(carts, FakeCatalog(snap))

    assert carts.locked == [USER]


def test_the_cart_is_locked_even_when_the_selection_is_empty() -> None:
    carts = FakeCarts()

    with pytest.raises(EmptySelection):
        prepare(carts, FakeCatalog())

    assert carts.locked == [USER]


# R8, R12: el precio no se guarda; cada llamada toma el vigente
def test_price_is_the_current_one_on_every_call() -> None:
    snap = snapshot(price=100000)
    carts = FakeCarts(cart_of((snap.product_id, 1, True)))
    first = prepare(carts, FakeCatalog(snap))

    cheaper = dataclasses.replace(snap, price=90000, discount_amount=10000, promotion_id=uuid4())
    second = prepare(carts, FakeCatalog(cheaper))

    assert (first.total, second.total) == (100000, 90000)
    assert second.lines[0].promotion_id == cheaper.promotion_id


# Seguridad: el carrito es el del user_id recibido, nunca el de otro
def test_two_users_prepare_only_their_own_selection() -> None:
    mine, theirs = snapshot(price=100000), snapshot(price=500000)
    carts = FakeCarts(
        cart_of((mine.product_id, 1, True), user=USER),
        cart_of((theirs.product_id, 2, True), user=OTHER),
    )
    catalog = FakeCatalog(mine, theirs)

    own, other = prepare(carts, catalog, USER), prepare(carts, catalog, OTHER)

    assert [ln.product_id for ln in own.lines] == [mine.product_id]
    assert [ln.product_id for ln in other.lines] == [theirs.product_id]
    assert (own.total, other.total) == (100000, 1000000)
    assert carts.locked == [USER, OTHER]


# CA-CART-13 / R11
def remove(carts: FakeCarts, product_ids: Collection[UUID], user: UUID = USER) -> None:
    assert RemoveCheckedOutItems(carts)(user, product_ids) is None


def lines_left(carts: FakeCarts, user: UUID = USER) -> dict[UUID, tuple[int, bool]]:
    return {i.product_id: (i.quantity, i.selected) for i in carts.carts[user].items}


def test_remove_deletes_only_the_given_products_and_keeps_the_unselected() -> None:
    bought_a, bought_b, kept, unselected = uuid4(), uuid4(), uuid4(), uuid4()
    carts = FakeCarts(
        cart_of(
            (bought_a, 2, True),
            (unselected, 3, False),
            (bought_b, 1, True),
            (kept, 4, True),
        )
    )

    remove(carts, [bought_a, bought_b])

    assert lines_left(carts) == {unselected: (3, False), kept: (4, True)}


@pytest.mark.parametrize("container", [tuple, set, frozenset, list])
def test_remove_accepts_any_collection_of_ids(container: type) -> None:
    bought, kept = uuid4(), uuid4()
    carts = FakeCarts(cart_of((bought, 1, True), (kept, 1, True)))

    remove(carts, container([bought]))

    assert lines_left(carts) == {kept: (1, True)}


def test_remove_ignores_absent_ids_and_is_idempotent() -> None:
    bought, kept = uuid4(), uuid4()
    carts = FakeCarts(cart_of((bought, 1, True), (kept, 2, False)))

    remove(carts, [bought, uuid4()])  # un id que nunca estuvo
    remove(carts, [bought])  # ya retirado

    assert lines_left(carts) == {kept: (2, False)}


def test_remove_with_no_ids_changes_nothing() -> None:
    a, b = uuid4(), uuid4()
    carts = FakeCarts(cart_of((a, 1, True), (b, 2, False)))

    remove(carts, [])

    assert lines_left(carts) == {a: (1, True), b: (2, False)}


def test_remove_on_a_user_without_cart_is_a_no_op() -> None:
    carts = FakeCarts()

    remove(carts, [uuid4()])

    assert lines_left(carts) == {}


def test_remove_locks_the_cart_of_the_user() -> None:
    bought = uuid4()
    carts = FakeCarts(cart_of((bought, 1, True)))

    remove(carts, [bought])

    assert carts.locked == [USER]


def test_remove_never_touches_the_cart_of_another_user() -> None:
    shared_product = uuid4()  # el mismo producto en dos carritos
    carts = FakeCarts(
        cart_of((shared_product, 1, True), user=USER),
        cart_of((shared_product, 2, True), user=OTHER),
    )

    remove(carts, [shared_product], USER)

    assert lines_left(carts, USER) == {}
    assert lines_left(carts, OTHER) == {shared_product: (2, True)}


def test_prepare_then_remove_of_the_prepared_lines_leaves_only_the_unselected() -> None:
    # El flujo de orders: toma los seleccionados y retira exactamente esos.
    a, b, c = snapshot(), snapshot(), snapshot(available=0)
    carts = FakeCarts(
        cart_of((a.product_id, 1, True), (b.product_id, 2, True), (c.product_id, 1, False))
    )
    catalog = FakeCatalog(a, b, c)

    result = prepare(carts, catalog)
    remove(carts, [ln.product_id for ln in result.lines])

    assert lines_left(carts) == {c.product_id: (1, False)}
    with pytest.raises(EmptySelection):  # la segunda confirmación ya no encuentra nada
        prepare(carts, catalog)
