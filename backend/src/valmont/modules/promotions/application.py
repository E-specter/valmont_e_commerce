from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Protocol
from uuid import UUID, uuid4

# AuditEntry forma parte de la firma del puerto público de audit (modules.md §3, excepción 2).
from valmont.modules.audit.application import AuditEntry, AuditRecorder
from valmont.modules.promotions.domain import (
    Promotion,
    PromotionError,
    PromotionKind,
    PromotionScope,
    PromotionStatus,
)


@dataclass(frozen=True)
class EffectivePrice:
    """Lo que ven cart y orders (SPEC §8); importes en céntimos de PEN con IGV incluido."""

    product_id: UUID
    list_price: int
    price: int  # precio vigente (R6), >= 1
    discount_amount: int  # 0 sin promoción aplicada
    promotion_id: UUID | None


class EffectivePriceReader(Protocol):
    def get_many(self, product_ids: Collection[UUID]) -> list[EffectivePrice]:
        """Una fila por producto existente, leída de la vista de precios vigentes."""
        ...


class PromotionRepository(Protocol):
    def add(self, promotion: Promotion) -> None: ...

    def get(self, promotion_id: UUID) -> Promotion | None: ...

    def lock(self, promotion_id: UUID) -> Promotion | None:
        """Bloquea la fila (FOR UPDATE) hasta el fin de la transacción (R12)."""
        ...

    def update(self, promotion: Promotion) -> None:
        """Reemplaza los campos y los product_ids; con otro alcance borra antes las filas."""
        ...

    def list(
        self,
        status: PromotionStatus | None,
        scope: PromotionScope | None,
        now: datetime,
        page: int,
        page_size: int,
    ) -> tuple[list[Promotion], int]: ...


class GetEffectivePrices:
    """UC-PROMOTIONS-06: corre en la transacción de quien lo llama (cart y orders)."""

    def __init__(self, reader: EffectivePriceReader) -> None:
        self._reader = reader

    def __call__(self, product_ids: Collection[UUID]) -> dict[UUID, EffectivePrice]:
        unique = set(product_ids)
        if not unique:
            return {}
        return {price.product_id: price for price in self._reader.get_many(unique)}


# --- Administración (UC-PROMOTIONS-01 a 04) ---


class PromotionNotFound(Exception):
    """La promoción no existe (404)."""


@dataclass(frozen=True)
class Actor:
    """Quién hace la operación: sale del token, nunca del cuerpo. Nulo = sistema (AUDIT-R5)."""

    user_id: UUID | None
    role: str | None


Clock = Callable[[], datetime]


def _now() -> datetime:
    return datetime.now(UTC)


def _snapshot(promotion: Promotion) -> dict[str, Any]:
    """Los campos auditados de R13, en tipos JSON; product_ids ordenado (no importa el orden)."""
    return {
        "name": promotion.name,
        "kind": promotion.kind.value,
        "percent_off": promotion.percent_off,
        "amount_off_cents": promotion.amount_off,
        "scope": promotion.scope.value,
        "category_id": None if promotion.category_id is None else str(promotion.category_id),
        "product_ids": sorted(str(product_id) for product_id in promotion.product_ids),
        "starts_at": promotion.starts_at.astimezone(UTC).isoformat(),
        "ends_at": promotion.ends_at.astimezone(UTC).isoformat(),
    }


def _entry(action: str, promotion: Promotion, actor: Actor, **change: Any) -> AuditEntry:
    entity_id = str(promotion.id)
    return AuditEntry(action, "promotion", entity_id, actor.user_id, actor.role, **change)


def _lock(promotions: PromotionRepository, promotion_id: UUID) -> Promotion:
    if (promotion := promotions.lock(promotion_id)) is None:
        raise PromotionNotFound
    return promotion


class CreatePromotion:
    def __init__(
        self, promotions: PromotionRepository, audit: AuditRecorder, clock: Clock = _now
    ) -> None:
        self._promotions = promotions
        self._audit = audit
        self._clock = clock

    def __call__(self, fields: Mapping[str, object], actor: Actor) -> Promotion:
        values = dict(fields)
        values["product_ids"] = tuple(values.get("product_ids") or ())  # type: ignore[call-overload]
        values["kind"] = PromotionKind(values["kind"])  # type: ignore[call-overload]
        values["scope"] = PromotionScope(values["scope"])  # type: ignore[call-overload]
        promotion = Promotion(id=uuid4(), **values)  # type: ignore[arg-type]
        if promotion.ends_at <= self._clock():  # R10: no se crean promociones ya vencidas
            raise PromotionError("ends_at: debe ser posterior a la fecha actual")
        self._promotions.add(promotion)
        after = _snapshot(promotion)
        self._audit.record(_entry("promotions.promotion_created", promotion, actor, after=after))
        return promotion


class UpdatePromotion:
    def __init__(
        self, promotions: PromotionRepository, audit: AuditRecorder, clock: Clock = _now
    ) -> None:
        self._promotions = promotions
        self._audit = audit

    def __call__(
        self, promotion_id: UUID, changes: Mapping[str, object], actor: Actor
    ) -> Promotion:
        current = _lock(self._promotions, promotion_id)  # R12: dos PATCH a la vez no se mezclan
        merged: dict[str, Any] = dict(changes)
        for name, enum in (("kind", PromotionKind), ("scope", PromotionScope)):
            if name in merged:
                merged[name] = enum(merged[name])
        # R14: al cambiar el tipo o el alcance se descarta lo anterior; lo nuevo va en la solicitud.
        if "kind" in merged and merged["kind"] != current.kind:
            merged = {"percent_off": None, "amount_off": None} | merged
        if "scope" in merged and merged["scope"] != current.scope:
            merged = {"category_id": None, "product_ids": ()} | merged
        if "product_ids" in merged:
            merged["product_ids"] = tuple(merged["product_ids"] or ())
        updated = replace(current, **merged)  # valida el resultado entero (R1, R2, R4)
        before, after = _snapshot(current), _snapshot(updated)
        changed = [name for name in after if after[name] != before[name]]
        if changed:
            self._promotions.update(updated)
            entry = _entry(
                "promotions.promotion_updated",
                updated,
                actor,
                before={name: before[name] for name in changed},
                after={name: after[name] for name in changed},
            )
            self._audit.record(entry)
        return updated


class _SetActive:
    action = ""
    target = True

    def __init__(
        self, promotions: PromotionRepository, audit: AuditRecorder, clock: Clock = _now
    ) -> None:
        self._promotions = promotions
        self._audit = audit

    def __call__(self, promotion_id: UUID, actor: Actor) -> Promotion:
        current = _lock(self._promotions, promotion_id)
        if current.is_active == self.target:  # repetido: sin cambios ni auditoría
            return current
        updated = replace(current, is_active=self.target)
        self._promotions.update(updated)
        change = {"before": {"is_active": current.is_active}, "after": {"is_active": self.target}}
        self._audit.record(_entry(self.action, updated, actor, **change))
        return updated


class ActivatePromotion(_SetActive):
    action = "promotions.promotion_activated"
    target = True


class DeactivatePromotion(_SetActive):
    action = "promotions.promotion_deactivated"
    target = False


class GetPromotion:
    def __init__(self, promotions: PromotionRepository) -> None:
        self._promotions = promotions

    def __call__(self, promotion_id: UUID) -> Promotion:
        if (promotion := self._promotions.get(promotion_id)) is None:
            raise PromotionNotFound
        return promotion


class ListPromotions:
    def __init__(self, promotions: PromotionRepository, clock: Clock = _now) -> None:
        self._promotions = promotions
        self._clock = clock

    def __call__(
        self,
        status: PromotionStatus | None,
        scope: PromotionScope | None,
        page: int,
        page_size: int,
    ) -> tuple[list[Promotion], int]:
        return self._promotions.list(status, scope, self._clock(), page, page_size)
