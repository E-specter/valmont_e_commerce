from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime
from typing import Protocol, TypedDict
from uuid import UUID

from valmont.modules.identity.domain import (
    BirthDateInvalid,
    BirthDateLocked,
    BirthDateRequired,
    BirthDateUnderage,
    Preferences,
    Profile,
    Underage,
    check_birth_date_range,
    is_adult,
    lima_today,
    normalize_full_name,
    normalize_phone,
    normalize_privacy_version,
)

# Reexportación para orders (modules.md §3): las excepciones salen de aquí.
__all__ = [
    "BirthDateInvalid",
    "BirthDateLocked",
    "BirthDateRequired",
    "EnsureAdult",
    "EnsureProfile",
    "ProfileChanges",
    "ProfileRepository",
    "Underage",
    "UpdateProfile",
]


class ProfileRepository(Protocol):
    def add_if_absent(self, user_id: UUID) -> None: ...

    def get(self, user_id: UUID) -> Profile: ...

    def update(self, user_id: UUID, values: Mapping[str, object]) -> Profile: ...

    def set_birth_date_if_unset(self, user_id: UUID, birth_date: date) -> bool:
        """True si escribió (la columna era NULL); False si ya había un valor. Atómico."""
        ...


class ProfileChanges(TypedDict, total=False):
    """Solo las claves presentes se cambian. None en full_name o phone los borra."""

    full_name: str | None
    phone: str | None
    preferences: Preferences
    marketing_opt_in: bool
    accept_privacy_version: str
    birth_date: date


class EnsureProfile:
    def __init__(self, repo: ProfileRepository) -> None:
        self._repo = repo

    def __call__(self, user_id: UUID) -> Profile:
        # IDENTITY-R5: decide la BD (ON CONFLICT), nunca "¿existe?" y luego "inserta".
        self._repo.add_if_absent(user_id)
        return self._repo.get(user_id)


class UpdateProfile:
    def __init__(
        self, repo: ProfileRepository, clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    ) -> None:
        self._repo = repo
        self._clock = clock

    def __call__(self, user_id: UUID, changes: ProfileChanges) -> Profile:
        # Se normaliza aquí también, no solo en HTTP: vale para cualquier llamador (idempotente).
        values: dict[str, object] = dict(changes)
        if "birth_date" in values:
            # IDENTITY-R7/R10: se fija una sola vez; decide la BD (UPDATE … WHERE IS NULL).
            birth_date = values.pop("birth_date")
            today = lima_today(self._clock())
            check_birth_date_range(birth_date, today)
            if not is_adult(birth_date, today):  # IDENTITY-R7b: antes de escribir nada
                raise BirthDateUnderage
            if (
                not self._repo.set_birth_date_if_unset(user_id, birth_date)
                and self._repo.get(user_id).birth_date != birth_date
            ):
                raise BirthDateLocked
            if not values:
                return self._repo.get(user_id)
        for name, normalize in (("full_name", normalize_full_name), ("phone", normalize_phone)):
            if values.get(name) is not None:
                values[name] = normalize(values[name])
        if "accept_privacy_version" in values:
            # IDENTITY-R3: la fecha la pone el servidor; el cliente solo envía la versión.
            version = normalize_privacy_version(values.pop("accept_privacy_version"))
            values["privacy_version"] = version
            values["privacy_accepted_at"] = self._clock()
        return self._repo.update(user_id, values)


class EnsureAdult:
    def __init__(self, repo: ProfileRepository) -> None:
        self._repo = repo

    def __call__(self, user_id: UUID, now: datetime) -> None:
        birth_date = self._repo.get(user_id).birth_date
        if birth_date is None:
            raise BirthDateRequired
        if not is_adult(birth_date, lima_today(now)):
            raise Underage
