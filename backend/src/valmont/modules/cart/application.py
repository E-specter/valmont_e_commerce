from collections.abc import Collection
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from valmont.modules.cart.domain import Cart, CartLineStatus, line_status, max_quantity


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


@dataclass(frozen=True)
class ProductSnapshot:
    product_id: UUID
    sku: str
    slug: str
    name: str
    image_path: str | None
    alt: str | None
    order_policy: str
    available: int
    availability_status: str
    lead_time_days: int | None
    list_price: int
    price: int
    discount_amount: int
    promotion_id: UUID | None


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
