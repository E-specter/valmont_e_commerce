"""Esquema de la migración 0011 (SPEC payments §6, CA-PAYMENTS-15): columnas, tipos, cada CHECK,
UNIQUE, índice parcial, FK con su acción de borrado e índices.

Las restricciones se prueban con SQL directo: son la última defensa (RNF08, RF05.04). Cada fila
inválida lo es por **un solo** motivo, así que el rechazo prueba esa restricción. Se comprueba el
SQLSTATE (23514 CHECK, 23503 FK, 23505 unicidad, 23502 NOT NULL, 22003 fuera de rango) y la tabla;
solo el índice parcial se identifica por su nombre, que la SPEC sí fija."""

import re
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_profile
from tests.orders.orders_db_helpers import (
    BASE,
    CHECK,
    FOREIGN_KEY,
    NOT_NULL,
    OUT_OF_RANGE,
    UNIQUE,
    insert_order_row,
    rejected,
    rows,
    scalar,
)
from tests.payments.payments_db_helpers import (
    PARTIAL_INDEX,
    attempt_values,
    insert_attempt_row,
    insert_sql,
    rejected_row,
    user_with_order,
    violation,
)

pytestmark = pytest.mark.integration

TABLE = "payment_attempts"
COLUMNS = {
    "id": ("uuid", "NO"),
    "order_id": ("uuid", "NO"),
    "user_id": ("uuid", "NO"),
    "idempotency_key": ("text", "NO"),
    "status": ("text", "NO"),
    "amount": ("bigint", "NO"),
    "failure_code": ("text", "YES"),
    "card_last4": ("text", "NO"),
    "gateway": ("text", "NO"),
    "created_at": ("timestamp with time zone", "NO"),
}
BAD_CODES = ["CARD_DECLINED", "Card_declined", "card declined", "card-declined", "card1", ""]


def reject(session: Session, **changes: Any) -> tuple[str | None, str | None]:
    user, order = user_with_order(session)
    return violation(session, order, user, **changes)


# ---------------------------------------------------------------------------------------------
# Columnas: nombre, tipo y nulabilidad exactos de §6.
def test_the_table_lives_in_the_app_schema(db_session: Session) -> None:
    assert scalar(db_session, "SELECT to_regclass('app.payment_attempts') IS NOT NULL")


def test_the_table_has_exactly_the_columns_of_section_6(db_session: Session) -> None:
    found = {
        name: (data_type, nullable)
        for name, data_type, nullable in rows(
            db_session,
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = :table",
            table=TABLE,
        )
    }

    assert found == COLUMNS


@pytest.mark.parametrize(
    "forbidden",
    ["card_number", "number", "pan", "cvv", "cvc", "expiry", "exp_month", "holder", "cardholder"],
)
def test_there_is_no_column_for_card_number_holder_expiry_or_cvv(
    db_session: Session, forbidden: str
) -> None:
    # RF05.04 / RN-11: ni siquiera nulables.
    assert not rows(
        db_session,
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app'"
        " AND table_name = :table AND column_name = :column",
        table=TABLE,
        column=forbidden,
    )


def test_amount_is_bigint_and_there_is_no_currency_column(db_session: Session) -> None:
    types = dict(
        rows(
            db_session,
            "SELECT column_name, data_type FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = :table"
            " AND column_name IN ('amount', 'currency')",
            table=TABLE,
        )
    )

    assert types == {"amount": "bigint"}


def test_there_is_no_updated_at_nor_any_sequence_for_the_table(db_session: Session) -> None:
    # Tabla inmutable (R1): sin updated_at; el id es un uuid de la aplicación, sin identidad.
    identity = scalar(
        db_session,
        "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'app'"
        " AND table_name = :table AND (is_identity = 'YES' OR column_default LIKE 'nextval%')",
        table=TABLE,
    )

    assert identity == 0
    assert "updated_at" not in {
        name
        for (name,) in rows(
            db_session,
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = :table",
            table=TABLE,
        )
    }


def test_created_at_defaults_to_now_with_a_time_zone(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    values = attempt_values(order, user)

    db_session.execute(text(insert_sql(values)), values)
    created, same_as_now = rows(
        db_session,
        "SELECT created_at, created_at = now() FROM app.payment_attempts WHERE id = :id",
        id=values["id"],
    )[0]

    assert created.tzinfo is not None
    assert same_as_now  # now() es el inicio de la transacción


def test_failure_code_defaults_to_null_when_omitted(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    values = attempt_values(order, user)
    del values["failure_code"]

    db_session.execute(text(insert_sql(values)), values)

    assert (
        scalar(
            db_session,
            "SELECT failure_code FROM app.payment_attempts WHERE id = :id",
            id=values["id"],
        )
        is None
    )


# ---------------------------------------------------------------------------------------------
# Filas válidas.
def test_a_valid_approved_row_is_accepted(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    values = insert_attempt_row(db_session, order, user)

    assert (
        scalar(
            db_session, "SELECT status FROM app.payment_attempts WHERE id = :id", id=values["id"]
        )
        == "approved"
    )


@pytest.mark.parametrize(
    "code", ["card_declined", "insufficient_funds", "expired_card", "order_expired"]
)
def test_a_valid_rejected_row_is_accepted_with_each_failure_code(
    db_session: Session, code: str
) -> None:
    user, order = user_with_order(db_session)

    values = rejected_row(db_session, order, user, code)

    assert (
        scalar(
            db_session,
            "SELECT failure_code FROM app.payment_attempts WHERE id = :id",
            id=values["id"],
        )
        == code
    )


# ---------------------------------------------------------------------------------------------
# CHECK de estado y de la coherencia estado ⇔ motivo.
@pytest.mark.parametrize("status", ["foo", "Approved", "APPROVED", "pending", "approve", ""])
def test_a_status_outside_approved_and_rejected_is_rejected(
    db_session: Session, status: str
) -> None:
    # Sin motivo: la coherencia (status = 'rejected') = (motivo no nulo) se cumple, así que el
    # único motivo del rechazo es el CHECK de la lista de estados.
    assert reject(db_session, status=status, failure_code=None) == (CHECK, TABLE)


def test_a_rejected_row_without_a_failure_code_is_rejected(db_session: Session) -> None:
    assert reject(db_session, status="rejected", failure_code=None) == (CHECK, TABLE)


@pytest.mark.parametrize("code", ["card_declined", "order_expired", "a"])
def test_an_approved_row_with_a_failure_code_is_rejected(db_session: Session, code: str) -> None:
    assert reject(db_session, status="approved", failure_code=code) == (CHECK, TABLE)


# ---------------------------------------------------------------------------------------------
# CHECK de failure_code: ^[a-z_]{1,40}$.
@pytest.mark.parametrize("code", BAD_CODES + ["a" * 41, "a" * 200, "card_declined\n", " card"])
def test_a_failure_code_outside_lowercase_letters_and_underscores_is_rejected(
    db_session: Session, code: str
) -> None:
    assert reject(db_session, status="rejected", failure_code=code) == (CHECK, TABLE)


@pytest.mark.parametrize("code", ["a", "_", "a" * 40, "order_expired"])
def test_failure_code_boundaries_are_accepted(db_session: Session, code: str) -> None:
    user, order = user_with_order(db_session)

    rejected_row(db_session, order, user, code)


# ---------------------------------------------------------------------------------------------
# CHECK de card_last4: exactamente 4 dígitos (RF05.04).
@pytest.mark.parametrize(
    "last4",
    [
        "",
        "1",
        "123",
        "12345",
        "4242424242424242",
        "abcd",
        "12a4",
        " 123",
        "123 ",
        "1234\n",
        "\n1234",
        "12-4",
        "١٢٣٤",  # dígitos arábigo-índicos: no son [0-9]
    ],
)
def test_a_card_last4_that_is_not_exactly_four_ascii_digits_is_rejected(
    db_session: Session, last4: str
) -> None:
    assert reject(db_session, card_last4=last4) == (CHECK, TABLE)


@pytest.mark.parametrize("last4", ["0000", "0002", "4242", "9995", "9999"])
def test_four_digit_card_last4_values_are_accepted(db_session: Session, last4: str) -> None:
    user, order = user_with_order(db_session)

    values = insert_attempt_row(db_session, order, user, card_last4=last4)

    assert (
        scalar(
            db_session,
            "SELECT card_last4 FROM app.payment_attempts WHERE id = :id",
            id=values["id"],
        )
        == last4
    )


# ---------------------------------------------------------------------------------------------
# Importe: bigint ≥ 1 (RN-15).
@pytest.mark.parametrize("amount", [0, -1, -100_000])
def test_a_non_positive_amount_is_rejected(db_session: Session, amount: int) -> None:
    assert reject(db_session, amount=amount) == (CHECK, TABLE)


def test_an_amount_of_one_cent_is_accepted(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    insert_attempt_row(db_session, order, user, amount=1)


@pytest.mark.parametrize("amount", [2**31 - 1, 2**31, 2**31 + 7, 2**40 + 5, 2**63 - 1])
def test_amounts_above_two_to_the_thirty_first_are_stored_without_loss(
    db_session: Session, amount: int
) -> None:
    user, order = user_with_order(db_session)

    values = insert_attempt_row(db_session, order, user, amount=amount)

    assert (
        scalar(
            db_session, "SELECT amount FROM app.payment_attempts WHERE id = :id", id=values["id"]
        )
        == amount
    )


def test_an_amount_above_bigint_is_rejected(db_session: Session) -> None:
    assert reject(db_session, amount=2**63)[0] == OUT_OF_RANGE


# ---------------------------------------------------------------------------------------------
# Clave de idempotencia (16-64) y pasarela (1-30).
@pytest.mark.parametrize("length", [0, 1, 15, 65, 200])
def test_an_idempotency_key_outside_16_to_64_characters_is_rejected(
    db_session: Session, length: int
) -> None:
    assert reject(db_session, idempotency_key="k" * length) == (CHECK, TABLE)


@pytest.mark.parametrize("length", [16, 17, 64])
def test_idempotency_key_boundaries_are_accepted(db_session: Session, length: int) -> None:
    user, order = user_with_order(db_session)

    insert_attempt_row(db_session, order, user, idempotency_key="k" * length)


@pytest.mark.parametrize("length", [0, 31, 100])
def test_a_gateway_name_outside_1_to_30_characters_is_rejected(
    db_session: Session, length: int
) -> None:
    assert reject(db_session, gateway="g" * length) == (CHECK, TABLE)


@pytest.mark.parametrize("length", [1, 9, 30])
def test_gateway_name_boundaries_are_accepted(db_session: Session, length: int) -> None:
    user, order = user_with_order(db_session)

    insert_attempt_row(db_session, order, user, gateway="g" * length)


# ---------------------------------------------------------------------------------------------
# NOT NULL.
@pytest.mark.parametrize(
    "column",
    [
        "id",
        "order_id",
        "user_id",
        "idempotency_key",
        "status",
        "amount",
        "card_last4",
        "gateway",
        "created_at",
    ],
)
def test_explicit_nulls_are_rejected_on_every_required_column(
    db_session: Session, column: str
) -> None:
    user, order = user_with_order(db_session)
    values = attempt_values(order, user, created_at=BASE)
    values[column] = None

    assert rejected(db_session, insert_sql(values), values) == (NOT_NULL, TABLE)


def test_an_explicit_created_at_is_kept(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    values = insert_attempt_row(db_session, order, user, created_at=BASE)

    assert (
        scalar(
            db_session,
            "SELECT created_at FROM app.payment_attempts WHERE id = :id",
            id=values["id"],
        )
        == BASE
    )


# ---------------------------------------------------------------------------------------------
# UNIQUE (user_id, idempotency_key) y clave primaria.
def test_the_same_key_twice_for_one_user_is_rejected(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    first = insert_attempt_row(
        db_session, order, user, status="rejected", failure_code="expired_card"
    )

    # Otro pedido, otro estado, otra tarjeta: solo coincide (user_id, idempotency_key).
    other_order = insert_order_row(db_session, user)
    outcome = violation(
        db_session, other_order, user, idempotency_key=first["idempotency_key"], card_last4="9995"
    )

    assert outcome == (UNIQUE, TABLE)


def test_the_same_key_for_two_users_is_accepted(db_session: Session) -> None:
    (user_a, order_a), (user_b, order_b) = (user_with_order(db_session) for _ in range(2))
    key = "shared-key-0123456789"

    insert_attempt_row(db_session, order_a, user_a, idempotency_key=key)
    insert_attempt_row(db_session, order_b, user_b, idempotency_key=key)

    assert (
        scalar(
            db_session,
            "SELECT count(*) FROM app.payment_attempts WHERE idempotency_key = :key",
            key=key,
        )
        == 2
    )


def test_two_different_keys_for_one_user_are_accepted(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    insert_attempt_row(db_session, order, user, status="rejected", failure_code="card_declined")
    insert_attempt_row(db_session, order, user, status="rejected", failure_code="card_declined")


def test_the_primary_key_is_unique(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    first = insert_attempt_row(
        db_session, order, user, status="rejected", failure_code="card_declined"
    )

    assert violation(
        db_session, order, user, id=first["id"], status="rejected", failure_code="expired_card"
    ) == (UNIQUE, TABLE)


# ---------------------------------------------------------------------------------------------
# Índice único parcial: un solo `approved` por pedido (R4).
def test_a_second_approved_attempt_for_the_same_order_is_rejected_by_the_partial_index(
    db_session: Session,
) -> None:
    user, order = user_with_order(db_session)
    insert_attempt_row(db_session, order, user)
    values = attempt_values(order, user)  # otra clave, otra tarjeta: solo coincide el pedido
    values["card_last4"] = "1111"

    with pytest.raises(DBAPIError) as error, db_session.begin_nested():
        db_session.execute(text(insert_sql(values)), values)

    assert error.value.orig.sqlstate == UNIQUE
    assert error.value.orig.diag.table_name == TABLE
    assert error.value.orig.diag.constraint_name == PARTIAL_INDEX


def test_a_second_approved_attempt_by_another_user_for_the_same_order_is_also_rejected(
    db_session: Session,
) -> None:
    # El índice es solo por pedido: el cobro es único aunque el dato de dueño fallara más arriba.
    user, order = user_with_order(db_session)
    intruder = add_profile(db_session)
    insert_attempt_row(db_session, order, user)

    assert violation(db_session, order, intruder) == (UNIQUE, TABLE)


@pytest.mark.parametrize("count", [2, 3, 6])
def test_several_rejected_attempts_for_one_order_fit(db_session: Session, count: int) -> None:
    user, order = user_with_order(db_session)

    for _ in range(count):
        rejected_row(db_session, order, user)

    assert (
        scalar(
            db_session, "SELECT count(*) FROM app.payment_attempts WHERE order_id = :id", id=order
        )
        == count
    )


def test_a_rejected_attempt_before_and_after_the_approved_one_fits(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    rejected_row(db_session, order, user)
    insert_attempt_row(db_session, order, user)
    rejected_row(db_session, order, user, "insufficient_funds")

    assert (
        scalar(
            db_session,
            "SELECT count(*) FROM app.payment_attempts"
            " WHERE order_id = :id AND status = 'approved'",
            id=order,
        )
        == 1
    )


def test_one_approved_attempt_per_order_fits_for_different_orders(db_session: Session) -> None:
    user, first = user_with_order(db_session)
    second = insert_order_row(db_session, user)

    insert_attempt_row(db_session, first, user)
    insert_attempt_row(db_session, second, user)


def test_the_partial_index_only_covers_approved_attempts(db_session: Session) -> None:
    definition = scalar(
        db_session,
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = :table"
        " AND indexname = :name",
        table=TABLE,
        name=PARTIAL_INDEX,
    )

    assert definition is not None
    normalized = re.sub(r"\s+", " ", definition.replace("app.", "").replace('"', ""))
    assert normalized.startswith("CREATE UNIQUE INDEX")
    assert "ON payment_attempts" in normalized
    assert "(order_id)" in normalized
    assert re.search(r"WHERE \(?status = 'approved'", normalized)


# ---------------------------------------------------------------------------------------------
# FK con su acción de borrado (RESTRICT) y existencia de lo referenciado.
def test_an_attempt_needs_an_existing_order(db_session: Session) -> None:
    user = add_profile(db_session)

    assert violation(db_session, uuid4(), user) == (FOREIGN_KEY, TABLE)


def test_an_attempt_needs_an_existing_profile(db_session: Session) -> None:
    _, order = user_with_order(db_session)

    assert violation(db_session, order, uuid4()) == (FOREIGN_KEY, TABLE)


def test_an_order_with_attempts_cannot_be_deleted(db_session: Session) -> None:
    user, order = user_with_order(db_session)
    insert_attempt_row(db_session, order, user)

    assert rejected(db_session, "DELETE FROM app.orders WHERE id = :id", {"id": order}) == (
        FOREIGN_KEY,
        TABLE,
    )
    assert scalar(db_session, "SELECT count(*) FROM app.orders WHERE id = :id", id=order) == 1


def test_a_profile_with_attempts_cannot_be_deleted(db_session: Session) -> None:
    # El perfil del intento no tiene pedidos: el único freno es la FK de payment_attempts.
    _, order = user_with_order(db_session)
    payer = add_profile(db_session)
    insert_attempt_row(db_session, order, payer)

    assert rejected(db_session, "DELETE FROM app.profiles WHERE user_id = :id", {"id": payer}) == (
        FOREIGN_KEY,
        TABLE,
    )


def test_deleting_an_order_or_profile_without_attempts_still_works(db_session: Session) -> None:
    user, order = user_with_order(db_session)

    db_session.execute(text("DELETE FROM app.orders WHERE id = :id"), {"id": order})
    db_session.execute(text("DELETE FROM app.profiles WHERE user_id = :id"), {"id": user})


# ---------------------------------------------------------------------------------------------
# Catálogo: claves, FK con su acción e índices tal como los pide §6.
def normalized(definition: str) -> str:
    cleaned = definition.replace("app.", "").replace("public.", "").replace('"', "")
    return re.sub(r"\s+", " ", cleaned).strip()


def constraint_defs(session: Session, kind: str) -> set[str]:
    return {
        normalized(definition)
        for (definition,) in rows(
            session,
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint AS c"
            " WHERE c.contype = :kind AND c.conrelid = 'app.payment_attempts'::regclass",
            kind=kind,
        )
    }


def test_primary_key(db_session: Session) -> None:
    assert constraint_defs(db_session, "p") == {"PRIMARY KEY (id)"}


def test_unique_constraints(db_session: Session) -> None:
    # El único de pedido es un índice parcial (no una restricción): no aparece aquí.
    assert constraint_defs(db_session, "u") == {"UNIQUE (user_id, idempotency_key)"}


def test_foreign_keys_and_their_delete_actions(db_session: Session) -> None:
    assert constraint_defs(db_session, "f") == {
        "FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT",
        "FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE RESTRICT",
    }


def test_the_table_has_check_constraints(db_session: Session) -> None:
    # Estado, coherencia estado/motivo, motivo, tarjeta, importe, clave y pasarela: 7 como mínimo.
    # Las probamos una a una arriba; aquí solo que no falta alguna por completo.
    assert len(constraint_defs(db_session, "c")) >= 7


def test_indexes_of_the_read_paths(db_session: Session) -> None:
    definitions = {
        normalized(definition)
        for (definition,) in rows(
            db_session,
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename = :table",
            table=TABLE,
        )
    }

    assert any(
        "ON payment_attempts" in d and "(order_id, created_at DESC, id DESC)" in d
        for d in definitions
    )
    assert any(f"INDEX {PARTIAL_INDEX} " in d and "UNIQUE" in d for d in definitions)
