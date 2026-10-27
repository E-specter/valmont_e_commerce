from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Protocol, TypedDict
from uuid import UUID

from valmont.modules.identity.domain import (
    Preferences,
    Profile,
    normalize_full_name,
    normalize_phone,
    normalize_privacy_version,
)


class ProfileRepository(Protocol):
    def add_if_absent(self, user_id: UUID) -> None: ...

    def get(self, user_id: UUID) -> Profile: ...

    def update(self, user_id: UUID, values: Mapping[str, object]) -> Profile: ...


class ProfileChanges(TypedDict, total=False):
    """Solo las claves presentes se cambian. None en full_name o phone los borra."""

    full_name: str | None
    phone: str | None
    preferences: Preferences
    marketing_opt_in: bool
    accept_privacy_version: str


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
        for name, normalize in (("full_name", normalize_full_name), ("phone", normalize_phone)):
            if values.get(name) is not None:
                values[name] = normalize(values[name])
        if "accept_privacy_version" in values:
            # IDENTITY-R3: la fecha la pone el servidor; el cliente solo envía la versión.
            version = normalize_privacy_version(values.pop("accept_privacy_version"))
            values["privacy_version"] = version
            values["privacy_accepted_at"] = self._clock()
        return self._repo.update(user_id, values)
