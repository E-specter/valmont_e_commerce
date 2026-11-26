from typing import Protocol
from uuid import UUID

from valmont.modules.cart.domain import Cart


class CartRepository(Protocol):
    def lock_for_user(self, user_id: UUID) -> Cart:
        """Crea el carrito si falta (R1), lo bloquea FOR UPDATE y lo devuelve con artículos."""
        ...

    def find_for_user(self, user_id: UUID) -> Cart | None:
        """Lectura sin bloqueo ni escritura."""
        ...

    def save(self, cart: Cart) -> None:
        """Persiste el estado del carrito; solo con la fila bloqueada."""
        ...
