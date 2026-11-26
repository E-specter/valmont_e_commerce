from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

from valmont.modules.cart.domain import Cart, CartLineStatus, line_status, max_quantity
from valmont.shared.product_snapshots import ProductSnapshot


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


class CartCatalog(Protocol):
    def get_published(self, product_ids: Collection[UUID]) -> dict[UUID, ProductSnapshot]:
        """Solo publicados; los demás no aparecen. Una sola consulta."""
        ...

    def get_names(self, product_ids: Collection[UUID]) -> dict[UUID, tuple[str, str]]:
        """Nombre y slug de cualquier producto (para los `unavailable`)."""
        ...


@dataclass(frozen=True)
class CartLineView:
    product_id: UUID
    sku: str | None
    slug: str
    name: str
    image_path: str | None
    alt: str | None
    quantity: int
    selected: bool
    status: CartLineStatus
    availability_status: str | None
    lead_time_days: int | None
    max_quantity: int
    unit_price: int | None
    original_price: int | None
    discount_amount: int | None
    subtotal: int | None


@dataclass(frozen=True)
class CartView:
    lines: tuple[CartLineView, ...]
    selected_count: int
    total: int
    can_checkout: bool


class GetCart:
    def __init__(self, carts: CartRepository, catalog: CartCatalog) -> None:
        self._carts = carts
        self._catalog = catalog

    def __call__(self, user_id: UUID) -> CartView:
        cart = self._carts.find_for_user(user_id)
        items = cart.items if cart else ()
        ids = [i.product_id for i in items]
        published = self._catalog.get_published(ids)
        names = self._catalog.get_names([i for i in ids if i not in published])
        lines: list[CartLineView] = []
        for item in items:
            snap = published.get(item.product_id)
            if snap is None:
                name, slug = names.get(item.product_id, ("", ""))
                lines.append(
                    CartLineView(
                        product_id=item.product_id, sku=None, slug=slug, name=name,
                        image_path=None, alt=None, quantity=item.quantity,
                        selected=item.selected, status=CartLineStatus.UNAVAILABLE,
                        availability_status=None, lead_time_days=None, max_quantity=0,
                        unit_price=None, original_price=None, discount_amount=None,
                        subtotal=None,
                    )
                )  # fmt: skip
                continue
            promoted = snap.promotion_id is not None
            lines.append(
                CartLineView(
                    product_id=item.product_id, sku=snap.sku, slug=snap.slug, name=snap.name,
                    image_path=snap.image_path, alt=snap.alt, quantity=item.quantity,
                    selected=item.selected,
                    status=line_status(True, snap.order_policy, snap.available, item.quantity),
                    availability_status=snap.availability_status,
                    lead_time_days=snap.lead_time_days,
                    max_quantity=max_quantity(True, snap.order_policy, snap.available),
                    unit_price=snap.price,
                    original_price=snap.list_price if promoted else None,
                    discount_amount=snap.discount_amount if promoted else None,
                    subtotal=snap.price * item.quantity,
                )
            )  # fmt: skip
        selected = [ln for ln in lines if ln.selected]
        return CartView(
            lines=tuple(lines),
            selected_count=len(selected),
            total=sum(ln.subtotal or 0 for ln in selected),  # R8: los unavailable no suman
            can_checkout=bool(selected) and all(ln.status is CartLineStatus.OK for ln in selected),
        )


class ProductNotAvailable(Exception):
    """R6: inexistente o no publicado (mismo error para ambos)."""


class CartItemNotFound(Exception):
    """El producto no está en el carrito del usuario."""


class ItemOutOfStock(Exception):
    def __init__(self, max_quantity: int = 0) -> None:
        super().__init__(max_quantity)
        self.max_quantity = max_quantity


class ItemInsufficientStock(Exception):
    def __init__(self, max_quantity: int) -> None:
        super().__init__(max_quantity)
        self.max_quantity = max_quantity


def _check_stock(snap: ProductSnapshot | None, quantity: int) -> None:
    """R5 (solo al subir la cantidad); RN-16: bajo pedido no depende del stock."""
    if snap is None:  # despublicado: max_quantity 0 (R4)
        raise ItemOutOfStock
    if snap.order_policy != "stock":
        return
    if snap.available <= 0:
        raise ItemOutOfStock
    if snap.available < quantity:
        raise ItemInsufficientStock(snap.available)


class AddToCart:
    def __init__(self, carts: CartRepository, catalog: CartCatalog) -> None:
        self._carts = carts
        self._catalog = catalog

    def __call__(self, user_id: UUID, product_id: UUID, quantity: int = 1) -> CartView:
        cart = self._carts.lock_for_user(user_id)
        snap = self._catalog.get_published([product_id]).get(product_id)
        if snap is None:
            raise ProductNotAvailable(product_id)
        cart = cart.add(product_id, quantity, datetime.now(UTC))  # R2, R3
        total = next(i.quantity for i in cart.items if i.product_id == product_id)
        _check_stock(snap, total)
        self._carts.save(cart)
        return GetCart(self._carts, self._catalog)(user_id)


class UpdateCartItem:
    def __init__(self, carts: CartRepository, catalog: CartCatalog) -> None:
        self._carts = carts
        self._catalog = catalog

    def __call__(
        self,
        user_id: UUID,
        product_id: UUID,
        quantity: int | None = None,
        selected: bool | None = None,
    ) -> CartView:
        if quantity is None and selected is None:
            raise ValueError("Se requiere quantity o selected.")
        cart = self._carts.lock_for_user(user_id)
        current = next((i for i in cart.items if i.product_id == product_id), None)
        if current is None:
            raise CartItemNotFound(product_id)
        if quantity is not None:
            cart = cart.set_quantity(product_id, quantity)
            if quantity > current.quantity:  # bajar nunca se rechaza por stock
                snap = self._catalog.get_published([product_id]).get(product_id)
                _check_stock(snap, quantity)
        if selected is not None:
            cart = cart.set_selected(product_id, selected)
        self._carts.save(cart)
        return GetCart(self._carts, self._catalog)(user_id)


class RemoveFromCart:
    def __init__(self, carts: CartRepository, catalog: CartCatalog) -> None:
        self._carts = carts
        self._catalog = catalog

    def __call__(self, user_id: UUID, product_id: UUID) -> CartView:
        cart = self._carts.lock_for_user(user_id)
        self._carts.save(cart.remove(product_id))  # idempotente
        return GetCart(self._carts, self._catalog)(user_id)


@dataclass(frozen=True)
class CheckoutLine:
    product_id: UUID
    sku: str
    name: str
    quantity: int
    list_price: int
    price: int
    discount_amount: int
    promotion_id: UUID | None
    availability_status: str
    lead_time_days: int | None


@dataclass(frozen=True)
class CheckoutCart:
    lines: tuple[CheckoutLine, ...]
    total: int


@dataclass(frozen=True)
class CartIssue:
    product_id: UUID
    status: CartLineStatus


class EmptySelection(Exception):
    """No hay artículos seleccionados."""


class CheckoutBlocked(Exception):
    def __init__(self, issues: tuple[CartIssue, ...]) -> None:
        super().__init__(issues)
        self.issues = issues


class PrepareCheckout:
    """Sin commit: corre en la transacción de orders (el carrito queda bloqueado)."""

    def __init__(self, carts: CartRepository, catalog: CartCatalog) -> None:
        self._carts = carts
        self._catalog = catalog

    def __call__(self, user_id: UUID) -> CheckoutCart:
        cart = self._carts.lock_for_user(user_id)
        items = [i for i in cart.items if i.selected]
        if not items:
            raise EmptySelection
        published = self._catalog.get_published([i.product_id for i in items])
        issues: list[CartIssue] = []
        lines: list[CheckoutLine] = []
        for item in items:
            snap = published.get(item.product_id)
            status = (
                CartLineStatus.UNAVAILABLE
                if snap is None
                else line_status(True, snap.order_policy, snap.available, item.quantity)
            )
            if snap is None or status is not CartLineStatus.OK:
                issues.append(CartIssue(item.product_id, status))
                continue
            lines.append(
                CheckoutLine(
                    product_id=item.product_id, sku=snap.sku, name=snap.name,
                    quantity=item.quantity, list_price=snap.list_price, price=snap.price,
                    discount_amount=snap.discount_amount, promotion_id=snap.promotion_id,
                    availability_status=snap.availability_status,
                    lead_time_days=snap.lead_time_days,
                )
            )  # fmt: skip
        if issues:
            raise CheckoutBlocked(tuple(issues))
        return CheckoutCart(lines=tuple(lines), total=sum(ln.price * ln.quantity for ln in lines))


class RemoveCheckedOutItems:
    def __init__(self, carts: CartRepository) -> None:
        self._carts = carts

    def __call__(self, user_id: UUID, product_ids: Collection[UUID]) -> None:
        cart = self._carts.lock_for_user(user_id)
        for pid in product_ids:
            cart = cart.remove(pid)  # ids ausentes se ignoran
        self._carts.save(cart)
