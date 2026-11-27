"""Ayudas de prueba de la fecha de nacimiento (T-138): repositorio en memoria atómico."""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from tests.identity.identity_helpers import InMemoryProfiles

# 2026-11-27 12:00 en Lima (17:00 UTC). Los cumpleaños de las pruebas se calculan contra este día.
NOW = datetime(2026, 11, 27, 17, 0, tzinfo=UTC)
LIMA_TODAY = date(2026, 11, 27)
VALID_BIRTH = date(1990, 5, 17)
OTHER_BIRTH = date(1991, 1, 1)


class BirthDateProfiles(InMemoryProfiles):
    """InMemoryProfiles + set_birth_date_if_unset; anota las llamadas para las pruebas de orden."""

    def __init__(self) -> None:
        super().__init__()
        self.set_calls: list[UUID] = []

    def set_birth_date_if_unset(self, user_id: UUID, birth_date: date) -> bool:
        self.set_calls.append(user_id)
        if self.rows[user_id].birth_date is not None:
            return False
        self.rows[user_id] = replace(self.rows[user_id], birth_date=birth_date)
        return True

    def with_birth_date(self, user_id: UUID, birth_date: date | None) -> None:
        self.add_if_absent(user_id)
        self.rows[user_id] = replace(self.rows[user_id], birth_date=birth_date)


def lima_today_from_wall_clock() -> date:
    """Hoy en Lima según el reloj real, para las pruebas HTTP que no pueden fijar el reloj."""
    return (datetime.now(UTC) - timedelta(hours=5)).date()
