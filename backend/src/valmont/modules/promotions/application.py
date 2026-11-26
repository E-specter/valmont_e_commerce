from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID

from valmont.modules.promotions.domain import Promotion, PromotionScope, PromotionStatus


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
