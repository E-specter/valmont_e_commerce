"""`GetCart` (UC-CART-01) con repositorio y catálogo falsos: R4, R7, R8, R9, R15 y que la lectura
no escribe (T-057; CA-CART-01, 08, 09 y 10 en su parte de aplicación)."""

from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from valmont.modules.cart.application import (
    CartLineView,
    CartView,
    GetCart,
    ProductSnapshot,
)
from valmont.modules.cart.domain import Cart, CartItem, CartLineStatus

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
USER = uuid4()
INT32_MAX = 2_147_483_647
OK = CartLineStatus.OK
INSUFFICIENT = CartLineStatus.INSUFFICIENT_STOCK
OUT = CartLineStatus.OUT_OF_STOCK
GONE = CartLineStatus.UNAVAILABLE
RETIRED = ("Reloj retirado", "reloj-retirado")


class FakeCarts:
    """Solo lee: bloquear o guardar rompe la prueba (la lectura no escribe, UC-CART-01)."""

    def __init__(self, carts: dict[UUID, Cart] | None = None) -> None:
        self.carts = carts or {}

    def find_for_user(self, user_id: UUID) -> Cart | None:
        return self.carts.get(user_id)

    def lock_for_user(self, user_id: UUID) -> Cart:
        raise AssertionError("la lectura no bloquea ni crea el carrito")

    def save(self, cart: Cart) -> None:
        raise AssertionError("la lectura no escribe")


class FakeCatalog:
    def __init__(
        self, *snapshots: ProductSnapshot, hidden: dict[UUID, tuple[str, str]] | None = None
    ) -> None:
        self.published = {s.product_id: s for s in snapshots}
        self.hidden = hidden or {}
        self.published_calls: list[set[UUID]] = []
        self.names_calls: list[set[UUID]] = []

    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]:
        self.published_calls.append(set(product_ids))
        return {i: self.published[i] for i in product_ids if i in self.published}

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]:
        self.names_calls.append(set(product_ids))
        names = {i: (s.name, s.slug) for i, s in self.published.items()} | self.hidden
        return {i: names[i] for i in product_ids if i in names}


def snapshot(
    *,
    policy: str = "stock",
    available: int = 10,
    price: int = 100000,
    list_price: int | None = None,
    availability: str = "in_stock",
    lead: int | None = None,
    promotion: UUID | None = None,
    image: str | None = "p/frontal.jpg",
) -> ProductSnapshot:
    product_id = uuid4()
    list_price = price if list_price is None else list_price
    return ProductSnapshot(
        product_id=product_id,
        sku=f"SKU-{product_id.hex[:6]}",
        slug=f"slug-{product_id.hex[:6]}",
        name=f"Reloj {product_id.hex[:6]}",
        image_path=image,
        alt="Vista frontal" if image else None,
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


def read(cart: Cart | None, catalog: FakeCatalog) -> CartView:
    carts = FakeCarts({cart.user_id: cart} if cart else {})
    return GetCart(carts, catalog)(USER)


def line(view: CartView, product_id: UUID) -> CartLineView:
    return next(entry for entry in view.lines if entry.product_id == product_id)


# CA-CART-01: carrito vacío o inexistente
def test_a_user_without_cart_gets_an_empty_view_and_nothing_is_created_or_queried() -> None:
    catalog = FakeCatalog()

    view = read(None, catalog)

    assert view == CartView(lines=(), selected_count=0, total=0, can_checkout=False)
    # Vacío sin consultar: el puerto no recibe ningún id (el lector real no ejecuta SQL con vacío).
    assert not any(catalog.published_calls) and not any(catalog.names_calls)


def test_a_cart_without_lines_is_empty_and_cannot_checkout() -> None:
    view = read(cart_of(), FakeCatalog())

    assert (view.lines, view.selected_count, view.total, view.can_checkout) == ((), 0, 0, False)


# CA-CART-01 / R15: el orden lo da el carrito
def test_lines_keep_the_order_of_the_cart_whatever_the_catalog_returns() -> None:
    a, b, c = snapshot(), snapshot(), snapshot()
    catalog = FakeCatalog(c, a, b)  # el catálogo devuelve en otro orden
    cart = cart_of((b.product_id, 1, True), (c.product_id, 1, True), (a.product_id, 1, True))

    view = read(cart, catalog)

    assert [entry.product_id for entry in view.lines] == [b.product_id, c.product_id, a.product_id]


# CA-CART-01: la lectura consulta una vez, con todos los ids
def test_the_catalog_is_asked_once_with_all_the_product_ids() -> None:
    items = [snapshot() for _ in range(4)]
    catalog = FakeCatalog(*items)

    read(cart_of(*((s.product_id, 1, True) for s in items)), catalog)

    assert catalog.published_calls == [{s.product_id for s in items}]
    assert not any(catalog.names_calls)  # sin despublicados no hay nombres que pedir


def test_names_are_asked_only_for_the_products_that_are_not_published() -> None:
    live, gone = snapshot(), uuid4()
    catalog = FakeCatalog(live, hidden={gone: RETIRED})

    read(cart_of((live.product_id, 1, True), (gone, 1, True)), catalog)

    assert [c for c in catalog.names_calls if c] == [{gone}]


# CA-CART-08: precio vigente, subtotal y total en el servidor
def test_a_line_without_promotion_has_price_subtotal_and_null_original_and_discount() -> None:
    item = snapshot(price=250000, available=9)

    view = read(cart_of((item.product_id, 3, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert entry.status is OK
    assert (entry.sku, entry.slug, entry.name) == (item.sku, item.slug, item.name)
    assert (entry.quantity, entry.selected) == (3, True)
    assert entry.unit_price == 250000
    assert entry.subtotal == 750000
    assert entry.original_price is None and entry.discount_amount is None
    assert (entry.image_path, entry.alt) == (item.image_path, item.alt)
    assert (entry.availability_status, entry.lead_time_days) == ("in_stock", None)
    assert (view.total, view.selected_count) == (750000, 1)


def test_a_promoted_line_shows_the_discounted_price_with_original_and_discount() -> None:
    item = snapshot(price=1062500, list_price=1250000, promotion=uuid4())

    view = read(cart_of((item.product_id, 2, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert entry.unit_price == 1062500
    assert entry.original_price == 1250000
    assert entry.discount_amount == 187500
    assert entry.subtotal == 2125000
    assert view.total == 2125000


def test_subtotal_and_total_are_exact_beyond_the_int32_range() -> None:
    big, small = snapshot(price=INT32_MAX, available=9), snapshot(price=1, available=9)
    cart = cart_of((big.product_id, 5, True), (small.product_id, 1, True))

    view = read(cart, FakeCatalog(big, small))

    assert line(view, big.product_id).subtotal == INT32_MAX * 5
    assert view.total == INT32_MAX * 5 + 1


def test_a_one_cent_promoted_product_keeps_its_cent() -> None:
    item = snapshot(price=1, list_price=2, promotion=uuid4())

    view = read(cart_of((item.product_id, 1, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert (entry.unit_price, entry.original_price, entry.discount_amount) == (1, 2, 1)
    assert view.total == 1


# RN-05 / R8: el total y el conteo solo cuentan los seleccionados
def test_total_and_selected_count_only_include_selected_lines() -> None:
    picked, skipped = snapshot(price=100000), snapshot(price=900000)
    cart = cart_of((picked.product_id, 2, True), (skipped.product_id, 1, False))

    view = read(cart, FakeCatalog(picked, skipped))

    assert view.total == 200000
    assert view.selected_count == 1
    unpicked = line(view, skipped.product_id)
    assert unpicked.selected is False
    assert unpicked.subtotal == 900000  # la línea sigue mostrando su subtotal


def test_nothing_selected_means_zero_total_and_no_checkout() -> None:
    item = snapshot()

    view = read(cart_of((item.product_id, 1, False)), FakeCatalog(item))

    assert (view.selected_count, view.total, view.can_checkout) == (0, 0, False)


# CA-CART-09 / R7 / R9
def test_all_selected_lines_ok_can_checkout() -> None:
    a, b = snapshot(), snapshot()

    view = read(cart_of((a.product_id, 1, True), (b.product_id, 2, True)), FakeCatalog(a, b))

    assert view.can_checkout is True


def test_an_out_of_stock_selected_line_blocks_checkout_but_still_counts_in_the_total() -> None:
    fine = snapshot(price=100000)
    sold_out = snapshot(price=500000, available=0, availability="out_of_stock")
    cart = cart_of((fine.product_id, 1, True), (sold_out.product_id, 1, True))

    view = read(cart, FakeCatalog(fine, sold_out))

    entry = line(view, sold_out.product_id)
    assert entry.status is OUT
    assert entry.max_quantity == 0
    assert entry.availability_status == "out_of_stock"
    assert view.can_checkout is False
    assert view.total == 600000  # R8: el total informa el importe, can_checkout decide


def test_a_selected_line_asking_for_more_than_available_is_insufficient_stock() -> None:
    item = snapshot(available=2, availability="low_stock")

    view = read(cart_of((item.product_id, 4, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert entry.status is INSUFFICIENT
    assert entry.max_quantity == 2
    assert view.can_checkout is False


def test_an_unselected_sold_out_line_does_not_block_checkout() -> None:
    fine = snapshot()
    sold_out = snapshot(available=0, availability="out_of_stock")
    cart = cart_of((fine.product_id, 1, True), (sold_out.product_id, 1, False))

    view = read(cart, FakeCatalog(fine, sold_out))

    assert line(view, sold_out.product_id).status is OUT
    assert view.can_checkout is True


@pytest.mark.parametrize("policy", ["made_to_order", "backorder"])
def test_on_request_lines_are_ok_with_their_lead_time_and_the_limit_as_max(policy: str) -> None:
    item = snapshot(policy=policy, available=0, availability="on_request", lead=21)

    view = read(cart_of((item.product_id, 3, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert entry.status is OK
    assert entry.max_quantity == 5
    assert (entry.availability_status, entry.lead_time_days) == ("on_request", 21)
    assert view.can_checkout is True


def test_max_quantity_is_the_lower_of_the_limit_and_the_available_units() -> None:
    plenty, few = snapshot(available=50), snapshot(available=3, availability="low_stock")
    cart = cart_of((plenty.product_id, 1, True), (few.product_id, 1, True))

    view = read(cart, FakeCatalog(plenty, few))

    assert line(view, plenty.product_id).max_quantity == 5
    assert line(view, few.product_id).max_quantity == 3


# R7 / H-3: un despublicado no revela más que nombre y slug
def test_an_unpublished_line_shows_only_name_and_slug_and_is_left_out_of_the_total() -> None:
    fine, gone = snapshot(price=100000), uuid4()
    catalog = FakeCatalog(fine, hidden={gone: RETIRED})

    view = read(cart_of((fine.product_id, 1, True), (gone, 2, True)), catalog)

    entry = line(view, gone)
    assert (entry.name, entry.slug) == RETIRED
    assert entry.status is GONE
    assert entry.max_quantity == 0
    assert (entry.quantity, entry.selected) == (2, True)
    for hidden in (
        entry.sku,
        entry.image_path,
        entry.alt,
        entry.availability_status,
        entry.lead_time_days,
        entry.unit_price,
        entry.original_price,
        entry.discount_amount,
        entry.subtotal,
    ):
        assert hidden is None
    assert view.total == 100000
    assert view.can_checkout is False  # seleccionado y no disponible


def test_an_unselected_unpublished_line_is_visible_but_does_not_block_checkout() -> None:
    fine, gone = snapshot(), uuid4()
    catalog = FakeCatalog(fine, hidden={gone: RETIRED})

    view = read(cart_of((fine.product_id, 1, True), (gone, 1, False)), catalog)

    assert line(view, gone).status is GONE
    assert view.can_checkout is True
    assert view.total == fine.price


def test_a_cart_with_only_an_unpublished_line_cannot_checkout_and_totals_zero() -> None:
    gone = uuid4()

    view = read(cart_of((gone, 1, True)), FakeCatalog(hidden={gone: RETIRED}))

    assert (view.total, view.can_checkout) == (0, False)


def test_a_line_without_image_has_no_image_data() -> None:
    item = snapshot(image=None)

    view = read(cart_of((item.product_id, 1, True)), FakeCatalog(item))

    entry = line(view, item.product_id)
    assert (entry.image_path, entry.alt) == (None, None)
    assert entry.status is OK


# RN-10: la identidad es la del argumento
def test_a_user_only_reads_their_own_cart() -> None:
    other = uuid4()
    mine, theirs = snapshot(), snapshot()
    carts = FakeCarts(
        {
            USER: cart_of((mine.product_id, 1, True)),
            other: cart_of((theirs.product_id, 3, True), user=other),
        }
    )
    catalog = FakeCatalog(mine, theirs)

    view = GetCart(carts, catalog)(USER)

    assert [entry.product_id for entry in view.lines] == [mine.product_id]
    assert theirs.product_id not in {i for call in catalog.published_calls for i in call}


def test_views_are_immutable() -> None:
    item = snapshot()
    view = read(cart_of((item.product_id, 1, True)), FakeCatalog(item))

    with pytest.raises(AttributeError):
        view.total = 1  # type: ignore[misc]
    with pytest.raises(AttributeError):
        view.lines[0].quantity = 9  # type: ignore[misc]
