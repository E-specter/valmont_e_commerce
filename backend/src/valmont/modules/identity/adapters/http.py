from datetime import UTC, date, datetime
from typing import Annotated, Self
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, model_validator

from valmont.modules.identity.adapters.persistence import SqlProfileRepository
from valmont.modules.identity.application import (
    EnsureProfile,
    ProfileChanges,
    ProfileRepository,
    UpdateProfile,
)
from valmont.modules.identity.domain import (
    FULL_NAME_MAX,
    MATERIALS_MAX,
    PRIVACY_VERSION_MAX,
    SHORT_TEXT_MAX,
    BirthDateInvalid,
    BirthDateLocked,
    CurrentUser,
    Preferences,
    Profile,
    Role,
    normalize_full_name,
    normalize_phone,
    normalize_privacy_version,
    parse_birth_date,
)
from valmont.shared.auth import unauthenticated, verify_token
from valmont.shared.db import SessionDep
from valmont.shared.errors import ERROR_RESPONSES, AppError, ErrorOut
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

    style: Annotated[str, Field(json_schema_extra={"maxLength": SHORT_TEXT_MAX})] | None = None
    budget_min: Money | None = None
    budget_max: Money | None = None
    materials: Annotated[
        list[Annotated[str, Field(json_schema_extra={"maxLength": SHORT_TEXT_MAX})]],
        Field(json_schema_extra={"maxItems": MATERIALS_MAX}),
    ] = []

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

    # Topes solo declarados (T-018e): se validan tras normalizar. phone: `+` y 15 dígitos.
    full_name: (
        Annotated[
            str,
            Field(json_schema_extra={"maxLength": FULL_NAME_MAX}),
            AfterValidator(normalize_full_name),
        ]
        | None
    ) = None
    phone: (
        Annotated[str, Field(json_schema_extra={"maxLength": 16}), AfterValidator(normalize_phone)]
        | None
    ) = None
    # Omitibles pero no nulos: Pydantic no valida el default, así que un null explícito → 422.
    preferences: PreferencesIn = None
    marketing_opt_in: StrictBool = None  # "yes" o "true" → 422
    accept_privacy_version: Annotated[
        str,
        Field(json_schema_extra={"maxLength": PRIVACY_VERSION_MAX}),
        AfterValidator(normalize_privacy_version),
    ] = None
    birth_date: Annotated[
        str, Field(json_schema_extra={"maxLength": 10}), AfterValidator(parse_birth_date)
    ] = None  # AAAA-MM-DD; null → 422

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
    birth_date: date | None
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
            birth_date=profile.birth_date,
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )


# --- Rutas ---

router = APIRouter(prefix="/api/v1/identity", tags=["identity"])
_AUTH_ERRORS = {status: ERROR_RESPONSES[status] for status in (401, 503)}


# El msg no repite el valor: es un dato personal.
_BIRTH_DATE_MSG = {
    "future": "La fecha de nacimiento no puede ser futura.",
    "too_old": "La fecha de nacimiento no es válida.",
    "underage": "Debes ser mayor de edad para registrar tu fecha de nacimiento.",
}
_LOCKED = {
    409: {"model": ErrorOut, "description": "`birth_date_locked`: la fecha ya está registrada."}
}


@router.get("/me", responses=_AUTH_ERRORS)
def get_me(profile: Annotated[Profile, Depends(current_profile)], response: Response) -> ProfileOut:
    response.headers["Cache-Control"] = "no-store"  # contiene un dato personal
    return ProfileOut.from_domain(profile)


@router.patch("/me", responses=_AUTH_ERRORS | {422: ERROR_RESPONSES[422]} | _LOCKED)
def update_me(
    body: ProfileUpdateIn,
    user: Annotated[CurrentUser, Depends(current_user)],
    repo: RepositoryDep,
    response: Response,
) -> ProfileOut:
    response.headers["Cache-Control"] = "no-store"
    try:
        profile = UpdateProfile(repo)(user.user_id, body.to_changes())
    except BirthDateInvalid as exc:
        raise AppError(
            "validation_error",
            "Datos de entrada no válidos.",
            422,
            [
                {
                    "loc": ["body", "birth_date"],
                    "type": f"birth_date_{exc.reason}",
                    "msg": _BIRTH_DATE_MSG[exc.reason],
                }
            ],
        ) from None
    except BirthDateLocked:
        raise AppError(
            "birth_date_locked",
            "La fecha de nacimiento ya está registrada y no se puede cambiar.",
            409,
        ) from None
    return ProfileOut.from_domain(profile)
