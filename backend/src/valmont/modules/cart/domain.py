from dataclasses import dataclass, replace
from datetime import datetime
from uuid import UUID

# CART-R3 (H-1, H-2): límites del dominio; la BD solo protege lo invariable.
CART_ITEM_MAX_QUANTITY = 5
CART_MAX_LINES = 20


class CartError(Exception):
    """Regla del carrito violada."""


class QuantityLimit(CartError):
    """La cantidad queda fuera de 1..CART_ITEM_MAX_QUANTITY."""


class CartFull(CartError):
    """El carrito ya tiene CART_MAX_LINES artículos distintos."""


class ItemNotInCart(CartError):
    """El producto no está en el carrito."""


@dataclass(frozen=True)
class CartItem:
    product_id: UUID
    quantity: int
    selected: bool
    created_at: datetime


@dataclass(frozen=True)
class Cart:
    id: UUID
    user_id: UUID
    items: tuple[CartItem, ...]

    def _find(self, product_id: UUID) -> CartItem | None:
        return next((i for i in self.items if i.product_id == product_id), None)

    def _with(self, item: CartItem) -> Cart:
        others = tuple(i for i in self.items if i.product_id != item.product_id)
        # CART-R15: por created_at y product_id.
        items = tuple(sorted((*others, item), key=lambda i: (i.created_at, i.product_id)))
        return replace(self, items=items)

    def add(self, product_id: UUID, quantity: int, now: datetime) -> Cart:
        """CART-R2: si ya existe, suma. CART-R3: tope por artículo y de artículos distintos."""
        if quantity < 1:
            raise QuantityLimit(quantity)
        current = self._find(product_id)
        if current is None:
            if len(self.items) >= CART_MAX_LINES:
                raise CartFull(product_id)
            if quantity > CART_ITEM_MAX_QUANTITY:
                raise QuantityLimit(quantity)
            return self._with(CartItem(product_id, quantity, True, now))
        total = current.quantity + quantity
        if total > CART_ITEM_MAX_QUANTITY:
            raise QuantityLimit(total)
        return self._with(replace(current, quantity=total))

    def set_quantity(self, product_id: UUID, quantity: int) -> Cart:
        current = self._find(product_id)
        if current is None:
            raise ItemNotInCart(product_id)
        if not 1 <= quantity <= CART_ITEM_MAX_QUANTITY:
            raise QuantityLimit(quantity)
        return self._with(replace(current, quantity=quantity))

    def set_selected(self, product_id: UUID, selected: bool) -> Cart:
        current = self._find(product_id)
        if current is None:
            raise ItemNotInCart(product_id)
        return self._with(replace(current, selected=selected))

    def remove(self, product_id: UUID) -> Cart:
        return replace(self, items=tuple(i for i in self.items if i.product_id != product_id))
