"""CA-CATALOG-05, 06 y 08 por HTTP contra PostgreSQL, con la auditoría real.

Cada solicitud corre en un SAVEPOINT (como la transacción de get_session): si falla, se
deshace entera. Nada se confirma: app.audit_log no admite DELETE.
"""

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, wait
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, text
from sqlalchemy.orm import Session

from tests.catalog.catalog_helpers import (
    AUTOMATIC,
    STEEL,
    Catalog,
    make_category,
    make_image,
    make_product,
)
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from valmont.main import create_app
from valmont.modules.catalog.adapters import http
from valmont.modules.catalog.adapters.persistence import (
    CategoryRow,
    SqlCategoryRepository,
    SqlProductRepository,
)
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.config import Settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
BASE = "/api/v1/catalog/admin"
REQUEST_ID = "t028-prueba"
AUDIT = text(
    "SELECT action, actor_id, actor_role, request_id, before, after FROM app.audit_log"
    " WHERE entity_type = 'product' AND entity_id = :id ORDER BY id"
)
ADMIN_PRODUCT_KEYS = {
    "id",
    "slug",
    "sku",
    "name",
    "category",
    "price",
    "movement",
    "case_material",
    "case_diameter_mm",
    "water_resistance_m",
    "main_image",
    "description",
    "specs",
    "images",
    "status",
    "order_policy",
    "lead_time_days",
    "category_id",
    "movement_code",
    "case_material_code",
    "published_at",
    "created_at",
    "updated_at",
}


@pytest.fixture
def client(
    db_session: Session,
    repo: SqlProductRepository,
    catalog: Catalog,
    monkeypatch: pytest.MonkeyPatch,
) -> TestClient:
    # Datos coherentes con CATALOG-R2: todo publicado tiene al menos una imagen.
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
    headers = {"Authorization": f"Bearer {make_token(str(ADMIN))}", "X-Request-ID": REQUEST_ID}
    return TestClient(app, headers=headers)


def audit(session: Session, product_id: object) -> list[tuple[object, ...]]:
    return [tuple(row) for row in session.execute(AUDIT, {"id": str(product_id)})]


def product_body(catalog: Catalog, **changes: object) -> dict[str, object]:
    body = {
        "sku": "TST-NUEVO-01",
        "name": "Nuevo Modelo de Prueba",
        "description": "Primera línea.\r\nSegunda línea.",
        "category_id": str(catalog.a.id),
        "price": {"amount": 150000},
        "order_policy": "stock",
        "movement_code": AUTOMATIC.code,
        "case_material_code": STEEL.code,
        "case_diameter_mm": 40.5,
        "water_resistance_m": 100,
        "specs": [{"label": "Calibre", "value": "TST-02"}, {"label": "Cristal", "value": "Zafiro"}],
    }
    return body | changes


def test_create_product_returns_a_draft_and_audits_it(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    response = client.post(f"{BASE}/products", json=product_body(catalog))

    assert response.status_code == 201
    body = response.json()
    assert set(body) == ADMIN_PRODUCT_KEYS
    assert (body["slug"], body["status"], body["published_at"]) == (
        "nuevo-modelo-de-prueba",  # generado del nombre (CATALOG-R3)
        "draft",
        None,
    )
    assert (body["main_image"], body["images"]) == (None, [])
    assert body["description"] == "Primera línea.\nSegunda línea."  # CATALOG-R12
    assert body["price"] == {"amount": 150000, "currency": "PEN"}
    assert body["specs"][0] == {"label": "Calibre", "value": "TST-02"}
    assert body["movement"] == {"code": AUTOMATIC.code, "label": AUTOMATIC.label}
    assert (body["case_diameter_mm"], body["category_id"]) == (40.5, str(catalog.a.id))
    assert body["created_at"].endswith("Z") and body["updated_at"].endswith("Z")
    after = {"sku": "TST-NUEVO-01", "price_cents": 150000, "order_policy": "stock"}
    assert audit(db_session, body["id"]) == [
        ("catalog.product_created", ADMIN, "admin", REQUEST_ID, None, after)
    ]


@pytest.mark.parametrize(
    ("changes", "code"),
    [({"sku": "TST-AUR-38"}, "sku_taken"), ({"slug": "aurora-de-prueba"}, "slug_taken")],
)
def test_duplicate_sku_or_slug_is_409(
    client: TestClient, catalog: Catalog, changes: dict[str, object], code: str
) -> None:
    response = client.post(f"{BASE}/products", json=product_body(catalog, **changes))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == code


@pytest.mark.parametrize(
    ("changes", "field"),
    [
        ({"category_id": str(uuid4())}, "category_id"),
        ({"movement_code": "no-existe"}, "movement_code"),
        ({"case_material_code": "no-existe"}, "case_material_code"),
    ],
)
def test_missing_references_are_422_on_their_field(
    client: TestClient, catalog: Catalog, changes: dict[str, object], field: str
) -> None:
    created = client.post(f"{BASE}/products", json=product_body(catalog, **changes))
    patched = client.patch(f"{BASE}/products/{catalog.products['aurora'].id}", json=changes)

    for response in (created, patched):
        assert response.status_code == 422
        error = response.json()["error"]
        assert error["code"] == "validation_error"
        assert [(d["loc"], d["type"]) for d in error["details"]] == [
            (["body", field], "reference_not_found")
        ]


def test_admin_reads_include_drafts(client: TestClient, catalog: Catalog) -> None:
    draft = catalog.products["draco"]

    one = client.get(f"{BASE}/products/{draft.id}")
    drafts = client.get(f"{BASE}/products", params={"status": "draft"}).json()
    found = client.get(f"{BASE}/products", params={"q": "vestir", "page_size": 48}).json()

    assert (one.status_code, one.json()["status"]) == (200, "draft")
    assert str(draft.id) in [item["id"] for item in drafts["items"]]
    assert {item["status"] for item in drafts["items"]} == {"draft"}
    assert {item["name"] for item in found["items"]} >= {"Draco borrador", "Cenit de prueba"}
    assert client.get(f"{BASE}/products/{uuid4()}").status_code == 404
    assert client.get(f"{BASE}/products/no-uuid").status_code == 422


def test_patch_changes_only_sent_fields_and_null_clears_optional_attributes(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]

    response = client.patch(
        f"{BASE}/products/{aurora.id}",
        json={"name": "Aurora renombrada", "movement_code": None, "case_diameter_mm": None},
    )

    body = response.json()
    assert response.status_code == 200
    assert (body["name"], body["movement"], body["movement_code"]) == (
        "Aurora renombrada",
        None,
        None,
    )
    assert (body["case_diameter_mm"], body["case_material_code"]) == (None, STEEL.code)
    assert (body["slug"], body["sku"]) == (aurora.slug, aurora.sku)  # sin tocar
    assert audit(db_session, aurora.id) == []  # ni precio ni política: nada que auditar


def test_price_change_is_audited_once(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    url = f"{BASE}/products/{aurora.id}"

    assert client.patch(url, json={"price": {"amount": 120000}}).json()["price"]["amount"] == 120000
    client.patch(url, json={"price": {"amount": 120000}})  # mismo precio: sin entrada nueva

    assert audit(db_session, aurora.id) == [
        (
            "catalog.price_changed",
            ADMIN,
            "admin",
            REQUEST_ID,
            {"price_cents": 100000},
            {"price_cents": 120000},
        )
    ]


def test_order_policy_change_is_audited(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    boreal = catalog.products["boreal"]

    response = client.patch(
        f"{BASE}/products/{boreal.id}", json={"order_policy": "backorder", "lead_time_days": 45}
    )

    assert (response.json()["order_policy"], response.json()["lead_time_days"]) == (
        "backorder",
        45,
    )
    assert audit(db_session, boreal.id) == [
        (
            "catalog.order_policy_changed",
            ADMIN,
            "admin",
            REQUEST_ID,
            {"order_policy": "made_to_order", "lead_time_days": 30},
            {"order_policy": "backorder", "lead_time_days": 45},
        )
    ]


@pytest.mark.parametrize(
    ("key", "changes", "missing"),
    [
        pytest.param("aurora", {"category_id": "inactiva"}, ["category"], id="categoria-inactiva"),
        pytest.param("aurora", {"price": {"amount": 0}}, ["price"], id="precio-0"),
        pytest.param("aurora", {"description": "   "}, ["description"], id="descripcion-vacia"),
        pytest.param(
            "boreal", {"lead_time_days": None}, ["lead_time_days"], id="bajo-pedido-sin-plazo"
        ),
        pytest.param(
            "aurora",
            {"order_policy": "made_to_order"},
            ["lead_time_days"],
            id="stock-a-bajo-pedido",
        ),
    ],
)
def test_patch_that_breaks_catalog_r2_on_a_published_product_is_409_without_changes(
    client: TestClient,
    db_session: Session,
    catalog: Catalog,
    key: str,
    changes: dict[str, object],
    missing: list[str],
) -> None:
    # B-1: CATALOG-R2 es un invariante mientras el producto está publicado.
    if changes.get("category_id") == "inactiva":
        inactive = make_category("Inactiva", is_active=False)
        SqlCategoryRepository(db_session).add(inactive)
        changes = {"category_id": str(inactive.id)}
    product = catalog.products[key]
    url = f"{BASE}/products/{product.id}"
    before = client.get(url).json()

    response = client.patch(url, json=changes)

    assert response.status_code == 409
    error = response.json()["error"]
    assert (error["code"], error["details"]) == ("publish_requirements_unmet", {"missing": missing})
    assert client.get(url).json() == before  # sin cambios
    assert audit(db_session, product.id) == []


def test_the_same_edits_are_allowed_on_a_draft(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    inactive = make_category("Inactiva", is_active=False)
    SqlCategoryRepository(db_session).add(inactive)
    draft = catalog.products["draco"]
    changes = {
        "category_id": str(inactive.id),
        "price": {"amount": 0},
        "description": "",
        "order_policy": "made_to_order",
    }

    response = client.patch(f"{BASE}/products/{draft.id}", json=changes)

    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["price"]["amount"], body["description"]) == ("draft", 0, "")
    assert (body["order_policy"], body["lead_time_days"]) == ("made_to_order", None)


def test_only_the_changed_policy_fields_are_audited(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    # M-1 (AUDIT-R2): solo cambia el plazo.
    boreal = catalog.products["boreal"]

    client.patch(f"{BASE}/products/{boreal.id}", json={"lead_time_days": 60})

    [row] = audit(db_session, boreal.id)
    assert (row[0], row[4], row[5]) == (
        "catalog.order_policy_changed",
        {"lead_time_days": 30},
        {"lead_time_days": 60},
    )


def test_failed_patch_leaves_no_change_and_no_audit(
    client: TestClient, db_session: Session, catalog: Catalog
) -> None:
    aurora = catalog.products["aurora"]
    changes = {"price": {"amount": 1}, "category_id": str(uuid4())}

    assert client.patch(f"{BASE}/products/{aurora.id}", json=changes).status_code == 422

    assert client.get(f"{BASE}/products/{aurora.id}").json()["price"]["amount"] == 100000
    assert audit(db_session, aurora.id) == []


def test_publication_lists_every_unmet_requirement(
    client: TestClient, db_session: Session, repo: SqlProductRepository
) -> None:
    inactive = make_category("Inactiva", is_active=False)
    SqlCategoryRepository(db_session).add(inactive)
    product = make_product(
        inactive, "Incompleto", days=None, description="", price=0, order_policy="made_to_order"
    )
    repo.add(product)

    response = client.post(f"{BASE}/products/{product.id}/publish")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "publish_requirements_unmet"
    assert response.json()["error"]["details"] == {
        "missing": ["description", "category", "price", "image", "lead_time_days"]
    }
    assert audit(db_session, product.id) == []


def test_publish_unpublish_audits_and_locks_the_slug(
    client: TestClient, db_session: Session, repo: SqlProductRepository, catalog: Catalog
) -> None:
    draft = catalog.products["draco"]
    url = f"{BASE}/products/{draft.id}"
    assert client.post(f"{url}/publish").json()["error"]["details"] == {"missing": ["image"]}
    repo.add_image(make_image(draft, 0))

    published = client.post(f"{url}/publish").json()
    again = client.post(f"{url}/publish").json()  # ya publicado: sin cambios ni auditoría
    public = client.get(f"/api/v1/catalog/products/{draft.slug}")
    locked = client.patch(url, json={"slug": "draco-nuevo"})
    same_slug = client.patch(url, json={"slug": draft.slug})
    unpublished = client.post(f"{url}/unpublish").json()
    still_locked = client.patch(url, json={"slug": "draco-nuevo"})
    republished = client.post(f"{url}/publish").json()

    assert published["status"] == again["status"] == "published"
    assert public.status_code == 200  # visible en la API pública
    assert (locked.status_code, locked.json()["error"]["code"]) == (409, "slug_locked")
    assert same_slug.status_code == 200
    assert (unpublished["status"], still_locked.status_code) == ("draft", 409)
    # published_at es la primera publicación: ni despublicar ni republicar lo cambian.
    assert published["published_at"] == unpublished["published_at"] == republished["published_at"]
    assert [(row[0], row[4], row[5]) for row in audit(db_session, draft.id)] == [
        ("catalog.product_published", {"status": "draft"}, {"status": "published"}),
        ("catalog.product_unpublished", {"status": "published"}, {"status": "draft"}),
        ("catalog.product_published", {"status": "draft"}, {"status": "published"}),
    ]


def test_slug_changes_freely_before_the_first_publication(
    client: TestClient, catalog: Catalog
) -> None:
    response = client.patch(
        f"{BASE}/products/{catalog.products['draco'].id}", json={"slug": "draco-nuevo"}
    )

    assert (response.status_code, response.json()["slug"]) == (200, "draco-nuevo")


@pytest.mark.parametrize("action", ["publish", "unpublish"])
def test_publish_and_unpublish_unknown_product_is_404(client: TestClient, action: str) -> None:
    response = client.post(f"{BASE}/products/{uuid4()}/{action}")

    assert (response.status_code, response.json()["error"]["code"]) == (404, "not_found")


def test_admin_manages_categories(client: TestClient, catalog: Catalog) -> None:
    created = client.post(f"{BASE}/categories", json={"name": "Nueva Categoría"})
    duplicate = client.post(f"{BASE}/categories", json={"name": "Otra", "slug": catalog.a.slug})
    category_id = created.json()["id"]
    described = client.patch(f"{BASE}/categories/{category_id}", json={"description": "Texto."})
    in_use = client.patch(f"{BASE}/categories/{catalog.a.id}", json={"is_active": False})
    hidden = client.patch(f"{BASE}/categories/{category_id}", json={"is_active": False})
    missing = client.patch(f"{BASE}/categories/{uuid4()}", json={"name": "X"})

    assert created.status_code == 201
    assert created.json() == {
        "id": category_id,
        "slug": "nueva-categoria",
        "name": "Nueva Categoría",
        "description": None,
        "position": 0,
        "is_active": True,
    }
    assert (duplicate.status_code, duplicate.json()["error"]["code"]) == (409, "slug_taken")
    assert described.json()["description"] == "Texto."
    assert (in_use.status_code, in_use.json()["error"]["code"]) == (409, "category_in_use")
    assert hidden.json()["is_active"] is False
    assert missing.status_code == 404
    admin_slugs = [c["slug"] for c in client.get(f"{BASE}/categories").json()]
    public_slugs = [c["slug"] for c in client.get("/api/v1/catalog/categories").json()]
    assert "nueva-categoria" in admin_slugs
    assert "nueva-categoria" not in public_slugs  # CA-CATALOG-06


@pytest.mark.parametrize(
    ("path", "key", "existing"),
    [
        ("/movement-types", "movements", AUTOMATIC.code),
        ("/case-materials", "case_materials", STEEL.code),
    ],
)
def test_admin_manages_attribute_values(
    client: TestClient, catalog: Catalog, path: str, key: str, existing: str
) -> None:
    created = client.post(f"{BASE}{path}", json={"code": "prueba-nuevo", "label": "Nuevo"})
    duplicate = client.post(f"{BASE}{path}", json={"code": existing, "label": "Otro"})
    relabeled = client.patch(f"{BASE}{path}/prueba-nuevo", json={"label": "Renombrado"})
    unchanged = client.patch(f"{BASE}{path}/prueba-nuevo", json={})
    hidden = client.patch(f"{BASE}{path}/prueba-nuevo", json={"is_active": False})
    missing = client.patch(f"{BASE}{path}/no-existe", json={"label": "X"})

    assert created.status_code == 201
    assert created.json() == {
        "code": "prueba-nuevo",
        "label": "Nuevo",
        "position": 0,
        "is_active": True,
    }
    assert (duplicate.status_code, duplicate.json()["error"]["code"]) == (409, "code_taken")
    assert relabeled.json()["label"] == unchanged.json()["label"] == "Renombrado"
    assert hidden.json()["is_active"] is False
    assert missing.status_code == 404
    admin_codes = [v["code"] for v in client.get(f"{BASE}/attributes").json()[key]]
    public_codes = [v["code"] for v in client.get("/api/v1/catalog/attributes").json()[key]]
    assert "prueba-nuevo" in admin_codes
    assert "prueba-nuevo" not in public_codes  # CA-CATALOG-06


@pytest.fixture
def committed_category(db_engine: Engine) -> Iterator[UUID]:
    """Categoría confirmada para probar bloqueos entre conexiones; se borra al terminar."""
    category = make_category("Bloqueo")
    with Session(db_engine) as session, session.begin():
        SqlCategoryRepository(session).add(category)
    yield category.id
    with db_engine.begin() as connection:
        connection.execute(delete(CategoryRow).filter_by(id=category.id))


def lock_for_update(engine: Engine, category_id: UUID) -> bool:
    with Session(engine) as session, session.begin():
        return SqlCategoryRepository(session).get(category_id, lock="update") is not None


def test_publishing_blocks_deactivation_of_its_category_until_it_ends(
    db_engine: Engine, committed_category: UUID
) -> None:
    # CATALOG-R10 sin carreras: publicar toma la categoría FOR SHARE y desactivar, FOR UPDATE.
    with ThreadPoolExecutor(max_workers=1) as pool, Session(db_engine) as publisher:
        publisher.begin()
        SqlCategoryRepository(publisher).get(committed_category, lock="share")
        deactivation = pool.submit(lock_for_update, db_engine, committed_category)
        assert not wait([deactivation], timeout=0.5).done  # espera a la publicación
        publisher.rollback()  # la publicación termina: la desactivación sigue
        assert deactivation.result(timeout=5) is True
