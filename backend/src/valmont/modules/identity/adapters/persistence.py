from collections.abc import Mapping
from dataclasses import asdict
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, Text, false, func, select, text, update
from sqlalchemy.dialects.postgresql import JSONB, insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from valmont.modules.identity.domain import Preferences, Profile, Role
from valmont.shared.db import Base


class ProfileRow(Base):
    """app.profiles (SPEC identity §6). Solo la escribe identity."""

    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("role IN ('customer', 'admin')", name="role"),
        CheckConstraint("jsonb_typeof(preferences) = 'object'", name="preferences_object"),
    )

    user_id: Mapped[UUID] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(Text, server_default="customer")
    full_name: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'"))
    privacy_version: Mapped[str | None] = mapped_column(Text)
    privacy_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    marketing_opt_in: Mapped[bool] = mapped_column(server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def _to_domain(row: ProfileRow) -> Profile:
    return Profile(
        user_id=row.user_id,
        role=Role(row.role),
        created_at=row.created_at,
        updated_at=row.updated_at,
        full_name=row.full_name,
        phone=row.phone,
        preferences=Preferences(**row.preferences),  # la lista JSON de materials pasa a tupla
        privacy_version=row.privacy_version,
        privacy_accepted_at=row.privacy_accepted_at,
        marketing_opt_in=row.marketing_opt_in,
    )


class SqlProfileRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add_if_absent(self, user_id: UUID) -> None:
        stmt = insert(ProfileRow).values(user_id=user_id)
        self._session.execute(stmt.on_conflict_do_nothing(index_elements=["user_id"]))

    def get(self, user_id: UUID) -> Profile:
        return _to_domain(
            self._session.scalars(select(ProfileRow).filter_by(user_id=user_id)).one()
        )

    def update(self, user_id: UUID, values: Mapping[str, object]) -> Profile:
        columns = dict(values)
        if isinstance(prefs := columns.get("preferences"), Preferences):
            columns["preferences"] = asdict(prefs)  # en céntimos, tal cual el dominio
        # Una sola sentencia con solo las columnas enviadas: dos PATCH a la vez no se pisan.
        stmt = (
            update(ProfileRow)
            .filter_by(user_id=user_id)
            .values(**columns, updated_at=func.now())
            .returning(ProfileRow)
        )
        return _to_domain(self._session.scalars(stmt).one())
