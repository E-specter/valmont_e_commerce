from dataclasses import asdict
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Identity, Index, Text, func, insert
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.audit.domain import AuditEntry
from valmont.shared.db import Base
from valmont.shared.logs import request_id_var

# none_as_null: un None de Python es NULL de SQL, no el JSON 'null' (que burlaría el CHECK).
_Json = JSONB(none_as_null=True)


class AuditLogRow(Base):
    """app.audit_log (SPEC audit §6). Solo inserción: los triggers de la migración 0003 rechazan
    UPDATE, DELETE y TRUNCATE."""

    __tablename__ = "audit_log"
    __table_args__ = (
        CheckConstraint(r"action ~ '^[a-z]+\.[a-z_]+$'", name="action"),
        CheckConstraint("before IS NOT NULL OR after IS NOT NULL", name="before_or_after"),
        Index("ix_audit_log_entity", "entity_type", "entity_id", "occurred_at"),
        Index("ix_audit_log_occurred_at", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    action: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[UUID | None]
    actor_role: Mapped[str | None] = mapped_column(Text)
    request_id: Mapped[str | None] = mapped_column(Text)
    before: Mapped[dict[str, Any] | None] = mapped_column(_Json)
    after: Mapped[dict[str, Any] | None] = mapped_column(_Json)


class SqlAuditRecorder:
    def __init__(self, session: Session) -> None:
        self._session = session

    def record(self, entry: AuditEntry) -> None:
        # AUDIT-R1: sin commit propio; la fila se confirma o se deshace con la operación auditada.
        request_id = request_id_var.get()  # AUDIT-R4; "-" es el valor fuera de una solicitud
        self._session.execute(
            insert(AuditLogRow).values(
                **asdict(entry), request_id=None if request_id == "-" else request_id
            )
        )
