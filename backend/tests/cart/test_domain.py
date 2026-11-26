"""Dominio de cart sin BD: R2 (artículo único, suma), R3 (5 unidades, 20 líneas), selección,
retirada idempotente e inmutabilidad (T-056; CA-CART-02, 04, 05, 06, 07 en su parte de dominio)."""

import ast
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from valmont.modules.cart import domain
from valmont.modules.cart.domain import (
    CART_ITEM_MAX_QUANTITY,
    CART_MAX_LINES,
    Cart,
    CartError,
    CartFull,
    CartItem,
    ItemNotInCart,
    QuantityLimit,
)

NOW = datetime(2026, 12, 1, 5, 0, tzinfo=UTC)
LATER = NOW + timedelta(hours=1)


def empty() -> Cart:
    return Cart(id=uuid4(), user_id=uuid4(), items=())


def with_lines(count: int, quantity: int = 1) -> Cart:
    cart = empty()
    for _ in range(count):
        cart = cart.add(uuid4(), quantity, NOW)
    return cart


def item_of(cart: Cart, product_id: UUID) -> CartItem:
    [found] = [item for item in cart.items if item.product_id == product_id]
    return found


def test_the_limits_are_the_ones_of_the_spec() -> None:
    assert (CART_ITEM_MAX_QUANTITY, CART_MAX_LINES) == (5, 20)


def test_the_errors_are_domain_errors() -> None:
    for error in (QuantityLimit, CartFull, ItemNotInCart):
        assert issubclass(error, CartError)
    assert issubclass(CartError, Exception)


# R2: un producto aparece una vez por carrito y agregar suma.
def test_adding_a_new_product_creates_a_selected_line_with_the_given_time() -> None:
    product = uuid4()

    cart = empty().add(product, 2, NOW)

    assert cart.items == (CartItem(product_id=product, quantity=2, selected=True, created_at=NOW),)


def test_adding_a_present_product_sums_the_quantity_and_keeps_one_line() -> None:
    product = uuid4()
    cart = empty().add(product, 2, NOW).add(product, 1, LATER)

    assert len(cart.items) == 1
    line = item_of(cart, product)
    assert line.quantity == 3
    assert line.created_at == NOW  # el orden (R15) no cambia al sumar


def test_adding_keeps_the_identity_and_the_other_lines() -> None:
    other, product = uuid4(), uuid4()
    cart = empty().add(other, 1, NOW)

    result = cart.add(product, 1, LATER)

    assert (result.id, result.user_id) == (cart.id, cart.user_id)
    assert {item.product_id for item in result.items} == {other, product}
    assert item_of(result, other) == item_of(cart, other)


# R3: tope de 5 unidades por artículo.
@pytest.mark.parametrize(("first", "second"), [(4, 1), (3, 2), (1, 4)])
def test_the_sum_may_reach_exactly_the_cap(first: int, second: int) -> None:
    product = uuid4()

    cart = empty().add(product, first, NOW).add(product, second, LATER)

    assert item_of(cart, product).quantity == 5


@pytest.mark.parametrize(("first", "second"), [(5, 1), (3, 3), (1, 5), (4, 2)])
def test_the_sum_above_the_cap_is_rejected_and_nothing_changes(first: int, second: int) -> None:
    product = uuid4()
    cart = empty().add(product, first, NOW)

    with pytest.raises(QuantityLimit):
        cart.add(product, second, LATER)

    assert item_of(cart, product).quantity == first


def test_a_new_product_above_the_cap_is_rejected() -> None:
    with pytest.raises(QuantityLimit):
        empty().add(uuid4(), CART_ITEM_MAX_QUANTITY + 1, NOW)


# R3: tope de 20 líneas distintas.
def test_twenty_distinct_lines_are_allowed() -> None:
    assert len(with_lines(CART_MAX_LINES).items) == 20


def test_the_line_21_is_rejected_and_nothing_changes() -> None:
    cart = with_lines(CART_MAX_LINES)

    with pytest.raises(CartFull):
        cart.add(uuid4(), 1, LATER)

    assert len(cart.items) == 20


def test_adding_to_an_existing_line_is_still_allowed_with_twenty_lines() -> None:
    cart = with_lines(CART_MAX_LINES)
    product = cart.items[0].product_id

    result = cart.add(product, 2, LATER)

    assert len(result.items) == 20 and item_of(result, product).quantity == 3


def test_an_existing_line_over_the_cap_is_a_quantity_limit_even_with_twenty_lines() -> None:
    cart = with_lines(CART_MAX_LINES, quantity=5)

    with pytest.raises(QuantityLimit):
        cart.add(cart.items[0].product_id, 1, LATER)


def test_removing_a_line_frees_a_slot() -> None:
    cart = with_lines(CART_MAX_LINES)

    result = cart.remove(cart.items[0].product_id).add(uuid4(), 1, LATER)

    assert len(result.items) == 20


# set_quantity: valor final, no suma.
@pytest.mark.parametrize("quantity", [1, 2, 5])
def test_set_quantity_sets_the_final_value(quantity: int) -> None:
    product = uuid4()
    cart = empty().add(product, 3, NOW)

    result = cart.set_quantity(product, quantity)

    assert item_of(result, product).quantity == quantity
    assert item_of(result, product).created_at == NOW
    assert item_of(cart, product).quantity == 3


@pytest.mark.parametrize("quantity", [0, -1, 6, 100])
def test_set_quantity_outside_one_to_five_is_a_quantity_limit(quantity: int) -> None:
    product = uuid4()
    cart = empty().add(product, 3, NOW)

    with pytest.raises(QuantityLimit):
        cart.set_quantity(product, quantity)

    assert item_of(cart, product).quantity == 3


def test_set_quantity_of_an_absent_product_is_not_in_cart() -> None:
    with pytest.raises(ItemNotInCart):
        empty().add(uuid4(), 1, NOW).set_quantity(uuid4(), 2)


# set_selected.
def test_set_selected_toggles_only_that_line() -> None:
    a, b = uuid4(), uuid4()
    cart = empty().add(a, 1, NOW).add(b, 2, NOW)

    off = cart.set_selected(a, False)

    assert item_of(off, a).selected is False and item_of(off, b).selected is True
    assert item_of(off, a).quantity == 1
    assert item_of(off.set_selected(a, True), a).selected is True
    assert item_of(cart, a).selected is True


def test_set_selected_is_idempotent() -> None:
    product = uuid4()
    cart = empty().add(product, 1, NOW)

    assert cart.set_selected(product, True) == cart


def test_set_selected_of_an_absent_product_is_not_in_cart() -> None:
    with pytest.raises(ItemNotInCart):
        empty().set_selected(uuid4(), False)


# remove: idempotente.
def test_remove_drops_only_that_line() -> None:
    a, b = uuid4(), uuid4()
    cart = empty().add(a, 1, NOW).add(b, 1, NOW)

    result = cart.remove(a)

    assert [item.product_id for item in result.items] == [b]
    assert (result.id, result.user_id) == (cart.id, cart.user_id)


def test_remove_of_an_absent_product_returns_an_equal_cart_without_error() -> None:
    cart = empty().add(uuid4(), 1, NOW)

    assert cart.remove(uuid4()) == cart
    assert empty().remove(uuid4()).items == ()


def test_remove_twice_is_the_same_as_once() -> None:
    product = uuid4()
    once = empty().add(product, 1, NOW).remove(product)

    assert once.remove(product) == once and once.items == ()


# Inmutabilidad.
def test_cart_and_items_are_frozen_and_items_is_a_tuple() -> None:
    cart = empty().add(uuid4(), 1, NOW)

    assert isinstance(cart.items, tuple)
    with pytest.raises(FrozenInstanceError):
        cart.id = uuid4()  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        cart.items[0].quantity = 2  # type: ignore[misc]


def test_operations_never_mutate_the_original() -> None:
    product = uuid4()
    cart = empty().add(product, 1, NOW)
    snapshot = Cart(cart.id, cart.user_id, cart.items)

    cart.add(product, 1, LATER)
    cart.add(uuid4(), 1, LATER)
    cart.set_quantity(product, 4)
    cart.set_selected(product, False)
    cart.remove(product)

    assert cart == snapshot


# Capas: el dominio y el puerto no importan frameworks (skill testing-and-quality-gates).
@pytest.mark.parametrize("module", ["domain.py", "application.py"])
def test_domain_and_application_import_no_framework(module: str) -> None:
    source = Path(domain.__file__).with_name(module).read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
        elif isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)

    assert not imported & {"fastapi", "pydantic", "sqlalchemy", "httpx", "supabase"}
