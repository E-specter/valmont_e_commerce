"""Vista app.product_effective_price y SqlEffectivePriceReader contra la BD de pruebas.

Cada caso fija now() de la transacción y las vigencias se expresan en segundos respecto de él.
"""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.promotions.promotions_helpers import (
    HOUR,
    add_category,
    add_product,
    add_promotion,
    effective,
    view_row,
)
from valmont.modules.promotions.adapters.persistence import SqlEffectivePriceReader
from valmont.modules.promotions.application import EffectivePrice, GetEffectivePrices
from valmont.modules.promotions.domain import AMOUNT_MAX

pytestmark = pytest.mark.integration

INT_MAX = 2_147_483_647


def outcome(session: Session, product_id: object) -> tuple[int, int, object]:
    row = effective(session, product_id)  # type: ignore[arg-type]
    return row.price, row.discount_amount, row.promotion_id


def test_view_has_one_row_per_product_without_promotions(db_session: Session) -> None:
    published = add_product(db_session, 250000, status="published")
    draft = add_product(db_session, 90000)

    assert view_row(db_session, published) == (published, 250000, 250000, 0, None)
    assert view_row(db_session, draft) == (draft, 90000, 90000, 0, None)
    products = db_session.scalar(text("SELECT count(*) FROM app.products"))
    assert db_session.scalar(text("SELECT count(*) FROM app.product_effective_price")) == products
    assert effective(db_session, draft) == EffectivePrice(draft, 90000, 90000, 0, None)


def test_reader_has_no_row_for_an_unknown_product(db_session: Session) -> None:
    assert SqlEffectivePriceReader(db_session).get_many([uuid4()]) == []
    assert SqlEffectivePriceReader(db_session).get_many([]) == []


# CA-PROMOTIONS-06 (R3): (is_active, starts, ends) en segundos desde now() → ¿se aplica?
@pytest.mark.parametrize(
    ("is_active", "starts", "ends", "applies"),
    [
        (True, -HOUR, HOUR, True),
        (True, 0, HOUR, True),  # starts_at = now() aplica
        (True, -HOUR, 1, True),
        (True, -HOUR, 0, False),  # ends_at = now() no aplica
        (True, -2 * HOUR, -HOUR, False),  # vencida
        (True, 1, HOUR, False),  # programada
        (True, HOUR, 2 * HOUR, False),
        (False, -HOUR, HOUR, False),  # inactiva con fechas vigentes
        (False, HOUR, 2 * HOUR, False),
    ],
)
def test_promotion_applies_only_when_active_and_within_its_interval(
    db_session: Session, is_active: bool, starts: int, ends: int, applies: bool
) -> None:
    product_id = add_product(db_session, 100000)
    promotion_id = add_promotion(
        db_session, value=20, scope="catalog", starts=starts, ends=ends, is_active=is_active
    )

    price, discount, promotion = outcome(db_session, product_id)

    assert (price, discount, promotion) == (
        (80000, 20000, promotion_id) if applies else (100000, 0, None)
    )


# CA-PROMOTIONS-07 (R5, mismo tipo)
def test_higher_percentage_wins_and_discounts_are_never_summed(db_session: Session) -> None:
    product_id = add_product(db_session, 100000)
    add_promotion(db_session, value=10, scope="products", product_ids=[product_id])
    best = add_promotion(db_session, value=20, scope="products", product_ids=[product_id])

    assert outcome(db_session, product_id) == (80000, 20000, best)  # no 70000


def test_equal_discounts_tie_on_the_lowest_id(db_session: Session) -> None:
    product_id = add_product(db_session, 100000)
    low, high = sorted(uuid4() for _ in range(2))
    add_promotion(db_session, value=10, scope="products", product_ids=[product_id], id=high)
    add_promotion(db_session, value=10, scope="products", product_ids=[product_id], id=low)

    assert outcome(db_session, product_id) == (90000, 10000, low)


def test_only_the_applicable_promotion_among_several_assigned_counts(db_session: Session) -> None:
    product_id = add_product(db_session, 100000)
    ids = [product_id]
    add_promotion(db_session, value=50, scope="products", product_ids=ids, is_active=False)
    add_promotion(
        db_session, value=60, scope="products", product_ids=ids, starts=HOUR, ends=2 * HOUR
    )
    add_promotion(
        db_session, value=70, scope="products", product_ids=ids, starts=-2 * HOUR, ends=-1
    )
    live = add_promotion(db_session, value=5, scope="products", product_ids=ids)

    assert outcome(db_session, product_id) == (95000, 5000, live)


# CA-PROMOTIONS-08 (R6, RN-15): (precio de lista, % → descuento esperado), enteros y mitad arriba.
@pytest.mark.parametrize(
    ("list_price", "percent", "discount"),
    [
        (100000, 15, 15000),
        (125000, 15, 18750),
        (99999, 15, 15000),  # 14 999,85 → 15 000
        (333, 10, 33),  # 33,3 → 33
        (344, 10, 34),  # 34,4 → 34
        (335, 10, 34),  # 33,5 → 34 (mitad hacia arriba)
        (345, 10, 35),  # 34,5 → 35
        (149, 1, 1),  # 1,49 → 1
        (150, 1, 2),  # 1,50 → 2
        (50, 1, 1),  # 0,50 → 1
        (49, 1, 0),  # 0,49 → 0: sin descuento
        (2, 90, 1),  # 1,8 → 2 → tope L − 1 = 1
        (2147483647, 1, 21474836),
        (2147483647, 50, 1073741824),  # producto > int32: aritmética en 64 bits
        (2147483647, 90, 1932735282),
    ],
)
def test_percent_discount_is_rounded_half_up_in_integers(
    db_session: Session, list_price: int, percent: int, discount: int
) -> None:
    product_id = add_product(db_session, list_price)
    promotion_id = add_promotion(db_session, value=percent)

    assert outcome(db_session, product_id) == (
        list_price - discount,
        discount,
        promotion_id if discount else None,
    )


@pytest.mark.parametrize("percent", [1, 50, 90])
def test_one_cent_product_never_goes_below_one_cent(db_session: Session, percent: int) -> None:
    product_id = add_product(db_session, 1)
    add_promotion(db_session, value=percent)

    assert outcome(db_session, product_id) == (1, 0, None)  # descuento 0: no cuenta como aplicada


def test_zero_priced_product_is_untouched(db_session: Session) -> None:
    product_id = add_product(db_session, 0)
    add_promotion(db_session, value=50)
    add_promotion(db_session, kind="fixed_amount", value=500)

    assert outcome(db_session, product_id) == (0, 0, None)


# CA-PROMOTIONS-16 (R1, R6, D-037): monto fijo
@pytest.mark.parametrize(
    ("list_price", "amount", "price", "discount"),
    [
        (100000, 20000, 80000, 20000),
        (100000, 1, 99999, 1),
        (100000, 99999, 1, 99999),
        (100000, 100000, 1, 99999),  # monto = precio → 1 céntimo (H-5)
        (100000, 5_000_000, 1, 99999),
        (2, 500, 1, 1),
        (INT_MAX, AMOUNT_MAX, 1, INT_MAX - 1),
        (INT_MAX, 1, INT_MAX - 1, 1),
    ],
)
def test_fixed_amount_is_subtracted_and_the_price_never_drops_below_one_cent(
    db_session: Session, list_price: int, amount: int, price: int, discount: int
) -> None:
    product_id = add_product(db_session, list_price)
    promotion_id = add_promotion(db_session, kind="fixed_amount", value=amount)

    assert outcome(db_session, product_id) == (price, discount, promotion_id)


def test_fixed_amount_on_a_one_cent_product_does_not_count_as_applied(db_session: Session) -> None:
    product_id = add_product(db_session, 1)
    add_promotion(db_session, kind="fixed_amount", value=500)

    assert outcome(db_session, product_id) == (1, 0, None)


# CA-PROMOTIONS-17 (R4, D-037): alcances
def test_products_scope_covers_only_the_listed_products_in_any_status(db_session: Session) -> None:
    listed_draft = add_product(db_session, 100000, status="draft")
    listed_published = add_product(db_session, 100000, status="published")
    other = add_product(db_session, 100000)
    promotion_id = add_promotion(
        db_session, scope="products", product_ids=[listed_draft, listed_published]
    )

    assert outcome(db_session, listed_draft) == (90000, 10000, promotion_id)
    assert outcome(db_session, listed_published) == (90000, 10000, promotion_id)
    assert outcome(db_session, other) == (100000, 0, None)


def test_category_scope_follows_the_category_now(db_session: Session) -> None:
    mine, theirs = add_category(db_session), add_category(db_session)
    inside = add_product(db_session, 100000, category_id=mine)
    outside = add_product(db_session, 100000, category_id=theirs)
    promotion_id = add_promotion(db_session, scope="category", category_id=mine)
    assert outcome(db_session, inside) == (90000, 10000, promotion_id)
    assert outcome(db_session, outside) == (100000, 0, None)

    added_later = add_product(db_session, 100000, category_id=mine)
    assert outcome(db_session, added_later) == (90000, 10000, promotion_id)

    move = text("UPDATE app.products SET category_id = :category WHERE id = :id")
    db_session.execute(move, {"category": mine, "id": outside})  # entra a la categoría
    db_session.execute(move, {"category": theirs, "id": inside})  # sale de la categoría
    assert outcome(db_session, outside) == (90000, 10000, promotion_id)
    assert outcome(db_session, inside) == (100000, 0, None)


def test_category_scope_applies_even_if_the_category_is_inactive(db_session: Session) -> None:
    category_id = add_category(db_session, is_active=False)  # H-6
    product_id = add_product(db_session, 100000, category_id=category_id)
    promotion_id = add_promotion(db_session, scope="category", category_id=category_id)

    assert outcome(db_session, product_id) == (90000, 10000, promotion_id)


def test_catalog_scope_covers_every_product_including_later_ones(db_session: Session) -> None:
    first = add_product(db_session, 100000)
    promotion_id = add_promotion(db_session, value=30, scope="catalog")
    later = add_product(db_session, 200000, status="published")

    assert outcome(db_session, first) == (70000, 30000, promotion_id)
    assert outcome(db_session, later) == (140000, 60000, promotion_id)


# CA-PROMOTIONS-18 (R5, D-037): gana el menor precio final, sin importar tipo ni alcance
def test_lowest_final_price_wins_across_kinds_and_scopes(db_session: Session) -> None:
    category_id = add_category(db_session)
    product_id = add_product(db_session, 125000, category_id=category_id)  # S/ 1 250
    percent = add_promotion(db_session, value=15, scope="products", product_ids=[product_id])
    fixed = add_promotion(
        db_session, kind="fixed_amount", value=20000, scope="category", category_id=category_id
    )
    catalog = add_promotion(db_session, value=10, scope="catalog")

    # 15 % = 18 750 frente a S/ 200 fijos: gana la fija; el 10 % deja 12 500
    assert outcome(db_session, product_id) == (105000, 20000, fixed)

    db_session.execute(
        text("UPDATE app.promotions SET is_active = false WHERE id = :id"), {"id": fixed}
    )
    assert outcome(db_session, product_id) == (106250, 18750, percent)

    db_session.execute(
        text("UPDATE app.promotions SET is_active = false WHERE id = :id"), {"id": percent}
    )
    assert outcome(db_session, product_id) == (112500, 12500, catalog)


def test_category_promotion_beats_products_and_catalog_when_it_leaves_the_lowest_price(
    db_session: Session,
) -> None:
    category_id = add_category(db_session)
    product_id = add_product(db_session, 100000, category_id=category_id)
    add_promotion(db_session, value=10, scope="products", product_ids=[product_id])
    best = add_promotion(db_session, value=20, scope="category", category_id=category_id)
    add_promotion(db_session, value=5, scope="catalog")

    assert outcome(db_session, product_id) == (80000, 20000, best)


@pytest.mark.parametrize("fixed_has_lower_id", [True, False])
def test_equal_final_price_between_kinds_ties_on_the_lowest_id(
    db_session: Session, fixed_has_lower_id: bool
) -> None:
    product_id = add_product(db_session, 100000)
    low, high = sorted(uuid4() for _ in range(2))
    fixed_id, percent_id = (low, high) if fixed_has_lower_id else (high, low)
    add_promotion(db_session, value=10, scope="catalog", id=percent_id)  # 10 000
    add_promotion(db_session, kind="fixed_amount", value=10000, scope="catalog", id=fixed_id)

    assert outcome(db_session, product_id) == (90000, 10000, low)


def test_a_clamped_fixed_amount_beats_a_ninety_percent_promotion(db_session: Session) -> None:
    product_id = add_product(db_session, 1000)
    add_promotion(db_session, value=90)  # 900
    fixed = add_promotion(db_session, kind="fixed_amount", value=5000)  # tope 999

    assert outcome(db_session, product_id) == (1, 999, fixed)


def test_a_zero_discount_promotion_does_not_win_on_its_id(db_session: Session) -> None:
    product_id = add_product(db_session, 49)
    low, high = sorted(uuid4() for _ in range(2))
    add_promotion(db_session, value=1, id=low)  # (49 + 50) / 100 = 0: no cuenta
    add_promotion(db_session, value=50, id=high)  # 25

    assert outcome(db_session, product_id) == (24, 25, high)


# CA-PROMOTIONS-11 (R7): el precio base cambia → el vigente se recalcula, sin tocar promotions
def test_changing_the_base_price_recalculates_and_can_change_the_winner(
    db_session: Session,
) -> None:
    product_id = add_product(db_session, 100000)
    percent = add_promotion(db_session, value=15)
    fixed = add_promotion(db_session, kind="fixed_amount", value=20000)
    assert outcome(db_session, product_id) == (80000, 20000, fixed)

    change = text("UPDATE app.products SET price_cents = :price WHERE id = :id")
    db_session.execute(change, {"price": 200000, "id": product_id})
    assert outcome(db_session, product_id) == (170000, 30000, percent)  # ahora gana el %

    db_session.execute(change, {"price": 15000, "id": product_id})  # monto > precio
    assert outcome(db_session, product_id) == (1, 14999, fixed)


# CA-PROMOTIONS-10 (UC-06, RN-09): el puerto devuelve lo que dice la vista
def test_get_effective_prices_matches_the_view(db_session: Session) -> None:
    plain, discounted, draft = (add_product(db_session, p) for p in (100000, 250000, 90000))
    promotion_id = add_promotion(
        db_session, kind="fixed_amount", value=50000, scope="products", product_ids=[discounted]
    )
    get_prices = GetEffectivePrices(SqlEffectivePriceReader(db_session))

    prices = get_prices([plain, discounted, draft, discounted, uuid4()])  # duplicado y ausente

    assert prices == {
        plain: EffectivePrice(plain, 100000, 100000, 0, None),
        discounted: EffectivePrice(discounted, 250000, 200000, 50000, promotion_id),
        draft: EffectivePrice(draft, 90000, 90000, 0, None),
    }
    for product_id, price in prices.items():
        assert view_row(db_session, product_id) == (
            product_id,
            price.list_price,
            price.price,
            price.discount_amount,
            price.promotion_id,
        )
    assert get_prices([]) == {}
