// Consulta del listado de pedidos: lista cerrada de claves (N-3). Todo lo demás se descarta.
import type { AdminOrderQuery, OrderStatus } from '../api/admin-orders';
import { ORDER_STATUSES } from './status';

const PAGE_SIZE = 20;
const MAX_Q = 100;
const MAX_PAGE = 1000;

// Forma de un día ISO: acepta "2026-11-27"; rechaza "27/11/2026" y "x". El calendario lo valida el backend.
// https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D%24&testString=2026-11-27
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Entero de 1 a 4 dígitos: acepta "12"; rechaza "-1", "1e3" y "١٢".
// https://regex101.com/?regex=%5E%5Cd%7B1%2C4%7D%24&testString=12
const PAGE = /^\d{1,4}$/;

/** `invalid` nombra las claves recibidas pero descartadas (la página las ignora sin error). */
export function parseOrderQuery(sp: URLSearchParams): { query: AdminOrderQuery; invalid: string[] } {
  const status = sp.get('status');
  const statusOk = status !== null && (ORDER_STATUSES as readonly string[]).includes(status);
  const q = sp.get('q')?.trim().slice(0, MAX_Q);
  const page = sp.get('page');
  const pageN = page !== null && PAGE.test(page) ? parseInt(page, 10) : 0;
  const pageOk = pageN >= 1 && pageN <= MAX_PAGE;
  const dates = (['created_from', 'created_to'] as const).map((k) => {
    const v = sp.get(k);
    return { k, v, ok: v !== null && DATE.test(v) };
  });

  const query: AdminOrderQuery = {
    page_size: PAGE_SIZE,
    ...(statusOk ? { status: status as OrderStatus } : {}),
    ...(q ? { q } : {}),
    ...Object.fromEntries(dates.filter((d) => d.ok).map((d) => [d.k, d.v])),
    ...(pageOk ? { page: pageN } : {}),
  };
  const invalid = [
    ...(status !== null && !statusOk ? ['status'] : []),
    ...dates.filter((d) => d.v !== null && !d.ok).map((d) => d.k),
    ...(page !== null && !pageOk ? ['page'] : []),
  ];
  return { query, invalid };
}

/** Claves en orden alfabético; sin `page=1` ni `page_size` (es fijo). */
export function orderQueryString(q: AdminOrderQuery): string {
  const entries: [string, string | undefined][] = [
    ['created_from', q.created_from],
    ['created_to', q.created_to],
    ['page', q.page && q.page > 1 ? String(q.page) : undefined],
    ['q', q.q],
    ['status', q.status],
  ];
  return new URLSearchParams(entries.filter((e): e is [string, string] => Boolean(e[1]))).toString();
}
