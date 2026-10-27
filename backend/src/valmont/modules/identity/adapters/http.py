from datetime import UTC, datetime
from typing import Annotated, Self
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, ConfigDict, StrictBool, model_validator

from valmont.modules.identity.adapters.persistence import SqlProfileRepository
from valmont.modules.identity.application import (
    EnsureProfile,
    ProfileChanges,
    ProfileRepository,
    UpdateProfile,
)
from valmont.modules.identity.domain import (
    CurrentUser,
    Preferences,
    Profile,
    Role,
    normalize_full_name,
    normalize_phone,
    normalize_privacy_version,
)
from valmont.shared.auth import unauthenticated, verify_token
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError
from valmont.shared.money import Money

# --- Dependencias de autenticación (las usan todos los routers: modules.md §3) ---

_bearer = HTTPBearer(auto_error=False)


def get_profile_repository(session: SessionDep) -> ProfileRepository:
    return SqlProfileRepository(session)


RepositoryDep = Annotated[ProfileRepository, Depends(get_profile_repository)]


def current_profile(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    repo: RepositoryDep,
) -> Profile:
    if credentials is None:  # sin cabecera o sin esquema Bearer
        raise unauthenticated()
    return EnsureProfile(repo)(verify_token(credentials.credentials).user_id)


def current_user(profile: Annotated[Profile, Depends(current_profile)]) -> CurrentUser:
    return CurrentUser(profile.user_id, profile.role)


def require_admin(user: Annotated[CurrentUser, Depends(current_user)]) -> CurrentUser:
    if user.role is not Role.ADMIN:
        raise AppError("forbidden", "No tienes permiso para esta operación.", 403)
    return user


# --- Esquemas ---

# Los límites de texto, la ausencia de caracteres de control y los importes los valida el dominio
# (ProfileError es un ValueError: Pydantic lo convierte en 422 con el formato común).
UtcDatetime = Annotated[datetime, AfterValidator(lambda value: value.astimezone(UTC))]


def _cents(money: Money | None) -> int | None:
    return None if money is None else money.amount


def _money(cents: int | None) -> Money | None:
    return None if cents is None else Money(amount=cents)


class PreferencesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    style: str | None = None
    budget_min: Money | None = None
    budget_max: Money | None = None
    materials: list[str] = []

    @model_validator(mode="after")
    def _check_invariants(self) -> Self:
        self.to_domain()
        return self

    def to_domain(self) -> Preferences:
        return Preferences(
            self.style, _cents(self.budget_min), _cents(self.budget_max), tuple(self.materials)
        )


class ProfileUpdateIn(BaseModel):
    # extra="forbid": un role o user_id en el cuerpo → 422 (IDENTITY-R1).
    model_config = ConfigDict(extra="forbid")

    full_name: Annotated[str, AfterValidator(normalize_full_name)] | None = None
    phone: Annotated[str, AfterValidator(normalize_phone)] | None = None
    # Omitibles pero no nulos: Pydantic no valida el default, así que un null explícito → 422.
    preferences: PreferencesIn = None
    marketing_opt_in: StrictBool = None  # "yes" o "true" → 422
    accept_privacy_version: Annotated[str, AfterValidator(normalize_privacy_version)] = None

    def to_changes(self) -> ProfileChanges:
        changes = {name: getattr(self, name) for name in self.model_fields_set}
        if "preferences" in changes:
            changes["preferences"] = self.preferences.to_domain()
        return ProfileChanges(**changes)


class PreferencesOut(BaseModel):
    style: str | None
    budget_min: Money | None
    budget_max: Money | None
    materials: list[str]


class ProfileOut(BaseModel):
    user_id: UUID
    role: Role
    full_name: str | None
    phone: str | None
    preferences: PreferencesOut
    privacy_version: str | None
    privacy_accepted_at: UtcDatetime | None
    marketing_opt_in: bool
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_domain(cls, profile: Profile) -> Self:
        prefs = profile.preferences
        return cls(
            user_id=profile.user_id,
            role=profile.role,
            full_name=profile.full_name,
            phone=profile.phone,
            preferences=PreferencesOut(
                style=prefs.style,
                budget_min=_money(prefs.budget_min),
                budget_max=_money(prefs.budget_max),
                materials=list(prefs.materials),
            ),
            privacy_version=profile.privacy_version,
            privacy_accepted_at=profile.privacy_accepted_at,
            marketing_opt_in=profile.marketing_opt_in,
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )


# --- Rutas ---

router = APIRouter(prefix="/api/v1/identity", tags=["identity"])
_AUTH_ERRORS = {status: ERROR_RESPONSES[status] for status in (401, 503)}


@router.get("/me", responses=_AUTH_ERRORS)
def get_me(profile: Annotated[Profile, Depends(current_profile)]) -> ProfileOut:
    return ProfileOut.from_domain(profile)


@router.patch("/me", responses=_AUTH_ERRORS | {422: ERROR_RESPONSES[422]})
def update_me(
    body: ProfileUpdateIn,
    user: Annotated[CurrentUser, Depends(current_user)],
    repo: RepositoryDep,
) -> ProfileOut:
    return ProfileOut.from_domain(UpdateProfile(repo)(user.user_id, body.to_changes()))
