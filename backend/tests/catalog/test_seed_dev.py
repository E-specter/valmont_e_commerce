"""Semillas de demostración (T-031): datos ficticios, rechazo en prod e idempotencia."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import InMemoryStorage
from tests.catalog.test_admin_http import Untouchable
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.domain import IMAGE_MAX_BYTES, OrderPolicy, image_format
from valmont.scripts import seed_dev
from valmont.shared.config import Settings
from valmont.shared.db import get_session

COUNTS = text(
    "SELECT"
    " (SELECT count(*) FROM app.products WHERE sku LIKE 'DEMO-%'),"
    " (SELECT count(*) FROM app.products WHERE sku LIKE 'DEMO-%' AND status = 'published'),"
    " (SELECT count(*) FROM app.product_images i JOIN app.products p ON p.id = i.product_id"
    "   WHERE p.sku LIKE 'DEMO-%'),"
    " (SELECT count(*) FROM app.categories WHERE slug = ANY(:slugs)),"
    " (SELECT count(*) FROM app.movement_types WHERE code IN ('automatic', 'manual')),"
    " (SELECT count(*) FROM app.case_materials"
    "   WHERE code IN ('steel', 'gold-18k', 'titanium', 'ceramic')),"
    " (SELECT count(*) FROM app.audit_log a JOIN app.products p ON a.entity_id = p.id::text"
    "   WHERE p.sku LIKE 'DEMO-%' AND a.actor_id IS NULL),"
    " (SELECT count(*) FROM app.stock_movements m JOIN app.products p ON p.id = m.product_id"
    "   WHERE p.sku LIKE 'DEMO-%'),"
    " (SELECT count(*) FROM app.inventory_items i JOIN app.products p ON p.id = i.product_id"
    "   WHERE p.sku LIKE 'DEMO-%')"
)
MOVEMENTS = text(
    "SELECT DISTINCT m.kind, m.note, m.actor_id, a.action FROM app.stock_movements m"
    " JOIN app.products p ON p.id = m.product_id"
    " LEFT JOIN app.audit_log a ON a.entity_id = p.id::text AND a.action LIKE 'inventory.%'"
    " WHERE p.sku LIKE 'DEMO-%'"
)
ON_HAND = text(
    "SELECT p.sku, i.on_hand FROM app.inventory_items i JOIN app.products p"
    " ON p.id = i.product_id WHERE p.sku LIKE 'DEMO-%'"
)
# Con el umbral 2 (D-027), los cuatro estados de D-023 por SKU (T-030).
EXPECTED_STATUS = {
    "DEMO-001": "in_stock",
    "DEMO-002": "low_stock",
    "DEMO-003": "on_request",
    "DEMO-004": "on_request",
    "DEMO-005": "out_of_stock",
    "DEMO-006": "in_stock",
    "DEMO-007": "in_stock",
    "DEMO-008": "low_stock",
    "DEMO-009": "on_request",
    "DEMO-010": "in_stock",
    "DEMO-011": "on_request",
    "DEMO-012": "out_of_stock",
}


def test_demo_products_are_fictitious_and_cover_every_order_policy() -> None:
    products = seed_dev.PRODUCTS

    assert len(products) == 12
    assert all(p["sku"].startswith("DEMO-") and "Demo" in p["name"] for p in products)
    assert all("\n" in p["description"] for p in products)  # varias líneas (CATALOG-R12)
    assert {p["order_policy"] for p in products} == set(OrderPolicy)
    assert all(p["lead_time_days"] for p in products if p["order_policy"] is not OrderPolicy.STOCK)
    assert len({p["category"] for p in products}) == len(seed_dev.CATEGORIES) == 4


def test_demo_stock_only_names_demo_products_with_positive_units() -> None:
    skus = {p["sku"] for p in seed_dev.PRODUCTS}

    assert set(seed_dev.DEMO_STOCK) <= skus
    assert all(units > 0 for units in seed_dev.DEMO_STOCK.values())  # 0 = sin fila de stock


def test_placeholder_is_a_png_by_its_signature_and_varies_by_color() -> None:
    red, blue = seed_dev.placeholder_png((200, 80, 80)), seed_dev.placeholder_png((80, 80, 200))

    assert image_format(red) == ("png", "image/png")
    assert red != blue
    assert len(red) < IMAGE_MAX_BYTES


def test_refuses_to_run_in_prod_without_touching_the_database_or_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        seed_dev, "get_settings", lambda: Settings(_env_file=None, environment="prod")
    )
    monkeypatch.setattr(seed_dev, "get_engine", Untouchable)
    monkeypatch.setattr(seed_dev, "get_image_storage", Untouchable)

    with pytest.raises(SystemExit) as exit_:
        seed_dev.main()

    assert "prod" in str(exit_.value.code)  # mensaje de error: código de salida 1


@pytest.mark.integration
def test_two_runs_leave_the_same_rows_and_files_and_the_api_shows_the_twelve(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = InMemoryStorage()
    slugs = {"slugs": [c["slug"] for c in seed_dev.CATEGORIES]}
    # El umbral por defecto (D-027), explícito por si la BD de pruebas tuviera otro.
    db_session.execute(text("UPDATE app.inventory_settings SET low_stock_threshold = 2"))

    seed_dev.seed(db_session, storage)
    first, files = db_session.execute(COUNTS, slugs).one(), set(storage.files)
    # Un cambio del admin entre ejecuciones: con fila de stock, la semilla no lo pisa.
    db_session.execute(
        text(
            "UPDATE app.inventory_items AS i SET on_hand = 9 FROM app.products AS p"
            " WHERE p.id = i.product_id AND p.sku = 'DEMO-007'"
        )
    )
    seed_dev.seed(db_session, storage)

    # 12 productos publicados con una imagen, 4 categorías, 2 + 4 valores, 30 entradas de
    # auditoría del sistema (alta, publicación y 6 ajustes de stock), 6 movimientos y 6 filas
    # de stock: la segunda vez no crea, no sube ni registra nada.
    assert tuple(first) == (12, 12, 12, 4, 2, 4, 30, 6, 6)
    assert tuple(db_session.execute(COUNTS, slugs).one()) == tuple(first)
    assert set(storage.files) == files and len(files) == 12
    # Con RecordMovement (UC-INVENTORY-01): ajuste con nota, actor del sistema y auditoría.
    assert [tuple(row) for row in db_session.execute(MOVEMENTS)] == [
        ("ajuste_inventario", seed_dev.STOCK_NOTE, None, "inventory.stock_adjusted")
    ]
    assert dict(db_session.execute(ON_HAND).tuples().all()) == {
        **seed_dev.DEMO_STOCK,
        "DEMO-007": 9,
    }

    settings = Settings(_env_file=None, storage_public_url="https://cdn.valmont.test")
    monkeypatch.setattr(http, "get_settings", lambda: settings)
    app = create_app()

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    client = TestClient(app)
    page = client.get("/api/v1/catalog/products", params={"page_size": 48}).json()
    demo = [item for item in page["items"] if item["sku"].startswith("DEMO-")]
    assert len(demo) == 12
    assert all(item["main_image"]["alt"] == seed_dev.ALT for item in demo)
    # Los cuatro estados de D-023 entre los 12, con plazo solo en on_request (T-030).
    lead = {p["sku"]: p["lead_time_days"] for p in seed_dev.PRODUCTS}
    assert {item["sku"]: item["availability"] for item in demo} == {
        sku: {"status": status, "lead_time_days": lead[sku] if status == "on_request" else None}
        for sku, status in EXPECTED_STATUS.items()
    }
    assert set(EXPECTED_STATUS.values()) == {"in_stock", "low_stock", "out_of_stock", "on_request"}
    detail = client.get(f"/api/v1/catalog/products/{demo[0]['slug']}")
    assert detail.status_code == 200
    assert detail.json()["images"] and detail.json()["related"]
