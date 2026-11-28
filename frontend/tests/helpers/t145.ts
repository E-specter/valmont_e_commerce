// Ayudantes de T-145 (panel /admin): pedidos y stock falsos, y un backend simulado de `/identity/me`, `/orders/admin` y `/inventory/admin/stock`. Sin red.
import { vi } from 'vitest';
import type { StockItem, StockStatus } from '../../src/lib/api/admin-inventory';
import type { AdminOrderSummary } from '../../src/lib/api/admin-orders';
import { ST } from './t142';
import { USER_ID, json, profile, type ProfileJson } from './t129';
import { BACKEND_MSG, apiError, manyOrders, money, pageOf, summary } from './t084';
import { text } from './ui';

export { BACKEND_MSG, apiError, money, pageOf, summary };

export const ORDERS_PATH = '/api/v1/orders/admin';
export const STOCK_PATH = '/api/v1/inventory/admin/stock';
export const ME_PATH = '/api/v1/identity/me';

const T_PREPARE = 137;
const T_PENDING = 41;
const T_LOW = 23;
const T_OUT = 8;
/** Totales reales distintos entre sí y de la longitud de las listas, para que ninguno se confunda con un conteo de filas. */
export const TOTALS = { toPrepare: T_PREPARE, pendingPayment: T_PENDING, lowStock: T_LOW, outOfStock: T_OUT } as const;
export const KPI_LABELS = { toPrepare: 'Por preparar', pendingPayment: 'Pendientes de pago', lowStock: 'Stock bajo', sales: 'Ventas del período' } as const;

export const PREPARE_ROWS = 5;
export const PENDING_ROWS = 1;
export const LOW_ROWS = 4;
export const OUT_ROWS = 1;
const HEX_WIDTH = 12;
const FIRST = 1;
const SAMPLE_TOTAL = 12_345_000;
const STEP = 100_000;
/** Orden recibido, deliberadamente no ascendente (la página pinta el orden recibido). */
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const RECEIVED_ORDER = [TWO, 0, FOUR, 1, THREE];
const RECEIVED_STOCK = [THREE, 1, 0, TWO];
const OUT_INDEX = 9;
const RADIX = 16;

export const ordersToPrepare = (): AdminOrderSummary[] => {
  const all = manyOrders(PREPARE_ROWS, { status: 'pagado' });
  return RECEIVED_ORDER.map((i) => ({ ...all[i], total: money(SAMPLE_TOTAL + i * STEP) }));
};

const hex = (n: number): string => n.toString(RADIX).padStart(HEX_WIDTH, '0');
export const stockItem = (i: number, over: Partial<StockItem> = {}): StockItem => ({
  product_id: `22222222-0000-4000-8000-${hex(i + FIRST)}`,
  sku: `DEMO-S${i + FIRST}`,
  name: `Reloj Bajo ${i + FIRST}`,
  product_status: 'published',
  on_hand: LOW_ROWS,
  reserved: 0,
  available: LOW_ROWS,
  status: 'low_stock' as StockStatus,
  ...over,
});
export const lowStockItems = (): StockItem[] => RECEIVED_STOCK.map((i) => stockItem(i, { available: i + FIRST }));
export const outItems = (): StockItem[] => [stockItem(OUT_INDEX, { on_hand: 0, available: 0, status: 'out_of_stock', name: 'Reloj Agotado' })];

export type Key = 'pagado' | 'pendiente_pago' | 'low_stock' | 'out_of_stock';
export const KEYS: readonly Key[] = ['pagado', 'pendiente_pago', 'low_stock', 'out_of_stock'];
/** Qué responde cada llamada de datos con la API sana. */
export const healthy = (): Record<Key, unknown> => ({
  pagado: pageOf(ordersToPrepare(), { total: TOTALS.toPrepare, page_size: PREPARE_ROWS }),
  pendiente_pago: pageOf([summary({ status: 'pendiente_pago' })], { total: TOTALS.pendingPayment, page_size: PENDING_ROWS }),
  low_stock: pageOf(lowStockItems() as never, { total: TOTALS.lowStock, page_size: LOW_ROWS }),
  out_of_stock: pageOf(outItems() as never, { total: TOTALS.outOfStock, page_size: OUT_ROWS }),
});

export type Seen = { method: string; url: URL; auth: string | null; params: Record<string, string>; body: unknown };
type Reply = Response | Promise<Response>;
export type Replies = Partial<Record<Key, () => unknown>>;
type Options = {
  role?: unknown;
  me?: () => Reply;
  /** Qué responde cada llamada de datos (un valor se serializa como JSON 200; una `Response` se usa tal cual; una excepción simula la red caída). */
  replies?: Replies;
  /** Las 4 llamadas de datos esperan a que las 4 estén en vuelo antes de responder (prueba de paralelismo). */
  barrier?: boolean;
};

/** `fetch` falso del panel. Registra método, URL, Bearer, parámetros y cuerpo de cada llamada. */
export function installPanelBackend(opts: Options = {}) {
  const calls: Seen[] = [];
  const base = healthy();
  const meBody: Omit<ProfileJson, 'role'> & { role: unknown } = { ...profile({ user_id: USER_ID }), role: 'role' in opts ? opts.role : 'admin' };
  let inFlight = 0;
  let release!: () => void;
  const all4 = new Promise<void>((r) => (release = r));
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const seen: Seen = {
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization'),
      params: Object.fromEntries(url.searchParams.entries()),
      body: init?.body ?? null,
    };
    calls.push(seen);
    if (url.pathname === ME_PATH) return opts.me ? opts.me() : json(meBody);
    if (url.pathname === ORDERS_PATH || url.pathname === STOCK_PATH) {
      if (opts.barrier && ++inFlight === KEYS.length) release();
      if (opts.barrier) await all4;
      const key = seen.params.status as Key;
      const custom = opts.replies?.[key];
      const out = custom ? custom() : base[key];
      return out instanceof Response ? out : json(out);
    }
    return apiError(ST.NOT_FOUND, 'not_found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    data: (): Seen[] => calls.filter((c) => c.url.pathname === ORDERS_PATH || c.url.pathname === STOCK_PATH),
    me: (): Seen[] => calls.filter((c) => c.url.pathname === ME_PATH),
    others: (): Seen[] => calls.filter((c) => ![ME_PATH, ORDERS_PATH, STOCK_PATH].includes(c.url.pathname)),
  };
}

/** Ruta y parámetros en orden alfabético (como los arma `toQueryString`): comparable sin importar el orden de las llamadas. */
export const signature = (c: Pick<Seen, 'url'>): string => {
  const sorted = [...c.url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${c.url.pathname}?${new URLSearchParams(sorted).toString()}`;
};
export const EXPECTED_SIGNATURES = [
  `${ORDERS_PATH}?page_size=${PREPARE_ROWS}&status=pagado`,
  `${ORDERS_PATH}?page_size=${PENDING_ROWS}&status=pendiente_pago`,
  `${STOCK_PATH}?page_size=${LOW_ROWS}&status=low_stock`,
  `${STOCK_PATH}?page_size=${OUT_ROWS}&status=out_of_stock`,
];

/** Tarjeta KPI por su rótulo (`KpiCard`: `.kpi` con `.label` y `.value`). */
export const kpi = (scope: ParentNode, label: string): Element | undefined =>
  [...scope.querySelectorAll('.kpi')].find((k) => text(k.querySelector('.label')) === label);
export const kpiValue = (scope: ParentNode, label: string): string => text(kpi(scope, label)?.querySelector('.value'));
export const kpiState = (scope: ParentNode, label: string): string | null | undefined => kpi(scope, label)?.getAttribute('data-state');
export const errorKpis = (scope: ParentNode): Element[] => [...scope.querySelectorAll('.kpi[data-state="error"]')];
