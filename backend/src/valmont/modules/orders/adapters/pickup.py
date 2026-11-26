from valmont.modules.orders.application import PickupStore
from valmont.shared.config import Settings


class SettingsPickupStore:
    """Boutique de `Settings` (H-1): un dato vacío o en blanco cuenta como ausente."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def get(self) -> PickupStore | None:
        s = self._settings
        values = [
            (v or "").strip()
            for v in (s.pickup_store_name, s.pickup_store_address, s.pickup_store_hours)
        ]
        return PickupStore(*values) if all(values) else None
