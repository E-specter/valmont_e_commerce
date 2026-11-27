import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from enum import StrEnum
from uuid import UUID

from valmont.shared.text import has_unsafe_chars, has_visible_char

PAYMENT_WINDOW_MINUTES = 30  # ORDERS-R6: igual que la reserva de inventory, pero constante propia
MAX_PENDING_ORDERS = 3  # ORDERS-R9
ORDER_NUMBER_PREFIX = "VAL-"  # ORDERS-R14

# ORDERS-R5. shortcut: Perú no tiene horario de verano, desfase fijo; revisar si cambia la regla.
_LIMA = timezone(timedelta(hours=-5))

_PHONE = re.compile(r"\+?[0-9]{6,15}")  # duplicada de identity (no se importa su dominio)


class OrderStatus(StrEnum):
    PENDING_PAYMENT = "pendiente_pago"
    PAID = "pagado"
    PREPARING = "en_preparacion"
    SHIPPED = "enviado"
    READY_FOR_PICKUP = "listo_para_recojo"
    DELIVERED = "entregado"
    CANCELLED = "cancelado"
    EXPIRED = "expirado"


class ActorKind(StrEnum):
    CUSTOMER = "customer"
    ADMIN = "admin"
    SYSTEM = "system"


class Fulfillment(StrEnum):
    STOCK = "stock"
    MADE_TO_ORDER = "made_to_order"


class DeliveryMethod(StrEnum):
    SHIPPING = "shipping"
    PICKUP = "pickup"


PAID_STATUSES = frozenset(
    {
        OrderStatus.PAID,
        OrderStatus.PREPARING,
        OrderStatus.SHIPPED,
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.DELIVERED,
    }
)


# --- Errores ---


class OrderError(Exception):
    """Regla de pedidos violada."""


class InvalidTransition(OrderError):
    def __init__(
        self, from_status: OrderStatus, to_status: OrderStatus, allowed: frozenset[OrderStatus]
    ) -> None:
        super().__init__(f"Transición no válida: {from_status} → {to_status}")
        self.from_status = from_status
        self.to_status = to_status
        self.allowed = allowed


class NotCancellable(OrderError):
    def __init__(self, status: OrderStatus) -> None:
        super().__init__(f"El pedido no se puede cancelar en estado {status}")
        self.status = status


class OrderNotPayable(OrderError):
    def __init__(self, status: OrderStatus) -> None:
        super().__init__(f"El pedido no se puede pagar en estado {status}")
        self.status = status


class TooManyPendingOrders(OrderError):
    """Ya hay MAX_PENDING_ORDERS pedidos pendientes de pago (R9)."""


class IdempotencyConflict(OrderError):
    """Carrera sobre la misma Idempotency-Key (R8)."""


class PickupUnavailable(OrderError):
    """La boutique no está configurada (R20, H-5)."""


class OrderNotFound(OrderError):
    """No existe o no es del cliente (R12)."""


class DeliveryInvalid(ValueError):
    """Dato de entrega no válido (R13). Sin el valor, que es personal (R18)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


# --- Transiciones (§5, R1, R10, R19, R20) ---


def admin_targets(status: OrderStatus, method: DeliveryMethod) -> frozenset[OrderStatus]:
    """Destinos que el administrador puede pedir desde `status`; vacío en los terminales."""
    shipping = method == DeliveryMethod.SHIPPING
    cancel = OrderStatus.CANCELLED
    if status == OrderStatus.PENDING_PAYMENT:
        return frozenset({cancel})
    if status == OrderStatus.PAID:
        return frozenset({OrderStatus.PREPARING, cancel})
    if status == OrderStatus.PREPARING:
        handed = OrderStatus.SHIPPED if shipping else OrderStatus.READY_FOR_PICKUP
        return frozenset({handed, cancel})
    # `enviado` solo existe en shipping y `listo_para_recojo` solo en pickup.
    if (status == OrderStatus.SHIPPED and shipping) or (
        status == OrderStatus.READY_FOR_PICKUP and not shipping
    ):
        return frozenset({OrderStatus.DELIVERED})
    return frozenset()


def check_admin_transition(
    from_status: OrderStatus, to_status: OrderStatus, method: DeliveryMethod
) -> None:
    allowed = admin_targets(from_status, method)
    if to_status not in allowed:
        raise InvalidTransition(from_status, to_status, allowed)


def can_customer_cancel(status: OrderStatus) -> bool:
    return status == OrderStatus.PENDING_PAYMENT


def format_order_number(number: int) -> str:
    return f"{ORDER_NUMBER_PREFIX}{number:06d}"


def estimated_delivery_on(created_at: datetime, lead_times: Iterable[int | None]) -> date | None:
    """Fecha de Lima de `created_at` + el mayor plazo; None si ninguna línea trae plazo (R5)."""
    known = [days for days in lead_times if days is not None]
    if not known:
        return None
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=UTC)
    return created_at.astimezone(_LIMA).date() + timedelta(days=max(known))


# --- Entrega (R13) ---


def _reject_control_chars(field_name: str, value: str) -> None:
    # Cc: \x00 rompe un text de PostgreSQL. Cs: un sustituto suelto no se codifica en UTF-8.
    if has_unsafe_chars(value):
        raise DeliveryInvalid(field_name, "El texto contiene caracteres de control no permitidos.")


def _text(field_name: str, value: str, low: int, high: int) -> str:
    _reject_control_chars(field_name, value)
    text = " ".join(value.split())
    if not has_visible_char(text) or not low <= len(text) <= high:
        raise DeliveryInvalid(field_name, f"Debe tener entre {low} y {high} caracteres.")
    return text


def _phone(value: str) -> str:
    _reject_control_chars("phone", value)
    phone = "".join(value.split())
    if not _PHONE.fullmatch(phone):
        raise DeliveryInvalid("phone", "El teléfono debe tener de 6 a 15 dígitos, con + opcional.")
    return phone


_LOCATION_LIMITS = {"department": (2, 40), "province": (2, 40), "district": (2, 40)}


@dataclass(frozen=True)
class DeliveryDetails:
    delivery_method: DeliveryMethod
    recipient_name: str
    phone: str
    department: str | None = None
    province: str | None = None
    district: str | None = None
    address_line: str | None = None
    reference: str | None = None

    def __post_init__(self) -> None:
        def put(name: str, value: str | None) -> None:
            object.__setattr__(self, name, value)

        put("recipient_name", _text("recipient_name", self.recipient_name, 2, 80))
        put("phone", _phone(self.phone))
        location = ("department", "province", "district", "address_line")
        if self.delivery_method == DeliveryMethod.PICKUP:
            for name in (*location, "reference"):
                if getattr(self, name) is not None:
                    raise DeliveryInvalid(name, "No aplica al recojo en tienda.")
            return
        for name in location:
            value = getattr(self, name)
            if value is None:
                raise DeliveryInvalid(name, "Es obligatorio para el envío.")
            low, high = (5, 150) if name == "address_line" else _LOCATION_LIMITS[name]
            put(name, _text(name, value, low, high))
        if self.reference is not None:
            _reject_control_chars("reference", self.reference)
            reference = " ".join(self.reference.split())
            if len(reference) > 150:
                raise DeliveryInvalid("reference", "Debe tener hasta 150 caracteres.")
            put("reference", reference or None)


@dataclass(frozen=True)
class Delivery(DeliveryDetails):
    """Entrega leída de la BD: añade los datos de envío (SPEC §5, R-11)."""

    carrier: str | None = None
    tracking_code: str | None = None
    shipped_at: datetime | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.delivery_method == DeliveryMethod.PICKUP:
            for name in ("carrier", "tracking_code", "shipped_at"):
                if getattr(self, name) is not None:
                    raise DeliveryInvalid(name, "No aplica al recojo en tienda.")


# --- Pedido ---


@dataclass(frozen=True)
class OrderLine:
    product_id: UUID
    sku: str
    name: str
    quantity: int
    list_price: int
    unit_price: int
    discount_amount: int
    promotion_id: UUID | None
    fulfillment: Fulfillment
    lead_time_days: int | None

    def __post_init__(self) -> None:
        if self.quantity < 1:
            raise ValueError("quantity debe ser al menos 1")
        if self.list_price < 1 or self.unit_price < 1:
            raise ValueError("Los precios deben ser de al menos 1 céntimo")

    @property
    def line_total(self) -> int:
        return self.unit_price * self.quantity


@dataclass(frozen=True)
class StatusChange:
    from_status: OrderStatus | None
    to_status: OrderStatus
    actor_kind: ActorKind
    actor_id: UUID | None
    note: str | None
    at: datetime


@dataclass(frozen=True)
class Order:
    id: UUID
    number: int | None
    user_id: UUID
    status: OrderStatus
    lines: Sequence[OrderLine]
    delivery: DeliveryDetails
    shipping_amount: int
    created_at: datetime
    expires_at: datetime
    estimated_delivery_on: date | None
    paid_at: datetime | None
    refunded_amount: int | None
    refunded_at: datetime | None
    history: Sequence[StatusChange] = field(default_factory=tuple)
    idempotency_key: str = ""

    def __post_init__(self) -> None:
        if not self.lines:
            raise ValueError("Un pedido necesita al menos una línea")
        if self.refunded_amount is not None and (
            self.status != OrderStatus.CANCELLED or self.refunded_amount != self.total_amount
        ):
            raise ValueError("El reembolso solo existe en un pedido cancelado y es total")

    @property
    def subtotal_amount(self) -> int:
        return sum(line.line_total for line in self.lines)

    @property
    def total_amount(self) -> int:
        return self.subtotal_amount + self.shipping_amount


def build_order(
    order_id: UUID,
    user_id: UUID,
    idempotency_key: str,
    lines: Sequence[OrderLine],
    delivery: DeliveryDetails,
    now: datetime,
) -> Order:
    if not lines:
        raise ValueError("Un pedido necesita al menos una línea")
    made_to_order = (
        line.lead_time_days for line in lines if line.fulfillment == Fulfillment.MADE_TO_ORDER
    )
    return Order(
        id=order_id,
        number=None,
        user_id=user_id,
        status=OrderStatus.PENDING_PAYMENT,
        lines=tuple(lines),
        delivery=delivery,
        shipping_amount=0,  # D-040, P-2
        created_at=now,
        expires_at=now + timedelta(minutes=PAYMENT_WINDOW_MINUTES),
        estimated_delivery_on=estimated_delivery_on(now, made_to_order),
        paid_at=None,
        refunded_amount=None,
        refunded_at=None,
        history=(
            StatusChange(None, OrderStatus.PENDING_PAYMENT, ActorKind.CUSTOMER, user_id, None, now),
        ),
        idempotency_key=idempotency_key,
    )
