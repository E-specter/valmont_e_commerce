import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from uuid import UUID

FULL_NAME_MAX = 120
SHORT_TEXT_MAX = 40  # style y cada material
MATERIALS_MAX = 10
PRIVACY_VERSION_MAX = 20

_PHONE = re.compile(r"\+?[0-9]{6,15}")


class ProfileError(ValueError):
    """Dato de perfil no válido. Hereda de ValueError: Pydantic lo convierte en un 422."""


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
    if any(unicodedata.category(char) in ("Cc", "Cs") for char in value):
        raise ProfileError("El texto contiene caracteres de control no permitidos.")


def clean_text(value: str, max_length: int, *, collapse_spaces: bool = False) -> str:
    """Valida y recorta un texto de entrada: 1..max_length caracteres, sin control ni sustitutos."""
    _reject_control_chars(value)
    text = " ".join(value.split()) if collapse_spaces else value.strip()
    if not 1 <= len(text) <= max_length:
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
