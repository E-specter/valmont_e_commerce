// Ayudante E2E de pedidos del backoffice (T-084; D-050): siembra pedidos REALES por la API como cliente y los lleva a un estado con las
// transiciones del administrador. Solo escribe filas de los usuarios `qa-t142-*` (y solo de los ids creados aquí): al terminar, `purgeOrders`
// borra pagos, reservas y pedidos de esa lista con `docker exec … psql`; los usuarios los borra `deleteQaUser` (helpers/admin.ts).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { API, type QaUser } from './admin';

// Instante UTC en segundos (se interpola en SQL).
// Acepta "2026-03-10T03:30:00Z"; rechaza "2026-03-10'; --".
// https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7DT%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7DZ%24&testString=2026-03-10T03%3A30%3A00Z
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DB_CONTAINER = 'supabase_db_valmont';
const EMAIL_PREFIX = 'qa-t142-';
// Identificador 8-4-4-4-12 en hexadecimal minúsculas (se interpola en SQL: solo pasa esta forma).
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza "x'; DROP TABLE a; --".
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&testString=3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Producto sin stock propio (bajo pedido): sembrar pedidos no consume ni reserva existencias de la tienda.
const MADE_TO_ORDER_SKU = 'DEMO-003';
const ADULT_BIRTH = '1990-05-17';
const CARD_OK = '1111';
const PSQL_TIMEOUT = 30_000;
const NO_CONTENT = 204;
const PAGE_ALL = 48;
const RETRIES = 6;
const RETRY_MS = 1500;
const WAIT_MS = 90_000;
const PING_MS = 1000;

export type OrderStatus = 'pendiente_pago' | 'pagado' | 'en_preparacion' | 'enviado' | 'listo_para_recojo' | 'entregado' | 'cancelado' | 'expirado';
export type Seeded = { id: string; number: string; recipient: string; status: OrderStatus; district: string | null };
export type Spec = { recipient: string; method?: 'shipping' | 'pickup'; district?: string; to?: OrderStatus };

type Json = Record<string, unknown>;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `fetch` que reintenta solo si la conexión falló (el servidor de desarrollo se recarga al editar el código): la petición no llegó o se cortó. */
async function resilient(url: string, init: RequestInit, left = RETRIES): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (left <= 1) throw e;
    await pause(RETRY_MS);
    return resilient(url, init, left - 1);
  }
}

/** Espera a que la API responda (hasta 90 s); falla con un mensaje claro si no vuelve. */
export async function waitForApi(): Promise<void> {
  const until = Date.now() + WAIT_MS;
  const ping = async (): Promise<void> => {
    const ok = await fetch(`${API}/api/v1/catalog/products?page_size=1`).then((r) => r.ok, () => false);
    if (ok) return;
    if (Date.now() > until) throw new Error('la API local no responde (¿backend caído?)');
    await pause(PING_MS);
    return ping();
  };
  await ping();
}

async function call<T>(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await resilient(`${API}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(JSON.parse(text || '{}') as { error?: { code?: string } }).error?.code ?? ''}`);
  return (text && res.status !== NO_CONTENT ? JSON.parse(text) : undefined) as T;
}

const uuid = (id: string): string => {
  if (!UUID_SHAPE.test(id)) throw new Error('id no válido');
  return id;
};

function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: PSQL_TIMEOUT,
  }).trim();
}

const idList = (ids: readonly string[]): string => ids.map((i) => `'${uuid(i)}'`).join(',');
// Solo pedidos de usuarios de la suite: la subconsulta es la red de seguridad si alguien pasara un id ajeno.
const ownOrders = (ids: readonly string[]): string => `id IN (${idList(ids)}) AND user_id IN (SELECT id FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%')`;

/** Id del producto bajo pedido de la demo (catálogo público). */
export async function madeToOrderProductId(): Promise<string> {
  const res = await resilient(`${API}/api/v1/catalog/products?page_size=${PAGE_ALL}`, {});
  const page = (await res.json()) as { items: { id: string; sku: string }[] };
  const found = page.items.find((p) => p.sku === MADE_TO_ORDER_SKU);
  if (!found) throw new Error(`falta el producto ${MADE_TO_ORDER_SKU} de la demo`);
  return found.id;
}

/** El checkout exige mayoría de edad: se registra una fecha de nacimiento de adulto en el perfil del usuario de la suite. */
export async function makeAdult(user: QaUser): Promise<void> {
  await call(user.token, 'PATCH', '/identity/me', { birth_date: ADULT_BIRTH });
}

/** Un pedido real: carrito → POST /orders (→ pendiente_pago) y, según `to`, pago y transiciones del administrador. */
export async function seedOrder(customer: QaUser, admin: QaUser, productId: string, spec: Spec): Promise<Seeded> {
  await call(customer.token, 'POST', '/cart/items', { product_id: productId, quantity: 1 });
  const method = spec.method ?? 'shipping';
  // El recojo en tienda no está habilitado en el backend local (409 pickup_unavailable): se crea con envío y la entrega se convierte en recojo
  // en la BD local (solo ese pedido de la suite); el listado lo ve como `district = null`, igual que un recojo real.
  const delivery: Json = {
    delivery_method: 'shipping', recipient_name: spec.recipient, phone: '+51999000111', department: 'Lima', province: 'Lima',
    district: spec.district ?? 'Miraflores', address_line: 'Calle de prueba 123', reference: null,
  };
  const created = await call<{ id: string; number: string; status: OrderStatus }>(customer.token, 'POST', '/orders', { delivery }, { 'Idempotency-Key': randomUUID() });
  if (method === 'pickup') makePickup(created.id);
  let status: OrderStatus = created.status;
  const to = spec.to ?? 'pendiente_pago';
  if (to === 'pendiente_pago') return { id: created.id, number: created.number, recipient: spec.recipient, status, district: method === 'pickup' ? null : (spec.district ?? 'Miraflores') };
  if (to === 'expirado') {
    psql(`UPDATE app.orders SET status = 'expirado' WHERE ${ownOrders([created.id])} AND status = 'pendiente_pago'`);
    psql(`DELETE FROM app.stock_reservations WHERE order_id = '${uuid(created.id)}'`);
    status = 'expirado';
  } else if (to === 'cancelado' && created.status === 'pendiente_pago') {
    await call(customer.token, 'POST', `/orders/${created.id}/cancel`, {});
    status = 'cancelado';
  } else {
    await call(customer.token, 'POST', `/payments/orders/${created.id}/attempts`, { card_last4: CARD_OK }, { 'Idempotency-Key': randomUUID() });
    status = 'pagado';
    const steps = PATHS[to] ?? [];
    await steps.reduce(async (prev, step) => {
      await prev;
      const body = step === 'enviado' ? { to: step, carrier: 'Olva', tracking_code: 'QA0001' } : { to: step, ...(step === 'cancelado' ? { note: 'Prueba QA' } : {}) };
      await call(admin.token, 'POST', `/orders/admin/${created.id}/transitions`, body);
    }, Promise.resolve());
    status = steps.length ? steps[steps.length - 1] : status;
  }
  return { id: created.id, number: created.number, recipient: spec.recipient, status, district: method === 'pickup' ? null : (spec.district ?? 'Miraflores') };
}

// Camino desde `pagado` (envío a domicilio salvo `listo_para_recojo`, que solo existe para recojo).
const PATHS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  pagado: [],
  en_preparacion: ['en_preparacion'],
  enviado: ['en_preparacion', 'enviado'],
  listo_para_recojo: ['en_preparacion', 'listo_para_recojo'],
  entregado: ['en_preparacion', 'enviado', 'entregado'],
  cancelado: ['cancelado'],
};

/** Convierte la entrega de un pedido de la suite en recojo en tienda (sin dirección). */
function makePickup(orderId: string): void {
  const out = psql(`UPDATE app.deliveries SET delivery_method = 'pickup', department = NULL, province = NULL, district = NULL, address_line = NULL, reference = NULL WHERE order_id IN (SELECT id FROM app.orders WHERE ${ownOrders([orderId])}) RETURNING order_id`);
  if (!out.includes(orderId)) throw new Error('no se cambió la entrega: el pedido no es de la suite');
}

/** Fija `created_at` de pedidos propios (para probar el día de Lima y el orden). */
export function setCreatedAt(orderId: string, iso: string): void {
  if (!INSTANT.test(iso)) throw new Error('fecha no válida');
  const out = psql(`UPDATE app.orders SET created_at = '${iso}' WHERE ${ownOrders([orderId])} RETURNING id`);
  if (!out.includes(orderId)) throw new Error('no se cambió la fecha: el pedido no es de la suite');
}

/** Borra pagos, reservas y pedidos (con su entrega, líneas e historial en cascada) de la lista dada. Solo de usuarios `qa-t142-*`. */
export function purgeOrders(orderIds: readonly string[]): void {
  if (orderIds.length === 0) return;
  const ids = idList(orderIds);
  const own = `order_id IN (${ids}) AND order_id IN (SELECT id FROM app.orders WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%'))`;
  psql(`DELETE FROM app.payment_attempts WHERE ${own}`);
  psql(`DELETE FROM app.stock_reservations WHERE ${own}`);
  psql(`DELETE FROM app.orders WHERE ${ownOrders(orderIds)}`);
}

/** ¿Quedan pedidos de la lista? (comprobación de limpieza). */
export function countOrders(orderIds: readonly string[]): number {
  return orderIds.length === 0 ? 0 : Number(psql(`SELECT count(*) FROM app.orders WHERE id IN (${idList(orderIds)})`));
}
