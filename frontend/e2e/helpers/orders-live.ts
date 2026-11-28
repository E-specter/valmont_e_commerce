// Ayudante E2E de pedidos reales (T-146, D-050): un cliente de la suite compra por el API (carrito → pedido → pago simulado) y el
// administrador de la suite los lleva por sus estados desde la interfaz. Todo se borra al terminar: pedidos, pagos, reservas, movimientos de
// venta y usuarios `qa-t142-*`; `on_hand` del producto vuelve al valor inicial. Solo se actúa sobre pedidos de usuarios de la suite.
// Límite conocido: `app.audit_log` es inmutable (trigger) y conserva sus filas de auditoría.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { API, type QaUser } from './admin';

const DB_CONTAINER = 'supabase_db_valmont';
const EMAIL_PREFIX = 'qa-t142-';
const PSQL_TIMEOUT_MS = 30_000;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_CONFLICT = 409;
/** Tarjeta de prueba que el simulador aprueba (payments R12): solo viajan sus 4 últimos dígitos. */
export const APPROVED_LAST4 = '4242';
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza cualquier otra cosa (se interpola en SQL).
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D(-%5B0-9a-f%5D%7B4%7D)%7B3%7D-%5B0-9a-f%5D%7B12%7D%24&testString=3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Money = { amount: number; currency: string };
export type OrderRef = { id: string; number: string; total: Money; method: 'shipping' | 'pickup' };
export type Stock = { product_id: string; sku: string; name: string; on_hand: number; reserved: number; available: number };
export type AdminOrder = {
  id: string;
  number: string;
  status: string;
  total: Money;
  paid_at: string | null;
  refund: { amount: Money; at: string } | null;
  history: { from_status: string | null; status: string; actor: string; note: string | null }[];
  delivery: { delivery_method: string; carrier: string | null; tracking_code: string | null; recipient_name: string };
  can_transition_to: string[];
};

const ADULT_BIRTH_DATE = '1990-05-17';
/** Comprar exige fecha de nacimiento (+18, T-131): se fija una vez en el perfil del cliente de la suite. */
export async function makeAdult(user: QaUser): Promise<void> {
  must(await api(user, 'PATCH', '/identity/me', { body: { birth_date: ADULT_BIRTH_DATE } }), [HTTP_OK], 'PATCH identity/me');
}

export class PickupUnavailable extends Error {}

/** Llamada JSON al API real con el token de un usuario de la suite. Devuelve estado y cuerpo (sin lanzar por 4xx). */
export async function api<T = unknown>(user: QaUser, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${user.token}`, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, body: (raw ? JSON.parse(raw) : undefined) as T };
}

const must = <T>(res: { status: number; body: T }, expected: number[], what: string): T => {
  if (!expected.includes(res.status)) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body;
};

/** Producto de stock con unidades de sobra: el de mayor disponibilidad (la suite necesita `needed`). */
export async function pickStockProduct(admin: QaUser, needed: number): Promise<Stock> {
  const page = must(await api<{ items: (Stock & { status: string; product_status: string })[] }>(admin, 'GET', '/inventory/admin/stock?status=in_stock&page_size=48'), [HTTP_OK], 'GET stock');
  const best = page.items.filter((i) => i.product_status === 'published').sort((a, b) => b.available - a.available)[0];
  if (!best || best.available < needed) throw new Error(`Se necesita un producto publicado con ${needed} unidades disponibles (máximo: ${best?.available ?? 0})`);
  return best;
}

export async function stockOf(admin: QaUser, productId: string): Promise<Stock> {
  return must(await api<Stock>(admin, 'GET', `/inventory/admin/stock/${productId}`), [HTTP_OK], 'GET stock/{id}');
}

export async function adminOrder(admin: QaUser, orderId: string): Promise<AdminOrder> {
  return must(await api<AdminOrder>(admin, 'GET', `/orders/admin/${orderId}`), [HTTP_OK], 'GET orders/admin/{id}');
}

type PlaceOptions = { method?: 'shipping' | 'pickup'; pay?: boolean; recipient?: string };

const delivery = (method: 'shipping' | 'pickup', recipient: string) =>
  method === 'pickup'
    ? { delivery_method: 'pickup', recipient_name: recipient, phone: '+51911222333' }
    : {
        delivery_method: 'shipping', recipient_name: recipient, phone: '+51987654321', department: 'Lima', province: 'Lima', district: 'Miraflores',
        address_line: 'Av. Larco 1234, piso 5', reference: 'Frente al parque',
      };

/** Carrito → pedido (`Idempotency-Key` UUID) → pago simulado con la tarjeta 4242 (clave UUID). Un pickup sin boutique lanza `PickupUnavailable`. */
export async function placeOrder(customer: QaUser, productId: string, opts: PlaceOptions = {}): Promise<OrderRef> {
  const { method = 'shipping', pay = true, recipient = 'Cliente QA T-146' } = opts;
  must(await api(customer, 'POST', '/cart/items', { body: { product_id: productId, quantity: 1 } }), [HTTP_OK, HTTP_CREATED], 'POST cart/items');
  const created = await api<{ id: string; number: string; total: Money }>(customer, 'POST', '/orders', {
    body: { delivery: delivery(method, recipient) },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (created.status === HTTP_CONFLICT && method === 'pickup') {
    await api(customer, 'DELETE', `/cart/items/${productId}`);
    throw new PickupUnavailable('la boutique de recojo no está configurada');
  }
  const order = must(created, [HTTP_CREATED, HTTP_OK], 'POST orders');
  if (pay) {
    const paid = must(
      await api<{ status: string }>(customer, 'POST', `/payments/orders/${order.id}/attempts`, { body: { card_last4: APPROVED_LAST4 }, headers: { 'idempotency-key': randomUUID() } }),
      [HTTP_CREATED, HTTP_OK],
      'POST payments',
    );
    if (paid.status !== 'approved') throw new Error(`el simulador no aprobó el pago (${paid.status})`);
  }
  return { id: order.id, number: order.number, total: order.total, method };
}

function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8', timeout: PSQL_TIMEOUT_MS }).trim();
}

const asUuid = (id: string): string => {
  if (!UUID.test(id)) throw new Error('id no válido');
  return `'${id}'`;
};

/**
 * Borra los pedidos (y sus pagos, reservas, movimientos de venta, líneas, entrega e historial) de los usuarios de la suite y devuelve
 * `on_hand` al valor inicial. Una sola transacción (`psql -c` con varias sentencias). Nunca toca pedidos de otros usuarios: la subconsulta exige `qa-t142-%`.
 */
export function purgeSuiteOrders(users: QaUser[], productId: string, onHand: number): void {
  const owners = users.map((u) => asUuid(u.id)).join(', ');
  if (!owners) return;
  const mine = `(SELECT o.id FROM app.orders o WHERE o.user_id IN (${owners}) AND o.user_id IN (SELECT id FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'))`;
  psql(
    [
      `DELETE FROM app.payment_attempts WHERE order_id IN ${mine}`,
      `DELETE FROM app.stock_reservations WHERE order_id IN ${mine}`,
      `DELETE FROM app.stock_movements WHERE order_id IN ${mine}`,
      `DELETE FROM app.order_status_history WHERE order_id IN ${mine}`,
      `DELETE FROM app.order_lines WHERE order_id IN ${mine}`,
      `DELETE FROM app.deliveries WHERE order_id IN ${mine}`,
      `DELETE FROM app.orders WHERE id IN ${mine}`,
      `DELETE FROM app.carts WHERE user_id IN (${owners}) AND user_id IN (SELECT id FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%')`,
      `UPDATE app.inventory_items SET on_hand = ${Math.trunc(onHand)} WHERE product_id = ${asUuid(productId)}`,
    ].join('; '),
  );
}

/** Pedidos que aún quedan de los usuarios de la suite (debe ser 0 al terminar). */
export function suiteOrderCount(users: QaUser[]): number {
  const owners = users.map((u) => asUuid(u.id)).join(', ');
  return Number(psql(`SELECT count(*) FROM app.orders WHERE user_id IN (${owners})`));
}
