"""Lo que se confirma y lo que se deshace de verdad en `POST /payments/orders/{id}/attempts` (T-094;
CA-PAYMENTS-01, 02, 06 y 13, SPEC §4 R4, R5, R6, R10 y §7). Cada solicitud HTTP corre en **su
propia transacción real**, con el mismo `SessionDep` de la app: commit si responde 2xx, rollback si
no. Así se comprueba, desde otra conexión:

- que el pago aprobado y el rechazo quedan confirmados;
- que `order_expired` se confirma (2xx) y la caducidad del pedido **persiste**;
- que cada 409, 503 y 500 deja la BD exactamente como estaba (rollback total).

Datos confirmados en valmont_test y borrados al final. Datos ficticios."""

from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine

from tests.orders.orders_payment_helpers import db_now, expire_reservations_only, set_expiry
from tests.orders.test_cancel_order_concurrency import placed, state
from tests.orders.test_confirm_payment_concurrency import facts_consistent
from tests.orders.test_create_order_concurrency import World
from tests.payments.pay_order_commit_helpers import (
    PayApi,
    approved_of,
    attempts_of_order,
    committed_pay_world,
)
from tests.payments.payments_db_helpers import new_key
from valmont.modules.payments.adapters.http import get_payment_attempts, get_payment_gateway
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.domain import PaymentAttempt
from valmont.shared.config import get_settings
from valmont.shared.db import SessionDep

pytestmark = pytest.mark.integration


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_pay_world(db_engine)


@pytest.fixture
def api(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[PayApi]:
    yield PayApi(db_engine, monkeypatch)
    get_settings.cache_clear()


def code_of(response: Any) -> str:
    return response.json()["error"]["code"]


def make(
    world: World, db_engine: Engine, api: PayApi, quantity: int = 2
) -> tuple[UUID, UUID, UUID]:
    """(cliente, pedido, producto): pedido real pendiente de pago, con su reserva activa."""
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, quantity))
    api.known(user)
    return user, order_id, product


# --------------------------------------------------------------------------------------------
# Lo que se confirma


def test_an_approved_payment_is_committed_and_visible_from_another_connection(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api, quantity=2)

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 201, response.text
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["paid_at"] is not None
    assert final["reservations"] == ["consumed"] and final["sales"] == 1
    assert world.on_hand(product) == 3
    assert attempts_of_order(db_engine, order_id) == [("approved", None, "simulated")]
    facts_consistent(final)


def test_an_approved_payment_audits_the_attempt_and_the_order_status_in_the_same_request(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)

    api.pay(user, order_id, "4242")

    [entry] = api.payment_entries()
    assert (entry.actor_id, entry.actor_role) == (user, "customer")
    assert entry.after["status"] == "approved" and "card_last4" not in str(entry)
    [changed] = api.entries_of("orders.status_changed")
    assert changed.after == {"status": "pagado"}


def test_a_rejection_is_committed_and_leaves_the_order_pending_with_its_reservations(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api, quantity=2)

    response = api.pay(user, order_id, "9995")

    assert response.status_code == 201 and response.json()["failure_code"] == "insufficient_funds"
    final = state(db_engine, order_id)
    assert final["status"] == "pendiente_pago" and final["paid_at"] is None
    assert final["reservations"] == ["active"] and final["sales"] == 0
    assert world.on_hand(product) == 5 and world.active_reservations(product) == 2
    assert attempts_of_order(db_engine, order_id) == [
        ("rejected", "insufficient_funds", "simulated")
    ]


def test_the_repetition_of_a_committed_attempt_is_200_from_another_transaction(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api)
    key = new_key()
    first = api.pay(user, order_id, "4242", key)

    second = api.pay(user, order_id, "4242", key)

    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json() == first.json()
    assert len(attempts_of_order(db_engine, order_id)) == 1 and world.on_hand(product) == 3
    assert len(api.payment_entries()) == 1


# --------------------------------------------------------------------------------------------
# CA-PAYMENTS-06: el pedido vence durante el pago y la caducidad persiste


def test_an_order_that_expires_during_the_payment_stays_expired_after_the_response(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api, quantity=2)
    expire_reservations_only(db_engine, order_id)  # al leerlo sigue vigente; al confirmar, no

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 201, response.text
    assert (response.json()["status"], response.json()["failure_code"]) == (
        "rejected",
        "order_expired",
    )
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["paid_at"] is None  # la transacción se confirmó
    assert final["reservations"] == ["released"] and final["sales"] == 0
    assert world.on_hand(product) == 5 and world.active_reservations(product) == 0
    assert attempts_of_order(db_engine, order_id) == [("rejected", "order_expired", "simulated")]
    facts_consistent(final)


def test_the_expiry_is_audited_with_the_orders_entry_and_the_rejected_attempt(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    expire_reservations_only(db_engine, order_id)

    api.pay(user, order_id, "4242")

    [attempt] = api.payment_entries()
    assert (
        attempt.after["status"] == "rejected" and attempt.after["failure_code"] == "order_expired"
    )
    assert [e.after for e in api.entries_of("orders.status_changed")] == [{"status": "expirado"}]


def test_after_the_expiry_persisted_the_next_payment_is_409_not_payable_expirado(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    expire_reservations_only(db_engine, order_id)
    assert api.pay(user, order_id, "4242").status_code == 201

    again = api.pay(user, order_id, "4242")

    assert again.status_code == 409 and code_of(again) == "order_not_payable"
    assert again.json()["error"]["details"] == {"status": "expirado"}
    assert len(attempts_of_order(db_engine, order_id)) == 1


def test_order_expired_does_not_count_for_the_rejection_limit_and_the_order_is_dead_anyway(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, _ = make(world, db_engine, api)
    for _ in range(4):
        assert api.pay(user, order_id, "0002").status_code == 201
    expire_reservations_only(db_engine, order_id)

    expired = api.pay(user, order_id, "4242")
    after = api.pay(user, order_id, "4242")

    assert expired.status_code == 201 and expired.json()["failure_code"] == "order_expired"
    assert (
        after.status_code == 409 and code_of(after) == "order_not_payable"
    )  # no too_many_attempts


# --------------------------------------------------------------------------------------------
# Rollback total ante cada 409, 503 y 500


def test_a_409_on_an_overdue_order_changes_nothing_and_the_next_read_materializes_the_expiry(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api, quantity=2)
    set_expiry(db_engine, order_id, db_now(db_engine) - timedelta(minutes=1))

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 409 and code_of(response) == "order_not_payable"
    assert response.json()["error"]["details"] == {"status": "expirado"}
    assert attempts_of_order(db_engine, order_id) == [] and api.payment_entries() == []
    before_read = state(db_engine, order_id)
    assert before_read["paid_at"] is None and before_read["sales"] == 0
    assert world.on_hand(product) == 5
    assert before_read["status"] == "pendiente_pago"  # R5: el 409 deshizo la expiración
    api.read_orders(user)  # R7 de orders: la lectura materializa el vencimiento
    assert state(db_engine, order_id)["status"] == "expirado"


def test_a_503_commits_nothing(world: World, db_engine: Engine, api: PayApi) -> None:
    user, order_id, product = make(world, db_engine, api)

    response = api.pay(user, order_id, "0119")

    assert response.status_code == 503
    assert attempts_of_order(db_engine, order_id) == [] and api.audit.entries == []
    final = state(db_engine, order_id)
    assert final["status"] == "pendiente_pago" and final["reservations"] == ["active"]
    assert world.on_hand(product) == 5


def test_a_409_already_paid_commits_nothing_new(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api)
    assert api.pay(user, order_id, "4242").status_code == 201
    entries = len(api.audit.entries)
    before = state(db_engine, order_id)

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 409 and code_of(response) == "order_already_paid"
    assert state(db_engine, order_id) == before
    assert len(attempts_of_order(db_engine, order_id)) == 1 and len(api.audit.entries) == entries
    assert world.on_hand(product) == 3


def test_a_409_on_a_cancelled_order_commits_nothing(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api)
    assert api.cancel(user, order_id).status_code == 200
    before = state(db_engine, order_id)
    entries = len(api.audit.entries)

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 409 and code_of(response) == "order_not_payable"
    assert response.json()["error"]["details"] == {"status": "cancelado"}
    assert state(db_engine, order_id) == before and attempts_of_order(db_engine, order_id) == []
    assert len(api.audit.entries) == entries and world.on_hand(product) == 5


class FailingRepository(SqlPaymentAttemptRepository):
    def add(self, attempt: PaymentAttempt) -> PaymentAttempt | None:
        raise RuntimeError("fallo simulado al guardar")


def failing_repository(session: SessionDep) -> SqlPaymentAttemptRepository:
    return FailingRepository(session)


def test_a_failure_saving_the_attempt_rolls_back_the_payment_of_the_order(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # Una transacción por solicitud (R10): si falla el INSERT del intento, `ConfirmOrderPayment` ya
    # había consumido el stock y marcado el pedido pagado; todo eso debe deshacerse.
    user, order_id, product = make(world, db_engine, api, quantity=2)
    api.client.app.dependency_overrides[get_payment_attempts] = failing_repository  # type: ignore[attr-defined]

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 500
    assert "fallo simulado" not in response.text and "Traceback" not in response.text
    final = state(db_engine, order_id)
    assert final["status"] == "pendiente_pago" and final["paid_at"] is None
    assert final["reservations"] == ["active"] and final["sales"] == 0
    assert world.on_hand(product) == 5 and attempts_of_order(db_engine, order_id) == []


def test_after_the_failed_save_the_same_key_pays_normally(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api)
    key = new_key()
    overrides = api.client.app.dependency_overrides  # type: ignore[attr-defined]
    overrides[get_payment_attempts] = failing_repository
    assert api.pay(user, order_id, "4242", key).status_code == 500
    del overrides[get_payment_attempts]  # el reintento ya no falla

    response = api.pay(user, order_id, "4242", key)

    assert response.status_code == 201 and response.json()["status"] == "approved"
    assert world.on_hand(product) == 3 and approved_of(db_engine, order_id) == 1


def test_an_unexpected_gateway_error_is_a_500_and_changes_nothing(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    user, order_id, product = make(world, db_engine, api)

    class Exploding:
        name = "boom"

        def authorize(self, charge: Any) -> Any:
            raise RuntimeError("detalle interno")

    api.client.app.dependency_overrides[get_payment_gateway] = lambda: Exploding()  # type: ignore[attr-defined]

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 500 and "detalle interno" not in response.text
    final = state(db_engine, order_id)
    assert final["status"] == "pendiente_pago" and world.on_hand(product) == 5
    assert attempts_of_order(db_engine, order_id) == []
