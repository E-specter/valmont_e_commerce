// Ayudantes de T-146 (detalle de pedido del backoffice): pedido de ejemplo y un backend simulado con las reglas de orders
// (SPEC §4 R10, R15, R19, R20 y §7 «transitions»). Sin red. El backend falso decide; la página solo pinta lo que recibe.
import { vi } from 'vitest';
import { formatMoney } from '../../src/lib/format';
import type { AdminDelivery, AdminHistoryEntry, AdminOrderDetail, AdminOrderLine, OrderStatus } from '../../src/lib/api/admin-orders';
import { API_BASE, CRED, ORDER_ID } from './t144';

export { API_BASE };
import { BEARER, SESSION, json, profile, type ProfileJson } from './t129';

export { BEARER, CRED, ORDER_ID, SESSION, json, profile };
export const ORIGIN = 'http://localhost:4321';
export const NO_STORE = 'private, no-store';
export const ME_URL = `${API_BASE}/identity/me`;
export const OTHER_USER_ID = 'c0ffee00-1234-4abc-8def-0123456789ab';
export const ADMIN_ACTOR_ID = '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab';
export const CUSTOMER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ef';
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_SEE_OTHER = 303;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNSUPPORTED = 415;
const HTTP_UNPROCESSABLE = 422;
const HTTP_SERVER = 500;
const HTTP_UNAVAILABLE = 503;
export const ST = {
  OK: HTTP_OK, SEE_OTHER: HTTP_SEE_OTHER, FOUND: HTTP_FOUND, FORBIDDEN: HTTP_FORBIDDEN, NOT_FOUND: HTTP_NOT_FOUND, CONFLICT: HTTP_CONFLICT,
  UNSUPPORTED: HTTP_UNSUPPORTED, UNPROCESSABLE: HTTP_UNPROCESSABLE, SERVER: HTTP_SERVER, UNAVAILABLE: HTTP_UNAVAILABLE,
} as const;
const YEAR = 2026;
const MONTH_NOV = 10; // Date.UTC usa meses desde 0
const DAY = 27;
const HOUR_PAID = 20;
const HOUR_ADMIN = 21;
const EXPIRES_SECONDS = 1500;

export const ALL_STATUSES: readonly OrderStatus[] = ['pendiente_pago', 'pagado', 'en_preparacion', 'enviado', 'listo_para_recojo', 'entregado', 'cancelado', 'expirado'];
export type Modality = 'shipping' | 'pickup';

/** Destinos que ofrece el servidor (SPEC §5 y R20): es lo único que la interfaz puede pintar. */
export function allowedFrom(status: OrderStatus, method: Modality): OrderStatus[] {
  const table: Partial<Record<OrderStatus, OrderStatus[]>> = {
    pendiente_pago: ['cancelado'],
    pagado: ['en_preparacion', 'cancelado'],
    en_preparacion: [method === 'pickup' ? 'listo_para_recojo' : 'enviado', 'cancelado'],
    enviado: ['entregado'],
    listo_para_recojo: ['entregado'],
  };
  return table[status] ?? [];
}

export const money = (amount: number) => ({ amount, currency: 'PEN' as const });
export const LINE_PRICE = 8_450_000; // S/ 84,500
export const SHIPPING_FEE = 5_000; // S/ 50

export const line = (over: Partial<AdminOrderLine> = {}): AdminOrderLine => ({
  product_id: '7a2d3b0f-6c8e-4d2f-8b21-1234567890bc',
  sku: 'DEMO-007',
  name: 'Demo Gaviota 42',
  image: { url: 'http://img.test/gaviota.webp', alt: 'Gaviota vista frontal' },
  quantity: 1,
  list_price: money(LINE_PRICE),
  unit_price: money(LINE_PRICE),
  discount_amount: money(0),
  line_total: money(LINE_PRICE),
  fulfillment: 'stock',
  lead_time_days: null,
  ...over,
});

export const shippingDelivery = (over: Partial<AdminDelivery> = {}): AdminDelivery => ({
  delivery_method: 'shipping',
  recipient_name: 'Lucía Fernández',
  phone: '+51987654321',
  department: 'Lima',
  province: 'Lima',
  district: 'Miraflores',
  address_line: 'Av. Larco 1234, piso 5',
  reference: 'Frente al parque Kennedy',
  pickup_store: null,
  carrier: null,
  tracking_code: null,
  shipped_at: null,
  ...over,
});
export const pickupDelivery = (over: Partial<AdminDelivery> = {}): AdminDelivery => ({
  delivery_method: 'pickup',
  recipient_name: 'Mateo Quispe',
  phone: '+51911222333',
  department: null,
  province: null,
  district: null,
  address_line: null,
  reference: null,
  pickup_store: { name: 'Boutique Valmont San Isidro', address: 'Calle Las Begonias 415', hours: 'Lun-Sáb 10:00-19:00' },
  carrier: null,
  tracking_code: null,
  shipped_at: null,
  ...over,
});

export const historyEntry = (over: Partial<AdminHistoryEntry> = {}): AdminHistoryEntry => ({
  from_status: null,
  status: 'pendiente_pago',
  at: '2026-11-27T20:00:00Z',
  actor: 'customer',
  actor_id: CUSTOMER_ID,
  note: null,
  ...over,
});

const stamp = (hour: number, minute: number): string => new Date(Date.UTC(YEAR, MONTH_NOV, DAY, hour, minute)).toISOString().replace('.000Z', 'Z');
const SYSTEM_STEPS: readonly OrderStatus[] = ['pagado', 'expirado'];

/** Historial coherente hasta `status` (1 min entre pasos desde 2026-11-27 20:00 UTC = 15:00 Lima). */
const actorOf = (i: number, s: OrderStatus): Pick<AdminHistoryEntry, 'actor' | 'actor_id'> => {
  if (i === 0) return { actor: 'customer', actor_id: CUSTOMER_ID };
  return SYSTEM_STEPS.includes(s) ? { actor: 'system', actor_id: null } : { actor: 'admin', actor_id: ADMIN_ACTOR_ID };
};

export function historyUpTo(status: OrderStatus, method: Modality = 'shipping'): AdminHistoryEntry[] {
  const path: Partial<Record<OrderStatus, OrderStatus[]>> = {
    pendiente_pago: ['pendiente_pago'],
    pagado: ['pendiente_pago', 'pagado'],
    en_preparacion: ['pendiente_pago', 'pagado', 'en_preparacion'],
    enviado: ['pendiente_pago', 'pagado', 'en_preparacion', 'enviado'],
    listo_para_recojo: ['pendiente_pago', 'pagado', 'en_preparacion', 'listo_para_recojo'],
    entregado: ['pendiente_pago', 'pagado', 'en_preparacion', method === 'pickup' ? 'listo_para_recojo' : 'enviado', 'entregado'],
    cancelado: ['pendiente_pago', 'cancelado'],
    expirado: ['pendiente_pago', 'expirado'],
  };
  const steps = path[status] ?? [status];
  return steps.map((s, i) =>
    historyEntry({
      from_status: i === 0 ? null : steps[i - 1],
      status: s,
      at: stamp(HOUR_PAID, i),
      ...actorOf(i, s),
    }),
  );
}

/** Pedido de administración coherente con su estado y modalidad; `over` pisa lo que se quiera. */
export function detail(status: OrderStatus = 'pagado', method: Modality = 'shipping', over: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  const shipping = method === 'pickup' ? 0 : SHIPPING_FEE;
  const total = LINE_PRICE + shipping;
  const paid = !['pendiente_pago', 'expirado'].includes(status) && !(status === 'cancelado');
  return {
    id: ORDER_ID,
    number: 'VAL-000123',
    status,
    total: money(total),
    item_count: 1,
    created_at: '2026-11-27T20:00:00Z',
    expires_at: status === 'pendiente_pago' ? '2026-11-27T20:30:00Z' : null,
    estimated_delivery_on: null,
    user_id: OTHER_USER_ID,
    paid_at: paid ? '2026-11-27T20:01:00Z' : null,
    expires_in_seconds: status === 'pendiente_pago' ? EXPIRES_SECONDS : null,
    subtotal: money(LINE_PRICE),
    shipping: money(shipping),
    lines: [line()],
    delivery: method === 'pickup' ? pickupDelivery() : shippingDelivery(),
    refund: null,
    history: historyUpTo(status, method),
    can_cancel: allowedFrom(status, method).includes('cancelado'),
    can_transition_to: allowedFrom(status, method),
    ...over,
  };
}

export type Detail = { loc: (string | number)[]; type: string; msg: string };
export const validationError = (...details: Detail[]): Response =>
  json({ error: { code: 'validation_error', message: 'La solicitud no es válida.', details } }, ST.UNPROCESSABLE);
export const bodyDetail = (field: string, type: string): Detail => ({ loc: ['body', field], type, msg: 'MSG-DEL-BACKEND-QX' });
export const apiError = (status: number, code: string, details: unknown = null): Response =>
  json({ error: { code, message: 'MSG-DEL-BACKEND-QX', details } }, status);

export type Call = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };
const NOTE_MAX = 500;
const TEXT_MAX = 60;
const KEYS_ALLOWED = ['to', 'note', 'carrier', 'tracking_code'];
const TARGETS = ['en_preparacion', 'enviado', 'listo_para_recojo', 'entregado', 'cancelado'];
const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export type Backend = ReturnType<typeof installOrderBackend>;

/**
 * `fetch` falso con `/identity/me` y `/orders/admin/{id}` (+ `/transitions`). Aplica las reglas del contrato: destinos fuera de
 * `can_transition_to` → 409 `invalid_transition`; `cancelado` exige `note` 1–500; `carrier` y `tracking_code` solo con `enviado`
 * (1–60); el reembolso (total) solo al cancelar un `pagado` o `en_preparacion`; el 409 no cambia nada. Repetir una cancelación
 * sobre un pedido ya cancelado es un 409 (el estado terminal no ofrece destinos).
 * `override(call)` fuerza una respuesta por llamada (401, 5xx, 422…); `state` se puede mutar entre llamadas ("otra pestaña").
 */
export function installOrderBackend(
  initial: AdminOrderDetail = detail(),
  opts: { role?: string; override?: (c: Call) => Response | undefined | Promise<Response | undefined> } = {},
) {
  const state: AdminOrderDetail = structuredClone(initial);
  const calls: Call[] = [];
  const me = (): ProfileJson => ({ ...profile(), role: opts.role ?? 'admin' });
  const orderPath = `${API_BASE}/orders/admin/${state.id}`;
  let transitions = 0;

  function apply(body: Record<string, unknown>): Response {
    const to = body.to as OrderStatus;
    if (!TARGETS.includes(String(body.to))) return validationError(bodyDetail('to', 'enum'));
    if (Object.keys(body).some((k) => !KEYS_ALLOWED.includes(k))) return validationError(bodyDetail('extra', 'extra_forbidden'));
    const note = body.note;
    if (to === 'cancelado' && (typeof note !== 'string' || trimmed(note).length < 1)) return validationError(bodyDetail('note', 'string_too_short'));
    if (typeof note === 'string' && note.length > NOTE_MAX) return validationError(bodyDetail('note', 'string_too_long'));
    const extras = (['carrier', 'tracking_code'] as const).flatMap((f) => {
      const v = body[f];
      if (v === undefined || v === null) return [];
      if (to !== 'enviado') return [bodyDetail(f, 'value_error')];
      if (typeof v !== 'string' || trimmed(v).length < 1) return [bodyDetail(f, 'string_too_short')];
      return v.length > TEXT_MAX ? [bodyDetail(f, 'string_too_long')] : [];
    });
    if (extras.length) return validationError(...extras);
    if (!state.can_transition_to.includes(to)) {
      return apiError(ST.CONFLICT, 'invalid_transition', { from: state.status, to, allowed: state.can_transition_to });
    }
    const from = state.status;
    transitions += 1;
    const at = stamp(HOUR_ADMIN, transitions);
    state.history.push({ from_status: from, status: to, at, actor: 'admin', actor_id: ADMIN_ACTOR_ID, note: typeof note === 'string' ? note : null });
    state.status = to;
    if (to === 'cancelado' && (from === 'pagado' || from === 'en_preparacion')) state.refund = { amount: state.total, at };
    if (to === 'enviado') {
      state.delivery = { ...state.delivery, carrier: (body.carrier as string | undefined) ?? null, tracking_code: (body.tracking_code as string | undefined) ?? null, shipped_at: at };
    }
    state.can_transition_to = allowedFrom(to, state.delivery.delivery_method);
    state.can_cancel = state.can_transition_to.includes('cancelado');
    return json(state);
  }

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: Call = { method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body };
    calls.push(call);
    const forced = await opts.override?.(call);
    if (forced) return forced;
    if (url === ME_URL && call.method === 'GET') return json(me());
    if (url === orderPath && call.method === 'GET') return json(state);
    if (url === `${orderPath}/transitions` && call.method === 'POST' && body) return apply(body);
    return apiError(ST.NOT_FOUND, 'not_found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    state,
    calls,
    fetchMock,
    posts: (): Call[] => calls.filter((c) => c.method === 'POST'),
    orderGets: (): Call[] => calls.filter((c) => c.method === 'GET' && c.url.includes('/orders/')),
    /** Cualquier llamada que no sea `/identity/me`. */
    beyondMe: (): Call[] => calls.filter((c) => c.url !== ME_URL),
  };
}

/** Cuerpo del único POST de transición (o `null`). */
export const postBody = (calls: Call[]): Record<string, unknown> | null => calls.find((c) => c.method === 'POST')?.body ?? null;

// Espacios duros (U+00A0, U+202F) que Intl pone en «S/ 84,500»: acepta "S/\u00a084,500"; no toca "S/ 84,500" con espacio normal.
// https://regex101.com/?regex=%5B%5Cu00a0%5Cu202f%5D&testString=S%2F%C2%A084%2C500
const HARD_SPACE = /[\u00a0\u202f]/g;
// Cualquier racha de espacios: acepta "a   b"; no altera "a b".
// https://regex101.com/?regex=%5Cs%2B&testString=a%20%20%20b
const SPACES = /\s+/g;
export const flat = (s: string): string => s.replace(HARD_SPACE, ' ').replace(SPACES, ' ').trim();
/** Importe como lo pinta la interfaz (misma función que producción: P-3, D-B6 B). */
export const soles = (amount: number): string => flat(formatMoney(money(amount)));
