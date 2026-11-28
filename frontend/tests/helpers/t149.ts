// Ayudantes de T-149 (listado de productos del backoffice): productos falsos y un backend simulado de `/identity/me` y `/catalog/admin/products`. Sin red.
import { vi } from 'vitest';
import type { AdminProduct } from '../../src/lib/api/admin-catalog';
import { adminProduct } from './t147';
import { ST } from './t142';
import { USER_ID, json, profile, type ProfileJson } from './t129';

export const ME_PATH = '/api/v1/identity/me';
export const LIST_PATH = '/api/v1/catalog/admin/products';
export const OTHER_ID = '9d8c7b6a-1111-4222-8333-444455556666';
export const BACKEND_MSG = 'MSG-DEL-BACKEND-QX';
export const HOSTILE = '<img src=x onerror=alert(1)><script>window.__pwn=1</script>';
/** 20:04 UTC del 27/11/2026 = 15:04 en Lima (UTC-5). */
export const AT_UTC = '2026-11-27T20:04:00Z';
export const AT_LIMA = '27/11/2026 15:04';
/** 03:30 UTC del 10/03 es todavía el 9 de marzo en Lima (22:30). */
export const NIGHT_UTC = '2026-03-10T03:30:00Z';
export const NIGHT_LIMA = '09/03/2026 22:30';
const HEX_WIDTH = 12;
const RADIX = 16;
const TWO = 2;
const NONE = 0;
const ID_WIDTH = 4;
const FIRST = 1;
const DEFAULT_PAGE_SIZE = 24;

/** Producto del listado (la misma forma que AdminProductOut; borrador por defecto). */
export const product = (over: Partial<AdminProduct> = {}): AdminProduct =>
  adminProduct({ updated_at: AT_UTC, created_at: AT_UTC, ...over });

const hex = (n: number): string => n.toString(RADIX).padStart(HEX_WIDTH, '0');
/** `count` productos con ids, SKU y nombres distintos (alternan borrador y publicado). */
export const manyProducts = (count: number, over: Partial<AdminProduct> = {}): AdminProduct[] =>
  Array.from({ length: count }, (_, i) =>
    product({
      id: `00000000-0000-4000-8000-${hex(i + FIRST)}`,
      sku: `QA-T149-${String(i + FIRST).padStart(ID_WIDTH, '0')}`,
      slug: `qa-reloj-${i + FIRST}`,
      name: `Reloj ${i + FIRST}`,
      status: i % TWO === NONE ? 'draft' : 'published',
      ...over,
    }),
  );

export type Reply = Response | Promise<Response>;
export type Seen = { method: string; url: URL; auth: string | null; params: Record<string, string> };
type Options = { role?: unknown; me?: () => Reply; list?: (seen: Seen) => Reply };

/** Cuerpo de página; `page_size` sale de lo pedido (o de 24), para que la paginación cuadre con lo que la página envió. */
export const pageOf = (items: unknown[], seen?: Seen, extra: { total?: number; page?: number } = {}) => ({
  items,
  total: extra.total ?? items.length,
  page: extra.page ?? Number(seen?.params.page ?? FIRST),
  page_size: Number(seen?.params.page_size ?? DEFAULT_PAGE_SIZE),
});

/** Cuerpo de error del formato común. */
export const apiError = (status: number, code: string, details: unknown = null): Response =>
  json({ error: { code, message: BACKEND_MSG, details } }, status);

/**
 * `fetch` falso. `/identity/me` responde con el rol dado (por defecto `admin`); el listado, con `list`.
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
    if (url.pathname === ME_PATH) return opts.me ? opts.me() : json(meBody);
    if (url.pathname === LIST_PATH) return opts.list ? opts.list(seen) : json(pageOf([], seen));
    return apiError(ST.NOT_FOUND, 'not_found');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    lists: (): Seen[] => calls.filter((c) => c.url.pathname === LIST_PATH),
    others: (): Seen[] => calls.filter((c) => c.url.pathname !== ME_PATH && c.url.pathname !== LIST_PATH),
  };
}
