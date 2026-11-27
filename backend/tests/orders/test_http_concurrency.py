"""Carreras de dinero y stock a través de la app HTTP completa (T-080; CA-ORDERS-06, 08, 09, 15, 22
y 24; SPEC §4 R4, R8, R9, R16). Las suites de T-074…T-079 corren las carreras sobre los casos de
uso; aquí cada solicitud HTTP abre **su propia** transacción real (el `SessionDep` confirma al
terminar), así que también se prueba la traducción de errores, el commit de la solicitud y que
nada responde 500 ni se interbloquea. El pago es el `ConfirmOrderPayment` real en otra conexión.

Datos confirmados en valmont_test y borrados al final (pedidos, reservas, movimientos, perfiles,
productos); la auditoría de las solicitudes va a memoria para no dejar filas en `app.audit_log`,
que no admite DELETE. Datos ficticios."""

import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_item
from tests.cart.test_concurrency import TIMEOUT, in_transaction
from tests.identity.identity_helpers import T0, InMemoryProfiles, make_token, use_test_auth
from tests.orders.orders_create_helpers import Calls, FakeAudit
from tests.orders.orders_http_helpers import SHIPPING, STORE_ENV
from tests.orders.orders_payment_helpers import committed_world, confirm
from tests.orders.test_cancel_order_concurrency import placed, state
from tests.orders.test_confirm_payment_concurrency import facts_consistent
from tests.orders.test_create_order_concurrency import World
from valmont.main import create_app
from valmont.modules.audit.adapters.http import get_audit_recorder
from valmont.modules.identity.adapters.http import get_profile_repository
from valmont.modules.identity.domain import Profile, Role
from valmont.modules.orders.application import PaymentOutcome
from valmont.shared.config import get_settings
from valmont.shared.db import get_session

pytestmark = pytest.mark.integration

PATH = "/api/v1/orders"


class Api:
    """La app real; cada solicitud en su propia sesión y transacción contra valmont_test."""

    def __init__(self, engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
        use_test_auth(monkeypatch)
        for variable, value in STORE_ENV.items():
            monkeypatch.setenv(variable, value)
        get_settings.cache_clear()
        self.profiles = InMemoryProfiles()
        self.audit = FakeAudit(Calls())
        app = create_app()

        def own_transaction() -> Iterator[Session]:
            with Session(engine) as session, session.begin():
                yield session

        app.dependency_overrides[get_session] = own_transaction
        app.dependency_overrides[get_profile_repository] = lambda: self.profiles
        app.dependency_overrides[get_audit_recorder] = lambda: self.audit
        self.client = TestClient(app, raise_server_exceptions=False)

    def known(self, user: UUID, role: Role = Role.CUSTOMER) -> UUID:
        self.profiles.rows[user] = Profile(user, role, T0, T0)
        return user

    def auth(self, user: UUID) -> dict[str, str]:
        return {"Authorization": f"Bearer {make_token(str(user))}"}

    def create(self, user: UUID, key: str | None = None) -> Any:
        sent = self.auth(user) | {"Idempotency-Key": key or str(uuid4())}
        return self.client.post(PATH, headers=sent, json={"delivery": SHIPPING})

    def cancel(self, user: UUID, order_id: object) -> Any:
        return self.client.post(f"{PATH}/{order_id}/cancel", headers=self.auth(user))

    def transition(self, admin: UUID, order_id: object, body: dict[str, Any]) -> Any:
        path = f"{PATH}/admin/{order_id}/transitions"
        return self.client.post(path, headers=self.auth(admin), json=body)


@pytest.fixture
def world(db_engine: Engine) -> Iterator[World]:
    yield from committed_world(db_engine)


@pytest.fixture
def api(db_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[Api]:
    yield Api(db_engine, monkeypatch)
    get_settings.cache_clear()


def together(*calls: Callable[[], Any]) -> list[Any]:
    """Lanza todas las solicitudes a la vez (barrera) y devuelve sus respuestas en orden."""
    barrier = threading.Barrier(len(calls))

    def run(call: Callable[[], Any]) -> Any:
        barrier.wait(TIMEOUT)
        return call()

    with ThreadPoolExecutor(len(calls)) as pool:
        futures = [pool.submit(run, call) for call in calls]
        return [future.result(TIMEOUT * 3) for future in futures]


def someone_waits_for_a_lock(engine: Engine) -> None:
    """Espera a que alguna otra conexión de esta BD esté bloqueada esperando un candado."""
    query = text(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
        " AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()"
    )
    deadline = time.monotonic() + TIMEOUT
    with engine.connect() as connection:
        while time.monotonic() < deadline:
            waiting = connection.scalar(query)
            connection.rollback()
            if waiting:
                return
            time.sleep(0.02)
    pytest.fail("Ninguna solicitud llegó a esperar el bloqueo.")


def holding(engine: Engine, work: Callable[[Session], Any], during: Callable[[], Any]) -> Any:
    """`work` corre en su transacción y no confirma hasta que `during` (una solicitud HTTP en otro
    hilo) está esperando su bloqueo; luego confirma y devuelve (resultado de work, de during)."""
    done, may_commit = threading.Event(), threading.Event()

    def first(session: Session) -> Any:
        result = work(session)
        done.set()
        assert may_commit.wait(TIMEOUT)
        return result

    with ThreadPoolExecutor(2) as pool:
        one = pool.submit(in_transaction, engine, first)
        try:
            assert done.wait(TIMEOUT)
            two = pool.submit(during)
            someone_waits_for_a_lock(engine)
        finally:
            may_commit.set()
        return one.result(TIMEOUT), two.result(TIMEOUT)


def no_500(*responses: Any) -> None:
    for response in responses:
        assert response.status_code < 500, response.text


def refill(engine: Engine, user: UUID, product: UUID) -> None:
    """Pone el producto en el carrito (ya creado) del cliente, seleccionado."""
    with Session(engine) as session, session.begin():
        cart = session.scalar(text("SELECT id FROM app.carts WHERE user_id = :u"), {"u": user})
        add_item(session, cart, product, 1)


def pending_of(world: World, user: UUID) -> int:
    return world.count(
        "SELECT count(*) FROM app.orders WHERE user_id = :u AND status = 'pendiente_pago'", u=user
    )


# --------------------------------------------------------------------------------------------
# Compras simultáneas (CA-ORDERS-06, 08, 24)


def test_two_customers_racing_for_the_last_unit_by_http_one_201_one_409(
    world: World, api: Api
) -> None:
    last = world.product(on_hand=1)
    one, two = (api.known(world.user((last, 1))) for _ in range(2))

    responses = together(lambda: api.create(one), lambda: api.create(two))

    no_500(*responses)
    assert sorted(r.status_code for r in responses) == [201, 409]
    [lost] = [r for r in responses if r.status_code == 409]
    assert lost.json()["error"]["code"] in ("insufficient_stock", "checkout_blocked")
    assert world.on_hand(last) == 1 and world.active_reservations(last) == 1
    assert world.orders_of(one) + world.orders_of(two) == 1


def test_the_same_key_sent_twice_at_once_by_http_leaves_one_order_and_no_500(
    world: World, api: Api
) -> None:
    product = world.product(on_hand=5)
    user = api.known(world.user((product, 2)))
    key = str(uuid4())

    responses = together(lambda: api.create(user, key), lambda: api.create(user, key))

    no_500(*responses)
    codes = sorted(r.status_code for r in responses)
    assert codes in ([200, 201], [201, 409]), [r.text for r in responses]
    if codes == [200, 201]:
        assert responses[0].json()["id"] == responses[1].json()["id"]
    else:
        assert [r.json()["error"]["code"] for r in responses if r.status_code == 409] == [
            "idempotency_conflict"
        ]
    assert world.orders_of(user) == 1 and world.active_reservations(product) == 2


def test_many_customers_buying_shared_products_in_shuffled_order_by_http_never_oversell(
    world: World, api: Api
) -> None:
    a, b, c = world.product(on_hand=3), world.product(on_hand=3), world.product(on_hand=3)
    carts = [(a, 1), (b, 1), (c, 1)]
    users = [api.known(world.user(*(carts[n:] + carts[:n]))) for n in range(3)] + [
        api.known(world.user(*reversed(carts[: n + 1]))) for n in range(3)
    ]

    responses = together(*(lambda u=u: api.create(u) for u in users))

    no_500(*responses)
    for product in (a, b, c):
        assert world.on_hand(product) == 3
        assert world.active_reservations(product) <= 3  # nunca más reservado que existencias


# --------------------------------------------------------------------------------------------
# Tope R9 bajo carrera (CA-ORDERS-09)


def test_concurrent_purchases_never_take_a_customer_past_three_pending_orders(
    world: World, api: Api, db_engine: Engine
) -> None:
    products = [world.product(on_hand=9) for _ in range(3)]
    user = api.known(world.user())
    for product in products[:2]:  # dos pedidos sin pagar ya creados
        refill(db_engine, user, product)
        assert api.create(user).status_code == 201
    refill(db_engine, user, products[2])

    responses = together(*(lambda: api.create(user) for _ in range(4)))

    no_500(*responses)
    assert [r.status_code for r in responses].count(201) == 1
    assert {r.json()["error"]["code"] for r in responses if r.status_code == 409} <= {
        "empty_selection",
        "too_many_pending_orders",
    }
    assert pending_of(world, user) == 3


def test_simultaneous_purchases_at_the_limit_are_all_409_and_none_slips_through(
    world: World, api: Api, db_engine: Engine
) -> None:
    products = [world.product(on_hand=9) for _ in range(4)]
    user = api.known(world.user())
    for product in products[:3]:
        refill(db_engine, user, product)
        assert api.create(user).status_code == 201
    refill(db_engine, user, products[3])

    responses = together(*(lambda: api.create(user) for _ in range(4)))

    no_500(*responses)
    assert [r.status_code for r in responses] == [409] * 4
    assert {r.json()["error"]["code"] for r in responses} == {"too_many_pending_orders"}
    assert all(r.json()["error"]["details"] == {"max": 3} for r in responses)
    assert pending_of(world, user) == 3 and world.active_reservations(products[3]) == 0


def test_a_purchase_racing_a_cancellation_at_the_limit_never_leaves_four_pending(
    world: World, api: Api, db_engine: Engine
) -> None:
    products = [world.product(on_hand=9) for _ in range(4)]
    user = api.known(world.user())
    placed_ids = []
    for product in products:
        refill(db_engine, user, product)
        if len(placed_ids) < 3:
            placed_ids.append(api.create(user).json()["id"])
    assert pending_of(world, user) == 3

    created, cancelled = together(lambda: api.create(user), lambda: api.cancel(user, placed_ids[0]))

    no_500(created, cancelled)
    assert cancelled.status_code == 200
    assert created.status_code in (201, 409)
    if created.status_code == 409:
        assert created.json()["error"]["code"] == "too_many_pending_orders"
    assert pending_of(world, user) <= 3


# --------------------------------------------------------------------------------------------
# Pago (ConfirmOrderPayment real, otra conexión) contra cada ruta que escribe (CA-ORDERS-15)


def test_a_payment_holding_the_row_makes_the_http_customer_cancel_409_after_waiting(
    world: World, api: Api, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 2))
    api.known(user)

    paid, cancel = holding(db_engine, confirm(user, order_id), lambda: api.cancel(user, order_id))

    assert paid.outcome == PaymentOutcome.PAID
    assert cancel.status_code == 409, cancel.text
    assert cancel.json()["error"] == {
        "code": "not_cancellable",
        "message": "El pedido no se puede cancelar.",
        "details": {"status": "pagado"},
    }
    facts_consistent(state(db_engine, order_id))
    assert world.on_hand(product) == 3  # un solo descuento


def test_a_payment_holding_the_row_then_the_http_admin_cancel_refunds_the_whole_total(
    world: World, api: Api, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)
    body = {"to": "cancelado", "note": "Carrera con el pago"}

    paid, cancel = holding(
        db_engine, confirm(user, order_id), lambda: api.transition(admin, order_id, body)
    )

    assert paid.outcome == PaymentOutcome.PAID
    assert cancel.status_code == 200, cancel.text
    final = state(db_engine, order_id)
    total = world.count("SELECT total_amount FROM app.orders WHERE id = :i", i=order_id)
    assert final["status"] == "cancelado" and final["refunded_amount"] == total
    assert final["sales"] == 1 and final["reservations"] == ["consumed"]
    assert world.on_hand(product) == 4  # R15: el stock vendido no se repone solo


def test_a_payment_holding_the_row_then_the_http_admin_preparation_succeeds_once_paid(
    world: World, api: Api, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)

    paid, prepared = holding(
        db_engine,
        confirm(user, order_id),
        lambda: api.transition(admin, order_id, {"to": "en_preparacion"}),
    )

    assert paid.outcome == PaymentOutcome.PAID
    assert prepared.status_code == 200, prepared.text
    final = state(db_engine, order_id)
    assert [h[0] for h in final["history"]] == ["pendiente_pago", "pagado", "en_preparacion"]
    assert final["sales"] == 1 and world.on_hand(product) == 4


def test_an_http_admin_preparation_of_an_unpaid_order_is_409_and_the_payment_still_works(
    world: World, api: Api, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    user, order_id = placed(world, db_engine, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)

    prepared, paid = together(
        lambda: api.transition(admin, order_id, {"to": "en_preparacion"}),
        lambda: in_transaction(db_engine, confirm(user, order_id)),
    )

    assert paid.outcome == PaymentOutcome.PAID
    assert prepared.status_code in (200, 409), prepared.text  # 200 solo si el pago llegó antes
    final = state(db_engine, order_id)
    assert final["sales"] == 1 and world.on_hand(product) == 4
    expected = ["pendiente_pago", "pagado"] + (
        ["en_preparacion"] if prepared.status_code == 200 else []
    )
    assert [h[0] for h in final["history"]] == expected


def test_payments_customer_and_admin_cancels_and_reads_storm_without_500_or_deadlock(
    world: World, api: Api, db_engine: Engine
) -> None:
    a, b = world.product(on_hand=4), world.product(on_hand=4)
    admin = api.known(world.user(), Role.ADMIN)
    orders = [placed(world, db_engine, (a, 1), (b, 1)) for _ in range(4)]
    for user, _ in orders:
        api.known(user)
    body = {"to": "cancelado", "note": "Tormenta"}
    calls: list[Callable[[], Any]] = []
    for n, (user, order_id) in enumerate(orders):
        calls.append(lambda u=user, o=order_id: in_transaction(db_engine, confirm(u, o)))
        if n % 2:
            calls.append(lambda u=user, o=order_id: api.cancel(u, o))
        else:
            calls.append(lambda o=order_id: api.transition(admin, o, body))
        calls.append(lambda u=user: api.client.get(PATH, headers=api.auth(u)))
    calls.append(lambda: api.client.get(f"{PATH}/admin", headers=api.auth(admin)))

    results = together(*calls)

    no_500(*(r for r in results if hasattr(r, "status_code")))
    sold = 0
    for _, order_id in orders:
        final = state(db_engine, order_id)
        if final["status"] == "cancelado" and final["refunded_amount"] is not None:
            assert final["sales"] == 2 and final["paid_at"] is not None  # pagado y reembolsado
        else:
            facts_consistent(final)
        sold += final["sales"] // 2
    assert world.on_hand(a) == world.on_hand(b) == 4 - sold >= 0


# --------------------------------------------------------------------------------------------
# Enumeración por tiempo: el pedido ajeno bloqueado no hace esperar a un extraño (R12)


def test_a_stranger_gets_404_at_once_even_while_the_owner_holds_the_order_row(
    world: World, api: Api, db_engine: Engine
) -> None:
    product = world.product(on_hand=5)
    owner, order_id = placed(world, db_engine, (product, 1))
    stranger = api.known(world.user())
    locked, may_release = threading.Event(), threading.Event()

    def hold(session: Session) -> None:
        session.execute(text("SELECT id FROM app.orders WHERE id = :i FOR UPDATE"), {"i": order_id})
        locked.set()
        assert may_release.wait(TIMEOUT)

    with ThreadPoolExecutor(1) as pool:
        holder = pool.submit(in_transaction, db_engine, hold)
        try:
            assert locked.wait(TIMEOUT)
            started = time.monotonic()
            foreign = [
                api.cancel(stranger, order_id),
                api.client.get(f"{PATH}/{order_id}", headers=api.auth(stranger)),
            ]
            missing = api.cancel(stranger, uuid4())
            elapsed = time.monotonic() - started
        finally:
            may_release.set()
        holder.result(TIMEOUT)

    assert [r.status_code for r in foreign] == [404, 404]
    assert foreign[0].json() == missing.json()
    assert elapsed < TIMEOUT / 2  # no esperó el bloqueo del dueño
    assert state(db_engine, order_id)["status"] == "pendiente_pago"
