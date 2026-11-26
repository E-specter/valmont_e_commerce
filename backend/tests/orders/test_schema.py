"""Esquema de la migración 0010 (SPEC §6, CA-ORDERS-23): columnas, tipos, cada CHECK, UNIQUE, FK
con su acción de borrado e índices.

Los CHECK, las FK y las claves se prueban con SQL directo: son la última defensa (RNF08). Cada
fila inválida lo es por **un solo** motivo, así que el rechazo prueba esa restricción. Se comprueba
el SQLSTATE (23514 CHECK, 23503 FK, 23505 unicidad, 23502 NOT NULL) y la tabla, no el nombre de
la restricción, que la SPEC no fija."""

import re
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.cart.cart_helpers import add_product, add_profile
from tests.orders.orders_db_helpers import (
    BASE,
    CHECK,
    FOREIGN_KEY,
    GENERATED_ALWAYS,
    NOT_NULL,
    OUT_OF_RANGE,
    UNIQUE,
    delivery_values,
    history_values,
    insert_delivery_row,
    insert_history_row,
    insert_line_row,
    insert_order_row,
    line_values,
    order_values,
    rejected,
    rows,
    scalar,
)

pytestmark = pytest.mark.integration

TABLES = ("orders", "order_lines", "deliveries", "order_status_history")


def insert_sql(table: str, values: dict[str, Any]) -> str:
    columns = ", ".join(values)
    marks = ", ".join(":" + name for name in values)
    return f"INSERT INTO app.{table} ({columns}) VALUES ({marks})"


def reject_order(session: Session, **changes: Any) -> tuple[str | None, str | None]:
    values = order_values(add_profile(session), **changes)
    return rejected(session, insert_sql("orders", values), values)


def reject_line(session: Session, **changes: Any) -> tuple[str | None, str | None]:
    order_id = insert_order_row(session)
    values = line_values(order_id, add_product(session), **changes)
    return rejected(session, insert_sql("order_lines", values), values)


def reject_delivery(session: Session, **changes: Any) -> tuple[str | None, str | None]:
    values = delivery_values(insert_order_row(session), **changes)
    return rejected(session, insert_sql("deliveries", values), values)


def reject_history(session: Session, **changes: Any) -> tuple[str | None, str | None]:
    values = history_values(insert_order_row(session), **changes)
    return rejected(session, insert_sql("order_status_history", values), values)


# ---------------------------------------------------------------------------------------------
# Columnas: nombre, tipo y nulabilidad exactos de §6.
COLUMNS = {
    "orders": {
        "id": ("uuid", "NO"),
        "order_number": ("bigint", "NO"),
        "user_id": ("uuid", "NO"),
        "status": ("text", "NO"),
        "idempotency_key": ("text", "NO"),
        "subtotal_amount": ("bigint", "NO"),
        "shipping_amount": ("bigint", "NO"),
        "total_amount": ("bigint", "NO"),
        "expires_at": ("timestamp with time zone", "NO"),
        "estimated_delivery_on": ("date", "YES"),
        "paid_at": ("timestamp with time zone", "YES"),
        "refunded_amount": ("bigint", "YES"),
        "refunded_at": ("timestamp with time zone", "YES"),
        "created_at": ("timestamp with time zone", "NO"),
        "updated_at": ("timestamp with time zone", "NO"),
    },
    "order_lines": {
        "id": ("uuid", "NO"),
        "order_id": ("uuid", "NO"),
        "position": ("smallint", "NO"),
        "product_id": ("uuid", "NO"),
        "sku": ("text", "NO"),
        "name": ("text", "NO"),
        "quantity": ("smallint", "NO"),
        "list_price_amount": ("bigint", "NO"),
        "unit_price_amount": ("bigint", "NO"),
        "discount_amount": ("bigint", "NO"),
        "line_total_amount": ("bigint", "NO"),
        "promotion_id": ("uuid", "YES"),
        "fulfillment": ("text", "NO"),
        "lead_time_days": ("integer", "YES"),
    },
    "deliveries": {
        "order_id": ("uuid", "NO"),
        "delivery_method": ("text", "NO"),
        "recipient_name": ("text", "NO"),
        "phone": ("text", "NO"),
        "department": ("text", "YES"),
        "province": ("text", "YES"),
        "district": ("text", "YES"),
        "address_line": ("text", "YES"),
        "reference": ("text", "YES"),
        "carrier": ("text", "YES"),
        "tracking_code": ("text", "YES"),
        "shipped_at": ("timestamp with time zone", "YES"),
    },
    "order_status_history": {
        "id": ("bigint", "NO"),
        "order_id": ("uuid", "NO"),
        "from_status": ("text", "YES"),
        "to_status": ("text", "NO"),
        "actor_kind": ("text", "NO"),
        "actor_id": ("uuid", "YES"),
        "note": ("text", "YES"),
        "created_at": ("timestamp with time zone", "NO"),
    },
}


@pytest.mark.parametrize("table", TABLES)
def test_each_table_has_exactly_the_columns_of_section_6(db_session: Session, table: str) -> None:
    found = {
        name: (data_type, nullable)
        for name, data_type, nullable in rows(
            db_session,
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = :table",
            table=table,
        )
    }

    assert found == COLUMNS[table]


def test_the_four_tables_live_in_the_app_schema(db_session: Session) -> None:
    for table in TABLES:
        assert scalar(db_session, "SELECT to_regclass(:name) IS NOT NULL", name=f"app.{table}")


def test_all_money_columns_are_bigint(db_session: Session) -> None:
    # R2 / RN-15: Σ de importes puede superar 2³¹.
    money = scalar(
        db_session,
        "SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns"
        " WHERE table_schema = 'app' AND table_name IN ('orders', 'order_lines')"
        " AND column_name LIKE '%\\_amount' AND data_type = 'bigint'",
    )

    assert money == [
        "discount_amount",
        "line_total_amount",
        "list_price_amount",
        "refunded_amount",
        "shipping_amount",
        "subtotal_amount",
        "total_amount",
        "unit_price_amount",
    ]


@pytest.mark.parametrize(
    ("table", "column"), [("orders", "order_number"), ("order_status_history", "id")]
)
def test_the_number_and_the_history_id_are_identity_always(
    db_session: Session, table: str, column: str
) -> None:
    identity = scalar(
        db_session,
        "SELECT identity_generation FROM information_schema.columns"
        " WHERE table_schema = 'app' AND table_name = :table AND column_name = :column",
        table=table,
        column=column,
    )

    assert identity == "ALWAYS"


def test_order_number_cannot_be_chosen_by_the_caller(db_session: Session) -> None:
    values = order_values(add_profile(db_session), order_number=7)

    assert rejected(db_session, insert_sql("orders", values), values)[0] == GENERATED_ALWAYS


def test_history_id_cannot_be_chosen_by_the_caller(db_session: Session) -> None:
    values = history_values(insert_order_row(db_session), id=1)

    assert rejected(db_session, insert_sql("order_status_history", values), values)[0] == (
        GENERATED_ALWAYS
    )


def test_order_numbers_come_from_a_sequence_and_increase(db_session: Session) -> None:
    first, second, third = (insert_order_row(db_session) for _ in range(3))

    numbers = [
        scalar(db_session, "SELECT order_number FROM app.orders WHERE id = :id", id=i)
        for i in (first, second, third)
    ]

    assert all(isinstance(n, int) and n > 0 for n in numbers)
    assert numbers[0] < numbers[1] < numbers[2]


def test_order_number_is_unique_even_when_overridden(db_session: Session) -> None:
    first = insert_order_row(db_session)
    number = scalar(db_session, "SELECT order_number FROM app.orders WHERE id = :id", id=first)
    values = order_values(add_profile(db_session), order_number=number)

    with pytest.raises(IntegrityError) as error, db_session.begin_nested():
        db_session.execute(
            text(
                insert_sql("orders", values).replace(") VALUES", ") OVERRIDING SYSTEM VALUE VALUES")
            ),
            values,
        )

    assert error.value.orig.sqlstate == UNIQUE
    assert error.value.orig.diag.table_name == "orders"


def test_defaults_of_the_orders_table(db_session: Session) -> None:
    user = add_profile(db_session)
    order = order_values(user)
    for column in ("shipping_amount", "created_at"):
        del order[column]
    order["total_amount"] = order["subtotal_amount"]
    order["expires_at"] = scalar(db_session, "SELECT now() + interval '30 minutes'")
    db_session.execute(text(insert_sql("orders", order)), order)

    shipping, created, updated, paid, refunded, estimated = rows(
        db_session,
        "SELECT shipping_amount, created_at, updated_at, paid_at, refunded_amount,"
        " estimated_delivery_on FROM app.orders WHERE id = :id",
        id=order["id"],
    )[0]

    assert shipping == 0
    assert created is not None and created.tzinfo is not None
    assert updated is not None and updated.tzinfo is not None
    assert (paid, refunded, estimated) == (None, None, None)


def test_created_at_of_history_defaults_to_now(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    insert_history_row(db_session, order_id)

    created = scalar(
        db_session,
        "SELECT created_at FROM app.order_status_history WHERE order_id = :id",
        id=order_id,
    )

    assert created is not None and created.tzinfo is not None


# ---------------------------------------------------------------------------------------------
# app.orders: CHECK.
def test_a_valid_order_row_is_accepted(db_session: Session) -> None:
    order_id = insert_order_row(db_session)

    assert scalar(db_session, "SELECT status FROM app.orders WHERE id = :id", id=order_id) == (
        "pendiente_pago"
    )


@pytest.mark.parametrize(
    "status",
    [
        "pendiente_pago",
        "pagado",
        "en_preparacion",
        "enviado",
        "listo_para_recojo",
        "entregado",
        "cancelado",
        "expirado",
    ],
)
def test_the_eight_statuses_are_accepted(db_session: Session, status: str) -> None:
    paid_at = (
        BASE
        if status in {"pagado", "en_preparacion", "enviado", "listo_para_recojo", "entregado"}
        else None
    )

    order_id = insert_order_row(db_session, status=status, paid_at=paid_at)

    assert scalar(db_session, "SELECT status FROM app.orders WHERE id = :id", id=order_id) == status


@pytest.mark.parametrize("status", ["foo", "Pagado", "paid", "", "pendiente"])
def test_an_unknown_status_is_rejected(db_session: Session, status: str) -> None:
    assert reject_order(db_session, status=status) == (CHECK, "orders")


@pytest.mark.parametrize("length", [0, 15, 65, 200])
def test_an_idempotency_key_outside_16_to_64_characters_is_rejected(
    db_session: Session, length: int
) -> None:
    assert reject_order(db_session, idempotency_key="k" * length) == (CHECK, "orders")


@pytest.mark.parametrize("length", [16, 64])
def test_idempotency_key_boundaries_are_accepted(db_session: Session, length: int) -> None:
    insert_order_row(db_session, idempotency_key="k" * length)


@pytest.mark.parametrize("subtotal", [0, -1])
def test_a_non_positive_subtotal_is_rejected(db_session: Session, subtotal: int) -> None:
    # total = subtotal + envío se mantiene: el único motivo es subtotal > 0.
    assert reject_order(db_session, subtotal_amount=subtotal, total_amount=subtotal) == (
        CHECK,
        "orders",
    )


def test_a_negative_shipping_amount_is_rejected(db_session: Session) -> None:
    assert reject_order(db_session, shipping_amount=-1, total_amount=99_999) == (CHECK, "orders")


@pytest.mark.parametrize("total", [100_000, 100_499, 99_999, 0])
def test_total_must_equal_subtotal_plus_shipping(db_session: Session, total: int) -> None:
    assert reject_order(db_session, shipping_amount=500, total_amount=total) == (CHECK, "orders")


def test_total_with_shipping_is_accepted(db_session: Session) -> None:
    insert_order_row(db_session, shipping_amount=500, total_amount=100_500)


def test_amounts_above_two_to_the_thirty_first_are_stored_without_loss(db_session: Session) -> None:
    big = 2**31 + 12_345  # 2 147 496 000 céntimos > int4
    order_id = insert_order_row(
        db_session, subtotal_amount=big, total_amount=big + 500, shipping_amount=500
    )

    stored = rows(
        db_session,
        "SELECT subtotal_amount, shipping_amount, total_amount FROM app.orders WHERE id = :id",
        id=order_id,
    )

    assert stored == [(big, 500, big + 500)]


@pytest.mark.parametrize("delta", [timedelta(0), timedelta(seconds=-1)])
def test_expires_at_must_be_after_created_at(db_session: Session, delta: timedelta) -> None:
    assert reject_order(db_session, expires_at=BASE + delta) == (CHECK, "orders")


def test_expires_at_one_microsecond_after_created_at_is_accepted(db_session: Session) -> None:
    insert_order_row(db_session, expires_at=BASE + timedelta(microseconds=1))


@pytest.mark.parametrize(
    "status", ["pagado", "en_preparacion", "enviado", "listo_para_recojo", "entregado"]
)
def test_a_paid_status_requires_paid_at(db_session: Session, status: str) -> None:
    assert reject_order(db_session, status=status, paid_at=None) == (CHECK, "orders")


@pytest.mark.parametrize("status", ["pendiente_pago", "cancelado", "expirado"])
def test_an_unpaid_status_does_not_require_paid_at(db_session: Session, status: str) -> None:
    insert_order_row(db_session, status=status, paid_at=None)


def test_refund_amount_and_refund_date_go_together(db_session: Session) -> None:
    amount_only = {"status": "cancelado", "refunded_amount": 100_000, "refunded_at": None}
    date_only = {"status": "cancelado", "refunded_amount": None, "refunded_at": BASE}

    assert reject_order(db_session, **amount_only) == (CHECK, "orders")
    assert reject_order(db_session, **date_only) == (CHECK, "orders")


@pytest.mark.parametrize(
    "status", ["pendiente_pago", "pagado", "en_preparacion", "entregado", "expirado"]
)
def test_a_refund_only_exists_on_a_cancelled_order(db_session: Session, status: str) -> None:
    paid = BASE if status in {"pagado", "en_preparacion", "entregado"} else None

    assert reject_order(
        db_session, status=status, paid_at=paid, refunded_amount=100_000, refunded_at=BASE
    ) == (CHECK, "orders")


@pytest.mark.parametrize("amount", [99_999, 100_001, 1])
def test_the_refund_must_be_total(db_session: Session, amount: int) -> None:
    assert reject_order(
        db_session, status="cancelado", refunded_amount=amount, refunded_at=BASE
    ) == (CHECK, "orders")


def test_a_total_refund_on_a_cancelled_order_is_accepted(db_session: Session) -> None:
    order_id = insert_order_row(
        db_session,
        status="cancelado",
        paid_at=BASE,
        refunded_amount=100_000,
        refunded_at=BASE + timedelta(hours=1),
    )

    assert (
        scalar(db_session, "SELECT refunded_amount FROM app.orders WHERE id = :id", id=order_id)
        == 100_000
    )


# ---------------------------------------------------------------------------------------------
# app.orders: NOT NULL, UNIQUE y FK.
@pytest.mark.parametrize(
    "column",
    [
        "id",
        "user_id",
        "status",
        "idempotency_key",
        "subtotal_amount",
        "shipping_amount",
        "total_amount",
        "expires_at",
        "created_at",
    ],
)
def test_explicit_nulls_are_rejected_on_every_required_order_column(
    db_session: Session, column: str
) -> None:
    # Un CHECK deja pasar el NULL: NOT NULL es lo que lo frena.
    values = order_values(add_profile(db_session), **{column: None})

    assert rejected(db_session, insert_sql("orders", values), values) == (NOT_NULL, "orders")


def test_the_same_key_twice_for_one_user_is_rejected(db_session: Session) -> None:
    user = add_profile(db_session)
    insert_order_row(db_session, user, idempotency_key="k" * 20)

    values = order_values(user, idempotency_key="k" * 20)

    assert rejected(db_session, insert_sql("orders", values), values) == (UNIQUE, "orders")


def test_the_same_key_for_two_users_is_accepted(db_session: Session) -> None:
    insert_order_row(db_session, idempotency_key="k" * 20)
    insert_order_row(db_session, idempotency_key="k" * 20)


def test_the_primary_key_of_orders_is_unique(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    values = order_values(add_profile(db_session), id=order_id)

    assert rejected(db_session, insert_sql("orders", values), values) == (UNIQUE, "orders")


def test_an_order_needs_an_existing_profile(db_session: Session) -> None:
    values = order_values(uuid4())

    assert rejected(db_session, insert_sql("orders", values), values) == (FOREIGN_KEY, "orders")


def test_a_profile_with_orders_cannot_be_deleted(db_session: Session) -> None:
    # ON DELETE RESTRICT: los pedidos no se pierden con el perfil.
    user = add_profile(db_session)
    insert_order_row(db_session, user)

    assert rejected(db_session, "DELETE FROM app.profiles WHERE user_id = :id", {"id": user}) == (
        FOREIGN_KEY,
        "orders",
    )


# ---------------------------------------------------------------------------------------------
# app.order_lines.
def test_a_valid_line_row_is_accepted(db_session: Session) -> None:
    order_id = insert_order_row(db_session)

    line_id = insert_line_row(db_session, order_id)

    assert (
        scalar(db_session, "SELECT count(*) FROM app.order_lines WHERE id = :id", id=line_id) == 1
    )


@pytest.mark.parametrize("position", [0, -1])
def test_line_position_must_be_at_least_one(db_session: Session, position: int) -> None:
    assert reject_line(db_session, position=position) == (CHECK, "order_lines")


@pytest.mark.parametrize("quantity", [0, -1, 101])
def test_line_quantity_outside_one_to_one_hundred_is_rejected(
    db_session: Session, quantity: int
) -> None:
    total = 100_000 * quantity  # line_total coherente: el único motivo es la cantidad
    assert reject_line(db_session, quantity=quantity, line_total_amount=total) == (
        CHECK,
        "order_lines",
    )


@pytest.mark.parametrize("quantity", [1, 100])
def test_line_quantity_boundaries_are_accepted(db_session: Session, quantity: int) -> None:
    order_id = insert_order_row(db_session)

    insert_line_row(db_session, order_id, quantity=quantity, line_total_amount=100_000 * quantity)


def test_line_quantity_is_a_smallint(db_session: Session) -> None:
    assert reject_line(db_session, quantity=40_000, line_total_amount=4_000_000_000)[0] == (
        OUT_OF_RANGE
    )


def test_line_position_is_a_smallint(db_session: Session) -> None:
    assert reject_line(db_session, position=40_000)[0] == OUT_OF_RANGE


@pytest.mark.parametrize("price", [0, -1])
def test_line_list_price_must_be_positive(db_session: Session, price: int) -> None:
    # unit y descuento se ajustan; con lista ≤ 0 el descuento negativo también lo impide.
    assert reject_line(
        db_session,
        list_price_amount=price,
        unit_price_amount=1,
        discount_amount=price - 1,
        line_total_amount=1,
    ) == (CHECK, "order_lines")


@pytest.mark.parametrize("price", [0, -1])
def test_line_unit_price_must_be_positive(db_session: Session, price: int) -> None:
    assert reject_line(
        db_session,
        unit_price_amount=price,
        discount_amount=100_000 - price,
        line_total_amount=price,
    ) == (CHECK, "order_lines")


def test_line_discount_cannot_be_negative(db_session: Session) -> None:
    # list 100 000 y unit 200 000: la aritmética cuadra (descuento −100 000) y solo falla el signo.
    assert reject_line(
        db_session,
        unit_price_amount=200_000,
        discount_amount=-100_000,
        line_total_amount=200_000,
    ) == (CHECK, "order_lines")


@pytest.mark.parametrize("discount", [0, 9_999, 10_001, 90_000])
def test_line_discount_must_equal_list_minus_unit(db_session: Session, discount: int) -> None:
    assert reject_line(
        db_session,
        list_price_amount=100_000,
        unit_price_amount=90_000,
        discount_amount=discount,
        line_total_amount=90_000,
    ) == (CHECK, "order_lines")


def test_line_with_a_promotion_discount_is_accepted(db_session: Session) -> None:
    order_id = insert_order_row(db_session)

    insert_line_row(
        db_session,
        order_id,
        unit_price_amount=90_000,
        discount_amount=10_000,
        line_total_amount=90_000,
        promotion_id=uuid4(),  # sin FK: dato histórico (R3)
    )


@pytest.mark.parametrize("line_total", [0, 99_999, 100_001, 200_000])
def test_line_total_must_equal_unit_price_times_quantity(
    db_session: Session, line_total: int
) -> None:
    assert reject_line(db_session, quantity=1, line_total_amount=line_total) == (
        CHECK,
        "order_lines",
    )


def test_line_amounts_above_two_to_the_thirty_first_are_stored_without_loss(
    db_session: Session,
) -> None:
    order_id = insert_order_row(
        db_session, subtotal_amount=6_000_000_000, total_amount=6_000_000_000
    )

    line_id = insert_line_row(
        db_session,
        order_id,
        quantity=2,
        list_price_amount=3_500_000_000,
        unit_price_amount=3_000_000_000,
        discount_amount=500_000_000,
        line_total_amount=6_000_000_000,
    )

    assert rows(
        db_session,
        "SELECT list_price_amount, unit_price_amount, discount_amount, line_total_amount"
        " FROM app.order_lines WHERE id = :id",
        id=line_id,
    ) == [(3_500_000_000, 3_000_000_000, 500_000_000, 6_000_000_000)]


def test_line_fulfillment_must_be_stock_or_made_to_order(db_session: Session) -> None:
    assert reject_line(db_session, fulfillment="backorder") == (CHECK, "order_lines")
    order_id = insert_order_row(db_session)
    insert_line_row(db_session, order_id, fulfillment="made_to_order", lead_time_days=21)


@pytest.mark.parametrize("days", [0, -1])
def test_line_lead_time_must_be_positive_when_present(db_session: Session, days: int) -> None:
    assert reject_line(db_session, fulfillment="made_to_order", lead_time_days=days) == (
        CHECK,
        "order_lines",
    )


def test_line_lead_time_may_be_null(db_session: Session) -> None:
    insert_line_row(db_session, insert_order_row(db_session), lead_time_days=None)


@pytest.mark.parametrize(
    "column",
    [
        "id",
        "order_id",
        "position",
        "product_id",
        "sku",
        "name",
        "quantity",
        "list_price_amount",
        "unit_price_amount",
        "discount_amount",
        "line_total_amount",
        "fulfillment",
    ],
)
def test_explicit_nulls_are_rejected_on_every_required_line_column(
    db_session: Session, column: str
) -> None:
    values = line_values(insert_order_row(db_session), add_product(db_session), **{column: None})

    assert rejected(db_session, insert_sql("order_lines", values), values) == (
        NOT_NULL,
        "order_lines",
    )


def test_a_product_appears_once_per_order(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    product = add_product(db_session)
    insert_line_row(db_session, order_id, product, position=1)
    values = line_values(order_id, product, position=2)

    assert rejected(db_session, insert_sql("order_lines", values), values) == (
        UNIQUE,
        "order_lines",
    )


def test_a_position_appears_once_per_order(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    insert_line_row(db_session, order_id, position=1)
    values = line_values(order_id, add_product(db_session), position=1)

    assert rejected(db_session, insert_sql("order_lines", values), values) == (
        UNIQUE,
        "order_lines",
    )


def test_the_same_product_and_position_in_two_orders_are_accepted(db_session: Session) -> None:
    product = add_product(db_session)
    insert_line_row(db_session, insert_order_row(db_session), product, position=1)
    insert_line_row(db_session, insert_order_row(db_session), product, position=1)


def test_a_line_needs_an_existing_order_and_product(db_session: Session) -> None:
    orphan = line_values(uuid4(), add_product(db_session))
    unknown_product = line_values(insert_order_row(db_session), uuid4())

    assert rejected(db_session, insert_sql("order_lines", orphan), orphan) == (
        FOREIGN_KEY,
        "order_lines",
    )
    assert rejected(db_session, insert_sql("order_lines", unknown_product), unknown_product) == (
        FOREIGN_KEY,
        "order_lines",
    )


def test_a_product_in_an_order_cannot_be_deleted(db_session: Session) -> None:
    # ON DELETE RESTRICT: la instantánea del pedido no pierde su producto.
    product = add_product(db_session)
    insert_line_row(db_session, insert_order_row(db_session), product)

    assert rejected(db_session, "DELETE FROM app.products WHERE id = :id", {"id": product}) == (
        FOREIGN_KEY,
        "order_lines",
    )


def test_deleting_an_order_cascades_to_lines_delivery_and_history(db_session: Session) -> None:
    order_id, other = insert_order_row(db_session), insert_order_row(db_session)
    for target in (order_id, other):
        insert_line_row(db_session, target)
        insert_delivery_row(db_session, target)
        insert_history_row(db_session, target)

    db_session.execute(text("DELETE FROM app.orders WHERE id = :id"), {"id": order_id})

    counts = {
        table: (
            scalar(db_session, f"SELECT count(*) FROM app.{table} WHERE {key} = :id", id=order_id),
            scalar(db_session, f"SELECT count(*) FROM app.{table} WHERE {key} = :id", id=other),
        )
        for table, key in (
            ("order_lines", "order_id"),
            ("deliveries", "order_id"),
            ("order_status_history", "order_id"),
        )
    }
    assert counts == {table: (0, 1) for table in counts}


# ---------------------------------------------------------------------------------------------
# app.deliveries.
def test_valid_shipping_and_pickup_deliveries_are_accepted(db_session: Session) -> None:
    insert_delivery_row(db_session, insert_order_row(db_session))  # shipping sin referencia
    insert_delivery_row(db_session, insert_order_row(db_session), reference="Frente al parque")
    pickup = {
        "delivery_method": "pickup",
        "department": None,
        "province": None,
        "district": None,
        "address_line": None,
    }
    insert_delivery_row(db_session, insert_order_row(db_session), **pickup)


def test_a_shipped_shipping_delivery_keeps_carrier_tracking_and_date(db_session: Session) -> None:
    order_id = insert_order_row(db_session)

    insert_delivery_row(
        db_session, order_id, carrier="Olva", tracking_code="OL-123", shipped_at=BASE
    )

    assert rows(
        db_session,
        "SELECT carrier, tracking_code, shipped_at FROM app.deliveries WHERE order_id = :id",
        id=order_id,
    ) == [("Olva", "OL-123", BASE)]


def test_an_unknown_delivery_method_is_rejected(db_session: Session) -> None:
    assert reject_delivery(db_session, delivery_method="drone") == (CHECK, "deliveries")


@pytest.mark.parametrize("column", ["department", "province", "district", "address_line"])
def test_a_shipping_delivery_without_a_location_field_is_rejected(
    db_session: Session, column: str
) -> None:
    assert reject_delivery(db_session, **{column: None}) == (CHECK, "deliveries")


@pytest.mark.parametrize(
    "column",
    [
        "department",
        "province",
        "district",
        "address_line",
        "reference",
        "carrier",
        "tracking_code",
        "shipped_at",
    ],
)
def test_a_pickup_delivery_with_address_carrier_tracking_or_shipping_date_is_rejected(
    db_session: Session, column: str
) -> None:
    clean = {
        "delivery_method": "pickup",
        "department": None,
        "province": None,
        "district": None,
        "address_line": None,
    }
    value = BASE if column == "shipped_at" else "Algo"

    assert reject_delivery(db_session, **{**clean, column: value}) == (CHECK, "deliveries")


@pytest.mark.parametrize("column", ["delivery_method", "recipient_name", "phone", "order_id"])
def test_explicit_nulls_are_rejected_on_every_required_delivery_column(
    db_session: Session, column: str
) -> None:
    values = delivery_values(insert_order_row(db_session), **{column: None})

    assert rejected(db_session, insert_sql("deliveries", values), values) == (
        NOT_NULL,
        "deliveries",
    )


def test_an_order_has_one_delivery_at_most(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    insert_delivery_row(db_session, order_id)
    values = delivery_values(order_id)

    assert rejected(db_session, insert_sql("deliveries", values), values) == (UNIQUE, "deliveries")


def test_a_delivery_needs_an_existing_order(db_session: Session) -> None:
    values = delivery_values(uuid4())

    assert rejected(db_session, insert_sql("deliveries", values), values) == (
        FOREIGN_KEY,
        "deliveries",
    )


# ---------------------------------------------------------------------------------------------
# app.order_status_history.
def test_valid_history_rows_are_accepted(db_session: Session) -> None:
    order_id = insert_order_row(db_session)
    insert_history_row(db_session, order_id)  # creación por el cliente
    insert_history_row(
        db_session,
        order_id,
        from_status="pendiente_pago",
        to_status="expirado",
        actor_kind="system",
        actor_id=None,
    )
    insert_history_row(
        db_session, order_id, from_status="pagado", to_status="cancelado", actor_kind="admin"
    )

    assert (
        scalar(
            db_session,
            "SELECT count(*) FROM app.order_status_history WHERE order_id = :id",
            id=order_id,
        )
        == 3
    )


@pytest.mark.parametrize("column", ["from_status", "to_status"])
def test_history_statuses_must_be_known(db_session: Session, column: str) -> None:
    changes: dict[str, Any] = {"from_status": "pendiente_pago", column: "foo"}

    assert reject_history(db_session, **changes) == (CHECK, "order_status_history")


def test_history_actor_kind_must_be_customer_admin_or_system(db_session: Session) -> None:
    assert reject_history(db_session, actor_kind="robot") == (CHECK, "order_status_history")


@pytest.mark.parametrize("to_status", ["pagado", "cancelado", "expirado"])
def test_a_history_without_origin_must_start_at_pending_payment(
    db_session: Session, to_status: str
) -> None:
    assert reject_history(db_session, from_status=None, to_status=to_status) == (
        CHECK,
        "order_status_history",
    )


def test_a_system_actor_has_no_actor_id(db_session: Session) -> None:
    assert reject_history(
        db_session, from_status="pendiente_pago", to_status="expirado", actor_kind="system"
    ) == (CHECK, "order_status_history")


@pytest.mark.parametrize("kind", ["customer", "admin"])
def test_a_person_actor_needs_an_actor_id(db_session: Session, kind: str) -> None:
    assert reject_history(db_session, actor_kind=kind, actor_id=None) == (
        CHECK,
        "order_status_history",
    )


@pytest.mark.parametrize("column", ["order_id", "to_status", "actor_kind"])
def test_explicit_nulls_are_rejected_on_every_required_history_column(
    db_session: Session, column: str
) -> None:
    values = history_values(insert_order_row(db_session), **{column: None})

    assert rejected(db_session, insert_sql("order_status_history", values), values) == (
        NOT_NULL,
        "order_status_history",
    )


def test_a_history_row_needs_an_existing_order(db_session: Session) -> None:
    values = history_values(uuid4())

    assert rejected(db_session, insert_sql("order_status_history", values), values) == (
        FOREIGN_KEY,
        "order_status_history",
    )


# ---------------------------------------------------------------------------------------------
# Catálogo: claves, FK con su acción e índices tal como los pide §6.
def normalized(definition: str) -> str:
    # PostgreSQL cita "position" (palabra reservada) al imprimir la definición.
    cleaned = definition.replace("app.", "").replace("public.", "").replace('"', "")
    return re.sub(r"\s+", " ", cleaned).strip()


def constraint_defs(session: Session, kind: str) -> dict[str, set[str]]:
    """tabla → definiciones (pg_get_constraintdef) de las restricciones del tipo `kind`."""
    found: dict[str, set[str]] = {table: set() for table in TABLES}
    for table, definition in rows(
        session,
        "SELECT c.conrelid::regclass::text, pg_get_constraintdef(c.oid) FROM pg_constraint AS c"
        " WHERE c.contype = :kind AND c.conrelid = ANY(ARRAY["
        "'app.orders'::regclass, 'app.order_lines'::regclass, 'app.deliveries'::regclass,"
        "'app.order_status_history'::regclass])",
        kind=kind,
    ):
        found[table.removeprefix("app.")].add(normalized(definition))
    return found


def test_primary_keys(db_session: Session) -> None:
    assert constraint_defs(db_session, "p") == {
        "orders": {"PRIMARY KEY (id)"},
        "order_lines": {"PRIMARY KEY (id)"},
        "deliveries": {"PRIMARY KEY (order_id)"},
        "order_status_history": {"PRIMARY KEY (id)"},
    }


def test_unique_constraints(db_session: Session) -> None:
    assert constraint_defs(db_session, "u") == {
        "orders": {"UNIQUE (order_number)", "UNIQUE (user_id, idempotency_key)"},
        "order_lines": {"UNIQUE (order_id, product_id)", "UNIQUE (order_id, position)"},
        "deliveries": set(),
        "order_status_history": set(),
    }


def test_foreign_keys_and_their_delete_actions(db_session: Session) -> None:
    # Solo estas FK: promotion_id y actor_id no tienen (datos históricos) y no hay FK de
    # stock_reservations a orders en esta migración (D-040, P-11).
    assert constraint_defs(db_session, "f") == {
        "orders": {
            "FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE RESTRICT",
        },
        "order_lines": {
            "FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE",
            "FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT",
        },
        "deliveries": {"FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE"},
        "order_status_history": {"FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE"},
    }


def test_no_foreign_key_from_stock_reservations_to_orders(db_session: Session) -> None:
    references = scalar(
        db_session,
        "SELECT count(*) FROM pg_constraint WHERE contype = 'f'"
        " AND conrelid = 'app.stock_reservations'::regclass AND confrelid = 'app.orders'::regclass",
    )

    assert references == 0


def test_indexes_of_the_read_paths(db_session: Session) -> None:
    definitions = {
        normalized(definition)
        for (definition,) in rows(
            db_session,
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename IN"
            " ('orders', 'order_lines', 'deliveries', 'order_status_history')",
        )
    }

    def has(*fragments: str) -> bool:
        return any(all(fragment in d for fragment in fragments) for d in definitions)

    assert has("ON orders", "(user_id, created_at DESC, id DESC)")
    assert has("ON orders", "(status, created_at DESC)")
    partial = [d for d in definitions if "ON orders" in d and "(expires_at)" in d]
    assert len(partial) == 1
    assert "WHERE" in partial[0] and "pendiente_pago" in partial[0]
    assert has("ON order_lines", "(product_id)")
    assert has("ON order_status_history", "(order_id, id)")
