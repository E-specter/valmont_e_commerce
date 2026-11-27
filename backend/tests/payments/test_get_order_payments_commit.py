"""Lo que `GET /payments/orders/{id}/attempts` confirma y deshace de verdad (T-095; CA-PAYMENTS-11,
SPEC §4 R7 de orders, R8 de payments, §7 "Listar"). Como `test_pay_order_commit.py`, cada solicitud
corre en **su propia transacción real** con el `SessionDep` de la app (commit si 2xx, rollback si
no) y el estado se mira desde otra conexión. Así se comprueba que:

- la caducidad perezosa de un pedido vencido leído por su dueño **persiste** (el 200 la confirma);
- el 404 de un pedido ajeno no caduca nada (rollback, nada se escribe);
- el GET ve lo que otras transacciones confirmaron y respeta el orden por fecha real.

Datos confirmados en valmont_test y borrados al final. Datos ficticios."""

from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine

from tests.orders.orders_payment_helpers import db_now, set_expiry
from tests.orders.test_cancel_order_concurrency import placed, state
from tests.orders.test_create_order_concurrency import World
from tests.payments.pay_order_commit_helpers import (
    PayApi,
    attempts_of_order,
    committed_pay_world,
)
from tests.payments.pay_order_helpers import pay_path
from valmont.modules.identity.domain import Role
from valmont.shared.config import get_settings

pytestmark = pytest.mark.integration

MISSING = UUID(int=0xBEEF)


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_pay_world(db_engine)


@pytest.fixture
def api(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[PayApi]:
    yield PayApi(db_engine, monkeypatch)
    get_settings.cache_clear()


def read(api: PayApi, user: UUID, order_id: object) -> Any:
    return api.client.get(pay_path(order_id), headers=api.auth(user))


def make(
    world: World, db_engine: Engine, api: PayApi, quantity: int = 2
) -> tuple[UUID, UUID, UUID]:
    """(cliente, pedido, producto): pedido real pendiente de pago, con su reserva activa."""
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, quantity))
    api.known(user)
    return user, order_id, product


def overdue(db_engine: Engine, order_id: UUID) -> None:
    set_expiry(db_engine, order_id, db_now(db_engine) - timedelta(minutes=1))


# --------------------------------------------------------------------------------------------
# El vencimiento perezoso persiste con el 200


def test_reading_an_overdue_order_expires_it_for_good_and_releases_its_reservations(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api, quantity=2)
    overdue(db_engine, order_id)
    assert state(db_engine, order_id)["status"] == "pendiente_pago"  # aún sin materializar

    response = read(api, user, order_id)

    assert response.status_code == 200, response.text
    assert (response.json()["can_pay"], response.json()["attempts"]) == (False, [])
    final = state(db_engine, order_id)  # desde otra conexión: la transacción se confirmó
    assert final["status"] == "expirado" and final["paid_at"] is None
    assert final["reservations"] == ["released"] and final["sales"] == 0
    assert world.on_hand(product) == 5 and world.active_reservations(product) == 0


def test_the_expiry_materialized_by_the_get_is_audited_by_orders_once(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    overdue(db_engine, order_id)

    read(api, user, order_id)
    read(api, user, order_id)

    assert [e.after for e in api.entries_of("orders.status_changed")] == [{"status": "expirado"}]
    assert api.payment_entries() == []  # leer no deja auditoría de payments


def test_a_second_read_of_the_expired_order_is_still_200_and_unchanged(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    overdue(db_engine, order_id)
    first = read(api, user, order_id)
    before = state(db_engine, order_id)

    second = read(api, user, order_id)

    assert (first.status_code, second.status_code) == (200, 200)
    assert second.json() == first.json() and state(db_engine, order_id) == before


def test_after_the_get_expired_it_paying_is_409_expirado_with_no_attempt(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    overdue(db_engine, order_id)
    read(api, user, order_id)

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 409 and response.json()["error"]["details"] == {
        "status": "expirado"
    }
    assert attempts_of_order(db_engine, order_id) == []


def test_a_stranger_reading_an_overdue_order_leaves_it_untouched_in_the_database(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    owner, order_id, product = make(world, db_engine, api)
    stranger = api.known(world.user())
    overdue(db_engine, order_id)
    before = state(db_engine, order_id)

    foreign = read(api, stranger, order_id)
    missing = read(api, stranger, MISSING)

    assert foreign.status_code == 404 and foreign.content == missing.content
    assert state(db_engine, order_id) == before  # ni caducado ni reservas liberadas
    assert before["status"] == "pendiente_pago" and before["reservations"] == ["active"]
    assert api.entries_of("orders.status_changed") == []
    assert world.active_reservations(product) == 2
    # el dueño sí lo materializa después
    assert read(api, owner, order_id).status_code == 200
    assert state(db_engine, order_id)["status"] == "expirado"


def test_an_administrator_reading_a_customers_overdue_order_does_not_expire_it(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    _, order_id, _ = make(world, db_engine, api)

    admin = api.known(world.user(), Role.ADMIN)
    overdue(db_engine, order_id)

    response = read(api, admin, order_id)

    assert response.status_code == 404
    assert state(db_engine, order_id)["status"] == "pendiente_pago"


# --------------------------------------------------------------------------------------------
# El GET ve lo confirmado por otras transacciones


def test_the_get_lists_committed_attempts_most_recent_first_by_real_timestamps(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    for last4 in ("0002", "9995", "0069"):  # tres transacciones, tres created_at distintos
        assert api.pay(user, order_id, last4).status_code == 201

    body = read(api, user, order_id).json()

    assert [a["failure_code"] for a in body["attempts"]] == [
        "expired_card",
        "insufficient_funds",
        "card_declined",
    ]
    assert (body["attempts_left"], body["can_pay"]) == (2, True)
    stamps = [a["created_at"] for a in body["attempts"]]
    assert stamps == sorted(stamps, reverse=True) and len(set(stamps)) == 3


def test_after_a_committed_approval_the_get_shows_it_and_can_pay_is_false(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    paid = api.pay(user, order_id, "4242")

    response = read(api, user, order_id)

    assert response.status_code == 200
    body = response.json()
    assert body["can_pay"] is False and body["attempts"] == [paid.json()]
    assert state(db_engine, order_id)["status"] == "pagado"


def test_a_rejection_after_four_others_closes_can_pay_in_the_next_read(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    for _ in range(4):
        api.pay(user, order_id, "0002")
    assert read(api, user, order_id).json()["can_pay"] is True

    api.pay(user, order_id, "0002")

    body = read(api, user, order_id).json()
    assert (body["can_pay"], body["attempts_left"], len(body["attempts"])) == (False, 0, 5)


def test_a_failed_read_with_no_order_writes_nothing(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    before = state(db_engine, order_id)

    response = read(api, user, MISSING)

    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
    assert state(db_engine, order_id) == before and api.audit.entries == []
