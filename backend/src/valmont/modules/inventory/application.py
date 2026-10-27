from typing import Protocol
from uuid import UUID

from valmont.modules.inventory.domain import (
    Availability,
    InventorySettings,
    StockItem,
    StockMovement,
)

# Puertos de inventory. Los casos de uso llegan en T-042 (reservas) y T-043 (administración).


class StockRepository(Protocol):
    def lock(self, product_id: UUID) -> StockItem | None:
        """Bloquea la fila de stock (FOR UPDATE) hasta el fin de la transacción, creándola con
        on_hand 0 si falta (INVENTORY-R4). None si el producto no existe."""
        ...

    def update(self, item: StockItem) -> None:
        """Guarda on_hand; solo con la fila bloqueada por lock()."""
        ...


class MovementRepository(Protocol):
    def add(self, movement: StockMovement) -> StockMovement:
        """Inserta el movimiento y lo devuelve con id y created_at."""
        ...

    def list_recent(self, product_id: UUID, limit: int) -> list[StockMovement]:
        """Los últimos `limit` movimientos del producto, del más reciente al más antiguo."""
        ...


class SettingsRepository(Protocol):
    def get(self, lock: bool = False) -> InventorySettings:
        """La fila única de ajustes; lock=True la bloquea (FOR UPDATE) para cambiarla."""
        ...

    def update(self, settings: InventorySettings) -> None: ...


class AvailabilityReader(Protocol):
    def get(self, product_id: UUID) -> Availability | None:
        """La fila de app.product_availability; None si el producto no existe."""
        ...
