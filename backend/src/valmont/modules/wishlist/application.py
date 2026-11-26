from dataclasses import dataclass
from datetime import datetime
from typing import Protocol
from uuid import UUID


@dataclass(frozen=True)
class WishlistEntry:
    product_id: UUID
    added_at: datetime


class WishlistRepository(Protocol):
    def list_for_user(self, user_id: UUID) -> tuple[WishlistEntry, ...]:
        """Más reciente primero y `product_id` (R8); sin bloqueo."""
        ...

    def add(self, user_id: UUID, product_id: UUID, now: datetime) -> bool:
        """True si insertó, False si ya estaba; InvalidReference si el producto no existe."""
        ...

    def remove(self, user_id: UUID, product_id: UUID) -> bool:
        """True si borró una fila, False si no había."""
        ...
