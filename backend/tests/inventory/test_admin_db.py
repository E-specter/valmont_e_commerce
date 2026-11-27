"""CA-INVENTORY-01 y 05 por HTTP contra PostgreSQL, con la auditoría real (SPEC §7).

Cada solicitud corre en un SAVEPOINT (como la transacción de get_session): si falla, se deshace
entera. Nada se confirma: app.audit_log no admite DELETE. Como todo va en una transacción,
now() es el mismo en las solicitudes, en la vista y en db_now(). Datos ficticios.
"""

from collections.abc import Iterator
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, insert, select, text
from sqlalchemy.orm import Session

from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.inventory.inventory_helpers import (
    add_product,
    add_reservation,
    consume_reservations,
    reserve_stock,
)
from valmont.main import create_app
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.modules.inventory.adapters.persistence import (
    InventoryItemRow,
    SqlMovementRepository,
    SqlReservationRepository,
)
from valmont.modules.inventory.domain import (
    MovementKind,
    OrderLine,
    ReservationExpired,
    ReservationStatus,
)
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

ADMIN = uuid4()
BASE = "/api/v1/inventory/admin"
REQUEST_ID = "6e1d8b2f-4c35-4a9b-8d7e-1b2c3d4e5f60"
INT4_MAX = 2**31 - 1
AUDIT = text(
    "SELECT action, actor_id, actor_role, request_id, before, after FROM app.audit_log"
    " WHERE entity_type = :type AND entity_id = :id ORDER BY id"
)
ITEM_KEYS = {
    "product_id",
    "sku",
    "name",
    "product_status",
    "on_hand",
    "reserved",
    "available",
    "status",
}
MOVEMENT_KEYS = {
    "id",
    "product_id",
    "kind",
    "quantity_delta",
    "on_hand_after",
    "note",
    "actor_id",
    "order_id",
    "created_at",
}


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
    return TestClient(app, headers=headers)


def product(session: Session, on_hand: int | None, policy: str = "stock", **fields: str) -> UUID:
    """Producto con su fila de stock (None: sin fila)."""
    product_id = add_product(session, policy, **fields)
    if on_hand is not None:
        session.execute(insert(InventoryItemRow).values(product_id=product_id, on_hand=on_hand))
    return product_id


def on_hand(session: Session, product_id: UUID) -> int | None:
    return session.scalar(select(InventoryItemRow.on_hand).filter_by(product_id=product_id))


def movements(session: Session, product_id: UUID) -> list[MovementKind]:
    return [m.kind for m in SqlMovementRepository(session).list_recent(product_id, 50)]


def audit(session: Session, entity_type: str, entity_id: object) -> list[tuple[object, ...]]:
    rows = session.execute(AUDIT, {"type": entity_type, "id": str(entity_id)})
    return [tuple(row) for row in rows]


def db_now(session: Session) -> datetime:
    return session.scalars(select(func.now())).one()


def movement_url(product_id: object) -> str:
    return f"{BASE}/stock/{product_id}/movements"


def test_each_admin_movement_updates_on_hand_with_its_movement_and_audit(
    client: TestClient, db_session: Session
) -> None:
    # CA-INVENTORY-01. El producto empieza sin fila de stock (on_hand 0).
    product_id = product(db_session, None)
    # (cuerpo, delta, on_hand_after, nota guardada: recortada y con \r\n → \n, SPEC §7)
    steps = [
        ({"kind": "entrada", "quantity": 5}, 5, 5, None),
        ({"kind": "devolucion", "quantity": 1, "note": " Desistimiento "}, 1, 6, "Desistimiento"),
        (
            {"kind": "merma", "quantity": 2, "note": "Cristal rayado\r\nen vitrina"},
            -2,
            4,
            "Cristal rayado\nen vitrina",
        ),
        (
            {"kind": "ajuste_inventario", "quantity": 7, "note": "Recuento anual"},
            3,  # cantidad contada 7: el delta lo calcula el servidor (R5)
            7,
            "Recuento anual",
        ),
    ]
    created = []

    for body, delta, after, note in steps:
        response = client.post(movement_url(product_id), json=body)

        assert response.status_code == 201, response.json()
        movement = response.json()
        assert set(movement) == MOVEMENT_KEYS
        assert (
            movement["product_id"],
            movement["kind"],
            movement["quantity_delta"],
            movement["on_hand_after"],
            movement["note"],
            movement["actor_id"],
            movement["order_id"],
        ) == (str(product_id), body["kind"], delta, after, note, str(ADMIN), None)
        assert isinstance(movement["id"], int)
        assert movement["created_at"].endswith("Z")
        created.append(movement)

    detail = client.get(f"{BASE}/stock/{product_id}").json()
    assert (detail["on_hand"], detail["reserved"], detail["available"]) == (7, 0, 7)
    assert detail["movements"] == created[::-1]  # el más reciente primero
    assert on_hand(db_session, product_id) == 7
    kinds = ["entrada", "devolucion", "merma", "ajuste_inventario"]
    befores, afters = [0, 5, 6, 4], [5, 6, 4, 7]
    assert audit(db_session, "product", product_id) == [
        (
            "inventory.stock_adjusted",
            ADMIN,
            "admin",
            REQUEST_ID,
            {"on_hand": before},
            {"on_hand": after, "kind": kind},
        )
        for kind, before, after in zip(kinds, befores, afters, strict=True)
    ]


def test_a_count_of_zero_empties_the_stock(client: TestClient, db_session: Session) -> None:
    product_id = product(db_session, 3)

    response = client.post(
        movement_url(product_id),
        json={"kind": "ajuste_inventario", "quantity": 0, "note": "Vitrina vacía"},
    )

    assert response.status_code == 201
    assert (response.json()["quantity_delta"], response.json()["on_hand_after"]) == (-3, 0)
    assert on_hand(db_session, product_id) == 0


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param({"kind": "merma", "quantity": 1}, "note", id="merma-sin-nota"),
        pytest.param({"kind": "merma", "quantity": 1, "note": ""}, "note", id="nota-vacia"),
        pytest.param(
            {"kind": "ajuste_inventario", "quantity": 1, "note": "   "}, "note", id="nota-blanca"
        ),
        pytest.param({"kind": "merma", "quantity": 1, "note": "x" * 501}, "note", id="nota-larga"),
        pytest.param(
            {"kind": "entrada", "quantity": 1, "note": "con \x00 nulo"}, "note", id="nota-nul"
        ),
        pytest.param({"kind": "merma", "quantity": 1, "note": "Rotura\t"}, "note", id="nota-tab"),
        pytest.param({"kind": "merma", "quantity": 0, "note": "Rotura"}, "quantity", id="merma-0"),
        pytest.param({"kind": "entrada", "quantity": 0}, "quantity", id="entrada-0"),
    ],
)
def test_invalid_movement_is_422_on_its_field_without_changes(
    client: TestClient, db_session: Session, body: dict[str, object], field: str
) -> None:
    product_id = product(db_session, 3)

    response = client.post(movement_url(product_id), json=body)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert [d["loc"] for d in error["details"]] == [["body", field]]
    assert on_hand(db_session, product_id) == 3
    assert movements(db_session, product_id) == []
    assert audit(db_session, "product", product_id) == []


def test_resulting_on_hand_above_the_integer_column_is_422_on_quantity(
    client: TestClient, db_session: Session
) -> None:
    product_id = product(db_session, INT4_MAX - 1)

    too_many = client.post(movement_url(product_id), json={"kind": "entrada", "quantity": 2})
    exactly = client.post(movement_url(product_id), json={"kind": "devolucion", "quantity": 1})

    assert too_many.status_code == 422
    assert [d["loc"] for d in too_many.json()["error"]["details"]] == [["body", "quantity"]]
    assert (exactly.status_code, exactly.json()["on_hand_after"]) == (201, INT4_MAX)
    assert on_hand(db_session, product_id) == INT4_MAX


def test_count_equal_to_on_hand_is_422_no_change(client: TestClient, db_session: Session) -> None:
    # INVENTORY-R9: no hay movimiento que registrar.
    product_id = product(db_session, 4)

    response = client.post(
        movement_url(product_id),
        json={"kind": "ajuste_inventario", "quantity": 4, "note": "Recuento"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "no_change"
    assert response.json()["error"]["details"] is None
    assert movements(db_session, product_id) == []
    assert audit(db_session, "product", product_id) == []


def test_shrinkage_below_zero_is_409_insufficient_stock_before_stock_reserved(
    client: TestClient, db_session: Session
) -> None:
    # R6: 3 > 2 deja on_hand bajo 0 y bajo lo reservado; gana insufficient_stock.
    product_id = product(db_session, 2)
    add_reservation(db_session, product_id, 1)

    response = client.post(
        movement_url(product_id), json={"kind": "merma", "quantity": 3, "note": "Rotura"}
    )

    assert response.status_code == 409
    error = response.json()["error"]
    assert (error["code"], error["details"]) == (
        "insufficient_stock",
        {"on_hand": 2, "reserved": 1},
    )
    assert on_hand(db_session, product_id) == 2
    assert movements(db_session, product_id) == []
    assert audit(db_session, "product", product_id) == []


def test_shrinkage_below_an_existing_reservation_is_409_stock_reserved(
    client: TestClient, db_session: Session
) -> None:
    # INVENTORY-R6 (criterio de T-043): un pedido reservó 2 de 3; no se puede incumplir.
    product_id = product(db_session, 3)
    order_id = uuid4()
    reserve_stock(db_session)(order_id, [OrderLine(product_id, 2)], db_now(db_session))

    shrink = client.post(
        movement_url(product_id), json={"kind": "merma", "quantity": 2, "note": "Rotura"}
    )
    count = client.post(
        movement_url(product_id),
        json={"kind": "ajuste_inventario", "quantity": 1, "note": "Recuento"},
    )

    for response in (shrink, count):
        assert response.status_code == 409
        error = response.json()["error"]
        assert (error["code"], error["details"]) == (
            "stock_reserved",
            {"on_hand": 3, "reserved": 2},
        )
    assert on_hand(db_session, product_id) == 3
    assert movements(db_session, product_id) == []
    assert audit(db_session, "product", product_id) == []
    detail = client.get(f"{BASE}/stock/{product_id}").json()
    assert (detail["on_hand"], detail["reserved"], detail["available"]) == (3, 2, 1)

    # Hasta lo reservado sí se puede retirar.
    allowed = client.post(
        movement_url(product_id), json={"kind": "merma", "quantity": 1, "note": "Rotura"}
    )

    assert (allowed.status_code, allowed.json()["on_hand_after"]) == (201, 2)
    statuses = [r.status for r in SqlReservationRepository(db_session).for_order(order_id)]
    assert statuses == [ReservationStatus.ACTIVE]


def test_shrinkage_after_a_reservation_expired_reaches_the_r11_check_of_consume(
    client: TestClient, db_session: Session
) -> None:
    # Criterio de T-043 (Nota 2 de QA, ronda 3 de T-042). O reservó la única unidad hace 31 min:
    # su reserva venció y no cuenta para R6, así que la merma pasa. Si O paga con un reloj
    # anterior a ese vencimiento, su reserva aún vale para R8, pero on_hand 0 ya no la cubre:
    # R11 da ReservationExpired sin escribir nada.
    product_id = product(db_session, 1)
    order_id, t0 = uuid4(), db_now(db_session) - timedelta(minutes=31)
    reserve_stock(db_session)(order_id, [OrderLine(product_id, 1)], t0)

    response = client.post(
        movement_url(product_id), json={"kind": "merma", "quantity": 1, "note": "Rotura"}
    )

    assert response.status_code == 201
    assert response.json()["on_hand_after"] == 0

    with pytest.raises(ReservationExpired):
        consume_reservations(db_session)(order_id, t0 + timedelta(minutes=29, seconds=59))

    assert on_hand(db_session, product_id) == 0
    assert movements(db_session, product_id) == [MovementKind.MERMA]  # ninguna venta
    statuses = [r.status for r in SqlReservationRepository(db_session).for_order(order_id)]
    assert statuses == [ReservationStatus.ACTIVE]


def test_unknown_product_is_404_without_creating_stock(
    client: TestClient, db_session: Session
) -> None:
    unknown = uuid4()

    detail = client.get(f"{BASE}/stock/{unknown}")
    movement = client.post(movement_url(unknown), json={"kind": "entrada", "quantity": 1})

    for response in (detail, movement):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"
    assert on_hand(db_session, unknown) is None


def test_detail_of_a_product_without_stock_row(client: TestClient, db_session: Session) -> None:
    sku = f"TST-SIN-FILA-{uuid4().hex[:8]}"
    product_id = product(db_session, None, sku=sku, name="Reloj sin fila")

    response = client.get(f"{BASE}/stock/{product_id}")

    assert response.status_code == 200
    assert response.json() == {
        "product_id": str(product_id),
        "sku": sku,
        "name": "Reloj sin fila",
        "product_status": "draft",
        "on_hand": 0,
        "reserved": 0,
        "available": 0,
        "status": "out_of_stock",
        "movements": [],
    }
    assert on_hand(db_session, product_id) is None  # leer no crea la fila


# CA-INVENTORY-05 por HTTP: (política, on_hand o None sin fila, reservas (cantidad, estado,
# minutos), umbral) → (on_hand, reserved, available, status).
@pytest.mark.parametrize(
    ("policy", "stock", "reservations", "threshold", "expected"),
    [
        ("stock", None, [], 2, (0, 0, 0, "out_of_stock")),
        ("backorder", None, [], 2, (0, 0, 0, "on_request")),
        ("made_to_order", 5, [], 2, (5, 0, 5, "on_request")),
        ("stock", 3, [], 2, (3, 0, 3, "in_stock")),
        ("stock", 3, [(1, "active", 30)], 2, (3, 1, 2, "low_stock")),
        ("stock", 3, [(1, "active", 30), (2, "active", 5)], 2, (3, 3, 0, "out_of_stock")),
        ("backorder", 2, [(2, "active", 30)], 2, (2, 2, 0, "on_request")),
        (
            "stock",
            3,
            [(2, "active", -1), (2, "released", 30), (1, "consumed", 30)],
            2,
            (3, 0, 3, "in_stock"),
        ),
        ("stock", 3, [], 5, (3, 0, 3, "low_stock")),  # umbral cambiado por PATCH (D-027)
        ("stock", 2, [], 1, (2, 0, 2, "in_stock")),
        # M3 de QA en T-043 (SPEC §7): más reservado que on_hand, solo posible con el desfase
        # de I-8. on_hand y reserved salen tal cual; available, acotado a 0.
        ("stock", 1, [(2, "active", 30)], 2, (1, 2, 0, "out_of_stock")),
        ("backorder", 1, [(2, "active", 30)], 2, (1, 2, 0, "on_request")),
    ],
)
def test_stock_status_follows_inventory_r1_and_r2(
    client: TestClient,
    db_session: Session,
    policy: str,
    stock: int | None,
    reservations: list[tuple[int, str, int]],
    threshold: int,
    expected: tuple[int, int, int, str],
) -> None:
    product_id = product(db_session, stock, policy)
    for quantity, status, minutes in reservations:
        add_reservation(db_session, product_id, quantity, status, minutes)
    if threshold != 2:
        patched = client.patch(f"{BASE}/settings", json={"low_stock_threshold": threshold})
        assert patched.status_code == 200

    detail = client.get(f"{BASE}/stock/{product_id}").json()
    sku = detail["sku"]
    listed = client.get(f"{BASE}/stock", params={"q": sku}).json()["items"]
    same_status = client.get(f"{BASE}/stock", params={"q": sku, "status": expected[3]}).json()
    other = "in_stock" if expected[3] != "in_stock" else "low_stock"
    other_status = client.get(f"{BASE}/stock", params={"q": sku, "status": other}).json()

    for item in (detail, *listed):
        assert (item["on_hand"], item["reserved"], item["available"], item["status"]) == expected
    assert [item["product_id"] for item in listed] == [str(product_id)]
    assert same_status["total"] == 1
    assert (other_status["items"], other_status["total"]) == ([], 0)


def test_list_includes_every_product_sorted_by_sku_and_paginated(
    client: TestClient, db_session: Session
) -> None:
    tag = uuid4().hex[:8]
    for suffix, status in (("C", "draft"), ("A", "published"), ("B", "draft")):
        product(
            db_session, 1 if suffix == "B" else None, sku=f"TST-LST-{tag}-{suffix}", status=status
        )

    def page(**params: object) -> dict[str, object]:
        response = client.get(f"{BASE}/stock", params={"q": tag, **params})
        assert response.status_code == 200
        return response.json()

    default = page()
    first, second, beyond = page(page_size=2), page(page=2, page_size=2), page(page=3, page_size=2)

    assert (default["total"], default["page"], default["page_size"]) == (3, 1, 24)
    skus = [f"TST-LST-{tag}-{suffix}" for suffix in "ABC"]
    assert [item["sku"] for item in default["items"]] == skus  # borradores y publicados
    assert [item["product_status"] for item in default["items"]] == ["published", "draft", "draft"]
    assert [item["on_hand"] for item in default["items"]] == [0, 1, 0]  # con o sin fila
    assert all(set(item) == ITEM_KEYS for item in default["items"])
    assert [item["sku"] for item in first["items"]] == skus[:2]
    assert [item["sku"] for item in second["items"]] == skus[2:]
    assert (first["total"], second["total"]) == (3, 3)
    assert beyond == {"items": [], "total": 3, "page": 3, "page_size": 2}


def test_search_ignores_accents_and_case_and_escapes_like_wildcards(
    client: TestClient, db_session: Session
) -> None:
    tag = uuid4().hex[:8]
    artico = product(db_session, None, sku=f"TST-BUS-{tag}-1", name=f"Cronógrafo Ártico {tag}")
    percent = product(db_session, None, sku=f"TST-BUS-{tag}-2", name=f"Lote {tag} 100% acero")
    plain = product(db_session, None, sku=f"TST-BUS-{tag}-3", name=f"Lote {tag} 1000 acero")

    def found(q: str) -> set[str]:
        response = client.get(f"{BASE}/stock", params={"q": q, "page_size": 48})
        assert response.status_code == 200
        return {item["product_id"] for item in response.json()["items"]}

    assert found(f"CRONOGRAFO artico {tag}") == {str(artico)}  # sin tildes ni mayúsculas
    assert found(f"tst-bus-{tag}-1") == {str(artico)}  # también en el SKU
    assert found(f"  {tag}  ") == {str(artico), str(percent), str(plain)}  # se recorta
    assert found(f"{tag} 100%") == {str(percent)}  # % literal, no comodín
    assert found(f"{tag} 10_") == set()  # _ literal, no comodín
    everything = client.get(f"{BASE}/stock").json()["total"]
    assert client.get(f"{BASE}/stock", params={"q": "   "}).json()["total"] == everything


def test_search_treats_slashes_as_literals_also_after_unaccent(
    client: TestClient, db_session: Session
) -> None:
    # M1 y M2 de QA en T-043. El escape del LIKE es /: uno del propio q es literal, y también
    # el que crea unaccent (½ → " 1/2"), porque se escapa después de app.f_unaccent. Si se
    # escapara antes, ese / escaparía al 2 y "½" buscaría "12".
    slash_tag, half_tag = uuid4().hex[:8], uuid4().hex[:8]
    slash = product(db_session, None, sku=f"TST-BAR-{slash_tag}-1", name=f"Reloj 1/2 {slash_tag}")
    product(db_session, None, sku=f"TST-BAR-{slash_tag}-2", name=f"Reloj 12 {slash_tag}")
    half = product(db_session, None, sku=f"TST-BAR-{half_tag}-1", name=f"Reloj ½ {half_tag}")
    product(db_session, None, sku=f"TST-BAR-{half_tag}-2", name=f"Reloj 12 {half_tag}")

    def found(q: str) -> set[str]:
        response = client.get(f"{BASE}/stock", params={"q": q})
        assert response.status_code == 200
        return {item["product_id"] for item in response.json()["items"]}

    assert found(f"1/2 {slash_tag}") == {str(slash)}
    assert found(f"½ {half_tag}") == {str(half)}


def test_threshold_change_is_audited_and_the_same_value_is_not(
    client: TestClient, db_session: Session
) -> None:
    # UC-INVENTORY-03 e INVENTORY-R7; el umbral de partida es el de la migración (D-027).
    assert client.get(f"{BASE}/settings").json() == {"low_stock_threshold": 2}

    first = client.patch(f"{BASE}/settings", json={"low_stock_threshold": 5})
    again = client.patch(f"{BASE}/settings", json={"low_stock_threshold": 5})

    assert (first.status_code, first.json()) == (200, {"low_stock_threshold": 5})
    assert (again.status_code, again.json()) == (200, {"low_stock_threshold": 5})
    assert client.get(f"{BASE}/settings").json() == {"low_stock_threshold": 5}
    assert audit(db_session, "inventory_settings", 1) == [
        (
            "inventory.threshold_changed",
            ADMIN,
            "admin",
            REQUEST_ID,
            {"low_stock_threshold": 2},
            {"low_stock_threshold": 5},
        )
    ]
