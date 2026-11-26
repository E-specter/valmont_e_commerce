"""Reglas puras de la lectura del carrito sin BD: `line_status` (CART-R7) y `max_quantity`
(CART-R4) con la tabla de políticas (T-057; CA-CART-09 y CA-CART-10 en su parte de dominio)."""

import pytest

from valmont.modules.cart.domain import (
    CART_ITEM_MAX_QUANTITY,
    CartLineStatus,
    line_status,
    max_quantity,
)

OK = CartLineStatus.OK
INSUFFICIENT = CartLineStatus.INSUFFICIENT_STOCK
OUT = CartLineStatus.OUT_OF_STOCK
GONE = CartLineStatus.UNAVAILABLE
NON_STOCK = ["made_to_order", "backorder"]


def test_status_values_are_the_contract_strings() -> None:
    assert [s.value for s in CartLineStatus] == [
        "ok",
        "insufficient_stock",
        "out_of_stock",
        "unavailable",
    ]


# R7: política `stock`, (disponible, cantidad) → status
@pytest.mark.parametrize(
    ("available", "quantity", "expected"),
    [
        (0, 1, OUT),
        (0, 5, OUT),
        (1, 1, OK),  # justo lo que hay
        (1, 2, INSUFFICIENT),
        (3, 3, OK),
        (3, 4, INSUFFICIENT),  # la cantidad actual excede el stock
        (3, 1, OK),
        (100, 5, OK),
    ],
)
def test_stock_policy_status_follows_available_against_quantity(
    available: int, quantity: int, expected: CartLineStatus
) -> None:
    assert line_status(True, "stock", available, quantity) is expected


# RN-16: bajo pedido y por encargo nunca dependen del stock
@pytest.mark.parametrize("policy", NON_STOCK)
@pytest.mark.parametrize("available", [0, 1, 5])
@pytest.mark.parametrize("quantity", [1, 5])
def test_non_stock_policies_are_always_ok_while_published(
    policy: str, available: int, quantity: int
) -> None:
    assert line_status(True, policy, available, quantity) is OK


# R7: despublicado manda sobre cualquier política y stock
@pytest.mark.parametrize("policy", ["stock", *NON_STOCK])
@pytest.mark.parametrize("available", [0, 3, 50])
def test_an_unpublished_product_is_unavailable_whatever_the_policy_or_stock(
    policy: str, available: int
) -> None:
    assert line_status(False, policy, available, 1) is GONE


# R4: máxima cantidad que se puede fijar ahora
@pytest.mark.parametrize(
    ("available", "expected"),
    [(0, 0), (1, 1), (3, 3), (5, 5), (6, 5), (400, CART_ITEM_MAX_QUANTITY)],
)
def test_max_quantity_for_stock_is_min_of_limit_and_available(
    available: int, expected: int
) -> None:
    assert max_quantity(True, "stock", available) == expected


@pytest.mark.parametrize("policy", NON_STOCK)
@pytest.mark.parametrize("available", [0, 2, 99])
def test_max_quantity_for_non_stock_policies_is_the_limit(policy: str, available: int) -> None:
    assert max_quantity(True, policy, available) == CART_ITEM_MAX_QUANTITY == 5


@pytest.mark.parametrize("policy", ["stock", *NON_STOCK])
@pytest.mark.parametrize("available", [0, 3, 50])
def test_max_quantity_of_an_unpublished_product_is_zero(policy: str, available: int) -> None:
    assert max_quantity(False, policy, available) == 0
