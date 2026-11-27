// Pedidos del backoffice (orders SPEC §7). Tipos 1:1 con el OpenAPI; los importes y estados
// son los del servidor (RN-09): nada se calcula aquí. 401/403 llegan como ApiError.
import type { Money, Page, Transport } from './http';

export type OrderStatus =
  | 'pendiente_pago'
  | 'pagado'
  | 'en_preparacion'
  | 'enviado'
  | 'listo_para_recojo'
  | 'entregado'
  | 'cancelado'
  | 'expirado';
export type TransitionTarget = 'en_preparacion' | 'enviado' | 'listo_para_recojo' | 'entregado' | 'cancelado';

export type AdminOrderSummary = {
  id: string;
  number: string;
  status: OrderStatus;
  total: Money;
  item_count: number;
  created_at: string;
  expires_at: string | null;
  estimated_delivery_on: string | null;
  user_id: string;
  recipient_name: string;
  district: string | null;
};
/** Fechas 'YYYY-MM-DD'; page_size ≤ 50. */
export type AdminOrderQuery = {
  status?: OrderStatus;
  q?: string;
  created_from?: string;
  created_to?: string;
  page?: number;
  page_size?: number;
};
export type AdminOrderLine = {
  product_id: string;
  sku: string;
  name: string;
  image: { url: string; alt: string } | null;
  quantity: number;
  list_price: Money;
  unit_price: Money;
  discount_amount: Money;
  line_total: Money;
  fulfillment: 'stock' | 'made_to_order';
  lead_time_days: number | null;
};
export type AdminDelivery = {
  delivery_method: 'shipping' | 'pickup';
  recipient_name: string;
  phone: string;
  department: string | null;
  province: string | null;
  district: string | null;
  address_line: string | null;
  reference: string | null;
  pickup_store: { name: string; address: string; hours: string } | null;
  carrier: string | null;
  tracking_code: string | null;
  shipped_at: string | null;
};
export type AdminHistoryEntry = {
  from_status: OrderStatus | null;
  status: OrderStatus;
  at: string;
  actor: 'customer' | 'admin' | 'system';
  actor_id: string | null;
  note: string | null;
};
export type AdminOrderDetail = Omit<AdminOrderSummary, 'recipient_name' | 'district'> & {
  paid_at: string | null;
  expires_in_seconds: number | null;
  subtotal: Money;
  shipping: Money;
  lines: AdminOrderLine[];
  delivery: AdminDelivery;
  refund: { amount: Money; at: string } | null;
  history: AdminHistoryEntry[];
  can_cancel: boolean;
  can_transition_to: OrderStatus[];
};

/** GET /orders/admin. Lista cerrada de claves: no se reenvía nada ajeno a AdminOrderQuery. */
export function listAdminOrders(t: Transport, q: AdminOrderQuery = {}): Promise<Page<AdminOrderSummary>> {
  const { status, q: text, created_from, created_to, page, page_size } = q;
  return t({
    method: 'GET',
    path: '/orders/admin',
    query: { status, q: text, created_from, created_to, page, page_size },
  });
}

export function getAdminOrder(t: Transport, orderId: string): Promise<AdminOrderDetail> {
  return t({ method: 'GET', path: `/orders/admin/${encodeURIComponent(orderId)}` });
}

/** POST /orders/admin/{id}/transitions. Solo viajan `to`, `note`, `carrier` y `tracking_code`. */
export function transitionOrder(
  t: Transport,
  orderId: string,
  body: { to: TransitionTarget; note?: string; carrier?: string; tracking_code?: string },
): Promise<AdminOrderDetail> {
  const { to, note, carrier, tracking_code } = body;
  return t({
    method: 'POST',
    path: `/orders/admin/${encodeURIComponent(orderId)}/transitions`,
    body: { to, note, carrier, tracking_code },
  });
}
