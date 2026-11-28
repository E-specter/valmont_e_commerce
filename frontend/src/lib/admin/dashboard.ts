// Datos del panel (T-145, D-049 D-B3 A): KPI derivados de los listados. T-141 solo cambiará el interior de `loadDashboard`.
// Nada se calcula aquí: las cifras son el `total` del servidor.
import { ApiError, type Page, type Transport } from '../api/http';
import { listAdminOrders, type AdminOrderSummary } from '../api/admin-orders';
import { listStock, type StockItem } from '../api/admin-inventory';

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const ORDERS_ROWS = 5;
const STOCK_ROWS = 4;
const ONE = 1;

export type Count = { ok: true; total: number } | { ok: false };
export type DashboardData = {
  toPrepare: Count;
  pendingPayment: Count;
  lowStock: Count;
  outOfStock: Count;
  ordersToPrepare: AdminOrderSummary[] | null;
  lowStockItems: StockItem[] | null;
};

// 401 y 403 se relanzan (los trata `adminErrorResponse`); cualquier otro fallo o forma inesperada degrada solo ese bloque.
function settle<T>(r: PromiseSettledResult<Page<T>>, valid: (row: unknown) => boolean): Page<T> | null {
  if (r.status === 'rejected') {
    if (r.reason instanceof ApiError && (r.reason.status === UNAUTHORIZED || r.reason.status === FORBIDDEN)) throw r.reason;
    return null;
  }
  const p = r.value;
  if (!p || !Array.isArray(p.items) || !Number.isInteger(p.total) || p.total < 0) return null;
  // Filas sin la forma esperada se descartan; si no queda ninguna válida, el bloque degrada.
  const items = p.items.filter(valid);
  return p.items.length > 0 && items.length === 0 ? null : { ...p, items };
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isOrder = (x: unknown) => isObj(x) && typeof x.id === 'string' && typeof x.number === 'string' && typeof x.status === 'string' && isObj(x.total) && typeof x.total.amount === 'number' && typeof x.recipient_name === 'string' && typeof x.created_at === 'string';
const isStock = (x: unknown) => isObj(x) && typeof x.product_id === 'string' && typeof x.name === 'string' && typeof x.available === 'number';
const any = () => true;
const count = (p: Page<unknown> | null): Count => (p ? { ok: true, total: p.total } : { ok: false });

export async function loadDashboard(t: Transport): Promise<DashboardData> {
  const [paid, pending, low, out] = await Promise.allSettled([
    listAdminOrders(t, { status: 'pagado', page_size: ORDERS_ROWS }),
    listAdminOrders(t, { status: 'pendiente_pago', page_size: ONE }),
    listStock(t, { status: 'low_stock', page_size: STOCK_ROWS }),
    listStock(t, { status: 'out_of_stock', page_size: ONE }),
  ]);
  const [pPaid, pPending, pLow, pOut] = [settle(paid, isOrder), settle(pending, any), settle(low, isStock), settle(out, any)];
  return {
    toPrepare: count(pPaid),
    pendingPayment: count(pPending),
    lowStock: count(pLow),
    outOfStock: count(pOut),
    ordersToPrepare: pPaid?.items ?? null,
    lowStockItems: pLow?.items ?? null,
  };
}
