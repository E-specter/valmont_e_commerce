"""T-096: carreras que faltaban en CA-PAYMENTS-10 (auditoría final de seguridad, Opus).

Misma clave con resultados distintos (R3, R10, R-5), pago contra caducidad en la frontera exacta de
`expires_at` y tope de rechazos bajo carrera. Transacciones reales en valmont_test, datos
confirmados y borrados al final; la auditoría va a memoria. Datos ficticios."""

import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import TIMEOUT, in_transaction
from tests.orders.orders_payment_helpers import db_now, set_expiry
from tests.orders.test_cancel_order_concurrency import placed, state
from tests.orders.test_confirm_payment_concurrency import facts_consistent
from tests.orders.test_create_order_concurrency import World
from tests.orders.test_http_concurrency import holding, someone_waits_for_a_lock, together
from tests.payments.pay_order_commit_helpers import (
    PayApi,
    approved_of,
    attempts_of_order,
    committed_pay_world,
    hold_pay,
    no_500,
)
from tests.payments.payments_db_helpers import new_key
from valmont.modules.payments.adapters.http import get_payment_attempts
from valmont.modules.payments.adapters.persistence import SqlPaymentAttemptRepository
from valmont.modules.payments.domain import AttemptStatus
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


def order_for(
    world: World, db_engine: Engine, api: PayApi, *lines: tuple[UUID, int]
) -> tuple[UUID, UUID]:
    user, order_id = placed(world, db_engine, *lines)
    api.known(user)
    return user, order_id


def coherent(db_engine: Engine, order_id: UUID) -> None:
    """Un pedido pagado tiene exactamente un intento aprobado, y uno sin pagar ninguno."""
    final = state(db_engine, order_id)
    if final["status"] == "pendiente_pago":  # sigue sin pagar: nada consumido ni vendido
        assert final["paid_at"] is None and final["sales"] == 0, final
        assert set(final["reservations"]) <= {"active"}, final
    else:
        facts_consistent(final)
    assert (final["status"] == "pagado") == (approved_of(db_engine, order_id) == 1), (
        final["status"],
        attempts_of_order(db_engine, order_id),
    )


# --------------------------------------------------------------------------------------------
# Misma clave, distinto resultado (R3 "limitación aceptada", R10 caso residual R-5)


def test_a_rejection_holding_the_key_then_an_approval_with_the_same_key_never_pays_unrecorded(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # Determinista: el rechazo (clave K) ya insertó su intento y sigue abierto (KEY SHARE sobre el
    # pedido). La aprobación con K no lo ve en find_by_key, espera en el FOR UPDATE de la
    # confirmación y, cuando el rechazo confirma, sigue. Nunca debe quedar un pedido pagado, con
    # stock vendido, sin intento aprobado ni con la respuesta "rechazado".
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    key = new_key()

    rejected, approval = holding(
        db_engine,
        hold_pay(user, order_id, "0002", key),
        lambda: api.pay(user, order_id, "4242", key),
    )

    assert rejected.attempt.status is AttemptStatus.REJECTED
    no_500(approval)
    coherent(db_engine, order_id)
    # T-099: la aprobación espera en `lock_key` y, al entrar, ve y repite el rechazo de su clave.
    assert approval.status_code == 200, approval.text
    assert approval.json()["id"] == str(rejected.attempt.id)
    assert approval.json()["status"] == "rejected"
    assert state(db_engine, order_id)["status"] == "pendiente_pago"
    assert world.on_hand(product) == 5 and len(attempts_of_order(db_engine, order_id)) == 1
    assert api.payment_entries() == [] and api.entries_of("orders.status_changed") == []


def test_without_the_key_lock_the_safeguard_rolls_the_charge_back_with_409(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # Salvaguarda de T-099 forzada: un repositorio cuyo `lock_key` no bloquea reproduce el
    # CRÍTICO-1; la confirmación `PAID` seguida de `add -> None` debe ser 409 y deshacerse entera.
    api.client.app.dependency_overrides[get_payment_attempts] = no_lock_attempts
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    key = new_key()

    rejected, approval = holding(
        db_engine,
        hold_pay(user, order_id, "0002", key),
        lambda: api.pay(user, order_id, "4242", key),
    )

    assert rejected.attempt.status is AttemptStatus.REJECTED
    assert approval.status_code == 409, approval.text
    assert approval.json()["error"]["code"] == "idempotency_key_reused"
    assert approval.headers["cache-control"] == "no-store"
    final = state(db_engine, order_id)
    assert final["status"] == "pendiente_pago" and final["paid_at"] is None
    assert final["sales"] == 0 and final["reservations"] == ["active"]
    assert world.on_hand(product) == 5
    assert attempts_of_order(db_engine, order_id) == [("rejected", "card_declined", "simulated")]


class NoLockAttempts(SqlPaymentAttemptRepository):
    def lock_key(self, user_id: UUID, key: str) -> None:
        del user_id, key


def no_lock_attempts(session: SessionDep) -> SqlPaymentAttemptRepository:
    return NoLockAttempts(session)


@pytest.mark.parametrize("round_", [1, 2, 3, 4, 5])
def test_the_same_key_with_an_approved_and_a_rejected_card_at_once_stays_coherent(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    # R-5 acepta un 500 por interbloqueo, nunca datos incoherentes.
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    key = new_key()

    first, second = together(
        lambda: api.pay(user, order_id, "4242", key), lambda: api.pay(user, order_id, "0002", key)
    )

    # T-099: la misma clave se serializa, así que ya no hay interbloqueo (R-5) ni 500.
    no_500(first, second)
    assert sorted([first.status_code, second.status_code]) == [200, 201], (first.text, second.text)
    assert first.json()["id"] == second.json()["id"]
    coherent(db_engine, order_id)
    assert len(attempts_of_order(db_engine, order_id)) == 1
    assert len(api.payment_entries()) == 1


# --------------------------------------------------------------------------------------------
# `lock_key` (T-099): bloqueo consultivo de transacción por (cliente, clave)


def lock_in_thread(engine: Engine, user: UUID, key: str) -> tuple[threading.Event, Any]:
    """Abre otra transacción que pide `lock_key`; devuelve (adquirido, futuro)."""
    acquired = threading.Event()

    def work(session: Session) -> None:
        SqlPaymentAttemptRepository(session).lock_key(user, key)
        acquired.set()

    pool = ThreadPoolExecutor(1)
    future = pool.submit(in_transaction, engine, work)
    pool.shutdown(wait=False)
    return acquired, future


@pytest.mark.parametrize("end", ["commit", "rollback"])
def test_the_same_key_lock_serialises_two_connections_until_commit_or_rollback(
    db_engine: Engine, end: str
) -> None:
    user, key = uuid4(), new_key()
    with Session(db_engine) as first:
        first.begin()
        SqlPaymentAttemptRepository(first).lock_key(user, key)
        acquired, future = lock_in_thread(db_engine, user, key)
        someone_waits_for_a_lock(db_engine)
        assert not acquired.is_set()  # la segunda espera mientras la primera sigue abierta
        first.commit() if end == "commit" else first.rollback()
        assert acquired.wait(TIMEOUT)  # se libera al terminar la transacción
        future.result(TIMEOUT)


@pytest.mark.parametrize("other", ["key", "user"])
def test_a_different_key_or_customer_does_not_wait_for_the_lock(
    db_engine: Engine, other: str
) -> None:
    user, key = uuid4(), new_key()
    with Session(db_engine) as first, first.begin():
        SqlPaymentAttemptRepository(first).lock_key(user, key)
        acquired, future = lock_in_thread(
            db_engine, uuid4() if other == "user" else user, new_key() if other == "key" else key
        )
        assert acquired.wait(TIMEOUT)  # adquiere sin esperar a la primera
        future.result(TIMEOUT)


def test_the_key_lock_is_parameterised_and_held_by_its_transaction(
    db_engine: Engine,
) -> None:
    # Una clave con comillas o SQL no rompe la consulta (va como parámetro) y sigue bloqueando.
    user, key = uuid4(), "k'); SELECT 1;--x"
    with Session(db_engine) as first, first.begin():
        SqlPaymentAttemptRepository(first).lock_key(user, key)
        held = first.scalar(
            text(
                "SELECT count(*) FROM pg_locks"
                " WHERE locktype = 'advisory' AND pid = pg_backend_pid()"
            )
        )
        assert held == 1


# --------------------------------------------------------------------------------------------
# Frontera exacta de `expires_at` (SPEC §11 casos de borde, R-3 de orders)


def test_an_order_expiring_exactly_now_is_409_expirado_with_no_charge(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    set_expiry(db_engine, order_id, db_now(db_engine))  # ya es <= now() de la solicitud

    response = api.pay(user, order_id, "4242")

    assert response.status_code == 409, response.text
    assert response.json()["error"] == {
        "code": "order_not_payable",
        "message": "El pedido no se puede pagar.",
        "details": {"status": "expirado"},
    }
    assert attempts_of_order(db_engine, order_id) == [] and world.on_hand(product) == 5


def test_payment_and_read_expiry_on_the_boundary_never_charge_an_expired_order(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    set_expiry(db_engine, order_id, db_now(db_engine) + timedelta(milliseconds=150))

    responses = together(
        lambda: api.pay(user, order_id, "4242"),
        lambda: api.read_orders(user),
        lambda: api.pay(user, order_id, "4242"),
        lambda: api.client.get(
            f"/api/v1/payments/orders/{order_id}/attempts", headers=api.auth(user)
        ),
    )

    no_500(*responses)
    final = state(db_engine, order_id)
    if final["status"] != "pendiente_pago":
        coherent(db_engine, order_id)
    assert approved_of(db_engine, order_id) <= 1 and world.on_hand(product) in (4, 5)
    assert (world.on_hand(product) == 4) == (final["status"] == "pagado")


# --------------------------------------------------------------------------------------------
# Tope de rechazos bajo carrera (R9 blando: a lo sumo uno de más, nunca un cobro doble)


def test_rejections_at_once_on_the_limit_overshoot_by_at_most_the_concurrency(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    for _ in range(4):
        assert api.pay(user, order_id, "0002").status_code == 201

    responses = together(*(lambda: api.pay(user, order_id, "9995") for _ in range(4)))

    no_500(*responses)
    created = [r for r in responses if r.status_code == 201]
    assert {r.json()["error"]["code"] for r in responses if r.status_code == 409} <= {
        "too_many_attempts"
    }
    assert 1 <= len(created) <= 4  # blando: el exceso lo acota la concurrencia (R-6)
    after = api.pay(user, order_id, "4242")
    assert after.status_code == 409 and after.json()["error"]["details"] == {"max": 5}
    assert approved_of(db_engine, order_id) == 0 and world.on_hand(product) == 5


# --------------------------------------------------------------------------------------------
# R-10: con LOG_LEVEL=DEBUG la raíz baja a DEBUG, pero SQLAlchemy fija el logger `sqlalchemy` en
# WARNING al importarse y el motor no usa `echo`: las filas leídas (con `card_last4`) no se vuelcan.


def test_with_log_level_debug_the_engine_never_dumps_card_last4(
    world: World, db_engine: Engine, api: PayApi, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    from valmont.shared.logs import configure_logging

    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    key = new_key()
    assert api.pay(user, order_id, "7391", key).status_code == 201

    root = logging.getLogger()
    level, handlers = root.level, list(root.handlers)
    caplog.set_level(logging.NOTSET)
    try:
        configure_logging("DEBUG")  # lo que hace create_app con LOG_LEVEL=DEBUG
        with Session(db_engine) as session:  # conexión nueva: lee el nivel efectivo ahora
            found = SqlPaymentAttemptRepository(session).find_by_key(user, key)
    finally:
        root.setLevel(level)
        root.handlers[:] = handlers
    assert found is not None and found.card_last4 == "7391"
    assert "7391" not in caplog.text
