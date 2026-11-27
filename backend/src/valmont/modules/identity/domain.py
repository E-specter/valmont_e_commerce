import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum
from typing import Final, Literal
from uuid import UUID

from valmont.shared.text import has_unsafe_chars, has_visible_char

FULL_NAME_MAX = 120
SHORT_TEXT_MAX = 40  # style y cada material
MATERIALS_MAX = 10
PRIVACY_VERSION_MAX = 20
MAJORITY_AGE: Final = 18
MAX_AGE_YEARS: Final = 120
MIN_BIRTH_DATE: Final = date(1900, 1, 1)

_PHONE = re.compile(r"\+?[0-9]{6,15}")
_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_LIMA_OFFSET = timedelta(hours=5)  # UTC-5 fijo, sin horario de verano


class ProfileError(ValueError):
    """Dato de perfil no válido. Hereda de ValueError: Pydantic lo convierte en un 422."""


class BirthDateInvalid(ProfileError):
    """Fecha fuera de rango. No lleva el valor: es un dato personal (D-041 P-8)."""

    def __init__(self, reason: Literal["future", "too_old"]) -> None:
        super().__init__("La fecha de nacimiento no es válida.")
        self.reason = reason


class BirthDateUnderage(BirthDateInvalid):
    """IDENTITY-R7b: menos de MAJORITY_AGE años cumplidos en Lima. Aditiva."""

    def __init__(self) -> None:
        super().__init__("too_old")
        self.reason = "underage"  # type: ignore[assignment]


class BirthDateLocked(Exception):
    """La fecha ya está fijada y no se puede cambiar (IDENTITY-R10)."""


class AgeRequirementError(Exception):
    """No se cumple la mayoría de edad. Sin fecha ni edad en el mensaje ni en los atributos."""


class BirthDateRequired(AgeRequirementError):
    pass


class Underage(AgeRequirementError):
    pass


class Role(StrEnum):
    CUSTOMER = "customer"
    ADMIN = "admin"


@dataclass(frozen=True)
class CurrentUser:
    user_id: UUID
    role: Role


def _reject_control_chars(value: str) -> None:
    # Cc: \x00 rompe un text de PostgreSQL. Cs: un sustituto suelto no se codifica en UTF-8.
    # Se comprueba antes de recortar: si no, un \t o \n en los extremos pasaría desapercibido.
    if has_unsafe_chars(value):
        raise ProfileError("El texto contiene caracteres de control no permitidos.")


def clean_text(value: str, max_length: int, *, collapse_spaces: bool = False) -> str:
    """Valida y recorta un texto de entrada: 1..max_length caracteres, sin control ni sustitutos."""
    _reject_control_chars(value)
    text = " ".join(value.split()) if collapse_spaces else value.strip()
    if not has_visible_char(text) or not 1 <= len(text) <= max_length:
        raise ProfileError(f"El texto debe tener entre 1 y {max_length} caracteres.")
    return text


def normalize_full_name(value: str) -> str:
    return clean_text(value, FULL_NAME_MAX, collapse_spaces=True)


def normalize_phone(value: str) -> str:
    _reject_control_chars(value)
    phone = "".join(value.split())
    if not _PHONE.fullmatch(phone):
        raise ProfileError("El teléfono debe tener de 6 a 15 dígitos, con + opcional.")
    return phone


def normalize_privacy_version(value: str) -> str:
    return clean_text(value, PRIVACY_VERSION_MAX)


@dataclass(frozen=True)
class Preferences:
    style: str | None = None
    budget_min: int | None = None  # céntimos PEN
    budget_max: int | None = None
    materials: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # frozen: la normalización se asigna con object.__setattr__.
        if self.style is not None:
            object.__setattr__(self, "style", clean_text(self.style, SHORT_TEXT_MAX))
        if len(self.materials) > MATERIALS_MAX:
            raise ProfileError(f"Como máximo {MATERIALS_MAX} materiales.")
        materials = tuple(clean_text(item, SHORT_TEXT_MAX) for item in self.materials)
        object.__setattr__(self, "materials", materials)
        low, high = self.budget_min, self.budget_max
        if (low is not None and low < 0) or (high is not None and high < 0):
            raise ProfileError("Los importes no pueden ser negativos.")
        if low is not None and high is not None and low > high:
            raise ProfileError("budget_min no puede ser mayor que budget_max.")


@dataclass(frozen=True)
class Profile:
    user_id: UUID
    role: Role
    created_at: datetime
    updated_at: datetime
    full_name: str | None = None
    phone: str | None = None
    preferences: Preferences = field(default_factory=Preferences)
    privacy_version: str | None = None
    privacy_accepted_at: datetime | None = None
    marketing_opt_in: bool = False
    birth_date: date | None = None


def lima_today(now: datetime) -> date:
    if now.tzinfo is None:
        raise ValueError("now debe tener zona horaria.")
    return (now.astimezone(UTC) - _LIMA_OFFSET).date()


def parse_birth_date(value: str) -> date:
    # Regex estricta: fromisoformat aceptaría formas que el contrato no admite.
    if not _ISO_DATE.fullmatch(value):
        raise ProfileError("La fecha debe tener el formato AAAA-MM-DD.")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ProfileError("La fecha debe tener el formato AAAA-MM-DD.") from None


def age_on(birth_date: date, today: date) -> int:
    # Comparar (mes, día): el 29-feb cumple el 1-mar en los años no bisiestos.
    birthday_pending = (today.month, today.day) < (birth_date.month, birth_date.day)
    return today.year - birth_date.year - birthday_pending


def check_birth_date_range(birth_date: date, today: date) -> None:
    if birth_date > today:
        raise BirthDateInvalid("future")
    if birth_date < MIN_BIRTH_DATE or age_on(birth_date, today) > MAX_AGE_YEARS:
        raise BirthDateInvalid("too_old")


def is_adult(birth_date: date, today: date) -> bool:
    return age_on(birth_date, today) >= MAJORITY_AGE
