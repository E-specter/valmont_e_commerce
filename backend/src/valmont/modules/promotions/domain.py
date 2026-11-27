from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from valmont.shared.text import has_unsafe_chars, has_visible_char

# SPEC promotions R1, R2 y R4. Dominio puro: sin framework ni acceso a datos.
PERCENT_MIN = 1
PERCENT_MAX = 90
AMOUNT_MAX = 2_147_483_647  # céntimos; el límite de un integer de Postgres
PRODUCTS_MAX = 100
NAME_MAX = 120


class PromotionKind(StrEnum):
    PERCENT = "percent"
    FIXED_AMOUNT = "fixed_amount"


class PromotionScope(StrEnum):
    PRODUCTS = "products"
    CATEGORY = "category"
    CATALOG = "catalog"


class PromotionStatus(StrEnum):
    INACTIVE = "inactive"
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    EXPIRED = "expired"


class PromotionError(ValueError):
    """Una regla de la promoción (R1, R2, R4) no se cumple."""


def _has_control_char(text: str) -> bool:
    # Mismo criterio que catalog e identity: Cc rompe un text de PostgreSQL y Cs no es UTF-8.
    return has_unsafe_chars(text)


@dataclass(frozen=True)
class Promotion:
    id: UUID
    name: str
    kind: PromotionKind
    percent_off: int | None
    amount_off: int | None  # céntimos de PEN
    scope: PromotionScope
    category_id: UUID | None
    product_ids: tuple[UUID, ...]
    starts_at: datetime
    ends_at: datetime
    is_active: bool = True

    def __post_init__(self) -> None:
        name = self.name.strip()
        if (
            _has_control_char(self.name)
            or not has_visible_char(name)
            or not 1 <= len(name) <= NAME_MAX
        ):
            raise PromotionError(f"name: de 1 a {NAME_MAX} caracteres, sin caracteres de control")
        object.__setattr__(self, "name", name)  # recortado (frozen)
        self._check_value()
        self._check_dates()
        self._check_scope()

    def _check_value(self) -> None:
        # R1: el valor del tipo elegido es obligatorio y el del otro debe faltar.
        if self.kind == PromotionKind.PERCENT:
            if self.percent_off is None or not PERCENT_MIN <= self.percent_off <= PERCENT_MAX:
                raise PromotionError(f"percent_off: entero de {PERCENT_MIN} a {PERCENT_MAX}")
            if self.amount_off is not None:
                raise PromotionError("amount_off: no corresponde al tipo percent")
        else:
            if self.amount_off is None or not 1 <= self.amount_off <= AMOUNT_MAX:
                raise PromotionError(f"amount_off: entero de 1 a {AMOUNT_MAX} céntimos")
            if self.percent_off is not None:
                raise PromotionError("percent_off: no corresponde al tipo fixed_amount")

    def _check_dates(self) -> None:
        # R2: con zona horaria (UTC) y fin posterior al inicio.
        if self.starts_at.tzinfo is None:
            raise PromotionError("starts_at: requiere zona horaria")
        if self.ends_at.tzinfo is None:
            raise PromotionError("ends_at: requiere zona horaria")
        if self.ends_at <= self.starts_at:
            raise PromotionError("ends_at: debe ser posterior a starts_at")

    def _check_scope(self) -> None:
        # R4: solo lo que corresponde al alcance.
        if self.scope == PromotionScope.PRODUCTS:
            if not 1 <= len(self.product_ids) <= PRODUCTS_MAX:
                raise PromotionError(f"product_ids: de 1 a {PRODUCTS_MAX} productos")
            if len(set(self.product_ids)) != len(self.product_ids):
                raise PromotionError("product_ids: sin repetidos")
            if self.category_id is not None:
                raise PromotionError("category_id: no corresponde al alcance products")
            return
        if self.product_ids:
            raise PromotionError("product_ids: solo con el alcance products")
        if self.scope == PromotionScope.CATEGORY and self.category_id is None:
            raise PromotionError("category_id: obligatorio con el alcance category")
        if self.scope == PromotionScope.CATALOG and self.category_id is not None:
            raise PromotionError("category_id: no corresponde al alcance catalog")

    def status_at(self, now: datetime) -> PromotionStatus:
        # R9: intervalo semiabierto [starts_at, ends_at).
        if not self.is_active:
            return PromotionStatus.INACTIVE
        if now < self.starts_at:
            return PromotionStatus.SCHEDULED
        if now >= self.ends_at:
            return PromotionStatus.EXPIRED
        return PromotionStatus.ACTIVE
