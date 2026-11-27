"""Persistencia de payments: `app.payment_attempts`, tabla de solo inserción (SPEC payments §6).

Solo la escribe payments; app.orders y app.profiles se referencian con FK (modules.md §3, E-P2).
`card_last4` nunca se registra en logs ni en mensajes de error (RF05.04).
"""

from dataclasses import replace
from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    func,
    select,
    text,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.payments.domain import (
    AttemptStatus,
    FailureCode,
    OrderAlreadyPaid,
    PaymentAttempt,
)
from valmont.shared.db import Base

_ORDER_APPROVED_UNIQUE = "uq_payment_attempts_order_approved"


class PaymentAttemptRow(Base):
    __tablename__ = "payment_attempts"
    __table_args__ = (
        CheckConstraint("char_length(idempotency_key) BETWEEN 16 AND 64", name="idempotency_key"),
        CheckConstraint("status IN ('approved','rejected')", name="status"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("failure_code ~ '^[a-z_]{1,40}$'", name="failure_code_format"),
        CheckConstraint("card_last4 ~ '^[0-9]{4}$'", name="card_last4_format"),
        CheckConstraint("char_length(gateway) BETWEEN 1 AND 30", name="gateway_length"),
        CheckConstraint("(status = 'rejected') = (failure_code IS NOT NULL)", name="failure_pair"),
        UniqueConstraint(
            "user_id", "idempotency_key", name="uq_payment_attempts_user_id_idempotency_key"
        ),
        Index(
            _ORDER_APPROVED_UNIQUE,
            "order_id",
            unique=True,
            postgresql_where=text("status = 'approved'"),
        ),
        Index(
            "ix_payment_attempts_order_id_created_at",
            "order_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    order_id: Mapped[UUID] = mapped_column(ForeignKey("app.orders.id", ondelete="RESTRICT"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("app.profiles.user_id", ondelete="RESTRICT"))
    idempotency_key: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    amount: Mapped[int] = mapped_column(BigInteger)
    failure_code: Mapped[str | None] = mapped_column(Text)
    card_last4: Mapped[str] = mapped_column(Text)
    gateway: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def _to_domain(row: PaymentAttemptRow) -> PaymentAttempt:
    return PaymentAttempt(
        id=row.id,
        order_id=row.order_id,
        user_id=row.user_id,
        idempotency_key=row.idempotency_key,
        status=AttemptStatus(row.status),
        amount=row.amount,
        failure_code=FailureCode(row.failure_code) if row.failure_code else None,
        card_last4=row.card_last4,
        gateway=row.gateway,
        created_at=row.created_at,
    )


class SqlPaymentAttemptRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, attempt: PaymentAttempt) -> PaymentAttempt | None:
        stmt = (
            pg_insert(PaymentAttemptRow)
            .values(
                id=attempt.id,
                order_id=attempt.order_id,
                user_id=attempt.user_id,
                idempotency_key=attempt.idempotency_key,
                status=attempt.status.value,
                amount=attempt.amount,
                failure_code=attempt.failure_code.value if attempt.failure_code else None,
                card_last4=attempt.card_last4,
                gateway=attempt.gateway,
            )
            .on_conflict_do_nothing(index_elements=["user_id", "idempotency_key"])
            .returning(PaymentAttemptRow.created_at)
        )
        try:
            created_at = self._session.execute(stmt).scalar_one_or_none()
        except IntegrityError as exc:
            if _ORDER_APPROVED_UNIQUE in str(exc.orig):
                raise OrderAlreadyPaid() from exc
            raise
        return None if created_at is None else replace(attempt, created_at=created_at)

    def find_by_key(self, user_id: UUID, key: str) -> PaymentAttempt | None:
        row = self._session.scalars(
            select(PaymentAttemptRow).where(
                PaymentAttemptRow.user_id == user_id, PaymentAttemptRow.idempotency_key == key
            )
        ).one_or_none()
        return None if row is None else _to_domain(row)

    def list_for_order(self, user_id: UUID, order_id: UUID) -> tuple[PaymentAttempt, ...]:
        rows = self._session.scalars(
            select(PaymentAttemptRow)
            .where(PaymentAttemptRow.user_id == user_id, PaymentAttemptRow.order_id == order_id)
            .order_by(PaymentAttemptRow.created_at.desc(), PaymentAttemptRow.id.desc())
        )
        return tuple(_to_domain(row) for row in rows)

    def count_rejected(self, user_id: UUID, order_id: UUID) -> int:
        count = self._session.scalar(
            select(func.count())
            .select_from(PaymentAttemptRow)
            .where(
                PaymentAttemptRow.user_id == user_id,
                PaymentAttemptRow.order_id == order_id,
                PaymentAttemptRow.status == AttemptStatus.REJECTED.value,
                PaymentAttemptRow.failure_code != FailureCode.ORDER_EXPIRED.value,
            )
        )
        return count or 0
