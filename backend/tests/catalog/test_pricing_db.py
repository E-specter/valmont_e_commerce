"""T-053 · CA-PROMOTIONS-09, 10, 11, 17 y 18 por HTTP contra PostgreSQL: el precio público es el
vigente que calcula la vista de promotions (la transacción de la prueba se deshace). Precios de la
semilla (céntimos): Aurora 100000, Boreal 250000, Cenit 175000 (categoría A), Eclipse 300000
(categoría B) y el borrador Draco 90000."""

from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import Catalog, all_keys, make_image, make_product
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.promotions.promotions_helpers import HOUR, add_promotion, captured
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.adapters.persistence import SqlProductRepository
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

BASE = "/api/v1/catalog"
ADMIN = uuid4()
PRICES = {"aurora": 100000, "boreal": 250000, "cenit": 175000, "eclipse": 300000}
INTERNALS = {"kind", "scope", "percent_off", "amount_off", "starts_at", "ends_at", "is_active"}


@pytest.fixture
def client(
    db_session: Session,
    repo: SqlProductRepository,
    catalog: Catalog,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    for product in catalog.products.values():
        if product.published_at is not None:
            repo.add_image(make_image(product, 0))
    use_test_auth(monkeypatch)
    settings = Settings(_env_file=None, storage_public_url="https://cdn.valmont.test")
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    return TestClient(app, headers={"Authorization": f"Bearer {make_token(str(ADMIN))}"})


def listing(
    client: TestClient, catalog: Catalog, category: str | None = None, **params: object
) -> list[dict[str, Any]]:
    query = {"category": category or catalog.a.slug, "page_size": 48, **params}
    response = client.get(f"{BASE}/products", params=query)
    assert response.status_code == 200, response.json()
    return response.json()["items"]


def by_name(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Productos por su primera palabra en minúsculas, en el orden recibido."""
    return {item["name"].split()[0].lower(): item for item in items}


def money(amount: int) -> dict[str, object]:
    return {"amount": amount, "currency": "PEN"}


def assert_pricing(item: dict[str, Any], *, price: int, original: int | None) -> None:
    assert item["price"] == money(price)
    if original is None:
        assert (item["original_price"], item["discount_amount"]) == (None, None)
    else:
        assert item["original_price"] == money(original)
        assert item["discount_amount"] == money(original - price)


def detail(client: TestClient, catalog: Catalog, key: str) -> dict[str, Any]:
    response = client.get(f"{BASE}/products/{catalog.products[key].slug}")
    assert response.status_code == 200
    return response.json()


def test_without_promotions_prices_are_the_base_and_the_new_fields_are_null(
    client: TestClient, catalog: Catalog
) -> None:
    items = listing(client, catalog)

    assert len(items) == 3
    for key, item in by_name(items).items():
        assert {"original_price", "discount_amount"} <= set(item)  # siempre presentes
        assert_pricing(item, price=PRICES[key], original=None)
    body = detail(client, catalog, "aurora")
    assert_pricing(body, price=100000, original=None)
    for related in body["related"]:
        assert (related["original_price"], related["discount_amount"]) == (None, None)


def test_percent_on_chosen_products_discounts_only_them_in_listing_detail_and_related(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    add_promotion(
        db_session,
        kind="percent",
        value=10,
        scope="products",
        product_ids=[catalog.products["aurora"].id],
    )

    items = by_name(listing(client, catalog))
    assert_pricing(items["aurora"], price=90000, original=100000)
    assert_pricing(items["boreal"], price=250000, original=None)
    assert_pricing(items["cenit"], price=175000, original=None)
    assert_pricing(detail(client, catalog, "aurora"), price=90000, original=100000)
    # Los relacionados de Boreal incluyen a Aurora con el mismo cálculo.
    related = by_name(detail(client, catalog, "boreal")["related"])
    assert_pricing(related["aurora"], price=90000, original=100000)
    assert_pricing(related["cenit"], price=175000, original=None)


def test_fixed_amount_on_a_category_covers_that_category_only(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    add_promotion(
        db_session, kind="fixed_amount", value=20000, scope="category", category_id=catalog.a.id
    )

    items = by_name(listing(client, catalog))
    assert_pricing(items["aurora"], price=80000, original=100000)
    assert_pricing(items["boreal"], price=230000, original=250000)
    assert_pricing(items["cenit"], price=155000, original=175000)
    [eclipse] = listing(client, catalog, category=catalog.b.slug)
    assert_pricing(eclipse, price=300000, original=None)


def test_catalog_scope_covers_every_published_product_including_later_ones(
    client: TestClient, db_session: Session, repo: SqlProductRepository, catalog: Catalog
) -> None:
    add_promotion(db_session, kind="percent", value=5, scope="catalog")
    later = make_product(catalog.b, "Zenit de prueba", days=9, price=200000)
    repo.add(later)
    repo.add_image(make_image(later, 0))

    assert_pricing(by_name(listing(client, catalog))["aurora"], price=95000, original=100000)
    assert_pricing(by_name(listing(client, catalog))["cenit"], price=166250, original=175000)
    others = by_name(listing(client, catalog, category=catalog.b.slug))
    assert_pricing(others["eclipse"], price=285000, original=300000)
    assert_pricing(others["zenit"], price=190000, original=200000)  # CA-17: creado después


def test_the_lowest_final_price_wins_across_kinds_and_is_never_summed(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    add_promotion(db_session, kind="percent", value=15, scope="catalog")
    add_promotion(
        db_session, kind="fixed_amount", value=20000, scope="category", category_id=catalog.a.id
    )
    add_promotion(
        db_session,
        kind="percent",
        value=5,
        scope="products",
        product_ids=[catalog.products["aurora"].id],
    )

    items = by_name(listing(client, catalog))
    # Aurora: 15 % ahorra 15000 y el monto fijo 20000: gana el fijo.
    assert_pricing(items["aurora"], price=80000, original=100000)
    # Boreal: 15 % ahorra 37500 frente a 20000: gana el porcentaje.
    assert_pricing(items["boreal"], price=212500, original=250000)
    # Cenit: 15 % ahorra 26250 frente a 20000: gana el porcentaje.
    assert_pricing(items["cenit"], price=148750, original=175000)


def test_a_second_promotion_changes_the_price_when_it_beats_the_first(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    add_promotion(db_session, kind="percent", value=10, scope="products", product_ids=[aurora.id])
    assert_pricing(by_name(listing(client, catalog))["aurora"], price=90000, original=100000)

    add_promotion(db_session, kind="fixed_amount", value=25000, scope="catalog")

    assert_pricing(by_name(listing(client, catalog))["aurora"], price=75000, original=100000)


@pytest.mark.parametrize(
    ("active", "starts", "ends"),
    [
        (False, -HOUR, HOUR),  # inactiva
        (True, HOUR, 2 * HOUR),  # programada
        (True, -2 * HOUR, -HOUR),  # vencida
        (True, -HOUR, 0),  # ends_at = now() ya no aplica (R3)
    ],
    ids=["inactive", "scheduled", "expired", "ends-now"],
)
def test_inactive_scheduled_or_expired_promotion_changes_nothing(
    client: TestClient,
    db_session: Session,
    catalog: Catalog,
    active: bool,
    starts: int,
    ends: int,
) -> None:
    add_promotion(
        db_session,
        kind="percent",
        value=50,
        scope="catalog",
        is_active=active,
        starts=starts,
        ends=ends,
    )

    for key, item in by_name(listing(client, catalog)).items():
        assert_pricing(item, price=PRICES[key], original=None)
    assert_pricing(detail(client, catalog, "aurora"), price=100000, original=None)
    assert listing(client, catalog, price_max=60000) == []  # el filtro tampoco lo ve


def test_the_promotion_starting_exactly_now_applies(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    add_promotion(db_session, kind="percent", value=10, scope="catalog", starts=0)

    assert_pricing(by_name(listing(client, catalog))["aurora"], price=90000, original=100000)


@pytest.fixture
def discounted(db_session: Session, catalog: Catalog) -> None:
    """Boreal baja de 250000 a 150000 con un monto fijo; Aurora y Cenit quedan igual."""
    add_promotion(
        db_session,
        kind="fixed_amount",
        value=100000,
        scope="products",
        product_ids=[catalog.products["boreal"].id],
    )


@pytest.mark.usefixtures("discounted")
@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ({"price_max": 160000}, ["boreal", "aurora"]),  # con el precio base saldría solo Aurora
        ({"price_max": 149999}, ["aurora"]),
        ({"price_max": 150000}, ["boreal", "aurora"]),  # el límite es inclusivo
        ({"price_min": 160000}, ["cenit"]),  # con el base saldrían Cenit y Boreal
        ({"price_min": 150000}, ["cenit", "boreal"]),
        ({"price_min": 110000, "price_max": 160000}, ["boreal"]),
        ({"price_min": 200000}, []),  # el precio de lista (250000) no cuenta
    ],
)
def test_price_filters_use_the_effective_price(
    client: TestClient, catalog: Catalog, filters: dict[str, int], expected: list[str]
) -> None:
    assert list(by_name(listing(client, catalog, **filters))) == expected


@pytest.mark.usefixtures("discounted")
@pytest.mark.parametrize(
    ("sort", "expected"),
    [
        ("price_asc", ["aurora", "boreal", "cenit"]),  # con el base: Aurora, Cenit, Boreal
        ("price_desc", ["cenit", "boreal", "aurora"]),
    ],
)
def test_sort_by_price_uses_the_effective_price(
    client: TestClient, catalog: Catalog, sort: str, expected: list[str]
) -> None:
    assert list(by_name(listing(client, catalog, sort=sort))) == expected


@pytest.mark.usefixtures("discounted")
def test_equal_effective_prices_tie_on_the_product_id(
    client: TestClient, repo: SqlProductRepository, catalog: Catalog
) -> None:
    twin = make_product(catalog.a, "Gemelo de prueba", days=5, price=150000)  # = Boreal vigente
    repo.add(twin)
    repo.add_image(make_image(twin, 0))
    pair = sorted([str(twin.id), str(catalog.products["boreal"].id)])

    ascending = [i["id"] for i in listing(client, catalog, sort="price_asc")]
    descending = [i["id"] for i in listing(client, catalog, sort="price_desc")]

    assert [i for i in ascending if i in pair] == pair
    assert [i for i in descending if i in pair] == pair  # CATALOG-R8: el desempate es por id


@pytest.mark.usefixtures("discounted")
def test_total_and_pagination_count_by_effective_price(
    client: TestClient, catalog: Catalog
) -> None:
    params = {"category": catalog.a.slug, "price_max": 160000, "page_size": 1, "sort": "price_asc"}
    first = client.get(f"{BASE}/products", params=params).json()
    second = client.get(f"{BASE}/products", params={**params, "page": 2}).json()
    beyond = client.get(f"{BASE}/products", params={**params, "page": 3}).json()

    assert first["total"] == second["total"] == beyond["total"] == 2
    assert [i["name"] for i in first["items"]] == ["Aurora de prueba"]
    assert [i["name"] for i in second["items"]] == ["Boreal de prueba"]
    assert beyond["items"] == []
    # Sin filtro de precio el total no cambia por la promoción.
    unfiltered = client.get(f"{BASE}/products", params={"category": catalog.a.slug}).json()
    assert unfiltered["total"] == 3


def test_changing_the_base_price_recalculates_the_public_price(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    add_promotion(db_session, kind="percent", value=10, scope="products", product_ids=[aurora.id])
    assert_pricing(by_name(listing(client, catalog))["aurora"], price=90000, original=100000)

    db_session.execute(
        text("UPDATE app.products SET price_cents = 200000 WHERE id = :id"), {"id": aurora.id}
    )

    assert_pricing(detail(client, catalog, "aurora"), price=180000, original=200000)  # CA-11


def test_the_public_body_does_not_leak_the_promotion(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    promotion = add_promotion(db_session, kind="percent", value=10, scope="catalog")
    bodies = [
        client.get(f"{BASE}/products", params={"page_size": 48}).json(),
        detail(client, catalog, "aurora"),
    ]

    for body in bodies:
        assert not {key for key in all_keys(body) if "promotion" in key}
        assert not all_keys(body) & INTERNALS
        assert str(promotion) not in str(body)
        assert "Promoción de prueba" not in str(body)


def test_listing_does_not_query_per_product(
    client: TestClient, db_session: Session, repo: SqlProductRepository, catalog: Catalog
) -> None:
    add_promotion(db_session, kind="percent", value=10, scope="catalog")

    def statements() -> list[str]:
        with captured(db_session) as sql:
            assert client.get(f"{BASE}/products", params={"page_size": 48}).status_code == 200
        return sql

    few = statements()
    for n in range(8):
        extra = make_product(catalog.a, f"Extra {n} de prueba", days=10 + n)
        repo.add(extra)
        repo.add_image(make_image(extra, 0))
    many = statements()

    assert len(many) == len(few)  # el precio vigente va en la misma consulta
    assert any("product_effective_price" in sql for sql in many)


def test_admin_keeps_showing_the_base_price(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    add_promotion(db_session, kind="percent", value=50, scope="catalog")

    body = client.get(f"{BASE}/admin/products/{aurora.id}").json()

    assert body["price"] == money(100000)
    assert not {"original_price", "discount_amount"} & set(body)
    listed = client.get(f"{BASE}/admin/products", params={"page_size": 48}).json()["items"]
    assert {i["price"]["amount"] for i in listed if i["id"] == str(aurora.id)} == {100000}
