"""Lector SQL del carrito (`SqlCartCatalog`, T-057) contra la BD de pruebas: producto, vista de
disponibilidad, vista de precio vigente y primera imagen en una sola consulta (SPEC §8).

CA-CART-08, 09, 10 (insumos del lector), RN-14 y la regla de que la lectura no escribe. Datos
ficticios; la transacción de cada prueba se deshace.
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import (
    LEAD_TIME_DAYS,
    add_image,
    add_listed,
    captured,
    identity_of,
    set_product,
)
from tests.inventory.inventory_helpers import add_reservation
from tests.promotions.promotions_helpers import HOUR, add_category, add_promotion, effective
from valmont.modules.cart.adapters.persistence import SqlCartCatalog
from valmont.modules.cart.application import ProductSnapshot

pytestmark = pytest.mark.integration


@pytest.fixture
def reader(db_session: Session) -> SqlCartCatalog:
    return SqlCartCatalog(db_session)


def one(reader: SqlCartCatalog, product_id: UUID) -> ProductSnapshot:
    found = reader.get_published([product_id])
    assert set(found) == {product_id}
    return found[product_id]


def test_snapshot_of_a_stock_product_has_identity_price_and_availability(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, price=250000, on_hand=7, name="Heritage 38")
    sku, slug, _ = identity_of(db_session, product_id)

    snap = one(reader, product_id)

    assert snap.product_id == product_id
    assert (snap.sku, snap.slug, snap.name) == (sku, slug, "Heritage 38")
    assert snap.order_policy == "stock"
    assert (snap.available, snap.availability_status, snap.lead_time_days) == (7, "in_stock", None)
    assert (snap.list_price, snap.price, snap.discount_amount, snap.promotion_id) == (
        250000,
        250000,
        0,
        None,
    )
    assert (snap.image_path, snap.alt) == (None, None)  # sin imagen: sin error


# R4/R7: cada política con la disponibilidad que le toca (umbral por defecto: 2)
@pytest.mark.parametrize(
    ("policy", "on_hand", "available", "status", "lead"),
    [
        ("stock", 3, 3, "in_stock", None),
        ("stock", 2, 2, "low_stock", None),
        ("stock", 1, 1, "low_stock", None),
        ("stock", 0, 0, "out_of_stock", None),
        ("stock", None, 0, "out_of_stock", None),  # sin fila de inventario
        ("made_to_order", None, 0, "on_request", LEAD_TIME_DAYS),
        ("made_to_order", 9, 9, "on_request", LEAD_TIME_DAYS),  # RN-16: no depende del stock
        ("backorder", 0, 0, "on_request", LEAD_TIME_DAYS),
        ("backorder", 9, 9, "in_stock", None),
    ],
)
def test_availability_comes_from_the_inventory_view_for_each_policy(
    db_session: Session,
    reader: SqlCartCatalog,
    policy: str,
    on_hand: int | None,
    available: int,
    status: str,
    lead: int | None,
) -> None:
    product_id = add_listed(db_session, policy=policy, on_hand=on_hand)

    snap = one(reader, product_id)

    assert snap.order_policy == policy
    assert (snap.available, snap.availability_status) == (available, status)
    if status == "on_request":
        assert snap.lead_time_days == lead


def test_active_unexpired_reservations_reduce_the_available_units(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, on_hand=5)
    add_reservation(db_session, product_id, 2)  # activa y vigente
    add_reservation(db_session, product_id, 1, minutes=-5)  # vencida: no cuenta
    add_reservation(db_session, product_id, 1, status="consumed")
    add_reservation(db_session, product_id, 1, status="released")

    snap = one(reader, product_id)

    assert (snap.available, snap.availability_status) == (3, "in_stock")


def test_a_fully_reserved_product_reads_as_out_of_stock(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, on_hand=3)
    add_reservation(db_session, product_id, 3)

    snap = one(reader, product_id)

    assert (snap.available, snap.availability_status) == (0, "out_of_stock")


# CA-CART-08: precio vigente de promotions, con los tres alcances
def test_a_catalog_wide_percent_promotion_discounts_the_price(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, price=1250000, on_hand=3)
    promotion = add_promotion(db_session, kind="percent", value=15, scope="catalog")

    snap = one(reader, product_id)

    assert (snap.list_price, snap.price, snap.discount_amount) == (1250000, 1062500, 187500)
    assert snap.promotion_id == promotion


def test_a_fixed_amount_promotion_on_listed_products_discounts_only_those(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    covered, other = add_listed(db_session, price=500000), add_listed(db_session, price=500000)
    promotion = add_promotion(
        db_session, kind="fixed_amount", value=40000, scope="products", product_ids=[covered]
    )

    with_promo, without = one(reader, covered), one(reader, other)

    assert (with_promo.price, with_promo.discount_amount, with_promo.promotion_id) == (
        460000,
        40000,
        promotion,
    )
    assert (without.price, without.discount_amount, without.promotion_id) == (500000, 0, None)


def test_a_category_promotion_covers_the_category_and_follows_a_reassignment(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    mine, theirs = add_category(db_session), add_category(db_session)
    inside = add_listed(db_session, price=100000, category_id=mine)
    outside = add_listed(db_session, price=100000, category_id=theirs)
    promotion = add_promotion(
        db_session, kind="percent", value=10, scope="category", category_id=mine
    )

    assert one(reader, inside).price == 90000
    assert one(reader, inside).promotion_id == promotion
    assert one(reader, outside).price == 100000

    set_product(db_session, outside, category_id=mine)  # la categoría se reasigna

    assert one(reader, outside).price == 90000


def test_an_expired_scheduled_or_inactive_promotion_does_not_apply(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, price=100000)
    add_promotion(db_session, value=50, starts=-2 * HOUR, ends=-HOUR)
    add_promotion(db_session, value=50, starts=HOUR, ends=2 * HOUR)
    add_promotion(db_session, value=50, is_active=False)

    snap = one(reader, product_id)

    assert (snap.price, snap.discount_amount, snap.promotion_id) == (100000, 0, None)


def test_the_price_is_read_live_so_a_change_shows_on_the_next_read(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, price=100000)
    assert one(reader, product_id).price == 100000

    set_product(db_session, product_id, price_cents=120000)
    assert one(reader, product_id).price == 120000
    promotion = add_promotion(db_session, value=25)
    assert (one(reader, product_id).price, one(reader, product_id).promotion_id) == (
        90000,
        promotion,
    )
    db_session.execute(
        text("UPDATE app.promotions SET is_active = false WHERE id = :id"), {"id": promotion}
    )

    assert one(reader, product_id).price == 120000


def test_the_price_equals_the_effective_price_that_catalog_and_promotions_use(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    products = [add_listed(db_session, price=p) for p in (1, 99999, 1250000, 2147483647)]
    add_promotion(db_session, kind="percent", value=33)

    for product_id in products:
        expected = effective(db_session, product_id)
        snap = one(reader, product_id)
        assert (snap.list_price, snap.price, snap.discount_amount, snap.promotion_id) == (
            expected.list_price,
            expected.price,
            expected.discount_amount,
            expected.promotion_id,
        )


# Imagen: primera por posición
def test_the_image_is_the_first_by_position(db_session: Session, reader: SqlCartCatalog) -> None:
    product_id = add_listed(db_session)
    add_image(db_session, product_id, "p/segunda.jpg", "Segunda", position=2)
    add_image(db_session, product_id, "p/primera.jpg", "Primera", position=0)
    add_image(db_session, product_id, "p/tercera.jpg", "Tercera", position=5)

    snap = one(reader, product_id)

    assert (snap.image_path, snap.alt) == ("p/primera.jpg", "Primera")


def test_several_images_do_not_duplicate_the_product(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, image=("p/a.jpg", "A"))
    add_image(db_session, product_id, "p/b.jpg", "B", position=1)

    assert list(reader.get_published([product_id])) == [product_id]


# Alcance de get_published / get_names
def test_get_published_leaves_out_drafts_and_unknown_ids(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    live, draft = add_listed(db_session), add_listed(db_session, status="draft")

    found = reader.get_published([live, draft, uuid4()])

    assert set(found) == {live}


def test_get_published_ignores_duplicates(db_session: Session, reader: SqlCartCatalog) -> None:
    product_id = add_listed(db_session)

    assert set(reader.get_published([product_id, product_id])) == {product_id}


def test_get_published_with_nothing_asked_does_not_query(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    with captured(db_session) as statements:
        assert reader.get_published([]) == {}
        assert reader.get_names([]) == {}

    assert statements == []


def test_get_names_returns_name_and_slug_of_any_product_and_nothing_else(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    draft = add_listed(db_session, status="draft", name="Reloj retirado", price=999999, on_hand=4)
    live = add_listed(db_session, name="Reloj vigente")
    _, draft_slug, _ = identity_of(db_session, draft)
    _, live_slug, _ = identity_of(db_session, live)

    names = reader.get_names([draft, live, uuid4()])

    assert names == {draft: ("Reloj retirado", draft_slug), live: ("Reloj vigente", live_slug)}


def test_an_unpublished_product_leaks_nothing_through_get_published(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    draft = add_listed(db_session, status="draft", price=999999, on_hand=4, image=("p/x.jpg", "X"))
    live = add_listed(db_session, image=("p/y.jpg", "Y"))

    found = reader.get_published([draft, live])

    assert draft not in found  # ni precio, ni imagen, ni stock, ni sku del borrador
    assert found[live].image_path == "p/y.jpg"


def test_republishing_a_product_makes_it_readable_again(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    product_id = add_listed(db_session, status="draft", on_hand=2)
    assert reader.get_published([product_id]) == {}

    set_product(db_session, product_id, status="published")

    assert one(reader, product_id).available == 2


# CA-CART-01 / SPEC §8: una sola consulta, sin N+1, sin escribir
def populate(session: Session, count: int, *, promoted: bool = False) -> list[UUID]:
    ids: list[UUID] = []
    for n in range(count):
        ids.append(
            add_listed(
                session,
                price=100000 + n,
                policy=("stock", "made_to_order", "backorder")[n % 3],
                on_hand=n,
                image=(f"p/{n}.jpg", f"Reloj {n}") if n % 2 else None,
            )
        )
    if promoted:
        add_promotion(session, value=10, scope="catalog")
    return ids


@pytest.mark.parametrize("count", [1, 2, 10, 20])
def test_get_published_runs_exactly_one_select_whatever_the_number_of_products(
    db_session: Session, reader: SqlCartCatalog, count: int
) -> None:
    ids = populate(db_session, count, promoted=True)

    with captured(db_session) as statements:
        found = reader.get_published(ids)

    assert len(found) == count
    assert len(statements) == 1
    assert statements[0].lstrip().upper().startswith("SELECT")


def test_reading_writes_nothing(db_session: Session, reader: SqlCartCatalog) -> None:
    ids = populate(db_session, 4)

    with captured(db_session) as statements:
        reader.get_published(ids)
        reader.get_names(ids)

    assert not any(
        s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) or "FOR UPDATE" in s.upper()
        for s in statements
    )


def test_get_names_also_runs_one_select_for_many_products(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    ids = populate(db_session, 8)

    with captured(db_session) as statements:
        reader.get_names(ids)

    assert len(statements) == 1


def test_the_reader_only_reads_what_the_spec_lists_from_catalog(
    db_session: Session, reader: SqlCartCatalog
) -> None:
    """SPEC §8: de app.products solo id, sku, slug, name, status, order_policy, lead_time_days."""
    ids = populate(db_session, 2)

    with captured(db_session) as statements:
        reader.get_published(ids)

    sql = statements[0].lower()
    for column in ("description", "specs", "case_diameter_mm", "movement_code", "price_cents"):
        assert f"products.{column}" not in sql
