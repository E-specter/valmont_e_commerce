// Ayudantes de T-084 (listado de pedidos del backoffice): pedidos falsos y un backend simulado de `/identity/me` y `/orders/admin`. Sin red.
import { vi } from 'vitest';
import type { AdminOrderSummary, OrderStatus } from '../../src/lib/api/admin-orders';
import { ORDER_STATUSES } from '../../src/lib/admin/status';
import { ST } from './t142';
import { USER_ID, json, profile, type ProfileJson } from './t129';

export const API_ROOT = 'http://api.test:8000/api/v1';
export const ME_URL = `${API_ROOT}/identity/me`;
export const LIST_PATH = '/api/v1/orders/admin';
export const OTHER_USER = '9d8c7b6a-1111-4222-8333-444455556666';
export const ORDER_ID = '7a1b2c3d-4e5f-4a6b-8c7d-0123456789ab';
export const PICKUP_TEXT = 'Recojo en tienda';
/** Instante UTC → Lima (UTC-5): 15:04 del 27/11/2026. */
export const AT_UTC = '2026-11-27T20:04:00Z';
export const AT_LIMA = '27/11/2026 15:04';
/** 03:30 UTC del 10/03 es todavía el 9 de marzo en Lima (22:30). */
export const NIGHT_UTC = '2026-03-10T03:30:00Z';
export const NIGHT_LIMA = '09/03/2026 22:30';
export const HOSTILE = '<img src=x onerror=alert(1)><script>window.__pwn=1</script>';
export const BACKEND_MSG = 'MSG-DEL-BACKEND-QX';

const SAMPLE_TOTAL = 8_450_000;
const SAMPLE_ITEMS = 2;
const HEX_WIDTH = 12;
const ID_WIDTH = 6;
export const PAGE_SIZE = 20;
const FIRST = 1;

export const money = (amount: number) => ({ amount, currency: 'PEN' as const });

export const summary = (over: Partial<AdminOrderSummary> = {}): AdminOrderSummary => ({
  id: ORDER_ID,
  number: 'VAL-000123',
  status: 'pagado',
  total: money(SAMPLE_TOTAL),
  item_count: SAMPLE_ITEMS,
  created_at: AT_UTC,
  expires_at: null,
  estimated_delivery_on: null,
  user_id: OTHER_USER,
  recipient_name: 'Ana Torres',
  district: 'Miraflores',
  ...over,
});

const hex = (n: number): string => n.toString(16).padStart(HEX_WIDTH, '0');
/** `count` pedidos con ids, números y destinatarios distintos. */
export const manyOrders = (count: number, over: Partial<AdminOrderSummary> = {}): AdminOrderSummary[] =>
  Array.from({ length: count }, (_, i) =>
    summary({ id: `00000000-0000-4000-8000-${hex(i + FIRST)}`, number: `VAL-${String(i + FIRST).padStart(ID_WIDTH, '0')}`, recipient_name: `Cliente ${i + FIRST}`, ...over }),
  );

/** Un pedido por cada uno de los 8 estados (con `expires_at` solo en pendiente_pago). */
export const onePerStatus = (): AdminOrderSummary[] =>
  ORDER_STATUSES.map((status: OrderStatus, i) =>
    summary({
      id: `11111111-0000-4000-8000-${hex(i + FIRST)}`,
      number: `VAL-9000${i}`,
      status,
      recipient_name: `Destino ${i}`,
      expires_at: status === 'pendiente_pago' ? '2026-11-28T20:04:00Z' : null,
    }),
  );

export const pageOf = (items: AdminOrderSummary[], extra: { total?: number; page?: number; page_size?: number } = {}) => ({
  items,
  total: extra.total ?? items.length,
  page: extra.page ?? 1,
  page_size: extra.page_size ?? PAGE_SIZE,
});

export type Seen = { method: string; url: URL; auth: string | null; params: Record<string, string> };
type Reply = Response | Promise<Response>;
type Options = { role?: unknown; me?: () => Reply; list?: (seen: Seen) => Reply };

/** Cabecera `{error:{code,message,details}}` del formato común. */
export const apiError = (status: number, code: string, details: unknown = null): Response =>
  json({ error: { code, message: BACKEND_MSG, details } }, status);

/** Detalle de 422 de FastAPI sobre un parámetro de la consulta. */
export const queryError = (field: string, type: string): Response =>
  apiError(ST.UNPROCESSABLE, 'validation_error', [{ loc: ['query', field], type, msg: BACKEND_MSG }]);

/**
 * `fetch` falso. `/identity/me` responde con el rol dado (por defecto `admin`); `/orders/admin` con `list`.
 * Registra cada llamada (método, URL, Bearer y parámetros de la consulta).
 */
export function installAdminBackend(opts: Options = {}) {
  const calls: Seen[] = [];
  const meBody: Omit<ProfileJson, 'role'> & { role: unknown } = { ...profile({ user_id: USER_ID }), role: 'role' in opts ? opts.role : 'admin' };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const seen: Seen = {
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization'),
      params: Object.fromEntries(url.searchParams.entries()),
    };
    calls.push(seen);
    if (url.pathname === '/api/v1/identity/me') return opts.me ? opts.me() : json(meBody);
    if (url.pathname === LIST_PATH) return opts.list ? opts.list(seen) : json(pageOf([]));
    return apiError(ST.NOT_FOUND, 'not_found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    lists: (): Seen[] => calls.filter((c) => c.url.pathname === LIST_PATH),
    others: (): Seen[] => calls.filter((c) => c.url.pathname !== '/api/v1/identity/me' && c.url.pathname !== LIST_PATH),
  };
}
