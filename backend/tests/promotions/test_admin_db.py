"""CA-PROMOTIONS-01 a 04, 12 y 16 por HTTP contra PostgreSQL, con la auditoría real (SPEC §7).

Cada solicitud corre en un SAVEPOINT (como la transacción de get_session): si falla, se deshace
entera. Nada se confirma: app.audit_log no admite DELETE. Datos ficticios."""

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.promotions.promotions_helpers import HOUR, add_category, add_product, add_promotion
from valmont.main import create_app
from valmont.modules.audit.adapters.http import get_audit_recorder
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
BASE = "/api/v1/promotions/admin"
REQUEST_ID = "7f2e9c30-5d46-4bac-9e8f-2c3d4e5f6071"
AUDIT = text(
    "SELECT action, actor_id, actor_role, request_id, before, after FROM app.audit_log"
    " WHERE entity_type = 'promotion' AND entity_id = :id ORDER BY id"
)
COUNTS = text(
    "SELECT (SELECT count(*) FROM app.promotions),"
    " (SELECT count(*) FROM app.promotion_products),"
    " (SELECT count(*) FROM app.audit_log WHERE entity_type = 'promotion')"
)
SUMMARY_KEYS = {
    "id",
    "name",
    "kind",
    "percent_off",
    "amount_off",
    "scope",
    "category",
    "starts_at",
    "ends_at",
    "is_active",
    "status",
    "product_count",
    "created_at",
    "updated_at",
}
NOW = datetime.now(UTC)
INT4_MAX = 2**31 - 1


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def money(amount: int) -> dict[str, object]:
    return {"amount": amount, "currency": "PEN"}


@dataclass
class World:
    cat: UUID
    other_cat: UUID
    p1: UUID  # S/ 10 000,00
    p2: UUID  # S/ 5 000,00 (en borrador, como p1: H-3)
    p3: UUID


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    use_test_auth(monkeypatch)
    profiles = InMemoryProfiles()
    profiles.rows[ADMIN] = Profile(ADMIN, Role.ADMIN, T0, T0)
    app = create_app()
    app.dependency_overrides[get_profile_repository] = lambda: profiles

    def request_session() -> Iterator[Session]:
        with db_session.begin_nested():
            yield db_session

    app.dependency_overrides[get_session] = request_session
    headers = {"Authorization": f"Bearer {make_token(str(ADMIN))}", "X-Request-ID": REQUEST_ID}
    return TestClient(app, headers=headers, raise_server_exceptions=False)


@pytest.fixture
def world(db_session: Session) -> World:
    cat, other = add_category(db_session), add_category(db_session, is_active=False)
    return World(
        cat,
        other,
        add_product(db_session, 1_000_000, category_id=cat),
        add_product(db_session, 500_000, category_id=cat),
        add_product(db_session, 300_000, category_id=other),
    )


def valid_body(world: World, **changes: object) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Temporada de prueba",
        "kind": "percent",
        "percent_off": 15,
        "scope": "products",
        "product_ids": [str(world.p1), str(world.p2)],
        "starts_at": iso(NOW - timedelta(days=1)),
        "ends_at": iso(NOW + timedelta(days=30)),
    }
    return {k: v for k, v in (body | changes).items() if v is not ABSENT}


ABSENT = object()  # marca un campo del cuerpo que se quita


def create(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f"{BASE}/promotions", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def audit(session: Session, promotion_id: object) -> list[tuple[Any, ...]]:
    return [tuple(row) for row in session.execute(AUDIT, {"id": str(promotion_id)})]


def counts(session: Session) -> tuple[int, ...]:
    return tuple(session.execute(COUNTS).one())


def detail(client: TestClient, promotion_id: object) -> dict[str, Any]:
    response = client.get(f"{BASE}/promotions/{promotion_id}")
    assert response.status_code == 200, response.text
    return response.json()


def error_locs(response: Any) -> list[list[object]]:
    return [d["loc"][:2] for d in response.json()["error"]["details"]]


# --- CA-PROMOTIONS-01 -------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["percent", "fixed_amount"])
@pytest.mark.parametrize("scope", ["products", "category", "catalog"])
def test_create_each_kind_and_scope_returns_201_active_and_audited(
    client: TestClient, db_session: Session, world: World, kind: str, scope: str
) -> None:
    # CA-PROMOTIONS-01 (UC-01, R13): las seis combinaciones; el actor sale del token.
    value = {"percent_off": 15} if kind == "percent" else {"amount_off": money(20000)}
    other = {"percent_off": ABSENT} if kind == "fixed_amount" else {}
    target = {
        "products": {"product_ids": [str(world.p1), str(world.p2)]},
        "category": {"product_ids": ABSENT, "category_id": str(world.cat)},
        "catalog": {"product_ids": ABSENT},
    }[scope]
    body = valid_body(world, kind=kind, scope=scope, **value, **other, **target)

    response = client.post(f"{BASE}/promotions", json=body)

    assert response.status_code == 201
    created = response.json()
    assert set(created) == SUMMARY_KEYS | {"products"}
    assert (created["kind"], created["scope"], created["is_active"]) == (kind, scope, True)
    assert created["status"] == "active"
    assert created["percent_off"] == (15 if kind == "percent" else None)
    assert created["amount_off"] == (money(20000) if kind == "fixed_amount" else None)
    assert created["created_at"].endswith("Z") and created["ends_at"].endswith("Z")
    assert created["product_count"] == (2 if scope == "products" else 0)
    assert len(created["products"]) == (2 if scope == "products" else 0)
    if scope == "category":
        row = db_session.execute(
            text("SELECT slug, name FROM app.categories WHERE id = :id"), {"id": world.cat}
        ).one()
        assert created["category"] == {"id": str(world.cat), "slug": row[0], "name": row[1]}
    else:
        assert created["category"] is None
    [(action, actor, role, request_id, before, after)] = audit(db_session, created["id"])
    assert (action, actor, role, request_id, before) == (
        "promotions.promotion_created",
        ADMIN,
        "admin",
        REQUEST_ID,
        None,
    )
    assert after["name"] == "Temporada de prueba"
    assert (after["kind"], after["scope"]) == (kind, scope)
    assert after.get("percent_off") == (15 if kind == "percent" else None)
    assert after.get("amount_off_cents") == (20000 if kind == "fixed_amount" else None)
    assert after.get("category_id") == (str(world.cat) if scope == "category" else None)
    assert after.get("product_ids", []) == (
        sorted([str(world.p1), str(world.p2)]) if scope == "products" else []
    )
    assert datetime.fromisoformat(after["starts_at"]) == datetime.fromisoformat(body["starts_at"])
    assert datetime.fromisoformat(after["ends_at"]) == datetime.fromisoformat(body["ends_at"])


def test_create_detail_lists_products_by_sku_with_list_and_effective_price(
    client: TestClient, db_session: Session, world: World
) -> None:
    # SPEC §7 PromotionProductOut: `price` es el vigente HOY con la mejor promoción (puede ser
    # otra, R5): la fija de S/ 1 000 gana en p2 (el 15 % deja menos) y pierde en p1.
    add_promotion(db_session, kind="fixed_amount", value=100_000, scope="catalog")

    created = create(client, valid_body(world))

    by_id = {p["id"]: p for p in created["products"]}
    assert set(by_id) == {str(world.p1), str(world.p2)}
    assert [p["sku"] for p in created["products"]] == sorted(p["sku"] for p in by_id.values())
    assert set(by_id[str(world.p1)]) == {"id", "sku", "name", "list_price", "price"}
    assert by_id[str(world.p1)]["list_price"] == money(1_000_000)
    assert by_id[str(world.p1)]["price"] == money(850_000)  # 15 % > S/ 1 000 fijos
    assert by_id[str(world.p2)]["list_price"] == money(500_000)
    assert by_id[str(world.p2)]["price"] == money(400_000)  # gana la fija


@pytest.mark.parametrize(
    ("starts", "ends", "status"),
    [
        (timedelta(days=1), timedelta(days=30), "scheduled"),
        (timedelta(days=-1), timedelta(days=30), "active"),
    ],
)
def test_create_status_is_computed_by_the_server(
    client: TestClient, world: World, starts: timedelta, ends: timedelta, status: str
) -> None:
    # R9: el servidor devuelve el estado según las fechas; crear activa por defecto.
    created = create(
        client, valid_body(world, starts_at=iso(NOW + starts), ends_at=iso(NOW + ends))
    )

    assert (created["status"], created["is_active"]) == (status, True)


def test_create_accepts_the_limits_draft_products_and_inactive_category(
    client: TestClient, db_session: Session, world: World
) -> None:
    # Bordes válidos: 1 y 90 %, el monto máximo, un nombre de 120 caracteres recortado, productos
    # en borrador (H-3) y categoría inactiva (H-6, `other_cat` lo es).
    low = create(client, valid_body(world, percent_off=1, name=f"  {'n' * 120}  "))
    high = create(client, valid_body(world, percent_off=90))
    fixed = create(
        client,
        valid_body(
            world, kind="fixed_amount", percent_off=ABSENT, amount_off=money(INT4_MAX), name="Max"
        ),
    )
    inactive_category = create(
        client,
        valid_body(
            world, scope="category", product_ids=ABSENT, category_id=str(world.other_cat), name="C"
        ),
    )

    assert (low["percent_off"], low["name"]) == (1, "n" * 120)
    assert high["percent_off"] == 90
    assert fixed["amount_off"] == money(INT4_MAX)
    assert inactive_category["category"]["id"] == str(world.other_cat)
    status = db_session.scalar(
        text("SELECT status FROM app.products WHERE id = :id"), {"id": world.p1}
    )
    assert status == "draft"  # los productos de `valid_body` están en borrador


def _body(change: Callable[[World], dict[str, Any]]) -> Callable[[World], dict[str, Any]]:
    return change


INVALID_CREATES = [
    # (cuerpo, campo con el error): CA-PROMOTIONS-01, R1, R2, R4, R10 y SPEC §7 «Validación».
    pytest.param(lambda w: valid_body(w, percent_off=0), "percent_off", id="porcentaje-0"),
    pytest.param(lambda w: valid_body(w, percent_off=-5), "percent_off", id="porcentaje-negativo"),
    pytest.param(lambda w: valid_body(w, percent_off=91), "percent_off", id="porcentaje-91"),
    pytest.param(lambda w: valid_body(w, percent_off=15.5), "percent_off", id="porcentaje-decimal"),
    pytest.param(lambda w: valid_body(w, percent_off=None), "percent_off", id="porcentaje-nulo"),
    pytest.param(
        lambda w: valid_body(w, percent_off=ABSENT), "percent_off", id="percent-sin-valor"
    ),
    pytest.param(
        lambda w: valid_body(w, amount_off=money(20000)), "amount_off", id="percent-con-monto"
    ),
    pytest.param(
        lambda w: valid_body(w, kind="fixed_amount", amount_off=money(0), percent_off=ABSENT),
        "amount_off",
        id="monto-0",
    ),
    pytest.param(
        lambda w: valid_body(w, kind="fixed_amount", amount_off=money(-1), percent_off=ABSENT),
        "amount_off",
        id="monto-negativo",
    ),
    pytest.param(
        lambda w: valid_body(
            w, kind="fixed_amount", amount_off=money(INT4_MAX + 1), percent_off=ABSENT
        ),
        "amount_off",
        id="monto-mayor-que-integer",
    ),
    pytest.param(
        lambda w: valid_body(
            w,
            kind="fixed_amount",
            amount_off={"amount": 20000, "currency": "USD"},
            percent_off=ABSENT,
        ),
        "amount_off",
        id="monto-otra-moneda",
    ),
    pytest.param(
        lambda w: valid_body(w, kind="fixed_amount", percent_off=ABSENT),
        "amount_off",
        id="fixed-sin-valor",
    ),
    pytest.param(
        lambda w: valid_body(w, kind="fixed_amount", amount_off=money(20000)),
        "percent_off",
        id="fixed-con-porcentaje",
    ),
    pytest.param(
        lambda w: valid_body(w, ends_at=iso(NOW - timedelta(days=1)), starts_at=iso(NOW)),
        "ends_at",
        id="fin-anterior-al-inicio",
    ),
    pytest.param(
        lambda w: valid_body(w, starts_at=iso(NOW), ends_at=iso(NOW)),
        "ends_at",
        id="fin-igual-al-inicio",
    ),
    pytest.param(
        lambda w: valid_body(
            w, starts_at=iso(NOW - timedelta(days=60)), ends_at=iso(NOW - timedelta(days=30))
        ),
        "ends_at",
        id="ya-vencida-R10",
    ),
    pytest.param(lambda w: valid_body(w, product_ids=[]), "product_ids", id="products-vacio"),
    pytest.param(
        lambda w: valid_body(w, product_ids=ABSENT), "product_ids", id="products-sin-lista"
    ),
    pytest.param(
        lambda w: valid_body(w, product_ids=[str(uuid4()) for _ in range(101)]),
        "product_ids",
        id="101-productos",
    ),
    pytest.param(
        lambda w: valid_body(w, product_ids=[str(w.p1), str(w.p1)]),
        "product_ids",
        id="ids-repetidos",
    ),
    pytest.param(
        lambda w: valid_body(w, product_ids=[str(w.p1), str(uuid4())]),
        "product_ids",
        id="producto-inexistente",
    ),
    pytest.param(
        lambda w: valid_body(w, category_id=str(w.cat)), "category_id", id="categoria-con-products"
    ),
    pytest.param(
        lambda w: valid_body(w, scope="category", product_ids=ABSENT),
        "category_id",
        id="category-sin-categoria",
    ),
    pytest.param(
        lambda w: valid_body(w, scope="category", product_ids=ABSENT, category_id=str(uuid4())),
        "category_id",
        id="categoria-inexistente",
    ),
    pytest.param(
        lambda w: valid_body(w, scope="category", category_id=str(w.cat)),
        "product_ids",
        id="category-con-productos",
    ),
    pytest.param(
        lambda w: valid_body(w, scope="catalog"), "product_ids", id="catalog-con-productos"
    ),
    pytest.param(
        lambda w: valid_body(w, scope="catalog", product_ids=ABSENT, category_id=str(w.cat)),
        "category_id",
        id="catalog-con-categoria",
    ),
    pytest.param(lambda w: valid_body(w, name=""), "name", id="nombre-vacio"),
    pytest.param(lambda w: valid_body(w, name="   "), "name", id="nombre-en-blanco"),
    pytest.param(lambda w: valid_body(w, name="n" * 121), "name", id="nombre-sobrelargo"),
    pytest.param(lambda w: valid_body(w, name="Oferta\x07"), "name", id="nombre-con-control"),
]


@pytest.mark.parametrize(("make_body", "field"), INVALID_CREATES)
def test_invalid_create_is_422_with_the_field_and_leaves_nothing(
    client: TestClient, db_session: Session, world: World, make_body: Any, field: str
) -> None:
    # CA-PROMOTIONS-01 y CA-PROMOTIONS-12: 422 con el loc del campo, sin promoción ni auditoría.
    before = counts(db_session)

    response = client.post(f"{BASE}/promotions", json=make_body(world))

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert ["body", field] in error_locs(response)
    assert counts(db_session) == before


# --- CA-PROMOTIONS-04: detalle y listado ------------------------------------------------------


def test_get_returns_the_detail_and_404_for_an_unknown_id(client: TestClient, world: World) -> None:
    created = create(client, valid_body(world))

    assert detail(client, created["id"]) == created
    missing = client.get(f"{BASE}/promotions/{uuid4()}")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"


def test_get_detail_has_no_products_unless_the_scope_is_products(
    client: TestClient, world: World
) -> None:
    category = create(
        client, valid_body(world, scope="category", product_ids=ABSENT, category_id=str(world.cat))
    )
    catalog = create(client, valid_body(world, scope="catalog", product_ids=ABSENT))

    for created in (category, catalog):
        shown = detail(client, created["id"])
        assert (shown["products"], shown["product_count"]) == ([], 0)


def listed(client: TestClient, **params: object) -> dict[str, Any]:
    response = client.get(f"{BASE}/promotions", params={"page_size": 48, **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_list_filters_by_status_and_scope_and_orders_by_start_descending(
    client: TestClient, db_session: Session, world: World
) -> None:
    # CA-PROMOTIONS-04, R9: cuatro estados calculados; `inactive` lo es tenga la fecha que tenga.
    filters = [{}, *({"status": s} for s in ("active", "scheduled", "expired", "inactive"))]
    filters += [{"scope": s} for s in ("products", "category", "catalog")]
    filters += [{"status": "inactive", "scope": "catalog"}]
    baseline = {tuple(f.items()): listed(client, **f)["total"] for f in filters}
    active = add_promotion(db_session, starts=-HOUR, ends=HOUR)
    scheduled = add_promotion(
        db_session, scope="products", product_ids=[world.p1], starts=HOUR, ends=2 * HOUR
    )
    expired = add_promotion(
        db_session, scope="category", category_id=world.cat, starts=-3 * HOUR, ends=-2 * HOUR
    )
    inactive = add_promotion(db_session, starts=-2 * HOUR, ends=HOUR, is_active=False)
    inactive_past = add_promotion(db_session, starts=-5 * HOUR, ends=-4 * HOUR, is_active=False)
    mine = {active, scheduled, expired, inactive, inactive_past}
    expected = {
        (): mine,
        (("status", "active"),): {active},
        (("status", "scheduled"),): {scheduled},
        (("status", "expired"),): {expired},
        (("status", "inactive"),): {inactive, inactive_past},
        (("scope", "products"),): {scheduled},
        (("scope", "category"),): {expired},
        (("scope", "catalog"),): {active, inactive, inactive_past},
        (("status", "inactive"), ("scope", "catalog")): {inactive, inactive_past},
    }

    for params, ids in expected.items():
        page = listed(client, **dict(params))
        shown = {UUID(item["id"]) for item in page["items"]}
        assert shown & mine == ids, params
        assert page["total"] == baseline[params] + len(ids), params
        wanted = dict(params).get("status")
        assert all(item["status"] == wanted for item in page["items"] if wanted)
    everything = listed(client)
    order = [UUID(i["id"]) for i in everything["items"] if UUID(i["id"]) in mine]
    # starts_at descendente: programada, activa, inactiva, vencida, inactiva pasada.
    assert order == [scheduled, active, inactive, expired, inactive_past]


def test_list_items_are_summaries_with_product_count_and_computed_status(
    client: TestClient, db_session: Session, world: World
) -> None:
    scheduled = add_promotion(
        db_session, scope="products", product_ids=[world.p1, world.p2], starts=HOUR, ends=2 * HOUR
    )
    fixed = add_promotion(db_session, kind="fixed_amount", value=20000, starts=-HOUR, ends=HOUR)

    items = {i["id"]: i for i in listed(client)["items"]}

    assert set(items[str(scheduled)]) == SUMMARY_KEYS  # sin `products`: es el resumen
    assert (items[str(scheduled)]["product_count"], items[str(scheduled)]["status"]) == (
        2,
        "scheduled",
    )
    assert items[str(scheduled)]["percent_off"] == 10
    assert items[str(scheduled)]["amount_off"] is None
    assert items[str(fixed)]["amount_off"] == money(20000)
    assert (items[str(fixed)]["percent_off"], items[str(fixed)]["product_count"]) == (None, 0)
    assert items[str(fixed)]["status"] == "active"


def test_list_paginates_and_a_page_past_the_end_is_empty_with_the_real_total(
    client: TestClient, db_session: Session
) -> None:
    for n in range(5):
        add_promotion(db_session, starts=-(n + 1) * HOUR, ends=HOUR)
    full = listed(client)
    total = full["total"]
    assert total >= 5 and len(full["items"]) == total  # el resto de la BD de pruebas está vacío

    collected, page = [], 1
    while chunk := client.get(f"{BASE}/promotions", params={"page": page, "page_size": 2}).json():
        assert (chunk["page"], chunk["page_size"], chunk["total"]) == (page, 2, total)
        if not chunk["items"]:
            break
        assert len(chunk["items"]) <= 2
        collected += [i["id"] for i in chunk["items"]]
        page += 1

    assert collected == [i["id"] for i in full["items"]]
    past = client.get(f"{BASE}/promotions", params={"page": 1000, "page_size": 2}).json()
    assert (past["items"], past["total"]) == ([], total)
    default = client.get(f"{BASE}/promotions").json()
    assert default["page_size"] == 24 and default["page"] == 1


# --- CA-PROMOTIONS-02: edición parcial (R14) --------------------------------------------------


def patch(client: TestClient, promotion_id: object, body: dict[str, Any]) -> Any:
    return client.patch(f"{BASE}/promotions/{promotion_id}", json=body)


def test_patch_changes_fields_audits_only_what_changed_and_the_price_follows(
    client: TestClient, db_session: Session, world: World
) -> None:
    # CA-PROMOTIONS-02, CA-PROMOTIONS-12 (before/after de lo que cambia, AUDIT-R2) y que el
    # precio vigente cambia al instante.
    created = create(client, valid_body(world))
    assert created["products"][0]["price"] == money(850_000) or created["products"][1][
        "price"
    ] == money(850_000)

    response = patch(client, created["id"], {"name": "  Otoño  ", "percent_off": 20})

    assert response.status_code == 200
    body = response.json()
    assert (body["name"], body["percent_off"]) == ("Otoño", 20)
    prices = {p["id"]: p["price"] for p in body["products"]}
    assert prices[str(world.p1)] == money(800_000)
    assert prices[str(world.p2)] == money(400_000)
    assert detail(client, created["id"]) == body
    rows = audit(db_session, created["id"])
    assert [row[0] for row in rows] == [
        "promotions.promotion_created",
        "promotions.promotion_updated",
    ]
    _, actor, role, request_id, before, after = rows[1]
    assert (actor, role, request_id) == (ADMIN, "admin", REQUEST_ID)
    assert before == {"name": "Temporada de prueba", "percent_off": 15}
    assert after == {"name": "Otoño", "percent_off": 20}


def test_patch_dates_and_replaces_the_product_list(
    client: TestClient, db_session: Session, world: World
) -> None:
    created = create(client, valid_body(world))
    ends = NOW + timedelta(days=60)

    response = patch(client, created["id"], {"product_ids": [str(world.p3)], "ends_at": iso(ends)})

    assert response.status_code == 200
    body = response.json()
    assert [p["id"] for p in body["products"]] == [str(world.p3)] and body["product_count"] == 1
    assert datetime.fromisoformat(body["ends_at"]) == ends.replace(microsecond=ends.microsecond)
    [_, (_, _, _, _, before, after)] = audit(db_session, created["id"])
    assert before["product_ids"] == sorted([str(world.p1), str(world.p2)])
    assert after["product_ids"] == [str(world.p3)]
    assert set(before) == set(after) == {"product_ids", "ends_at"}
    rows = db_session.scalar(
        text("SELECT count(*) FROM app.promotion_products WHERE promotion_id = :id"),
        {"id": created["id"]},
    )
    assert rows == 1  # la lista se reemplaza, sin filas mezcladas


def test_patch_changes_the_category_of_a_category_promotion(
    client: TestClient, db_session: Session, world: World
) -> None:
    created = create(
        client, valid_body(world, scope="category", product_ids=ABSENT, category_id=str(world.cat))
    )

    response = patch(client, created["id"], {"category_id": str(world.other_cat)})

    assert response.status_code == 200
    assert response.json()["category"]["id"] == str(world.other_cat)
    [_, row] = audit(db_session, created["id"])
    assert row[4] == {"category_id": str(world.cat)}
    assert row[5] == {"category_id": str(world.other_cat)}


def test_patch_kind_needs_the_new_value_and_discards_the_old_one(
    client: TestClient, db_session: Session, world: World
) -> None:
    # R14: cambiar `kind` sin el valor del nuevo tipo → 422; con él, el anterior se descarta.
    created = create(client, valid_body(world))
    before = counts(db_session)

    missing = patch(client, created["id"], {"kind": "fixed_amount"})

    assert missing.status_code == 422
    assert ["body", "amount_off"] in error_locs(missing)
    assert counts(db_session) == before
    assert detail(client, created["id"])["kind"] == "percent"

    swapped = patch(
        client, created["id"], {"kind": "fixed_amount", "amount_off": money(20000)}
    ).json()
    assert (swapped["kind"], swapped["percent_off"], swapped["amount_off"]) == (
        "fixed_amount",
        None,
        money(20000),
    )
    back = patch(client, created["id"], {"kind": "percent", "percent_off": 30}).json()
    assert (back["kind"], back["percent_off"], back["amount_off"]) == ("percent", 30, None)
    rows = audit(db_session, created["id"])
    # R13: before/after de lo que cambia; el valor que pasa de null a un número también cambia.
    assert rows[1][4] == {"kind": "percent", "percent_off": 15, "amount_off_cents": None}
    assert rows[1][5] == {"kind": "fixed_amount", "percent_off": None, "amount_off_cents": 20000}
    assert rows[2][4] == {"kind": "fixed_amount", "percent_off": None, "amount_off_cents": 20000}
    assert rows[2][5] == {"kind": "percent", "percent_off": 30, "amount_off_cents": None}


@pytest.mark.parametrize(
    ("kind", "body", "field"),
    [
        ("percent", {"amount_off": money(20000)}, "amount_off"),
        ("fixed_amount", {"percent_off": 10}, "percent_off"),
    ],
)
def test_patch_a_value_of_the_other_kind_is_422(
    client: TestClient, world: World, kind: str, body: dict[str, Any], field: str
) -> None:
    changes = {"kind": kind}
    if kind == "fixed_amount":
        changes |= {"percent_off": ABSENT, "amount_off": money(20000)}
    created = create(client, valid_body(world, **changes))

    response = patch(client, created["id"], body)

    assert response.status_code == 422
    assert ["body", field] in error_locs(response)


def test_patch_scope_discards_the_previous_target(
    client: TestClient, db_session: Session, world: World
) -> None:
    # R14 y CA-PROMOTIONS-02: al salir de `products` la lista queda vacía y sin filas.
    created = create(client, valid_body(world))

    to_category = patch(client, created["id"], {"scope": "category"})
    assert to_category.status_code == 422 and ["body", "category_id"] in error_locs(to_category)
    to_category = patch(
        client, created["id"], {"scope": "category", "category_id": str(world.cat)}
    ).json()
    assert (to_category["scope"], to_category["category"]["id"]) == ("category", str(world.cat))
    assert (to_category["products"], to_category["product_count"]) == ([], 0)
    assert detail(client, created["id"])["products"] == []
    rows = text("SELECT count(*) FROM app.promotion_products WHERE promotion_id = :id")
    assert db_session.scalar(rows, {"id": created["id"]}) == 0

    to_products = patch(client, created["id"], {"scope": "products"})
    assert to_products.status_code == 422 and ["body", "product_ids"] in error_locs(to_products)
    to_products = patch(
        client, created["id"], {"scope": "products", "product_ids": [str(world.p1)]}
    ).json()
    assert (to_products["scope"], to_products["category"]) == ("products", None)
    assert [p["id"] for p in to_products["products"]] == [str(world.p1)]

    to_catalog = patch(client, created["id"], {"scope": "catalog"}).json()
    assert (to_catalog["scope"], to_catalog["category"], to_catalog["products"]) == (
        "catalog",
        None,
        [],
    )
    assert db_session.scalar(rows, {"id": created["id"]}) == 0
    assert [row[0] for row in audit(db_session, created["id"])] == [
        "promotions.promotion_created",
        *["promotions.promotion_updated"] * 3,
    ]


@pytest.mark.parametrize(
    ("scope", "body", "field"),
    [
        ("catalog", {"product_ids": "p1"}, "product_ids"),
        ("catalog", {"category_id": "cat"}, "category_id"),
        ("catalog", {"scope": "catalog", "category_id": "cat"}, "category_id"),
        ("category", {"product_ids": "p1"}, "product_ids"),
        ("products", {"category_id": "cat"}, "category_id"),
        ("products", {"scope": "catalog", "product_ids": "p1"}, "product_ids"),
        (
            "products",
            {"scope": "category", "category_id": "cat", "product_ids": "p1"},
            "product_ids",
        ),
    ],
)
def test_patch_a_target_that_does_not_match_the_resulting_scope_is_422(
    client: TestClient, world: World, scope: str, body: dict[str, Any], field: str
) -> None:
    changes: dict[str, Any] = {"scope": scope}
    if scope == "category":
        changes |= {"product_ids": ABSENT, "category_id": str(world.cat)}
    if scope == "catalog":
        changes |= {"product_ids": ABSENT}
    created = create(client, valid_body(world, **changes))
    real = {"p1": [str(world.p1)], "cat": str(world.cat)}
    body = {k: real.get(v, v) if isinstance(v, str) else v for k, v in body.items()}

    response = patch(client, created["id"], body)

    assert response.status_code == 422, response.text
    assert ["body", field] in error_locs(response)


def test_patch_empty_body_is_422(client: TestClient, db_session: Session, world: World) -> None:
    created = create(client, valid_body(world))
    before = counts(db_session)

    response = patch(client, created["id"], {})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert error_locs(response) == [["body"]]  # SPEC §7: un PATCH sin campos
    assert counts(db_session) == before


@pytest.mark.parametrize("field", ["name", "kind", "scope", "starts_at", "ends_at"])
def test_patch_an_explicit_null_of_a_required_field_is_422(
    client: TestClient, db_session: Session, world: World, field: str
) -> None:
    created = create(client, valid_body(world))
    before = counts(db_session)

    response = patch(client, created["id"], {field: None})

    assert response.status_code == 422
    assert ["body", field] in error_locs(response)
    assert counts(db_session) == before


def test_patch_null_discards_an_optional_value_of_the_current_target(
    client: TestClient, world: World
) -> None:
    # Un `null` en category_id descarta el valor; el resultado debe seguir siendo coherente.
    created = create(
        client, valid_body(world, scope="category", product_ids=ABSENT, category_id=str(world.cat))
    )

    response = patch(client, created["id"], {"category_id": None})

    assert response.status_code == 422
    assert ["body", "category_id"] in error_locs(response)  # category exige categoría (R4)
    assert detail(client, created["id"]) == created


def test_patch_without_real_changes_is_200_and_audits_nothing(
    client: TestClient, db_session: Session, world: World
) -> None:
    # R13: auditoría solo cuando algo cambia.
    created = create(client, valid_body(world))
    before = counts(db_session)

    response = patch(
        client,
        created["id"],
        {"name": created["name"], "product_ids": [str(world.p2), str(world.p1)]},
    )

    assert response.status_code == 200
    assert counts(db_session) == before


def test_patch_extends_an_expired_promotion_and_does_not_require_a_future_end(
    client: TestClient, db_session: Session, world: World
) -> None:
    # CA-PROMOTIONS-02 y R10/H-4: al editar solo se exige R2; una vencida se extiende.
    expired = add_promotion(db_session, starts=-3 * HOUR, ends=-HOUR)
    assert detail(client, expired)["status"] == "expired"

    still_past = patch(client, expired, {"ends_at": iso(NOW - timedelta(minutes=10))})
    assert still_past.status_code == 200
    assert still_past.json()["status"] == "expired"
    extended = patch(client, expired, {"ends_at": iso(NOW + timedelta(days=7))})
    assert extended.status_code == 200
    assert extended.json()["status"] == "active"
    [(first, *_), (second, *_)] = audit(db_session, expired)
    assert (first, second) == ("promotions.promotion_updated",) * 2


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param({"ends_at": "2000-01-01T00:00:00Z"}, "ends_at", id="fin-antes-del-inicio"),
        pytest.param({"percent_off": 91}, "percent_off", id="porcentaje"),
        pytest.param({"name": " "}, "name", id="nombre"),
        pytest.param({"product_ids": []}, "product_ids", id="sin-productos"),
        pytest.param({"percent_off": None}, "percent_off", id="valor-nulo"),
        pytest.param({"starts_at": "2099-01-01T00:00:00Z"}, "ends_at", id="inicio-tras-el-fin"),
    ],
)
def test_invalid_patch_is_422_and_changes_nothing(
    client: TestClient, db_session: Session, world: World, body: dict[str, Any], field: str
) -> None:
    created = create(client, valid_body(world))
    before = counts(db_session)

    response = patch(client, created["id"], body)

    assert response.status_code == 422, response.text
    assert ["body", field] in error_locs(response)
    assert counts(db_session) == before
    assert detail(client, created["id"]) == created


def test_patch_with_unknown_product_or_category_reports_the_field_and_changes_nothing(
    client: TestClient, db_session: Session, world: World
) -> None:
    created = create(client, valid_body(world))
    category = create(
        client, valid_body(world, scope="category", product_ids=ABSENT, category_id=str(world.cat))
    )
    before = counts(db_session)

    products = patch(client, created["id"], {"name": "Otro", "product_ids": [str(uuid4())]})
    categories = patch(client, category["id"], {"name": "Otro", "category_id": str(uuid4())})

    assert products.status_code == categories.status_code == 422
    assert ["body", "product_ids"] in error_locs(products)
    assert ["body", "category_id"] in error_locs(categories)
    assert counts(db_session) == before
    assert detail(client, created["id"]) == created  # ni el nombre ni los productos cambiaron
    assert detail(client, category["id"]) == category


def test_patch_and_toggles_of_an_unknown_promotion_are_404(client: TestClient) -> None:
    unknown = uuid4()

    for response in (
        patch(client, unknown, {"name": "Otro nombre"}),
        client.post(f"{BASE}/promotions/{unknown}/activate"),
        client.post(f"{BASE}/promotions/{unknown}/deactivate"),
    ):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"


# --- CA-PROMOTIONS-03: activar y desactivar ---------------------------------------------------


def price_of(client: TestClient, promotion_id: object, product_id: UUID) -> object:
    shown = detail(client, promotion_id)
    return next(p["price"] for p in shown["products"] if p["id"] == str(product_id))


def test_deactivate_and_activate_toggle_the_discount_and_audit_once_each(
    client: TestClient, db_session: Session, world: World
) -> None:
    created = create(client, valid_body(world))
    assert price_of(client, created["id"], world.p1) == money(850_000)

    off = client.post(f"{BASE}/promotions/{created['id']}/deactivate")

    assert off.status_code == 200
    assert (off.json()["is_active"], off.json()["status"]) == (False, "inactive")
    assert price_of(client, created["id"], world.p1) == money(
        1_000_000
    )  # sin descuento al instante
    rows = audit(db_session, created["id"])
    assert [r[0] for r in rows] == [
        "promotions.promotion_created",
        "promotions.promotion_deactivated",
    ]
    _, actor, role, request_id, before, after = rows[1]
    assert (actor, role, request_id) == (ADMIN, "admin", REQUEST_ID)
    assert (before, after) == ({"is_active": True}, {"is_active": False})

    again = client.post(f"{BASE}/promotions/{created['id']}/deactivate")
    assert again.status_code == 200 and again.json() == off.json()
    assert len(audit(db_session, created["id"])) == 2  # repetir no audita

    on = client.post(f"{BASE}/promotions/{created['id']}/activate")
    assert on.status_code == 200
    assert (on.json()["is_active"], on.json()["status"]) == (True, "active")
    assert price_of(client, created["id"], world.p1) == money(850_000)
    rows = audit(db_session, created["id"])
    assert rows[2][0] == "promotions.promotion_activated"
    assert (rows[2][4], rows[2][5]) == ({"is_active": False}, {"is_active": True})
    again = client.post(f"{BASE}/promotions/{created['id']}/activate")
    assert again.status_code == 200 and again.json() == on.json()
    assert len(audit(db_session, created["id"])) == 3


def test_activating_an_inactive_future_or_past_promotion_keeps_the_calendar_status(
    client: TestClient, db_session: Session
) -> None:
    # R9: activar no fuerza «activa»: la vigencia manda (scheduled / expired).
    future = add_promotion(db_session, starts=HOUR, ends=2 * HOUR, is_active=False)
    past = add_promotion(db_session, starts=-3 * HOUR, ends=-HOUR, is_active=False)

    assert detail(client, future)["status"] == detail(client, past)["status"] == "inactive"
    assert client.post(f"{BASE}/promotions/{future}/activate").json()["status"] == "scheduled"
    assert client.post(f"{BASE}/promotions/{past}/activate").json()["status"] == "expired"


# --- CA-PROMOTIONS-12: auditoría en la misma transacción --------------------------------------


class FailingAudit:
    def record(self, entry: object) -> None:
        raise RuntimeError("auditoría caída")


def test_a_failing_audit_rolls_back_the_create_the_update_and_the_toggle(
    client: TestClient, db_session: Session, world: World
) -> None:
    # CA-PROMOTIONS-12: la auditoría va en la misma transacción: si falla, no queda cambio.
    created = create(client, valid_body(world))
    before = counts(db_session)
    app = client.app
    app.dependency_overrides[get_audit_recorder] = FailingAudit

    responses = [
        client.post(f"{BASE}/promotions", json=valid_body(world, name="Otra")),
        patch(client, created["id"], {"percent_off": 25, "product_ids": [str(world.p3)]}),
        client.post(f"{BASE}/promotions/{created['id']}/deactivate"),
    ]
    del app.dependency_overrides[get_audit_recorder]

    assert [r.status_code for r in responses] == [500, 500, 500]
    assert counts(db_session) == before
    assert detail(client, created["id"]) == created  # ni valor, ni productos, ni estado


def test_a_422_leaves_no_audit_entry_for_any_write_route(
    client: TestClient, db_session: Session, world: World
) -> None:
    created = create(client, valid_body(world))
    before = counts(db_session)

    client.post(f"{BASE}/promotions", json=valid_body(world, percent_off=0))
    patch(client, created["id"], {"percent_off": 0})
    patch(client, created["id"], {})
    client.post(f"{BASE}/promotions/{uuid4()}/activate")
    client.post(f"{BASE}/promotions/{uuid4()}/deactivate")

    assert counts(db_session) == before


# --- CA-PROMOTIONS-16 por HTTP: el precio vigente nunca baja de 1 céntimo ---------------------


def test_a_fixed_amount_above_the_price_leaves_one_cent_in_the_detail(
    client: TestClient, db_session: Session
) -> None:
    cheap = add_product(db_session, 15_000)
    body = {
        "name": "Monto alto",
        "kind": "fixed_amount",
        "amount_off": money(20_000),  # S/ 200 sobre un reloj de S/ 150
        "scope": "products",
        "product_ids": [str(cheap)],
        "starts_at": iso(NOW - timedelta(days=1)),
        "ends_at": iso(NOW + timedelta(days=1)),
    }

    created = create(client, body)

    assert created["products"][0]["list_price"] == money(15_000)
    assert created["products"][0]["price"] == money(1)
