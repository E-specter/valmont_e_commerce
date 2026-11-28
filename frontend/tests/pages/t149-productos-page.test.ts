import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Productos from '../../src/pages/admin/productos/index.astro';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { productPill } from '../../src/lib/admin/status';
import { formatMoney } from '../../src/lib/format';
import { parseHtml } from '../helpers/render';
import { ST } from '../helpers/t142';
import { BEARER, NO_STORE, ORIGIN, SESSION, USER_ID, json } from '../helpers/t129';
import {
  AT_LIMA, BACKEND_MSG, HOSTILE, LIST_PATH, OTHER_ID, apiError, installAdminBackend, manyProducts, pageOf, product,
} from '../helpers/t149';
import { text } from '../helpers/ui';

// T-149 · ruta GET /admin/productos con la Container API y un `fetch` falso como backend de identity y catalog.
// Como en T-084, `rewrite` se sustituye por una respuesta con el estado de la página destino; la lógica de requireAdmin y
// adminErrorResponse es la real. De extremo a extremo se prueba en el E2E.
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

const PRICE = 8_450_000;
const COST = 987_001_337;
const ON_HAND = 424_242;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const TOTAL_45 = 45;
const LONG_Q = 150;
const MAX_Q = 100;
const MAX_PAGE_SIZE = 48;
const OVERSIZE_PAGE = 500;
const FAR_PAGE = 999;
const FOUND = ST.FOUND;
const OK = ST.OK;
const FORBIDDEN = ST.FORBIDDEN;
const UNAVAILABLE = ST.UNAVAILABLE;
const SERVER_ERRORS = [ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE, ST.GATEWAY_TIMEOUT];
const ALLOWED_KEYS = ['status', 'q', 'page', 'page_size'];
const LEAK_WORDS = ['fetch failed', 'TypeError', 'ECONNREFUSED', 'stack', '.ts:', 'api.test', BACKEND_MSG, BEARER];
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
const PATH = '/admin/productos';
const NEW_PATH = '/admin/productos/nuevo';
const HTTP_SERVER_ERROR = 500;
const DRAFT_ID = '0a0a0a0a-1111-4222-8333-444455556666';
const PUBLISHED_ID = '0b0b0b0b-1111-4222-8333-444455556666';

let signOut: ReturnType<typeof vi.fn>;
type Init = { session?: unknown; cookie?: string };

async function get(query = '', init: Init = {}) {
  const request = new Request(`${ORIGIN}${PATH}${query}`, { headers: { cookie: init.cookie ?? COOKIE_HEADER } });
  const session = 'session' in init ? init.session : SESSION;
  const supabase = { auth: { signOut } };
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Productos, { request, locals: { session, supabase } as never, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

const rows = (d: Document): Element[] => [...d.querySelectorAll('tbody tr')];
const input = (d: Document, name: string): HTMLInputElement | null => d.querySelector(`input[name="${name}"]`);
const pager = (d: Document): HTMLAnchorElement[] => [...d.querySelectorAll('nav[aria-label="Paginación"] a')] as HTMLAnchorElement[];
const pageLink = (d: Document, n: number): HTMLAnchorElement | undefined => pager(d).find((a) => a.getAttribute('aria-label') === `Página ${n}`);
const params = (href: string | null): URLSearchParams => new URL(href ?? '', 'http://x.test').searchParams;
const link = (d: Document, label: string): HTMLAnchorElement | undefined => [...d.querySelectorAll('a')].find((a) => text(a) === label) as HTMLAnchorElement | undefined;
const noLeaks = (html: string): void => LEAK_WORDS.forEach((w) => expect(html, w).not.toContain(w));
const mainText = (d: Document): string => text(d.querySelector('main'));
const listing = (items: unknown[] = [product()]) => installAdminBackend({ list: (seen) => json(pageOf(items, seen)) });

beforeEach(() => {
  signOut = vi.fn(async () => ({ error: null }));
  hoisted.rewrites.length = NONE;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /admin/productos · 200 con datos', () => {
  test('200: único h1 «Productos», noindex, respuesta privada y una tabla con una fila por producto', async () => {
    listing(manyProducts(THREE));
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1'))).toBe('Productos');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelectorAll('table')).toHaveLength(ONE);
    expect(rows(doc)).toHaveLength(THREE);
  });

  test('pide /identity/me y luego UNA sola GET al listado de administración, con el Bearer de la sesión', async () => {
    const be = listing();
    await get();
    expect(be.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['GET /api/v1/identity/me', `GET ${LIST_PATH}`]);
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
  });

  test('sin filtros la consulta solo lleva page_size fijo (entre 1 y 48), nunca elegido por la URL', async () => {
    const be = listing();
    await get();
    const sent = be.lists()[NONE].params;
    expect(Object.keys(sent)).toEqual(['page_size']);
    expect(Number(sent.page_size)).toBeGreaterThanOrEqual(ONE);
    expect(Number(sent.page_size)).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  test('solo lectura: ninguna llamada que no sea GET', async () => {
    const be = listing();
    await get('?status=draft&q=Ana');
    expect(be.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(be.others()).toHaveLength(NONE);
  });

  test('«Productos» del menú es un enlace a /admin/productos con aria-current="page"; las demás entradas sin pantalla siguen deshabilitadas', async () => {
    listing();
    const { doc } = await get();
    const nav = doc.querySelector('nav[aria-label="Administración"]');
    const current = nav?.querySelector('a[href="/admin/productos"]');
    expect(current?.getAttribute('aria-current')).toBe('page');
    expect(nav?.querySelectorAll('a[aria-current="page"]')).toHaveLength(ONE);
    expect(nav?.querySelectorAll('[aria-disabled="true"]')).toHaveLength(ADMIN_NAV.filter((e) => !e.enabled).length);
  });

  test('«Nuevo producto» es un enlace a /admin/productos/nuevo', async () => {
    listing();
    const { doc } = await get();
    const nuevo = [...doc.querySelectorAll('a')].filter((a) => text(a) === 'Nuevo producto');
    expect(nuevo.length).toBeGreaterThanOrEqual(ONE);
    nuevo.forEach((a) => expect(new URL(a.getAttribute('href') ?? '', ORIGIN).pathname).toBe(NEW_PATH));
  });

  test('borrador y publicado salen con su pill (productPill), precio de formatMoney, fecha de Lima y enlace al formulario', async () => {
    listing([
      product({ id: DRAFT_ID, status: 'draft', name: 'Borrador QA' }),
      product({ id: PUBLISHED_ID, status: 'published', name: 'Publicado QA', price: { amount: PRICE, currency: 'PEN' } }),
    ]);
    const { doc } = await get();
    const [draft, published] = rows(doc);
    expect(text(draft.querySelector('.pill'))).toBe(productPill('draft').label);
    expect(text(published.querySelector('.pill'))).toBe(productPill('published').label);
    expect(draft.querySelector('.pill')?.getAttribute('data-tone')).toBe(productPill('draft').tone);
    expect(published.querySelector('.pill')?.getAttribute('data-tone')).toBe(productPill('published').tone);
    expect(text(published)).toContain(formatMoney({ amount: PRICE, currency: 'PEN' }).replaceAll(' ', ' '));
    expect(text(draft)).toContain(AT_LIMA);
    expect(new URL(draft.querySelector('a')?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(`${PATH}/${DRAFT_ID}`);
    expect(new URL(published.querySelector('a')?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(`${PATH}/${PUBLISHED_ID}`);
  });

  test('un producto sin imagen no rompe la página', async () => {
    listing([product({ main_image: null })]);
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(rows(doc)).toHaveLength(ONE);
  });

  test('nunca se pinta el Bearer, el id del administrador ni el rol', async () => {
    listing([product()]);
    const { html } = await get();
    [BEARER, USER_ID, OTHER_ID].forEach((w) => expect(html, w).not.toContain(w));
  });

  test('nombre hostil se pinta como texto, sin scripts ni elementos inyectados', async () => {
    listing([product({ name: HOSTILE })]);
    const { html, doc } = await get();
    expect([...doc.querySelectorAll('script')].some((el) => (el.textContent ?? '').includes('__pwn'))).toBe(false);
    expect(doc.querySelector('img[src="x"], [onerror]')).toBeNull();
    expect(text(rows(doc)[NONE])).toContain(HOSTILE);
  });

  test('console limpia: la página no escribe en la consola del servidor', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    listing();
    await get('?status=draft&q=Ana');
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });
});

describe('GET /admin/productos · la consulta sale solo de una lista cerrada (estado, búsqueda, página)', () => {
  test('filtros válidos viajan al backend', async () => {
    const be = listing();
    await get('?status=published&q=Ana&page=2');
    expect(be.lists()[NONE].params).toMatchObject({ status: 'published', q: 'Ana', page: '2' });
    expect(Object.keys(be.lists()[NONE].params).sort()).toEqual([...ALLOWED_KEYS].sort());
  });

  test.each(['?status=otro', '?status=Draft', '?status=PUBLISHED', '?status=pagado', '?status=', '?page=0', '?page=-1', '?page=1e3', '?page=abc', '?page=12345', '?page=1.5'])(
    '%s se ignora sin error: 200 y ningún valor inválido llega al backend',
    async (query) => {
      const be = listing();
      const { res } = await get(query);
      expect(res.status).toBe(OK);
      const sent = be.lists()[NONE].params;
      expect(Object.keys(sent)).toEqual(['page_size']);
    },
  );

  test('claves ajenas se descartan: category, category_id, sort, page_size=500, user_id, role, offset, order_by, limit, id', async () => {
    const be = listing();
    await get(
      `?category=clasicos&category_id=${OTHER_ID}&user_id=${OTHER_ID}&sort=asc&page_size=${OVERSIZE_PAGE}&role=admin&offset=40&order_by=price&limit=999&id=1&status=draft`,
    );
    const sent = be.lists()[NONE].params;
    expect(sent.status).toBe('draft');
    expect(Object.keys(sent).filter((k) => !ALLOWED_KEYS.includes(k))).toEqual([]);
    expect(Number(sent.page_size)).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(sent.page_size).not.toBe(String(OVERSIZE_PAGE));
  });

  test('un parámetro repetido no se convierte en lista: gana un solo valor', async () => {
    const be = listing();
    await get('?status=draft&status=published&q=a&q=b');
    expect(be.lists()[NONE].url.searchParams.getAll('status')).toHaveLength(ONE);
    expect(be.lists()[NONE].url.searchParams.getAll('q')).toHaveLength(ONE);
  });

  test('q se recorta de espacios y a 100 caracteres; los espacios internos se conservan', async () => {
    const be = listing();
    await get(`?q=${encodeURIComponent('  Ana   María  ')}`);
    expect(be.lists()[NONE].params.q).toBe('Ana   María');
    await get(`?q=${'z'.repeat(LONG_Q)}`);
    expect(be.lists()[ONE].params.q).toHaveLength(MAX_Q);
  });

  test('q vacío o solo espacios no es un filtro: no se envía y el vacío es «Aún no hay productos»', async () => {
    const be = installAdminBackend({ list: (seen) => json(pageOf([], seen)) });
    const { doc } = await get(`?q=${encodeURIComponent('   ')}`);
    expect(Object.keys(be.lists()[NONE].params)).toEqual(['page_size']);
    expect(mainText(doc)).toContain('Aún no hay productos');
  });

  test('q con caracteres de SQL o HTML viaja como parámetro codificado y no rompe la página', async () => {
    const hostile = `'; DROP TABLE products; -- <b>x</b>`;
    const be = listing([]);
    const { res, doc } = await get(`?q=${encodeURIComponent(hostile)}`);
    expect(res.status).toBe(OK);
    expect(be.lists()[NONE].params.q).toBe(hostile);
    expect(doc.querySelector('main b')).toBeNull();
    expect(input(doc, 'q')?.getAttribute('value')).toBe(hostile);
  });

  test('q hostil en la URL se escapa en el campo (sin scripts inyectados)', async () => {
    listing([]);
    const attack = '"><script>window.__pwn=1</script>';
    const { doc } = await get(`?q=${encodeURIComponent(attack)}`);
    expect([...doc.querySelectorAll('script')].some((el) => (el.textContent ?? '').includes('__pwn'))).toBe(false);
    expect(input(doc, 'q')?.getAttribute('value')).toBe(attack);
  });

  test('q con &, #, +, %, espacios y eñe viaja intacto y vuelve intacto en los enlaces de chips y de página', async () => {
    const special = 'Ñandú & Co #1+2 100%';
    const be = installAdminBackend({ list: (seen) => json(pageOf(manyProducts(THREE), seen, { total: TOTAL_45 })) });
    const { doc } = await get(`?q=${encodeURIComponent(special)}&status=draft`);
    expect(be.lists()[NONE].params.q).toBe(special);
    const hrefs = [...doc.querySelectorAll('main a[href^="/admin/productos?"], nav[aria-label="Paginación"] a')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(ONE);
    hrefs.filter((h) => h?.includes('q=')).forEach((h) => expect(params(h).get('q'), String(h)).toBe(special));
  });
});

describe('GET /admin/productos · filtros (GET, sin JavaScript)', () => {
  test('los filtros válidos se pintan: q en el campo y el chip del estado activo (aria-current)', async () => {
    listing();
    const { doc } = await get('?status=draft&q=Ana&evil=1&page=zz');
    expect(input(doc, 'q')?.getAttribute('value')).toBe('Ana');
    expect(link(doc, 'Borrador')?.getAttribute('aria-current')).toBeTruthy();
    expect(link(doc, 'Publicado')?.getAttribute('aria-current')).toBeNull();
    expect(link(doc, 'Todos')?.getAttribute('aria-current')).toBeNull();
  });

  test('los filtros inválidos no se pintan: campo vacío y «Todos» activo', async () => {
    listing();
    const { doc } = await get('?status=otro&q=');
    expect(input(doc, 'q')?.getAttribute('value') ?? '').toBe('');
    expect(link(doc, 'Todos')?.getAttribute('aria-current')).toBeTruthy();
  });

  test('chips «Todos», «Borrador» y «Publicado» son enlaces (funcionan sin JavaScript), en ese orden', async () => {
    listing();
    const { doc } = await get();
    const chips = [...doc.querySelectorAll('nav a')].filter((a) => ['Todos', 'Borrador', 'Publicado'].includes(text(a)));
    expect(chips.map((a) => text(a))).toEqual(['Todos', 'Borrador', 'Publicado']);
    chips.forEach((a) => expect(a.getAttribute('href')).toContain(PATH));
  });

  test('cada chip conserva q y vuelve a la página 1; «Todos» quita el estado', async () => {
    listing(manyProducts(THREE));
    const { doc } = await get('?status=draft&q=Ana&page=3');
    const pub = params(link(doc, 'Publicado')?.getAttribute('href') ?? null);
    expect(pub.get('status')).toBe('published');
    expect(pub.get('q')).toBe('Ana');
    expect([null, '1']).toContain(pub.get('page'));
    const all = params(link(doc, 'Todos')?.getAttribute('href') ?? null);
    expect(all.get('status')).toBeNull();
    expect(all.get('q')).toBe('Ana');
    expect([null, '1']).toContain(all.get('page'));
  });

  test('el formulario es un GET hacia /admin/productos con campo type=search name=q, etiqueta y botón «Aplicar» de envío', async () => {
    listing();
    const { doc } = await get('?q=Ana');
    const q = input(doc, 'q');
    const form = q?.closest('form');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(new URL(form?.getAttribute('action') ?? PATH, ORIGIN).pathname).toBe(PATH);
    expect(q?.getAttribute('type')).toBe('search');
    expect(text(doc.querySelector(`label[for="${q?.id}"]`))).not.toBe('');
    const apply = [...(form?.querySelectorAll('button') ?? [])].find((b) => text(b).includes('Aplicar'));
    expect(apply?.getAttribute('type')).not.toBe('button');
    expect(doc.querySelector('main form[method="post" i]')).toBeNull();
  });

  test('aplicar conserva el estado activo (campo oculto) y nunca arrastra page: aplicar → página 1', async () => {
    listing(manyProducts(THREE));
    const { doc } = await get('?status=published&q=Ana&page=3');
    const form = input(doc, 'q')?.closest('form');
    expect(form?.querySelector('input[name="status"]')?.getAttribute('value')).toBe('published');
    expect(form?.querySelector('input[name="page"]')).toBeNull();
    expect(form?.querySelector('input[name="page_size"]')).toBeNull();
  });

  test('«Limpiar filtros» lleva a /admin/productos sin consulta', async () => {
    listing();
    const { doc } = await get('?status=draft&q=Ana');
    const clear = link(doc, 'Limpiar filtros');
    expect(clear).toBeDefined();
    const target = new URL(clear?.getAttribute('href') ?? '', ORIGIN);
    expect(target.pathname).toBe(PATH);
    expect(target.search).toBe('');
  });

  test('no hay filtro de categoría (el contrato no lo ofrece): ningún campo ni chip de categoría', async () => {
    listing();
    const { doc } = await get();
    expect(doc.querySelector('[name="category"], [name="category_id"], select[name]')).toBeNull();
    expect(mainText(doc).toLowerCase()).not.toContain('categoría:');
  });
});

describe('GET /admin/productos · paginación', () => {
  const filtered = '?status=draft&q=Ana';
  const many = () => installAdminBackend({ list: (seen) => json(pageOf(manyProducts(THREE), seen, { total: TOTAL_45 })) });

  test('45 productos con el tamaño de página que envió la página → varias páginas; la actual lleva aria-current', async () => {
    many();
    const { doc } = await get('?page=2');
    const numbered = pager(doc).filter((a) => a.getAttribute('aria-label')?.startsWith('Página '));
    expect(numbered.length).toBeGreaterThanOrEqual(TWO);
    expect(pageLink(doc, TWO)?.getAttribute('aria-current')).toBe('page');
    expect(pageLink(doc, ONE)?.getAttribute('aria-current')).toBeNull();
  });

  test('los enlaces de página conservan estado y texto, y cambian solo page; page_size nunca aparece', async () => {
    many();
    const { doc } = await get(filtered);
    const target = pageLink(doc, TWO);
    const p = params(target?.getAttribute('href') ?? null);
    expect(new URL(target?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(PATH);
    expect(Object.fromEntries(p.entries())).toEqual({ status: 'draft', q: 'Ana', page: String(TWO) });
    pager(doc).forEach((a) => expect(a.getAttribute('href') ?? '').not.toContain('page_size'));
  });

  test('Anterior y Siguiente (rel=prev/next) respetan los filtros', async () => {
    many();
    const { doc } = await get(`${filtered}&page=2`);
    const prev = doc.querySelector('a[rel="prev"]')?.getAttribute('href') ?? null;
    const next = doc.querySelector('a[rel="next"]')?.getAttribute('href') ?? null;
    expect(params(next).get('page')).toBe(String(THREE));
    expect(params(next).get('status')).toBe('draft');
    expect([null, '1']).toContain(params(prev).get('page'));
    expect(params(prev).get('q')).toBe('Ana');
  });

  test('con una sola página no se pinta la paginación', async () => {
    listing(manyProducts(THREE));
    const { doc } = await get();
    expect(pager(doc)).toHaveLength(NONE);
  });

  test('una página fuera de rango (items vacíos y total > 0): «Esta página no existe», «Ir a la página 1» con los filtros, sin redirigir ni tabla', async () => {
    installAdminBackend({ list: (seen) => json(pageOf([], seen, { total: TOTAL_45, page: FAR_PAGE })) });
    const { res, doc } = await get(`?status=draft&q=Ana&page=${FAR_PAGE}`);
    expect(res.status).toBe(OK);
    expect(res.headers.get('location')).toBeNull();
    expect(mainText(doc)).toContain('Esta página no existe');
    expect(mainText(doc)).not.toContain('Aún no hay productos');
    expect(doc.querySelector('table')).toBeNull();
    const back = [...doc.querySelectorAll('main a')].find((a) => text(a).includes('Ir a la página 1'));
    expect(back).toBeDefined();
    const p = params(back?.getAttribute('href') ?? null);
    expect(p.get('status')).toBe('draft');
    expect(p.get('q')).toBe('Ana');
    expect([null, '1']).toContain(p.get('page'));
  });
});

describe('GET /admin/productos · vacío, error y 422', () => {
  const empty = () => installAdminBackend({ list: (seen) => json(pageOf([], seen)) });

  test('vacío con filtros: «No hay productos con estos filtros», «Limpiar filtros» sin consulta y ninguna tabla', async () => {
    empty();
    const { res, doc } = await get('?status=published&q=zzzz');
    expect(res.status).toBe(OK);
    expect(mainText(doc)).toContain('No hay productos con estos filtros');
    expect(doc.querySelector('table')).toBeNull();
    const clear = [...doc.querySelectorAll('main a')].filter((a) => text(a) === 'Limpiar filtros');
    expect(clear.length).toBeGreaterThanOrEqual(ONE);
    clear.forEach((a) => expect(new URL(a.getAttribute('href') ?? '', ORIGIN).search).toBe(''));
  });

  test('vacío sin filtros: «Aún no hay productos» con «Nuevo producto», sin mensaje de filtros y sin tabla', async () => {
    empty();
    const { doc } = await get();
    expect(mainText(doc)).toContain('Aún no hay productos');
    expect(mainText(doc)).not.toContain('con estos filtros');
    expect(doc.querySelector('table')).toBeNull();
    expect([...doc.querySelectorAll('a')].some((a) => text(a) === 'Nuevo producto' && a.getAttribute('href') === NEW_PATH)).toBe(true);
  });

  test('parámetros inválidos no cuentan como filtros: vacío sin filtros', async () => {
    empty();
    const { doc } = await get('?status=otro&page=0');
    expect(mainText(doc)).toContain('Aún no hay productos');
  });

  test.each(SERVER_ERRORS)('error %i del listado: 503, «Reintentar», sin tabla y sin detalles técnicos', async (status) => {
    installAdminBackend({ list: () => apiError(status, 'internal_error') });
    const { res, doc, html } = await get('?status=draft');
    expect(res.status).toBe(UNAVAILABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelector('table')).toBeNull();
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect([...doc.querySelectorAll('a, button')].some((el) => text(el).includes('Reintentar'))).toBe(true);
    noLeaks(html);
    expect(mainText(doc)).not.toContain('Aún no hay productos');
  });

  test('«Reintentar» vuelve a la misma consulta (misma ruta y mismos filtros)', async () => {
    installAdminBackend({ list: () => apiError(ST.SERVER_ERROR, 'internal_error') });
    const { doc } = await get('?status=draft&q=Ana&page=2');
    const retry = [...doc.querySelectorAll('a')].find((a) => text(a).includes('Reintentar'));
    expect(new URL(retry?.getAttribute('href') ?? '', ORIGIN).pathname).toBe(PATH);
    expect(params(retry?.getAttribute('href') ?? null).get('status')).toBe('draft');
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
    ['items null', { items: null, total: ONE, page: ONE, page_size: MAX_Q }],
    ['items objeto', { items: {}, total: ONE, page: ONE, page_size: MAX_Q }],
    ['items texto', { items: 'x', total: ONE, page: ONE, page_size: MAX_Q }],
    ['sin items', { total: ONE, page: ONE, page_size: MAX_Q }],
    ['cuerpo null', null],
    ['cuerpo arreglo', []],
    ['cuerpo texto', 'ok'],
  ])('forma inesperada (%s): 503 con «Reintentar», sin tabla ni 500', async (_name, body) => {
    installAdminBackend({ list: () => json(body) });
    const { res, doc, html } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(doc.querySelector('table')).toBeNull();
    expect([...doc.querySelectorAll('a, button')].some((el) => text(el).includes('Reintentar'))).toBe(true);
    noLeaks(html);
  });

  test('422 sobre q: el mensaje va junto al campo, en español, sin el texto del backend, sin tabla ni mensajes de vacío', async () => {
    installAdminBackend({ list: () => apiError(ST.UNPROCESSABLE, 'validation_error', [{ loc: ['query', 'q'], type: 'string_too_long', msg: BACKEND_MSG }]) });
    const { res, doc, html } = await get('?q=Ana');
    expect(res.status).toBeLessThan(HTTP_SERVER_ERROR);
    const q = input(doc, 'q');
    expect(q?.getAttribute('aria-invalid')).toBe('true');
    const ids = (q?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(ids.map((id) => text(doc.querySelector(`[id="${id}"]`))).join(' ').trim()).not.toBe('');
    expect(q?.getAttribute('value')).toBe('Ana');
    expect(doc.querySelector('table')).toBeNull();
    expect(html).not.toContain(BACKEND_MSG);
    expect(mainText(doc)).not.toContain('Aún no hay productos');
    expect(mainText(doc)).not.toContain('No hay productos con estos filtros');
  });
});

describe('GET /admin/productos · autorización (401, 403, rol y sesión)', () => {
  test('sin sesión (locals.session = null): 302 al ingreso con next y ninguna llamada a la API', async () => {
    const be = installAdminBackend();
    const { res } = await get('?status=draft', { session: null });
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=draft`)}`);
    expect(be.calls).toHaveLength(NONE);
  });

  test('perfil con role null (forma inesperada) → «No disponible» (503): nunca un acceso, y no se pide el listado', async () => {
    const be = installAdminBackend({ role: null });
    const { res } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(be.lists()).toHaveLength(NONE);
  });

  test.each(['customer', 'Admin', 'ADMIN', 'administrator', '', ' admin'])(
    'perfil con role %j → 403 «Sin permiso» y NUNCA se pide el listado ni se pintan productos',
    async (role) => {
      const be = installAdminBackend({ role, list: (seen) => json(pageOf([product({ name: 'SECRETO-QX' })], seen)) });
      const { res, html } = await get();
      expect(res.status).toBe(FORBIDDEN);
      expect(hoisted.rewrites).toEqual(['/admin/sin-permiso']);
      expect(be.lists()).toHaveLength(NONE);
      expect(html).not.toContain('SECRETO-QX');
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
    const { res, html } = await get('?status=draft');
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=draft`)}`);
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

  test('el rol sale del perfil del backend, no de la URL: ?role=admin no abre nada', async () => {
    const be = installAdminBackend({ role: 'customer' });
    const { res } = await get('?role=admin&user_id=otro');
    expect(res.status).toBe(FORBIDDEN);
    expect(be.lists()).toHaveLength(NONE);
  });
});

describe('GET /admin/productos · respuestas sin filtraciones', () => {
  test.each([
    ['200', (s: Parameters<typeof pageOf>[1]) => json(pageOf([product()], s))],
    ['vacío', (s: Parameters<typeof pageOf>[1]) => json(pageOf([], s))],
    ['503', () => apiError(ST.UNAVAILABLE, 'internal_error')],
  ])('%s: la respuesta es privada (no-store) y sin Bearer ni mensajes técnicos', async (_name, reply) => {
    installAdminBackend({ list: (seen) => reply(seen) });
    const { res, html } = await get('?q=x');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get('cache-control')).not.toContain('public');
    noLeaks(html);
  });

  test('la página nunca expone el contenido de la cookie de sesión', async () => {
    listing();
    const { html } = await get();
    ['base64-QUJD', 'REVG'].forEach((w) => expect(html).not.toContain(w));
  });

  test('campos que el contrato no tiene (costo, nota interna, stock) no llegan a la pantalla aunque el servidor los enviara', async () => {
    const extra = { ...product(), cost_price: COST, internal_note: 'NOTA-INTERNA-QX', stock_on_hand: ON_HAND };
    listing([extra]);
    const { html } = await get();
    ['NOTA-INTERNA-QX', '987001337', '424242'].forEach((w) => expect(html, w).not.toContain(w));
  });
});
