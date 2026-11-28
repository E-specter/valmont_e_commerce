import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Pedidos from '../../src/pages/admin/pedidos/index.astro';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { ORDER_STATUSES } from '../../src/lib/admin/status';
import { parseHtml } from '../helpers/render';
import { ST } from '../helpers/t142';
import { BEARER, NO_STORE, ORIGIN, SESSION, USER_ID, json } from '../helpers/t129';
import {
  BACKEND_MSG, HOSTILE, LIST_PATH, OTHER_USER, PAGE_SIZE, apiError, installAdminBackend, manyOrders, onePerStatus, pageOf, queryError, summary,
} from '../helpers/t084';
import { text } from '../helpers/ui';

// T-084 · ruta GET /admin/pedidos con la Container API y un `fetch` falso como backend de identity y orders.
// La guardia del middleware (T-126) y el rewrite real no corren aquí: `rewrite` se sustituye por una respuesta con el estado de la página destino
// (la lógica de requireAdmin y adminErrorResponse es la real). De extremo a extremo se prueba en el E2E.
const hoisted = vi.hoisted(() => {
  const FORBIDDEN_CODE = 403;
  const UNAVAILABLE_CODE = 503;
  const NOT_FOUND_CODE = 404;
  const OK_CODE = 200;
  const status: Record<string, number> = { '/admin/sin-permiso': FORBIDDEN_CODE, '/admin/no-disponible': UNAVAILABLE_CODE, '/404': NOT_FOUND_CODE };
  return { rewrites: [] as string[], status, ok: OK_CODE };
});

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));
vi.mock('../../src/lib/server/admin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/server/admin')>();
  const wrap = (a: Parameters<typeof real.requireAdmin>[0]) => ({
    locals: a.locals,
    url: a.url,
    request: a.request,
    cookies: a.cookies,
    rewrite: async (path: string) => {
      hoisted.rewrites.push(path);
      return new Response(`rewrite:${path}`, { status: hoisted.status[path] ?? hoisted.ok });
    },
  });
  return {
    ...real,
    requireAdmin: (a: Parameters<typeof real.requireAdmin>[0]) => real.requireAdmin(wrap(a) as never),
    adminErrorResponse: (a: Parameters<typeof real.adminErrorResponse>[0], e: unknown) => real.adminErrorResponse(wrap(a) as never, e),
  };
});

const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const TOTAL_45 = 45;
const LONG_Q = 150;
const MAX_Q = 100;
const OVERSIZE_PAGE = 500;
const FOUND = ST.FOUND;
const OK = ST.OK;
const FORBIDDEN = ST.FORBIDDEN;
const UNAVAILABLE = ST.UNAVAILABLE;
const UNPROCESSABLE = ST.UNPROCESSABLE;
const SERVER_ERRORS = [ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE, ST.GATEWAY_TIMEOUT];
const LEAK_WORDS = ['fetch failed', 'TypeError', 'ECONNREFUSED', 'stack', '.ts:', 'api.test', BACKEND_MSG, BEARER];
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
const PATH = '/admin/pedidos';
const HTTP_SERVER_ERROR = 500;

let signOut: ReturnType<typeof vi.fn>;
type Init = { session?: unknown; cookie?: string };

async function get(query = '', init: Init = {}) {
  const request = new Request(`${ORIGIN}${PATH}${query}`, { headers: { cookie: init.cookie ?? COOKIE_HEADER } });
  const session = 'session' in init ? init.session : SESSION;
  const supabase = { auth: { signOut } };
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Pedidos, { request, locals: { session, supabase } as never, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

const rows = (d: Document): Element[] => [...d.querySelectorAll('tbody tr')];
const input = (d: Document, name: string): HTMLInputElement | null => d.querySelector(`input[name="${name}"]`);
const pager = (d: Document): HTMLAnchorElement[] => [...d.querySelectorAll('nav[aria-label="Paginación"] a')] as HTMLAnchorElement[];
const pageLink = (d: Document, n: number): HTMLAnchorElement | undefined => pager(d).find((a) => a.getAttribute('aria-label') === `Página ${n}`);
const params = (href: string | null): URLSearchParams => new URL(href ?? '', 'http://x.test').searchParams;
const chip = (d: Document, label: string): HTMLAnchorElement | undefined => [...d.querySelectorAll('a')].find((a) => text(a) === label) as HTMLAnchorElement | undefined;
const noLeaks = (html: string): void => LEAK_WORDS.forEach((w) => expect(html, w).not.toContain(w));

beforeEach(() => {
  signOut = vi.fn(async () => ({ error: null }));
  hoisted.rewrites.length = NONE;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /admin/pedidos · 200 con datos', () => {
  test('200: único h1 «Pedidos», noindex, respuesta privada y una tabla con una fila por pedido', async () => {
    installAdminBackend({ list: () => json(pageOf(manyOrders(THREE))) });
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1'))).toBe('Pedidos');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelectorAll('table')).toHaveLength(ONE);
    expect(rows(doc)).toHaveLength(THREE);
  });

  test('pide /identity/me y luego UNA sola GET /orders/admin con el Bearer de la sesión y solo page_size=20', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get();
    expect(be.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /api/v1/identity/me', `GET ${LIST_PATH}`]);
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
    expect(be.lists()[NONE].params).toEqual({ page_size: String(PAGE_SIZE) });
  });

  test('solo lectura: ninguna llamada que no sea GET', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get('?status=pagado&q=Ana');
    expect(be.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(be.others()).toHaveLength(NONE);
  });

  test('«Pedidos» del menú es un enlace a /admin/pedidos con aria-current="page"; las entradas sin pantalla siguen «Pronto»', async () => {
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    const { doc } = await get();
    const nav = doc.querySelector('nav[aria-label="Administración"]');
    const current = nav?.querySelector('a[href="/admin/pedidos"]');
    expect(current?.getAttribute('aria-current')).toBe('page');
    expect(nav?.querySelectorAll('[aria-disabled="true"]')).toHaveLength(ADMIN_NAV.filter((e) => !e.enabled).length);
  });

  test('el total y las fechas llegan formateados; el enlace del número lleva a /admin/pedidos/{id}', async () => {
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    const { doc } = await get();
    const row = rows(doc)[NONE];
    expect(text(row)).toContain('S/ 84,500');
    expect(text(row)).toContain('27/11/2026 15:04');
    expect(new URL(row.querySelector('a')?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(`${PATH}/${summary().id}`);
  });

  test('los 8 estados se pintan con su pill', async () => {
    installAdminBackend({ list: () => json(pageOf(onePerStatus())) });
    const { doc } = await get();
    expect(doc.querySelectorAll('tbody .pill')).toHaveLength(ORDER_STATUSES.length);
  });

  test('nunca se pinta el user_id completo, el Bearer ni datos de entrega', async () => {
    installAdminBackend({ list: () => json(pageOf([summary({ user_id: OTHER_USER })])) });
    const { html } = await get();
    expect(html).not.toContain(OTHER_USER);
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(BEARER);
  });

  test('recipient_name hostil se pinta como texto, sin scripts ni elementos inyectados', async () => {
    installAdminBackend({ list: () => json(pageOf([summary({ recipient_name: HOSTILE })])) });
    const { html, doc } = await get();
    expect(html).not.toContain('<script>window.__pwn');
    expect(doc.querySelector('tbody img')).toBeNull();
    expect(text(rows(doc)[NONE])).toContain(HOSTILE);
  });

  test('console limpia: la página no escribe en la consola del servidor', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get('?status=pagado&q=Ana');
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});

describe('GET /admin/pedidos · la consulta sale solo de parseOrderQuery (lista blanca)', () => {
  test('filtros válidos viajan al backend, con page_size fijo en 20', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get('?status=pagado&q=Ana&created_from=2026-11-01&created_to=2026-11-27&page=2');
    expect(be.lists()[NONE].params).toEqual({
      status: 'pagado', q: 'Ana', created_from: '2026-11-01', created_to: '2026-11-27', page: '2', page_size: String(PAGE_SIZE),
    });
  });

  test.each(['?status=otro', '?page=0', '?page=-1', '?page=1001', '?page=1e3', '?page=abc', '?created_from=x', '?created_to=27/11/2026', '?created_from=2026-1-1'])(
    '%s se ignora sin error: 200 y ningún parámetro inválido llega al backend',
    async (query) => {
      const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
      const { res } = await get(query);
      expect(res.status).toBe(OK);
      expect(be.lists()[NONE].params).toEqual({ page_size: String(PAGE_SIZE) });
    },
  );

  test('claves ajenas se descartan: user_id, sort, page_size=500, role, offset, order_by, limit, id', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get(`?user_id=${OTHER_USER}&sort=asc&page_size=${OVERSIZE_PAGE}&role=admin&offset=40&order_by=total&limit=999&id=1&status=pagado`);
    expect(be.lists()[NONE].params).toEqual({ status: 'pagado', page_size: String(PAGE_SIZE) });
  });

  test('un parámetro repetido no se convierte en lista: gana un solo valor', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get('?status=pagado&status=cancelado');
    const sent = be.lists()[NONE].url.searchParams.getAll('status');
    expect(sent).toHaveLength(ONE);
  });

  test('q se recorta de espacios y a 100 caracteres', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([summary()])) });
    await get(`?q=${encodeURIComponent('  Ana  ')}`);
    expect(be.lists()[NONE].params.q).toBe('Ana');
    await get(`?q=${'z'.repeat(LONG_Q)}`);
    expect(be.lists()[ONE].params.q).toHaveLength(MAX_Q);
  });

  test('q con caracteres de SQL o HTML viaja como parámetro codificado (nunca concatenado) y no rompe la página', async () => {
    const hostile = `'; DROP TABLE orders; -- <b>x</b>`;
    const be = installAdminBackend({ list: () => json(pageOf([])) });
    const { res, doc } = await get(`?q=${encodeURIComponent(hostile)}`);
    expect(res.status).toBe(OK);
    expect(be.lists()[NONE].params.q).toBe(hostile.trim());
    expect(doc.querySelector('main b')).toBeNull();
    expect(input(doc, 'q')?.getAttribute('value')).toBe(hostile);
  });

  test('los filtros válidos se pintan en el formulario y el chip del estado queda activo', async () => {
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    const { doc } = await get('?status=enviado&q=Ana&created_from=2026-11-01&created_to=2026-11-27&evil=1&page=zz');
    expect(input(doc, 'q')?.getAttribute('value')).toBe('Ana');
    expect(input(doc, 'created_from')?.getAttribute('value')).toBe('2026-11-01');
    expect(input(doc, 'created_to')?.getAttribute('value')).toBe('2026-11-27');
    expect(chip(doc, 'Enviado')?.getAttribute('aria-current')).toBeTruthy();
    expect(chip(doc, 'Todos')?.getAttribute('aria-current')).toBeNull();
  });

  test('los filtros inválidos no se pintan: los campos quedan vacíos y «Todos» activo', async () => {
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    const { doc } = await get('?status=otro&created_from=x&created_to=y');
    expect(input(doc, 'created_from')?.getAttribute('value') ?? '').toBe('');
    expect(input(doc, 'created_to')?.getAttribute('value') ?? '').toBe('');
    expect(chip(doc, 'Todos')?.getAttribute('aria-current')).toBeTruthy();
  });

  test('q hostil en la URL se escapa en el campo (sin scripts inyectados)', async () => {
    installAdminBackend({ list: () => json(pageOf([])) });
    const attack = '"><script>window.__pwn=1</script>';
    const { doc } = await get(`?q=${encodeURIComponent(attack)}`);
    expect([...doc.querySelectorAll('script')].some((el) => (el.textContent ?? '').includes('__pwn'))).toBe(false);
    expect(input(doc, 'q')?.getAttribute('value')).toBe(attack);
  });
});

describe('GET /admin/pedidos · paginación y filtros combinados', () => {
  const filtered = '?status=pagado&q=Ana&created_from=2026-11-01&created_to=2026-11-27';
  const backend = (page: number) => installAdminBackend({ list: () => json(pageOf(manyOrders(PAGE_SIZE), { total: TOTAL_45, page })) });

  test('45 pedidos, 20 por página → 3 páginas; la página actual lleva aria-current', async () => {
    backend(TWO);
    const { doc } = await get('?page=2');
    expect(pager(doc).filter((a) => a.getAttribute('aria-label')?.startsWith('Página '))).toHaveLength(THREE);
    expect(pageLink(doc, TWO)?.getAttribute('aria-current')).toBe('page');
    expect(pageLink(doc, ONE)?.getAttribute('aria-current')).toBeNull();
  });

  test('los enlaces de página conservan estado, texto y fechas, y cambian solo page', async () => {
    backend(ONE);
    const { doc } = await get(filtered);
    const target = pageLink(doc, THREE);
    const p = params(target?.getAttribute('href') ?? null);
    expect(new URL(target?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(PATH);
    expect(Object.fromEntries(p.entries())).toEqual({ status: 'pagado', q: 'Ana', created_from: '2026-11-01', created_to: '2026-11-27', page: String(THREE) });
  });

  test('Anterior y Siguiente (rel=prev/next) respetan los filtros; page_size nunca aparece en los enlaces', async () => {
    backend(TWO);
    const { doc } = await get(`${filtered}&page=2`);
    const prev = doc.querySelector('a[rel="prev"]')?.getAttribute('href') ?? null;
    const next = doc.querySelector('a[rel="next"]')?.getAttribute('href') ?? null;
    expect(params(next).get('page')).toBe(String(THREE));
    expect(params(next).get('status')).toBe('pagado');
    expect([null, '1']).toContain(params(prev).get('page'));
    expect(params(prev).get('q')).toBe('Ana');
    pager(doc).forEach((a) => expect(a.getAttribute('href') ?? '').not.toContain('page_size'));
  });

  test('con una sola página no se pinta la paginación', async () => {
    installAdminBackend({ list: () => json(pageOf(manyOrders(THREE))) });
    const { doc } = await get();
    expect(pager(doc)).toHaveLength(NONE);
  });

  test('cambiar de estado desde la página 3 vuelve a la 1 y conserva texto y fechas', async () => {
    backend(THREE);
    const { doc } = await get(`${filtered}&page=3`);
    const href = chip(doc, 'Enviado')?.getAttribute('href') ?? null;
    const p = params(href);
    expect(p.get('status')).toBe('enviado');
    expect(p.get('q')).toBe('Ana');
    expect(p.get('created_from')).toBe('2026-11-01');
    expect([null, '1']).toContain(p.get('page'));
    const all = params(chip(doc, 'Todos')?.getAttribute('href') ?? null);
    expect(all.get('status')).toBeNull();
    expect(all.get('q')).toBe('Ana');
    expect([null, '1']).toContain(all.get('page'));
  });

  test('el formulario no arrastra la página actual (aplicar filtros → página 1)', async () => {
    backend(THREE);
    const { doc } = await get(`${filtered}&page=3`);
    expect(input(doc, 'page')).toBeNull();
    const form = input(doc, 'q')?.closest('form');
    expect(form?.getAttribute('action') ?? PATH).toBe(PATH);
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('get');
  });

  test('los enlaces a un detalle conservan la consulta actual en `volver` (sin page=1 ni page_size)', async () => {
    backend(TWO);
    const { doc } = await get(`${filtered}&page=2`);
    const volver = params(rows(doc)[NONE].querySelector('a')?.getAttribute('href') ?? null).get('volver') ?? '';
    const back = new URLSearchParams(volver);
    expect(Object.fromEntries(back.entries())).toEqual({ status: 'pagado', q: 'Ana', created_from: '2026-11-01', created_to: '2026-11-27', page: '2' });
  });

  test('`volver` sale de la consulta saneada: lo ajeno no se arrastra al detalle', async () => {
    backend(ONE);
    const { doc } = await get('?status=pagado&evil=1&user_id=abc&page=zz');
    const volver = params(rows(doc)[NONE].querySelector('a')?.getAttribute('href') ?? null).get('volver') ?? '';
    expect(volver).toBe('status=pagado');
  });
});

describe('GET /admin/pedidos · vacío, error y 422', () => {
  test('vacío con filtros: «No hay pedidos con estos filtros», «Limpiar filtros» y ninguna tabla', async () => {
    installAdminBackend({ list: () => json(pageOf([])) });
    const { res, doc } = await get('?status=pagado&q=zzzz');
    expect(res.status).toBe(OK);
    expect(text(doc.querySelector('main'))).toContain('No hay pedidos con estos filtros');
    expect(doc.querySelector('table')).toBeNull();
    const clear = chip(doc, 'Limpiar filtros');
    expect(clear).toBeDefined();
    expect(new URL(clear?.getAttribute('href') ?? '', ORIGIN).search).toBe('');
  });

  test('vacío sin filtros: «Aún no hay pedidos», sin «Limpiar filtros» de estado vacío y sin tabla', async () => {
    installAdminBackend({ list: () => json(pageOf([])) });
    const { doc } = await get();
    const main = text(doc.querySelector('main'));
    expect(main).toContain('Aún no hay pedidos');
    expect(main).not.toContain('No hay pedidos con estos filtros');
    expect(doc.querySelector('table')).toBeNull();
  });

  test('parámetros inválidos no cuentan como filtros: vacío sin filtros', async () => {
    installAdminBackend({ list: () => json(pageOf([])) });
    const { doc } = await get('?status=otro&created_from=x&page=0');
    expect(text(doc.querySelector('main'))).toContain('Aún no hay pedidos');
  });

  test.each(SERVER_ERRORS)('error %i del listado: 503, «Reintentar», sin tabla y sin detalles técnicos', async (status) => {
    installAdminBackend({ list: () => apiError(status, 'internal_error') });
    const { res, doc, html } = await get('?status=pagado');
    expect(res.status).toBe(UNAVAILABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    const retry = [...doc.querySelectorAll('[role="alert"] a, [role="alert"] button, main a, main button')].find((el) => text(el).includes('Reintentar'));
    expect(retry).toBeDefined();
    noLeaks(html);
    expect(text(doc.querySelector('main'))).not.toContain('Aún no hay pedidos');
  });

  test('«Reintentar» vuelve a la misma consulta (misma ruta y mismos filtros)', async () => {
    installAdminBackend({ list: () => apiError(ST.SERVER_ERROR, 'internal_error') });
    const { doc } = await get('?status=pagado&q=Ana&page=2');
    const retry = [...doc.querySelectorAll('a')].find((a) => text(a).includes('Reintentar'));
    expect(new URL(retry?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(PATH);
    expect(params(retry?.getAttribute('href') ?? null).get('status')).toBe('pagado');
    expect(params(retry?.getAttribute('href') ?? null).get('q')).toBe('Ana');
  });

  test('sin respuesta (fetch lanza): 503 con «Reintentar», sin trazas ni «fetch failed»', async () => {
    installAdminBackend({
      list: () => {
        throw new TypeError('fetch failed ECONNREFUSED api.test');
      },
    });
    const { res, html, doc } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    noLeaks(html);
    expect(doc.querySelector('table')).toBeNull();
  });

  test('respuesta 200 con cuerpo que no es JSON: 503 y sin tabla', async () => {
    installAdminBackend({ list: () => new Response('<html>boom</html>', { status: OK, headers: { 'content-type': 'text/html' } }) });
    const { res, doc } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(doc.querySelector('table')).toBeNull();
  });

  test.each([
    ['q', 'string_too_long'],
    ['q', 'missing'],
  ])('422 de %s (%s): mensaje junto al campo en español, sin tabla ni vacío, sin el texto del backend', async (field, type) => {
    installAdminBackend({ list: () => queryError(field, type) });
    const { res, doc, html } = await get('?q=Ana');
    expect([OK, UNPROCESSABLE]).toContain(res.status);
    const q = input(doc, 'q');
    expect(q?.getAttribute('aria-invalid')).toBe('true');
    const ids = (q?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.map((id) => text(doc.querySelector(`[id="${id}"]`))).join(' ').trim()).not.toBe('');
    expect(input(doc, 'q')?.getAttribute('value')).toBe('Ana');
    expect(doc.querySelector('table')).toBeNull();
    expect(html).not.toContain(BACKEND_MSG);
    expect(text(doc.querySelector('main'))).not.toContain('Aún no hay pedidos');
    expect(text(doc.querySelector('main'))).not.toContain('No hay pedidos con estos filtros');
  });

  test.each(['created_from', 'created_to'])('422 de %s: el error aparece junto a ese campo y los otros quedan sin marcar', async (field) => {
    installAdminBackend({ list: () => queryError(field, 'date_from_datetime_parsing') });
    const { doc, html } = await get('?created_from=2026-02-31&created_to=2026-02-31');
    expect(input(doc, field)?.getAttribute('aria-invalid')).toBe('true');
    expect(input(doc, 'q')?.getAttribute('aria-invalid')).not.toBe('true');
    expect(html).not.toContain(BACKEND_MSG);
    expect(doc.querySelector('table')).toBeNull();
  });
});

describe('GET /admin/pedidos · autorización (401, 403, rol y sesión)', () => {
  test('sin sesión (locals.session = null): 302 al ingreso con next y ninguna llamada a la API', async () => {
    const be = installAdminBackend();
    const { res } = await get('?status=pagado', { session: null });
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=pagado`)}`);
    expect(be.calls).toHaveLength(NONE);
  });

  test('perfil con role null (forma inesperada) → «No disponible» (503): nunca un acceso, y no se pide el listado', async () => {
    const be = installAdminBackend({ role: null });
    const { res } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(be.lists()).toHaveLength(NONE);
  });

  test.each(['customer', 'Admin', 'ADMIN', 'administrator', '', ' admin'])(
    'perfil con role %j → 403 «Sin permiso» y NUNCA se pide el listado',
    async (role) => {
      const be = installAdminBackend({ role });
      const { res, html } = await get();
      expect(res.status).toBe(FORBIDDEN);
      expect(hoisted.rewrites).toEqual(['/admin/sin-permiso']);
      expect(be.lists()).toHaveLength(NONE);
      expect(html).not.toContain('VAL-');
      expect(signOut).not.toHaveBeenCalled();
    },
  );

  test('/identity/me responde 403 → «Sin permiso» sin pedir el listado', async () => {
    const be = installAdminBackend({ me: () => apiError(ST.FORBIDDEN, 'forbidden') });
    const { res } = await get();
    expect(res.status).toBe(FORBIDDEN);
    expect(be.lists()).toHaveLength(NONE);
  });

  test.each(SERVER_ERRORS)('/identity/me responde %i → 503 «No disponible» sin pedir el listado', async (status) => {
    const be = installAdminBackend({ me: () => apiError(status, 'internal_error') });
    const { res } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(hoisted.rewrites).toEqual(['/admin/no-disponible']);
    expect(be.lists()).toHaveLength(NONE);
  });

  test('/identity/me responde 401 → cierra la sesión local (signOut) y 302 al ingreso', async () => {
    const be = installAdminBackend({ me: () => apiError(ST.UNAUTHORIZED, 'unauthenticated') });
    const { res } = await get('?q=Ana');
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?q=Ana`)}`);
    expect(signOut).toHaveBeenCalledTimes(ONE);
    expect(be.lists()).toHaveLength(NONE);
  });

  test('el listado responde 401 → endSession (signOut) y 302 al ingreso con next; sin datos', async () => {
    installAdminBackend({ list: () => apiError(ST.UNAUTHORIZED, 'unauthenticated') });
    const { res, html } = await get('?status=pagado');
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=pagado`)}`);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(signOut).toHaveBeenCalledTimes(ONE);
    expect(html).toBe('');
  });

  test('el listado responde 403 (rol retirado a media sesión) → «Sin permiso» (403), sin tabla ni datos', async () => {
    installAdminBackend({ list: () => apiError(ST.FORBIDDEN, 'forbidden') });
    const { res, html } = await get();
    expect(res.status).toBe(FORBIDDEN);
    expect(hoisted.rewrites).toEqual(['/admin/sin-permiso']);
    expect(html).not.toContain('<table');
    expect(signOut).not.toHaveBeenCalled();
  });

  test('el listado responde 404 → /404 (por adminErrorResponse)', async () => {
    installAdminBackend({ list: () => apiError(ST.NOT_FOUND, 'not_found') });
    const { res } = await get();
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(hoisted.rewrites).toEqual(['/404']);
  });

  test('el rol sale del perfil del backend, no de la URL ni de la sesión: ?role=admin no abre nada', async () => {
    const be = installAdminBackend({ role: 'customer' });
    const { res } = await get('?role=admin&user_id=otro');
    expect(res.status).toBe(FORBIDDEN);
    expect(be.lists()).toHaveLength(NONE);
  });
});

describe('GET /admin/pedidos · respuestas sin filtraciones', () => {
  test.each([
    ['200', () => json(pageOf([summary()]))],
    ['vacío', () => json(pageOf([]))],
    ['503', () => apiError(ST.UNAVAILABLE, 'internal_error')],
    ['422', () => queryError('q', 'string_too_long')],
  ])('%s: la respuesta es privada (no-store) y sin Bearer ni mensajes técnicos', async (_name, list) => {
    installAdminBackend({ list });
    const { res, html } = await get('?q=x');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get('cache-control')).not.toContain('public');
    noLeaks(html);
  });

  test('la página nunca expone el contenido de la cookie de sesión', async () => {
    installAdminBackend({ list: () => json(pageOf([summary()])) });
    const { html } = await get();
    ['base64-QUJD', 'REVG'].forEach((w) => expect(html).not.toContain(w));
  });

  test('el listado no incluye teléfono ni dirección (no son datos de la tabla)', async () => {
    installAdminBackend({
      list: () => json(pageOf([{ ...summary(), phone: '+51999888777', address_line: 'Av. Secreta 123' } as never])),
    });
    const { html } = await get();
    expect(html).not.toContain('+51999888777');
    expect(html).not.toContain('Av. Secreta 123');
  });
});

describe('GET /admin/pedidos · bordes de la consulta y de los enlaces', () => {
  const SPECIAL = 'Ñandú & Co #1+2 100%';
  const SPECIAL_TOTAL = 45;
  const FAR_PAGE = 999;

  test('q con &, #, +, %, espacios y eñe viaja intacto al backend y vuelve intacto en cada enlace (chips, páginas y detalle)', async () => {
    const be = installAdminBackend({ list: () => json(pageOf(manyOrders(PAGE_SIZE), { total: SPECIAL_TOTAL })) });
    const { doc } = await get(`?q=${encodeURIComponent(SPECIAL)}&status=pagado`);
    expect(be.lists()[NONE].params.q).toBe(SPECIAL);
    const hrefs = [...doc.querySelectorAll('main a[href^="/admin/pedidos?"], nav[aria-label="Paginación"] a')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(ONE);
    hrefs.filter((h) => h?.includes('q=')).forEach((h) => expect(params(h).get('q'), String(h)).toBe(SPECIAL));
    const volver = params(rows(doc)[NONE].querySelector('a')?.getAttribute('href') ?? null).get('volver') ?? '';
    expect(new URLSearchParams(volver).get('q')).toBe(SPECIAL);
    expect(new URLSearchParams(volver).get('status')).toBe('pagado');
  });

  test('q con espacios solo se recorta en los extremos: los internos se conservan', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([])) });
    await get(`?q=${encodeURIComponent('  Ana   María  ')}`);
    expect(be.lists()[NONE].params.q).toBe('Ana   María');
  });

  test('q vacío o solo espacios no es un filtro: no se envía y el vacío es «Aún no hay pedidos»', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([])) });
    const { doc } = await get(`?q=${encodeURIComponent('   ')}`);
    expect(be.lists()[NONE].params).toEqual({ page_size: String(PAGE_SIZE) });
    expect(text(doc.querySelector('main'))).toContain('Aún no hay pedidos');
  });

  test('una página fuera de rango (items vacíos pero total > 0) no dice «Aún no hay pedidos»: sí hay pedidos', async () => {
    installAdminBackend({ list: () => json(pageOf([], { total: SPECIAL_TOTAL, page: FAR_PAGE })) });
    const { res, doc } = await get(`?page=${FAR_PAGE}`);
    expect(res.status).toBeLessThan(HTTP_SERVER_ERROR);
    expect(text(doc.querySelector('main'))).not.toContain('Aún no hay pedidos');
    expect(doc.querySelector('table')).toBeNull();
  });

  test('una página fuera de rango explica «Esta página no existe» y ofrece «Ir a la página 1» con los filtros y sin redirigir', async () => {
    installAdminBackend({ list: () => json(pageOf([], { total: SPECIAL_TOTAL, page: FAR_PAGE })) });
    const { res, doc } = await get(`?status=pagado&q=Ana&page=${FAR_PAGE}`);
    expect(res.status).toBe(OK);
    expect(text(doc.querySelector('main'))).toContain('Esta página no existe');
    const back = [...doc.querySelectorAll('main a')].find((a) => text(a).includes('Ir a la página 1'));
    expect(back).toBeDefined();
    const p = params(back?.getAttribute('href') ?? null);
    expect(p.get('status')).toBe('pagado');
    expect(p.get('q')).toBe('Ana');
    expect([null, '1']).toContain(p.get('page'));
  });

  test('fechas invertidas (desde > hasta) las resuelve el backend: no hay 500 y se pintan tal cual', async () => {
    const be = installAdminBackend({ list: () => json(pageOf([])) });
    const { res, doc } = await get('?created_from=2026-12-01&created_to=2026-11-01');
    expect(res.status).toBe(OK);
    expect(be.lists()[NONE].params).toMatchObject({ created_from: '2026-12-01', created_to: '2026-11-01' });
    expect(input(doc, 'created_from')?.getAttribute('value')).toBe('2026-12-01');
  });

  test('un cuerpo de página con items que no es una lista no rompe la página: 503, sin tabla', async () => {
    installAdminBackend({ list: () => json({ items: null, total: ONE, page: ONE, page_size: PAGE_SIZE }) });
    const { res, doc } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(doc.querySelector('table')).toBeNull();
  });
});
