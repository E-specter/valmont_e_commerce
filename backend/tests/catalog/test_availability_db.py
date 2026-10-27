"""CA-CATALOG-09 (T-030): disponibilidad por HTTP contra PostgreSQL, leída de la vista
app.product_availability. El stock y las reservas se insertan por SQL: catalog no usa el código de
inventory (modules.md §3). La transacción de la prueba se deshace."""

from datetime import timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import (
    QUANTITIES,
    all_keys,
    make_category,
    make_image,
    make_product,
)
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.adapters.persistence import (
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.catalog.domain import Category, OrderPolicy, Product
from valmont.shared.config import Settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

BASE = "/api/v1/catalog"
LEAD = 21  # plazo de los productos bajo pedido o por encargo
STOCK, MADE, BACK = OrderPolicy.STOCK, OrderPolicy.MADE_TO_ORDER, OrderPolicy.BACKORDER


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    settings = Settings(_env_file=None, storage_public_url="https://cdn.valmont.test")
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    # El umbral por defecto (D-027), explícito por si la BD de pruebas tuviera otro.
    db_session.execute(text("UPDATE app.inventory_settings SET low_stock_threshold = 2"))
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db_session
    return TestClient(app)


@pytest.fixture
def category(db_session: Session) -> Category:
    category = make_category("Disponibilidad")
    SqlCategoryRepository(db_session).add(category)
    return category


def add_product(
    session: Session,
    category: Category,
    name: str,
    policy: OrderPolicy = STOCK,
    *,
    on_hand: int | None = None,
    days: int = 0,
    **changes: object,
) -> Product:
    """Publicado hace `days` días, con una imagen. on_hand=None: sin fila de stock (on_hand 0)."""
    lead_time_days = None if policy is STOCK else LEAD
    product = make_product(
        category, name, days=days, order_policy=policy, lead_time_days=lead_time_days, **changes
    )
    repo = SqlProductRepository(session)
    repo.add(product)
    repo.add_image(make_image(product, 0))
    if on_hand is not None:
        session.execute(
            text("INSERT INTO app.inventory_items (product_id, on_hand) VALUES (:id, :on_hand)"),
            {"id": product.id, "on_hand": on_hand},
        )
    return product


def add_reservation(
    session: Session, product_id: UUID, quantity: int, status: str, minutes: int
) -> None:
    """Reserva de un pedido ficticio que vence dentro de `minutes` (en el pasado si es < 0).
    now() es el de la transacción: el mismo que usa la vista."""
    session.execute(
        text(
            "INSERT INTO app.stock_reservations"
            " (id, product_id, order_id, quantity, status, expires_at)"
            " VALUES (gen_random_uuid(), :product_id, gen_random_uuid(), :quantity, :status,"
            " now() + :ttl)"
        ),
        {
            "product_id": product_id,
            "quantity": quantity,
            "status": status,
            "ttl": timedelta(minutes=minutes),
        },
    )


@pytest.mark.parametrize(
    ("policy", "on_hand", "reservations", "status", "lead_time_days"),
    [
        # stock: > umbral (2) → in_stock; 1–2 → low_stock; 0 → out_of_stock (INVENTORY-R2).
        pytest.param(STOCK, 3, [], "in_stock", None, id="stock-3"),
        pytest.param(STOCK, 2, [], "low_stock", None, id="stock-2"),
        pytest.param(STOCK, 1, [], "low_stock", None, id="stock-1"),
        pytest.param(STOCK, 0, [], "out_of_stock", None, id="stock-0"),
        pytest.param(STOCK, None, [], "out_of_stock", None, id="stock-sin-fila"),
        # backorder: agotado → on_request con plazo; con stock, como stock y sin plazo.
        pytest.param(BACK, 0, [], "on_request", LEAD, id="backorder-0"),
        pytest.param(BACK, None, [], "on_request", LEAD, id="backorder-sin-fila"),
        pytest.param(BACK, 5, [], "in_stock", None, id="backorder-con-stock"),
        pytest.param(BACK, 2, [], "low_stock", None, id="backorder-ultimas"),
        # made_to_order: siempre on_request, tenga o no stock.
        pytest.param(MADE, None, [], "on_request", LEAD, id="made_to_order"),
        pytest.param(MADE, 10, [], "on_request", LEAD, id="made_to_order-con-stock"),
        # Reservas (INVENTORY-R1): solo las activas no vencidas reducen lo disponible.
        pytest.param(STOCK, 4, [(2, "active", 30)], "low_stock", None, id="reserva-activa"),
        pytest.param(STOCK, 3, [(3, "active", 30)], "out_of_stock", None, id="todo-reservado"),
        pytest.param(BACK, 2, [(2, "active", 30)], "on_request", LEAD, id="backorder-reservado"),
        pytest.param(STOCK, 4, [(2, "active", -1)], "in_stock", None, id="reserva-vencida"),
        pytest.param(STOCK, 4, [(2, "released", 30)], "in_stock", None, id="reserva-liberada"),
        pytest.param(STOCK, 4, [(2, "consumed", 30)], "in_stock", None, id="reserva-consumida"),
    ],
)
def test_availability_follows_d023_in_the_listing_and_the_detail(
    client: TestClient,
    db_session: Session,
    category: Category,
    policy: OrderPolicy,
    on_hand: int | None,
    reservations: list[tuple[int, str, int]],
    status: str,
    lead_time_days: int | None,
) -> None:
    product = add_product(db_session, category, "Reloj de disponibilidad", policy, on_hand=on_hand)
    for quantity, state, minutes in reservations:
        add_reservation(db_session, product.id, quantity, state, minutes)

    listing = client.get(f"{BASE}/products", params={"category": category.slug}).json()
    detail = client.get(f"{BASE}/products/{product.slug}").json()

    expected = {"status": status, "lead_time_days": lead_time_days}
    [item] = listing["items"]
    assert item["availability"] == detail["availability"] == expected
    assert not QUANTITIES & (all_keys(listing) | all_keys(detail))  # inventory SPEC §2


def test_available_filter_drops_only_out_of_stock_with_real_total_and_pages(
    client: TestClient, db_session: Session, category: Category
) -> None:
    # Por defecto, los más recientes primero: el orden de las páginas es estable.
    add_product(db_session, category, "Agotado de prueba", on_hand=0, days=5, price=300000)
    add_product(db_session, category, "Sin fila de prueba", days=4)
    add_product(db_session, category, "Disponible de prueba", on_hand=5, days=3)
    add_product(db_session, category, "Ultimas de prueba", on_hand=1, days=2)
    add_product(db_session, category, "Encargo de prueba", MADE, days=1, price=300000)
    add_product(db_session, category, "Bajo pedido de prueba", BACK, on_hand=0, days=0)
    params: dict[str, object] = {"category": category.slug, "available": "true", "page_size": 3}

    first = client.get(f"{BASE}/products", params=params).json()
    second = client.get(f"{BASE}/products", params={**params, "page": 2}).json()
    combined = client.get(f"{BASE}/products", params={**params, "price_min": 200000}).json()
    unfiltered = client.get(f"{BASE}/products", params={"category": category.slug}).json()
    explicit_false = client.get(
        f"{BASE}/products", params={"category": category.slug, "available": "false"}
    ).json()

    assert [item["name"] for item in first["items"]] == [
        "Disponible de prueba",
        "Ultimas de prueba",
        "Encargo de prueba",
    ]
    assert [item["name"] for item in second["items"]] == ["Bajo pedido de prueba"]
    assert first["total"] == second["total"] == 4  # el total cuenta todas las páginas
    statuses = {item["availability"]["status"] for item in first["items"] + second["items"]}
    assert statuses == {"in_stock", "low_stock", "on_request"}  # on_request cuenta (SPEC §7)
    # AND con los demás filtros: de los dos de 300000, el agotado queda fuera.
    assert [item["name"] for item in combined["items"]] == ["Encargo de prueba"]
    assert combined["total"] == 1
    # Sin el filtro (o con false), también los agotados.
    assert unfiltered["total"] == explicit_false["total"] == 6
    assert not QUANTITIES & all_keys(first)


def test_detail_and_related_carry_their_own_availability(
    client: TestClient, db_session: Session, category: Category
) -> None:
    main = add_product(db_session, category, "Principal de prueba", on_hand=1, days=3)
    add_product(db_session, category, "Agotado de prueba", on_hand=0, days=2)
    add_product(db_session, category, "Bajo pedido de prueba", BACK, days=1)
    add_product(db_session, category, "Con stock de prueba", BACK, on_hand=7, days=0)

    body = client.get(f"{BASE}/products/{main.slug}").json()

    assert body["availability"] == {"status": "low_stock", "lead_time_days": None}
    assert [(item["name"], item["availability"]) for item in body["related"]] == [
        ("Agotado de prueba", {"status": "out_of_stock", "lead_time_days": None}),
        ("Bajo pedido de prueba", {"status": "on_request", "lead_time_days": LEAD}),
        ("Con stock de prueba", {"status": "in_stock", "lead_time_days": None}),
    ]
    assert not QUANTITIES & all_keys(body)


def test_listing_reads_availability_in_its_two_queries_without_quantities(
    client: TestClient, db_session: Session, category: Category
) -> None:
    for n in range(3):  # 0 → out_of_stock; 1 y 2 → low_stock
        add_product(db_session, category, f"Reloj {n} de prueba", on_hand=n, days=n)
    connection = db_session.connection()
    statements: list[str] = []

    def capture(*args: object) -> None:
        statements.append(str(args[2]))  # (conn, cursor, statement, parameters, …)

    event.listen(connection, "before_cursor_execute", capture)
    try:
        params = {"category": category.slug, "available": "true"}
        response = client.get(f"{BASE}/products", params=params)
    finally:
        event.remove(connection, "before_cursor_execute", capture)

    assert response.json()["total"] == 2
    assert len(statements) == 2  # el total y la página: nunca una consulta por producto
    assert all("app.product_availability" in statement for statement in statements)
    assert not any("product_availability.available" in statement for statement in statements)
