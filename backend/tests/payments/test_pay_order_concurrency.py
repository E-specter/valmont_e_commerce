"""Carreras de dinero y stock de `POST /payments/orders/{id}/attempts` (T-094; CA-PAYMENTS-10;
SPEC §4 R3, R4, R9 y R10). Cada solicitud HTTP abre **su propia** transacción real (el `SessionDep`
confirma al terminar) contra valmont_test, con cart, inventory y orders reales y dos o más
conexiones. Donde hace falta que la carrera ocurra siempre y no solo con suerte, `holding` deja
una transacción con el pedido bloqueado hasta que la solicitud HTTP está esperando su bloqueo.

En ningún caso: doble cobro, doble descuento de stock, pedido pagado con reservas liberadas ni
cancelado con stock vendido, estado incoherente, error 500 o interbloqueo. Datos confirmados y
borrados al final. La auditoría va a memoria (`app.audit_log` no admite DELETE). Datos ficticios."""

from collections.abc import Callable, Iterator
from datetime import timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.cart.test_concurrency import in_transaction
from tests.orders.orders_payment_helpers import db_now, set_expiry
from tests.orders.test_cancel_order_concurrency import cancel, overdue, placed, read_expiring, state
from tests.orders.test_confirm_payment_concurrency import facts_consistent
from tests.orders.test_create_order_concurrency import World
from tests.orders.test_http_concurrency import holding, together
from tests.payments.pay_order_commit_helpers import (
    PayApi,
    approved_of,
    attempts_of_order,
    committed_pay_world,
    hold_pay,
    no_500,
)
from tests.payments.payments_db_helpers import new_key
from valmont.modules.identity.domain import Role
from valmont.modules.payments.domain import AttemptStatus
from valmont.shared.config import get_settings

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


def order_for(
    world: World, db_engine: Engine, api: PayApi, *lines: tuple[UUID, int]
) -> tuple[UUID, UUID]:
    """(cliente conocido por la API, pedido real pendiente con sus reservas)."""
    user, order_id = placed(world, db_engine, *lines)
    api.known(user)
    return user, order_id


def total_of(world: World, order_id: UUID) -> int:
    return world.count("SELECT total_amount FROM app.orders WHERE id = :i", i=order_id)


# --------------------------------------------------------------------------------------------
# Misma clave a la vez


@pytest.mark.parametrize("round_", [1, 2, 3])
def test_the_same_key_sent_twice_at_once_leaves_one_attempt_one_discount_201_and_200(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    key = new_key()

    first, second = together(
        lambda: api.pay(user, order_id, "4242", key), lambda: api.pay(user, order_id, "4242", key)
    )

    no_500(first, second)
    assert sorted([first.status_code, second.status_code]) == [200, 201], (first.text, second.text)
    assert first.json()["id"] == second.json()["id"]
    assert attempts_of_order(db_engine, order_id) == [("approved", None, "simulated")]
    assert world.on_hand(product) == 3 and state(db_engine, order_id)["sales"] == 1
    assert len(api.payment_entries()) == 1
    facts_consistent(state(db_engine, order_id))


def test_the_same_key_with_a_rejected_card_sent_twice_at_once_leaves_one_rejection(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    key = new_key()

    first, second = together(
        lambda: api.pay(user, order_id, "0002", key), lambda: api.pay(user, order_id, "0002", key)
    )

    no_500(first, second)
    assert sorted([first.status_code, second.status_code]) == [200, 201]
    assert first.json()["id"] == second.json()["id"]
    assert attempts_of_order(db_engine, order_id) == [("rejected", "card_declined", "simulated")]
    assert world.on_hand(product) == 5 and len(api.payment_entries()) == 1


def test_a_request_waiting_for_the_lock_returns_the_attempt_of_the_same_key_that_won(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # Determinista: el pago A tiene el pedido bloqueado; B (misma clave) espera en la confirmación,
    # y al confirmar A, B encuentra el intento ya guardado y responde 200 con el mismo id.
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    key = new_key()

    won, waited = holding(
        db_engine,
        hold_pay(user, order_id, "4242", key),
        lambda: api.pay(user, order_id, "4242", key),
    )

    assert won.created is True and won.attempt.status is AttemptStatus.APPROVED
    assert waited.status_code == 200, waited.text
    assert waited.json()["id"] == str(won.attempt.id) and waited.json()["status"] == "approved"
    assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 3
    assert api.payment_entries() == []  # la repetición no audita (la de A va a otra auditoría)


# --------------------------------------------------------------------------------------------
# Claves distintas a la vez: un solo cobro


@pytest.mark.parametrize("round_", [1, 2, 3])
def test_two_payments_with_different_keys_at_once_are_one_201_and_one_409_already_paid(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    first, second = together(
        lambda: api.pay(user, order_id, "4242"), lambda: api.pay(user, order_id, "4242")
    )

    no_500(first, second)
    assert sorted([first.status_code, second.status_code]) == [201, 409], (first.text, second.text)
    [lost] = [r for r in (first, second) if r.status_code == 409]
    assert code_of(lost) == "order_already_paid"
    assert attempts_of_order(db_engine, order_id) == [("approved", None, "simulated")]
    assert world.on_hand(product) == 3  # un solo descuento
    final = state(db_engine, order_id)
    assert final["sales"] == 1 and final["reservations"] == ["consumed"]
    assert len(api.payment_entries()) == 1
    facts_consistent(final)


def test_many_payments_with_different_keys_at_once_charge_exactly_once(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=9)
    user, order_id = order_for(world, db_engine, api, (product, 3))

    responses = together(*(lambda: api.pay(user, order_id, "4242") for _ in range(5)))

    no_500(*responses)
    assert [r.status_code for r in responses].count(201) == 1
    assert {code_of(r) for r in responses if r.status_code == 409} <= {"order_already_paid"}
    assert [r.status_code for r in responses].count(409) == 4
    assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 6
    assert state(db_engine, order_id)["sales"] == 1


def test_a_payment_that_holds_the_order_makes_a_second_key_wait_and_get_409_already_paid(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    won, waited = holding(
        db_engine, hold_pay(user, order_id, "4242"), lambda: api.pay(user, order_id, "4242")
    )

    assert won.created is True
    assert waited.status_code == 409 and code_of(waited) == "order_already_paid", waited.text
    assert len(attempts_of_order(db_engine, order_id)) == 1  # el segundo no dejó intento
    assert world.on_hand(product) == 3 and state(db_engine, order_id)["sales"] == 1
    assert api.payment_entries() == []


def test_a_rejection_racing_an_approval_never_breaks_the_order_and_never_deadlocks(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # El INSERT de un rechazo toma un KEY SHARE sobre el pedido que choca con el FOR UPDATE de la
    # confirmación: si el orden fuera otro habría interbloqueo (R10).
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    approval, rejection = together(
        lambda: api.pay(user, order_id, "4242"), lambda: api.pay(user, order_id, "0002")
    )

    no_500(approval, rejection)
    assert approval.status_code == 201 and approval.json()["status"] == "approved"
    assert rejection.status_code in (201, 409)
    if rejection.status_code == 409:
        assert code_of(rejection) == "order_already_paid"
    assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 3
    facts_consistent(state(db_engine, order_id))


def test_two_rejections_at_once_with_different_keys_are_both_recorded(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))

    first, second = together(
        lambda: api.pay(user, order_id, "0002"), lambda: api.pay(user, order_id, "9995")
    )

    no_500(first, second)
    assert (first.status_code, second.status_code) == (201, 201)
    assert sorted(a[1] for a in attempts_of_order(db_engine, order_id)) == [
        "card_declined",
        "insufficient_funds",
    ]
    assert state(db_engine, order_id)["status"] == "pendiente_pago" and world.on_hand(product) == 5


# --------------------------------------------------------------------------------------------
# Pago contra la cancelación del cliente


def test_a_payment_holding_the_order_wins_and_the_customer_cancel_is_409_not_cancellable(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    won, cancel_response = holding(
        db_engine, hold_pay(user, order_id, "4242"), lambda: api.cancel(user, order_id)
    )

    assert won.created is True
    assert cancel_response.status_code == 409, cancel_response.text
    assert cancel_response.json()["error"]["details"] == {"status": "pagado"}
    final = state(db_engine, order_id)
    assert final["status"] == "pagado" and final["reservations"] == ["consumed"]
    assert world.on_hand(product) == 3 and approved_of(db_engine, order_id) == 1
    facts_consistent(final)


def test_a_cancellation_holding_the_order_wins_and_the_payment_is_409_not_payable(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    cancelled, payment = holding(
        db_engine, cancel(user, order_id), lambda: api.pay(user, order_id, "4242")
    )

    assert cancelled.outcome.status == "cancelado"
    assert payment.status_code == 409, payment.text
    assert code_of(payment) == "order_not_payable"
    assert payment.json()["error"]["details"] == {"status": "cancelado"}
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and final["sales"] == 0  # nunca stock en un cancelado
    assert final["reservations"] == ["released"] and world.on_hand(product) == 5
    assert attempts_of_order(db_engine, order_id) == []  # sin cobro ni intento
    assert api.payment_entries() == []
    facts_consistent(final)


@pytest.mark.parametrize("round_", [1, 2, 3, 4])
def test_a_payment_and_a_customer_cancellation_at_once_leave_one_coherent_outcome(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))

    paid, cancelled = together(
        lambda: api.pay(user, order_id, "4242"), lambda: api.cancel(user, order_id)
    )

    no_500(paid, cancelled)
    final = state(db_engine, order_id)
    facts_consistent(final)
    if final["status"] == "pagado":
        assert (paid.status_code, cancelled.status_code) == (201, 409)
        assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 3
    else:
        assert final["status"] == "cancelado"
        assert (paid.status_code, cancelled.status_code) == (409, 200)
        assert code_of(paid) == "order_not_payable"
        assert attempts_of_order(db_engine, order_id) == [] and world.on_hand(product) == 5


# --------------------------------------------------------------------------------------------
# Pago contra la transición del administrador


def test_a_payment_holding_the_order_then_the_admin_prepares_it_in_the_right_order(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)

    won, prepared = holding(
        db_engine,
        hold_pay(user, order_id, "4242"),
        lambda: api.transition(admin, order_id, {"to": "en_preparacion"}),
    )

    assert won.created is True and prepared.status_code == 200, prepared.text
    final = state(db_engine, order_id)
    assert [h[0] for h in final["history"]] == ["pendiente_pago", "pagado", "en_preparacion"]
    assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 4


@pytest.mark.parametrize("round_", [1, 2, 3])
def test_a_payment_and_an_admin_cancellation_at_once_never_charge_without_a_refund(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)
    body = {"to": "cancelado", "note": "Carrera con el pago"}

    paid, cancelled = together(
        lambda: api.pay(user, order_id, "4242"),
        lambda: api.transition(admin, order_id, body),
    )

    no_500(paid, cancelled)
    final = state(db_engine, order_id)
    assert final["status"] == "cancelado" and cancelled.status_code == 200
    if paid.status_code == 201:  # cobró y luego se canceló: reembolso total, intento intacto
        assert final["refunded_amount"] == total_of(world, order_id)
        assert final["paid_at"] is not None and final["sales"] == 1
        assert attempts_of_order(db_engine, order_id) == [("approved", None, "simulated")]
        assert world.on_hand(product) == 4  # el stock vendido no se repone solo
    else:  # la cancelación ganó: no hay cobro, intento ni stock vendido
        assert paid.status_code == 409 and code_of(paid) == "order_not_payable"
        assert final["refunded_amount"] is None and final["paid_at"] is None
        assert final["sales"] == 0 and final["reservations"] == ["released"]
        assert attempts_of_order(db_engine, order_id) == [] and world.on_hand(product) == 5


@pytest.mark.parametrize("round_", [1, 2, 3])
def test_an_admin_preparation_at_once_with_the_payment_only_succeeds_after_the_payment(
    world: World, db_engine: Engine, api: PayApi, round_: int
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    admin = api.known(world.user(), Role.ADMIN)

    paid, prepared = together(
        lambda: api.pay(user, order_id, "4242"),
        lambda: api.transition(admin, order_id, {"to": "en_preparacion"}),
    )

    no_500(paid, prepared)
    assert paid.status_code == 201, paid.text  # el pago siempre llega a cobrarse
    assert prepared.status_code in (200, 409), prepared.text
    final = state(db_engine, order_id)
    assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 4
    assert final["sales"] == 1
    expected = ["pendiente_pago", "pagado"] + (
        ["en_preparacion"] if prepared.status_code == 200 else []
    )
    assert [h[0] for h in final["history"]] == expected


# --------------------------------------------------------------------------------------------
# Pago contra la caducidad por lectura


def test_a_payment_against_an_overdue_order_being_expired_by_a_read_is_409_and_expired(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    overdue(db_engine, order_id)

    paid, read = together(lambda: api.pay(user, order_id, "4242"), lambda: api.read_orders(user))

    no_500(paid, read)
    assert read.status_code == 200
    assert paid.status_code == 409 and code_of(paid) == "order_not_payable", paid.text
    assert paid.json()["error"]["details"] == {"status": "expirado"}
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["sales"] == 0
    assert final["reservations"] == ["released"] and world.on_hand(product) == 5
    assert attempts_of_order(db_engine, order_id) == []
    facts_consistent(final)


def test_a_payment_waiting_for_an_expiry_in_progress_gets_409_not_payable_expirado(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    overdue(db_engine, order_id)

    read, payment = holding(
        db_engine, read_expiring(user, order_id), lambda: api.pay(user, order_id, "4242")
    )

    assert read.outcome == "expirado"
    assert payment.status_code == 409, payment.text
    assert code_of(payment) == "order_not_payable"
    assert payment.json()["error"]["details"] == {"status": "expirado"}
    final = state(db_engine, order_id)
    assert final["status"] == "expirado" and final["sales"] == 0
    assert final["reservations"] == ["released"] and world.on_hand(product) == 5
    assert attempts_of_order(db_engine, order_id) == []
    facts_consistent(final)


@pytest.mark.parametrize("seconds", [0.05, 0.2, 0.5])
def test_an_order_about_to_expire_ends_paid_or_expired_never_both(
    world: World, db_engine: Engine, api: PayApi, seconds: float
) -> None:
    # El vencimiento cae a unos instantes de la solicitud: según llegue antes o después, se paga
    # o es 409; el estado final es uno solo y coherente (el reloj de una solicitud es el de su
    # transacción, así que nunca hay un pago a medias).
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 2))
    set_expiry(db_engine, order_id, db_now(db_engine) + timedelta(seconds=seconds))

    response = api.pay(user, order_id, "4242")

    no_500(response)
    final = state(db_engine, order_id)
    if response.status_code == 201:
        facts_consistent(final)
        assert response.json()["status"] == "approved" and final["status"] == "pagado"
        assert approved_of(db_engine, order_id) == 1 and world.on_hand(product) == 3
    else:
        # R5: el 409 deshace la transacción, así que el vencimiento puede seguir sin materializar.
        assert response.status_code == 409 and code_of(response) == "order_not_payable"
        assert final["status"] in ("pendiente_pago", "expirado")
        assert final["paid_at"] is None and final["sales"] == 0
        assert world.on_hand(product) == 5 and approved_of(db_engine, order_id) == 0


# --------------------------------------------------------------------------------------------
# Interbloqueos entre pagos de pedidos con los mismos productos en distinto orden


def test_payments_of_orders_with_the_same_products_in_opposite_order_do_not_deadlock(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    a, b = world.product(on_hand=9), world.product(on_hand=9)
    forward = [order_for(world, db_engine, api, (a, 1), (b, 1)) for _ in range(3)]
    backward = [order_for(world, db_engine, api, (b, 1), (a, 1)) for _ in range(3)]
    orders = forward + backward

    responses = together(*(lambda u=u, o=o: api.pay(u, o, "4242") for u, o in orders))

    no_500(*responses)
    assert [r.status_code for r in responses] == [201] * 6, [r.text for r in responses]
    assert world.on_hand(a) == 3 and world.on_hand(b) == 3  # 6 pedidos de 1 unidad de cada uno
    for _, order_id in orders:
        facts_consistent(state(db_engine, order_id))
        assert approved_of(db_engine, order_id) == 1


def test_a_storm_of_payments_cancellations_reads_and_retries_stays_coherent(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    a, b = world.product(on_hand=6), world.product(on_hand=6)
    admin = api.known(world.user(), Role.ADMIN)
    orders = [order_for(world, db_engine, api, (a, 1), (b, 1)) for _ in range(4)]
    body = {"to": "cancelado", "note": "Tormenta"}
    calls: list[Callable[[], Any]] = []
    for n, (user, order_id) in enumerate(orders):
        key = new_key()
        calls.append(lambda u=user, o=order_id, k=key: api.pay(u, o, "4242", k))
        calls.append(lambda u=user, o=order_id, k=key: api.pay(u, o, "4242", k))  # reintento
        calls.append(lambda u=user, o=order_id: api.pay(u, o, "0002"))
        calls.append(lambda u=user: api.read_orders(u))
        if n % 2:
            calls.append(lambda u=user, o=order_id: api.cancel(u, o))
        else:
            calls.append(lambda o=order_id: api.transition(admin, o, body))

    responses = together(*calls)

    no_500(*responses)
    sold = 0
    for _, order_id in orders:
        final = state(db_engine, order_id)
        approved = approved_of(db_engine, order_id)
        assert approved <= 1
        assert (approved == 1) == (final["paid_at"] is not None), final
        if final["status"] == "cancelado" and final["refunded_amount"] is not None:
            assert final["sales"] == 2 and approved == 1  # pagado y luego reembolsado
        else:
            facts_consistent(final)
        sold += final["sales"] // 2
    assert world.on_hand(a) == world.on_hand(b) == 6 - sold >= 0


def test_the_rejection_limit_is_soft_but_never_lets_the_order_be_charged_twice(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # R9: dos solicitudes simultáneas pueden pasar de 5 rechazos en uno (límite blando aceptado);
    # lo que nunca puede pasar es un doble cobro ni un 500.
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    for _ in range(4):
        assert api.pay(user, order_id, "0002").status_code == 201

    responses = together(*(lambda: api.pay(user, order_id, "4242") for _ in range(3)))

    no_500(*responses)
    assert {r.status_code for r in responses} <= {201, 409}
    assert approved_of(db_engine, order_id) <= 1 and world.on_hand(product) >= 4
    rows = attempts_of_order(db_engine, order_id)
    assert [r[0] for r in rows].count("rejected") == 4  # solo aprobó o fue 409
    final = state(db_engine, order_id)
    assert (final["status"] == "pagado") == (approved_of(db_engine, order_id) == 1)


def test_the_unique_index_is_the_last_defence_even_if_two_approvals_reach_the_insert(
    world: World, db_engine: Engine, api: PayApi
) -> None:
    # Aun saltándose a orders, la BD impide un segundo aprobado del mismo pedido.
    product = world.product(on_hand=5)
    user, order_id = order_for(world, db_engine, api, (product, 1))
    assert api.pay(user, order_id, "4242").status_code == 201

    with pytest.raises(IntegrityError) as error:
        in_transaction(db_engine, second_approval(user, order_id))

    assert "uq_payment_attempts_order_approved" in str(error.value)
    assert approved_of(db_engine, order_id) == 1


def second_approval(user: UUID, order_id: UUID) -> Callable[[Session], None]:
    def work(session: Session) -> None:
        session.execute(
            text(
                "INSERT INTO app.payment_attempts (id, order_id, user_id, idempotency_key,"
                " status, amount, card_last4, gateway) VALUES (gen_random_uuid(), :o, :u, :k,"
                " 'approved', 1, '4242', 'simulated')"
            ),
            {"o": order_id, "u": user, "k": new_key()},
        )

    return work
