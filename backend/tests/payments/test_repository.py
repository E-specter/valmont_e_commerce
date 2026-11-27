"""Repositorio SQL de payments (T-093): `add`, `find_by_key`, `list_for_order` y `count_rejected`
contra la BD de pruebas. La parte de repositorio de CA-PAYMENTS-03 (misma clave → `None`), de
CA-PAYMENTS-09 (`count_rejected` sin `order_expired`) y de CA-PAYMENTS-11 (orden del listado), más
R4 (segundo `approved` → `OrderAlreadyPaid`) y R7 (sin `card_last4` en logs). Datos ficticios; la
transacción de cada prueba se deshace.

Los efectos se comprueban con SQL directo además de con el propio repositorio, para que una
lectura y una escritura equivocadas del mismo modo no se tapen entre sí."""

import logging
import re
from collections.abc import Iterator
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import BASE, FOREIGN_KEY, UNIQUE, insert_order_row, rows, scalar
from tests.payments.payments_db_helpers import (
    LAST4,
    Factory,
    attempts_in_db,
    make_attempt,
    new_key,
    rejected_row,
    user_with_order,
)
from valmont.modules.payments.adapters.persistence import (
    PaymentAttemptRow,
    SqlPaymentAttemptRepository,
)
from valmont.modules.payments.application import PaymentAttemptRepository
from valmont.modules.payments.domain import (
    AttemptStatus,
    FailureCode,
    OrderAlreadyPaid,
    PaymentAttempt,
)

pytestmark = pytest.mark.integration

DECLINED, FUNDS = FailureCode.CARD_DECLINED, FailureCode.INSUFFICIENT_FUNDS
EXPIRED_CARD, ORDER_EXPIRED = FailureCode.EXPIRED_CARD, FailureCode.ORDER_EXPIRED


def repository(session: Session) -> SqlPaymentAttemptRepository:
    return SqlPaymentAttemptRepository(session)


def stored(session: Session, attempt: PaymentAttempt) -> PaymentAttempt:
    result = repository(session).add(attempt)
    assert result is not None
    return result


def assert_same_attempt(actual: PaymentAttempt | None, expected: PaymentAttempt) -> None:
    """Todos los campos del dominio, uno a uno (`created_at` lo pone la BD)."""
    assert actual is not None
    assert actual.id == expected.id
    assert actual.order_id == expected.order_id
    assert actual.user_id == expected.user_id
    assert actual.idempotency_key == expected.idempotency_key
    assert actual.status == expected.status
    assert actual.amount == expected.amount
    assert actual.failure_code == expected.failure_code
    assert actual.card_last4 == expected.card_last4
    assert actual.gateway == expected.gateway
    assert actual.created_at is not None and actual.created_at.tzinfo is not None


# ---------------------------------------------------------------------------------------------
# La fila ORM y el puerto.
def test_the_row_maps_the_table_and_columns_of_section_6() -> None:
    table = PaymentAttemptRow.__table__

    assert (table.schema, table.name) == ("app", "payment_attempts")
    assert set(table.columns.keys()) == {
        "id",
        "order_id",
        "user_id",
        "idempotency_key",
        "status",
        "amount",
        "failure_code",
        "card_last4",
        "gateway",
        "created_at",
    }


def test_the_repository_offers_every_method_of_the_port(db_session: Session) -> None:
    repo: PaymentAttemptRepository = repository(db_session)

    for name in ("add", "find_by_key", "list_for_order", "count_rejected"):
        assert callable(getattr(repo, name))


# ---------------------------------------------------------------------------------------------
# add: ida y vuelta de todos los campos.
def test_add_stores_an_approved_attempt_and_returns_it_with_the_creation_date_of_the_db(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    attempt = make_attempt(order, user, amount=1_234_500, last4="0002")

    result = repository(db_session).add(attempt)

    assert_same_attempt(result, attempt)
    assert isinstance(result, PaymentAttempt)
    assert result.status is AttemptStatus.APPROVED and result.failure_code is None
    db_row = rows(
        db_session,
        "SELECT id, order_id, user_id, idempotency_key, status, amount, failure_code,"
        " card_last4, gateway, created_at FROM app.payment_attempts WHERE id = :id",
        id=attempt.id,
    )
    assert db_row == [
        (
            attempt.id,
            order,
            user,
            attempt.idempotency_key,
            "approved",
            1_234_500,
            None,
            "0002",
            "simulated",
            result.created_at,
        )
    ]
    assert scalar(
        db_session,
        "SELECT created_at = now() FROM app.payment_attempts WHERE id = :id",
        id=attempt.id,
    )


@pytest.mark.parametrize("code", list(FailureCode))
def test_add_stores_a_rejected_attempt_with_each_failure_code(
    db_session: Session, code: FailureCode
) -> None:
    user, order = user_with_order(db_session)
    attempt = make_attempt(order, user, failure_code=code, last4="9995")

    result = repository(db_session).add(attempt)

    assert_same_attempt(result, attempt)
    assert result is not None
    assert result.status is AttemptStatus.REJECTED and result.failure_code is code
    assert rows(
        db_session,
        "SELECT status, failure_code FROM app.payment_attempts WHERE id = :id",
        id=attempt.id,
    ) == [("rejected", code.value)]


def test_add_keeps_an_amount_above_two_to_the_thirty_first_without_loss(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    amount = 2**40 + 7

    result = stored(db_session, make_attempt(order, user, amount=amount))

    assert result.amount == amount
    assert (
        scalar(db_session, "SELECT amount FROM app.payment_attempts WHERE id = :id", id=result.id)
        == amount
    )


def test_add_stores_the_name_of_the_gateway(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    result = stored(db_session, make_attempt(order, user, gateway="stripe-sandbox"))

    assert result.gateway == "stripe-sandbox"
    assert (
        scalar(db_session, "SELECT gateway FROM app.payment_attempts WHERE id = :id", id=result.id)
        == "stripe-sandbox"
    )


def test_add_does_not_commit(db_engine: Engine, committed_orders: Factory) -> None:
    ((user, order),) = committed_orders(1)
    attempt = make_attempt(order, user)

    writer = Session(db_engine)
    try:
        repository(writer).add(attempt)
        # Desde otra conexión, con la transacción del repositorio abierta: no se ve.
        with Session(db_engine) as reader, reader.begin():
            assert attempts_in_db(reader, id=attempt.id) == 0
    finally:
        writer.rollback()
        writer.close()

    # Tras el rollback sigue sin existir: nadie hizo commit por su cuenta.
    with Session(db_engine) as reader, reader.begin():
        assert attempts_in_db(reader, id=attempt.id) == 0


def test_a_committed_attempt_is_visible_from_another_connection(
    db_engine: Engine, committed_orders: Factory
) -> None:
    ((user, order),) = committed_orders(1)
    attempt = make_attempt(order, user)

    with Session(db_engine) as writer, writer.begin():
        repository(writer).add(attempt)

    with Session(db_engine) as reader, reader.begin():
        assert_same_attempt(repository(reader).find_by_key(user, attempt.idempotency_key), attempt)


# ---------------------------------------------------------------------------------------------
# add: misma clave (R3) → None, sin filas huérfanas y sin romper la transacción.
def test_add_with_a_repeated_key_returns_none_and_leaves_one_row(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    key = new_key()
    first = stored(db_session, make_attempt(order, user, key=key))

    second = repository(db_session).add(make_attempt(order, user, key=key))

    assert second is None
    assert attempts_in_db(db_session, user_id=user) == 1
    assert attempts_in_db(db_session, id=first.id) == 1


def test_a_repeated_key_leaves_the_original_row_untouched(db_session: Session) -> None:
    # Limitación aceptada de R3: la misma clave con otra tarjeta devuelve el intento original.
    user, order = user_with_order(db_session)
    key = new_key()
    first = stored(
        db_session, make_attempt(order, user, key=key, failure_code=DECLINED, last4="0002")
    )

    other = make_attempt(order, user, key=key, last4="4242", amount=999)
    assert repository(db_session).add(other) is None

    assert attempts_in_db(db_session, id=other.id) == 0
    assert rows(
        db_session,
        "SELECT id, status, failure_code, card_last4, amount FROM app.payment_attempts"
        " WHERE user_id = :user",
        user=user,
    ) == [(first.id, "rejected", "card_declined", "0002", first.amount)]


def test_a_repeated_key_for_an_already_approved_order_returns_none_not_order_already_paid(
    db_session: Session,
) -> None:
    # La reintentada de la solicitud ya aprobada: el arbitraje es por la clave (R3 paso 3).
    user, order = user_with_order(db_session)
    key = new_key()
    stored(db_session, make_attempt(order, user, key=key))

    assert repository(db_session).add(make_attempt(order, user, key=key)) is None


def test_the_same_key_of_another_user_is_a_different_attempt(db_session: Session) -> None:
    (user_a, order_a), (user_b, order_b) = (user_with_order(db_session) for _ in range(2))
    key = new_key()

    first = stored(db_session, make_attempt(order_a, user_a, key=key))
    second = stored(db_session, make_attempt(order_b, user_b, key=key))

    assert first.id != second.id
    assert attempts_in_db(db_session, idempotency_key=key) == 2


def test_the_session_stays_usable_after_a_repeated_key(db_session: Session) -> None:
    # ON CONFLICT DO NOTHING no aborta la transacción: el caso de uso sigue leyendo y escribiendo.
    user, order = user_with_order(db_session)
    key = new_key()
    stored(db_session, make_attempt(order, user, key=key, failure_code=DECLINED))
    assert repository(db_session).add(make_attempt(order, user, key=key)) is None

    found = repository(db_session).find_by_key(user, key)
    later = stored(db_session, make_attempt(order, user, failure_code=FUNDS))

    assert found is not None and found.failure_code is DECLINED
    assert attempts_in_db(db_session, order_id=order) == 2
    assert later.failure_code is FUNDS


# ---------------------------------------------------------------------------------------------
# add: un segundo `approved` para el pedido (R4) → OrderAlreadyPaid.
def test_a_second_approved_attempt_for_the_same_order_raises_order_already_paid(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    first = stored(db_session, make_attempt(order, user))

    with pytest.raises(OrderAlreadyPaid), db_session.begin_nested():
        repository(db_session).add(make_attempt(order, user, last4="1111"))

    # Sin fila huérfana: solo queda el aprobado original.
    assert rows(
        db_session, "SELECT id, status FROM app.payment_attempts WHERE order_id = :o", o=order
    ) == [(first.id, "approved")]


def test_the_order_already_paid_error_is_a_domain_error_without_the_card(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    stored(db_session, make_attempt(order, user))

    with pytest.raises(OrderAlreadyPaid) as error, db_session.begin_nested():
        repository(db_session).add(make_attempt(order, user, last4=LAST4))

    assert not isinstance(error.value, DBAPIError)
    assert LAST4 not in str(error.value)


def test_a_second_approved_attempt_by_another_user_for_the_same_order_also_raises(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    other = add_profile(db_session)
    stored(db_session, make_attempt(order, user))

    with pytest.raises(OrderAlreadyPaid), db_session.begin_nested():
        repository(db_session).add(make_attempt(order, other))


def test_rejected_attempts_before_and_after_the_approved_one_are_stored(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)

    stored(db_session, make_attempt(order, user, failure_code=DECLINED))
    stored(db_session, make_attempt(order, user))
    stored(db_session, make_attempt(order, user, failure_code=FUNDS))

    assert attempts_in_db(db_session, order_id=order) == 3
    assert attempts_in_db(db_session, order_id=order, status="approved") == 1


def test_two_orders_of_one_user_can_each_have_an_approved_attempt(db_session: Session) -> None:
    user, first_order = user_with_order(db_session)
    second_order = insert_order_row(db_session, user)

    stored(db_session, make_attempt(first_order, user))
    stored(db_session, make_attempt(second_order, user))

    assert attempts_in_db(db_session, user_id=user, status="approved") == 2


# ---------------------------------------------------------------------------------------------
# add: cualquier otro error de la BD se propaga tal cual.
def test_add_for_a_missing_order_propagates_the_foreign_key_error(db_session: Session) -> None:
    user = add_profile(db_session)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        repository(db_session).add(make_attempt(uuid4(), user))

    assert error.value.orig.sqlstate == FOREIGN_KEY
    assert not isinstance(error.value, OrderAlreadyPaid)


def test_add_for_a_missing_profile_propagates_the_foreign_key_error(db_session: Session) -> None:
    _, order = user_with_order(db_session)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        repository(db_session).add(make_attempt(order, uuid4()))

    assert error.value.orig.sqlstate == FOREIGN_KEY


def test_add_with_an_existing_id_propagates_the_primary_key_error(
    db_session: Session,
) -> None:
    # 23505 de otra restricción (la clave primaria): no es la clave repetida (None) ni el cobro
    # duplicado (OrderAlreadyPaid): se relanza.
    user, order = user_with_order(db_session)
    first = stored(db_session, make_attempt(order, user, failure_code=DECLINED))

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        repository(db_session).add(
            make_attempt(order, user, failure_code=FUNDS, attempt_id=first.id)
        )

    assert error.value.orig.sqlstate == UNIQUE
    assert error.value.orig.diag.constraint_name != "uq_payment_attempts_order_approved"


def test_a_primary_key_clash_of_an_approved_attempt_is_not_reported_as_a_paid_order(
    db_session: Session,
) -> None:
    # El pedido no tiene aprobado: el choque es solo de la clave primaria.
    user, order = user_with_order(db_session)
    first = stored(db_session, make_attempt(order, user, failure_code=DECLINED))

    with pytest.raises(IntegrityError), db_session.begin_nested():
        repository(db_session).add(make_attempt(order, user, attempt_id=first.id))


def test_add_with_an_amount_beyond_bigint_propagates_the_database_error(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)

    with pytest.raises(DBAPIError), db_session.begin_nested():
        repository(db_session).add(make_attempt(order, user, amount=2**63))

    assert attempts_in_db(db_session, order_id=order) == 0


# ---------------------------------------------------------------------------------------------
# find_by_key: por (dueño, clave).
def test_find_by_key_returns_the_attempt_with_every_field(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    attempt = stored(db_session, make_attempt(order, user, failure_code=EXPIRED_CARD, last4="0069"))

    found = repository(db_session).find_by_key(user, attempt.idempotency_key)

    assert found == attempt
    assert_same_attempt(found, attempt)


def test_find_by_key_returns_none_for_an_unknown_key(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    stored(db_session, make_attempt(order, user))

    assert repository(db_session).find_by_key(user, new_key()) is None


def test_find_by_key_does_not_return_the_attempt_of_another_user(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    intruder = add_profile(db_session)
    attempt = stored(db_session, make_attempt(order, user))

    assert repository(db_session).find_by_key(intruder, attempt.idempotency_key) is None
    assert repository(db_session).find_by_key(uuid4(), attempt.idempotency_key) is None


def test_find_by_key_returns_each_users_own_attempt_when_two_share_a_key(
    db_session: Session,
) -> None:
    (user_a, order_a), (user_b, order_b) = (user_with_order(db_session) for _ in range(2))
    key = new_key()
    mine = stored(db_session, make_attempt(order_a, user_a, key=key))
    theirs = stored(db_session, make_attempt(order_b, user_b, key=key, failure_code=DECLINED))

    assert repository(db_session).find_by_key(user_a, key) == mine
    assert repository(db_session).find_by_key(user_b, key) == theirs


@pytest.mark.parametrize(
    "key",
    ["' OR '1'='1", "x'; DROP TABLE app.payment_attempts; --", "%", "_" * 16, "", "k" * 500],
)
def test_find_by_key_is_parametrized_and_matches_only_the_exact_key(
    db_session: Session, key: str
) -> None:
    user, order = user_with_order(db_session)
    stored(db_session, make_attempt(order, user))

    assert repository(db_session).find_by_key(user, key) is None
    assert attempts_in_db(db_session, user_id=user) == 1  # la tabla sigue ahí y con su fila


# ---------------------------------------------------------------------------------------------
# list_for_order: orden `created_at desc, id desc`, solo del dueño.
def test_list_for_order_returns_a_tuple_of_attempts_newest_first(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    ids = [
        rejected_row(db_session, order, user, created_at=BASE + timedelta(minutes=m))["id"]
        for m in (3, 1, 5, 2)
    ]
    by_age = [ids[2], ids[0], ids[3], ids[1]]  # minutos 5, 3, 2, 1

    result = repository(db_session).list_for_order(user, order)

    assert isinstance(result, tuple)
    assert [a.id for a in result] == by_age
    assert all(isinstance(a, PaymentAttempt) for a in result)


def test_list_for_order_breaks_ties_by_id_descending(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    ids = [rejected_row(db_session, order, user, created_at=BASE)["id"] for _ in range(5)]

    result = repository(db_session).list_for_order(user, order)

    assert [a.id for a in result] == sorted(ids, reverse=True)


def test_list_for_order_orders_by_creation_before_the_id(db_session: Session) -> None:
    # Un id mayor pero más antiguo va después: el orden primario es `created_at`.
    user, order = user_with_order(db_session)
    low, high = sorted([uuid4(), uuid4()])
    rejected_row(db_session, order, user, id=high, created_at=BASE)
    rejected_row(db_session, order, user, id=low, created_at=BASE + timedelta(seconds=1))

    result = repository(db_session).list_for_order(user, order)

    assert [a.id for a in result] == [low, high]


def test_list_for_order_returns_every_field_of_each_attempt(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    declined = stored(db_session, make_attempt(order, user, failure_code=DECLINED, last4="0002"))
    approved = stored(db_session, make_attempt(order, user, last4="4242", amount=777))

    result = repository(db_session).list_for_order(user, order)

    assert set(result) == {declined, approved}


def test_list_for_order_is_empty_without_attempts(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    assert repository(db_session).list_for_order(user, order) == ()


def test_list_for_order_is_empty_for_an_unknown_order(db_session: Session) -> None:
    user, _ = user_with_order(db_session)

    assert repository(db_session).list_for_order(user, uuid4()) == ()


def test_list_for_order_returns_only_the_attempts_of_that_order(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    other_order = insert_order_row(db_session, user)
    mine = stored(db_session, make_attempt(order, user, failure_code=DECLINED))
    stored(db_session, make_attempt(other_order, user, failure_code=FUNDS))

    result = repository(db_session).list_for_order(user, order)

    assert [a.id for a in result] == [mine.id]


def test_list_for_order_of_a_foreign_user_is_empty(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    intruder = add_profile(db_session)
    stored(db_session, make_attempt(order, user))
    stored(db_session, make_attempt(order, user, failure_code=DECLINED))

    assert repository(db_session).list_for_order(intruder, order) == ()
    assert repository(db_session).list_for_order(uuid4(), order) == ()
    assert len(repository(db_session).list_for_order(user, order)) == 2


def test_list_for_order_filters_by_the_user_column(db_session: Session) -> None:
    # Fila con el pedido de A pero a nombre de B: A no la ve y B sí, porque el filtro es user_id.
    user_a, order = user_with_order(db_session)
    user_b = add_profile(db_session)
    mine = stored(db_session, make_attempt(order, user_a, failure_code=DECLINED))
    theirs = stored(db_session, make_attempt(order, user_b, failure_code=FUNDS))

    assert [a.id for a in repository(db_session).list_for_order(user_a, order)] == [mine.id]
    assert [a.id for a in repository(db_session).list_for_order(user_b, order)] == [theirs.id]


# ---------------------------------------------------------------------------------------------
# count_rejected: el tope de 5 (D-043, R9): rechazos sin `order_expired`.
def test_count_rejected_counts_the_rejections_of_the_order(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    for code in (DECLINED, FUNDS, EXPIRED_CARD):
        stored(db_session, make_attempt(order, user, failure_code=code))

    assert repository(db_session).count_rejected(user, order) == 3


def test_count_rejected_does_not_count_order_expired(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    stored(db_session, make_attempt(order, user, failure_code=DECLINED))
    stored(db_session, make_attempt(order, user, failure_code=ORDER_EXPIRED))
    stored(db_session, make_attempt(order, user, failure_code=ORDER_EXPIRED))

    assert repository(db_session).count_rejected(user, order) == 1


def test_count_rejected_does_not_count_approved_attempts(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    stored(db_session, make_attempt(order, user, failure_code=DECLINED))
    stored(db_session, make_attempt(order, user))

    assert repository(db_session).count_rejected(user, order) == 1


def test_count_rejected_is_zero_without_attempts_or_with_only_an_approved_one(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    other_order = insert_order_row(db_session, user)
    stored(db_session, make_attempt(other_order, user))

    assert repository(db_session).count_rejected(user, order) == 0
    assert repository(db_session).count_rejected(user, other_order) == 0
    assert repository(db_session).count_rejected(user, uuid4()) == 0


@pytest.mark.parametrize("count", [4, 5, 6, 8])
def test_count_rejected_is_exact_around_the_limit_of_five(db_session: Session, count: int) -> None:
    # El repositorio solo cuenta; el tope (>= 5) lo aplica el caso de uso.
    user, order = user_with_order(db_session)
    for _ in range(count):
        stored(db_session, make_attempt(order, user, failure_code=DECLINED))

    assert repository(db_session).count_rejected(user, order) == count


def test_count_rejected_of_a_foreign_user_is_zero(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    intruder = add_profile(db_session)
    for _ in range(3):
        stored(db_session, make_attempt(order, user, failure_code=DECLINED))

    assert repository(db_session).count_rejected(intruder, order) == 0
    assert repository(db_session).count_rejected(user, order) == 3


def test_count_rejected_is_per_order(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    other_order = insert_order_row(db_session, user)
    for _ in range(2):
        stored(db_session, make_attempt(order, user, failure_code=DECLINED))
    stored(db_session, make_attempt(other_order, user, failure_code=FUNDS))

    assert repository(db_session).count_rejected(user, order) == 2
    assert repository(db_session).count_rejected(user, other_order) == 1


def test_count_rejected_returns_an_int(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    result = repository(db_session).count_rejected(user, order)

    assert type(result) is int


# ---------------------------------------------------------------------------------------------
# R7 / RF05.04: `card_last4` nunca aparece en logs, tampoco en los de SQLAlchemy ni en los
# errores. Se usa un motor como el de producción (`hide_parameters=True`, shared/db.py).
UUID_OR_DATE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|\d{4}-\d{2}-\d{2}[ T][0-9:.+-]+|pid \d+|id \d+"
)


def visible(text_: str) -> str:
    """El texto sin uuids ni fechas, que pueden contener cuatro dígitos seguidos por azar."""
    return UUID_OR_DATE.sub("", text_)


@pytest.fixture
def production_like_session(
    db_engine: Engine, caplog: pytest.LogCaptureFixture
) -> Iterator[Session]:
    # El registro se activa antes de abrir la conexión: SQLAlchemy decide al conectar si loguea.
    caplog.set_level(logging.DEBUG)
    # INFO muestra cada sentencia (con los parámetros ocultos). A DEBUG SQLAlchemy vuelca además
    # las filas leídas, `card_last4` incluido: ese nivel no se usa fuera de un depurador y no
    # depende del repositorio; queda anotado para la ronda de seguridad (T-096).
    caplog.set_level(logging.INFO, logger="sqlalchemy.engine")
    engine = create_engine(
        db_engine.url.render_as_string(hide_password=False), hide_parameters=True
    )
    with engine.connect() as connection:
        outer = connection.begin()
        with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
            yield session
        outer.rollback()
    engine.dispose()


def test_card_last4_never_reaches_the_logs_or_the_errors_in_any_operation(
    caplog: pytest.LogCaptureFixture, production_like_session: Session
) -> None:
    session = production_like_session
    user, order = user_with_order(session)
    repo = repository(session)
    approved = make_attempt(order, user, last4=LAST4)

    assert repo.add(approved) is not None
    assert repo.add(replace(approved, id=uuid4())) is None  # misma clave
    with pytest.raises(OrderAlreadyPaid) as paid, session.begin_nested():
        repo.add(make_attempt(order, user, last4=LAST4))
    with pytest.raises(IntegrityError) as foreign, session.begin_nested():
        repo.add(make_attempt(uuid4(), user, last4=LAST4))
    repo.add(make_attempt(order, user, failure_code=DECLINED, last4=LAST4))
    repo.find_by_key(user, approved.idempotency_key)
    repo.list_for_order(user, order)
    repo.count_rejected(user, order)

    assert caplog.records  # el registro estaba activo: el silencio es de verdad
    assert LAST4 not in visible(caplog.text)
    assert LAST4 not in visible(str(paid.value))
    assert LAST4 not in visible(str(foreign.value))
