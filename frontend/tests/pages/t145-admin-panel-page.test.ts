import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Panel from '../../src/pages/admin/index.astro';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { formatDateTimeNumeric, formatMoney } from '../../src/lib/format';
import { parseHtml } from '../helpers/render';
import { ST } from '../helpers/t142';
import { BEARER, NO_STORE, ORIGIN, SESSION, USER_ID, json } from '../helpers/t129';
import { HOSTILE, OTHER_USER } from '../helpers/t084';
import {
  BACKEND_MSG, EXPECTED_SIGNATURES, KEYS, KPI_LABELS, LOW_ROWS, PREPARE_ROWS, TOTALS, apiError, errorKpis, installPanelBackend, kpi, kpiState, kpiValue,
  lowStockItems, ordersToPrepare, signature, stockItem, summary, type Key,
} from '../helpers/t145';
import { text } from '../helpers/ui';

// T-145 · ruta GET /admin (panel) con la Container API y un `fetch` falso como backend de identity, orders e inventory.
// La guardia del middleware (T-126) y el rewrite real no corren aquí: `rewrite` devuelve una respuesta con el estado de la página destino
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
const OK = ST.OK;
const FOUND = ST.FOUND;
const FORBIDDEN = ST.FORBIDDEN;
const UNAVAILABLE = ST.UNAVAILABLE;
const NOT_FOUND = ST.NOT_FOUND;
const PATH = '/admin';
const TIMEOUT_MS = 4000;
const SERVER_ERRORS = [ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE, ST.GATEWAY_TIMEOUT];
const LEAK_WORDS = ['fetch failed', 'TypeError', 'ECONNREFUSED', 'stack', '.ts:', 'api.test', BACKEND_MSG, BEARER];
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
const KPI_BY_KEY: Partial<Record<Key, string>> = { pagado: KPI_LABELS.toPrepare, pendiente_pago: KPI_LABELS.pendingPayment, low_stock: KPI_LABELS.lowStock };
const DATA_LABELS = [KPI_LABELS.toPrepare, KPI_LABELS.pendingPayment, KPI_LABELS.lowStock];
const GARBAGE = ['NaN', 'undefined', '[object'];

let signOut: ReturnType<typeof vi.fn>;
type Init = { session?: unknown; cookie?: string; query?: string };

async function get(init: Init = {}) {
  const request = new Request(`${ORIGIN}${PATH}${init.query ?? ''}`, { headers: { cookie: init.cookie ?? COOKIE_HEADER } });
  const session = 'session' in init ? init.session : SESSION;
  const supabase = { auth: { signOut } };
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Panel, { request, locals: { session, supabase } as never, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

const rows = (d: Document, caption: string): Element[] => {
  const table = [...d.querySelectorAll('table')].find((t) => text(t.querySelector('caption')).toLowerCase().includes(caption.toLowerCase()));
  return table ? [...table.querySelectorAll('tbody tr')] : [];
};
const orderRows = (d: Document): Element[] => rows(d, 'por preparar');
const stockRows = (d: Document): Element[] => rows(d, 'stock');
const links = (d: ParentNode): HTMLAnchorElement[] => [...d.querySelectorAll('a')] as HTMLAnchorElement[];
const path = (a: Element | undefined | null): string => new URL(a?.getAttribute('href') ?? '', 'http://x.test').pathname;
const retries = (d: ParentNode): Element[] => [...d.querySelectorAll('a, button')].filter((el) => text(el).toLowerCase().includes('reintentar'));
const noLeaks = (html: string): void => LEAK_WORDS.forEach((w) => expect(html, w).not.toContain(w));
const noGarbage = (html: string): void => GARBAGE.forEach((g) => expect(html, g).not.toContain(g));
const throwNetwork = (): never => {
  throw new TypeError('fetch failed');
};
const fail = (status: number) => () => apiError(status, 'internal_error');

beforeEach(() => {
  signOut = vi.fn(async () => ({ error: null }));
  hoisted.rewrites.length = NONE;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /admin · con la API sana', () => {
  test('200: único h1 «Panel», noindex y respuesta privada (no-store)', async () => {
    installPanelBackend();
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1'))).toBe('Panel');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test('los KPI muestran el `total` de cada listado y «Ventas del período» está pending con «Sin contrato»', async () => {
    installPanelBackend();
    const { doc } = await get();
    expect(kpiValue(doc, KPI_LABELS.toPrepare)).toBe(String(TOTALS.toPrepare));
    expect(kpiValue(doc, KPI_LABELS.pendingPayment)).toBe(String(TOTALS.pendingPayment));
    expect(kpiValue(doc, KPI_LABELS.lowStock)).toBe(String(TOTALS.lowStock));
    expect(kpiState(doc, KPI_LABELS.sales)).toBe('pending');
    expect(text(kpi(doc, KPI_LABELS.sales)?.querySelector('.value'))).toBe('Sin contrato');
    expect(errorKpis(doc)).toHaveLength(NONE);
  });

  test('la alerta dice «N productos agotados» con el total real', async () => {
    installPanelBackend();
    const { doc } = await get();
    expect(text(doc.body)).toContain(`${TOTALS.outOfStock} productos agotados`);
  });

  // Decisión del Leader: «N productos con stock bajo» es válido; se exige el número y «con stock bajo» en la misma alerta.
  test('la alerta de stock bajo lleva el total real y «con stock bajo»', async () => {
    installPanelBackend();
    const { doc } = await get();
    const alert = [...doc.querySelectorAll('li')].find((li) => text(li).includes('con stock bajo'));
    expect(alert, 'falta la alerta de stock bajo').toBeDefined();
    expect(text(alert).startsWith(String(TOTALS.lowStock))).toBe(true);
  });

  test('«Pedidos por preparar»: las 5 filas recibidas, en el orden recibido, con enlace al detalle del pedido', async () => {
    installPanelBackend();
    const { doc } = await get();
    const expected = ordersToPrepare();
    const r = orderRows(doc);
    expect(r).toHaveLength(PREPARE_ROWS);
    r.forEach((row, i) => {
      expect(text(row.querySelector('a'))).toBe(expected[i].number);
      expect(path(row.querySelector('a'))).toBe(`/admin/pedidos/${expected[i].id}`);
    });
  });

  test('cada fila: destinatario, total con formatMoney y fecha con formatDateTimeNumeric (nada se calcula en el cliente)', async () => {
    installPanelBackend();
    const { doc } = await get();
    const first = ordersToPrepare()[NONE];
    const row = text(orderRows(doc)[NONE]);
    const expectedTotal = formatMoney(first.total).replaceAll(' ', ' ');
    expect(row).toContain(first.recipient_name);
    expect(row).toContain(expectedTotal);
    expect(row).toContain(formatDateTimeNumeric(first.created_at));
  });

  test('«Ver todos» lleva a /admin/pedidos?status=pagado', async () => {
    installPanelBackend();
    const { doc } = await get();
    expect(links(doc).find((a) => text(a).startsWith('Ver todos'))?.getAttribute('href')).toBe('/admin/pedidos?status=pagado');
  });

  test('mini tabla «Stock bajo»: las 4 filas en el orden recibido, con nombre, disponibles y enlace al producto', async () => {
    installPanelBackend();
    const { doc } = await get();
    const expected = lowStockItems();
    const r = stockRows(doc);
    expect(r).toHaveLength(LOW_ROWS);
    r.forEach((row, i) => {
      expect(text(row)).toContain(expected[i].name);
      expect(text(row)).toContain(String(expected[i].available));
      expect(path(row.querySelector('a'))).toBe(`/admin/productos/${expected[i].product_id}`);
    });
  });

  test('«Panel» del menú es un enlace a /admin con aria-current="page"; las demás entradas no lo llevan', async () => {
    installPanelBackend();
    const { doc } = await get();
    const nav = doc.querySelector('nav[aria-label="Administración"]');
    const current = [...(nav?.querySelectorAll('[aria-current]') ?? [])];
    expect(current).toHaveLength(ONE);
    expect(current[NONE].getAttribute('aria-current')).toBe('page');
    expect(current[NONE].getAttribute('href')).toBe('/admin');
    expect(text(current[NONE])).toContain('Panel');
    expect(nav?.querySelectorAll('[aria-disabled="true"]')).toHaveLength(ADMIN_NAV.filter((e) => !e.enabled).length);
  });

  test('un solo <main id="contenido"> y la navegación de administración', async () => {
    installPanelBackend();
    const { doc } = await get();
    expect(doc.querySelectorAll('main')).toHaveLength(ONE);
    expect(doc.querySelector('main#contenido')).not.toBeNull();
    expect(doc.querySelectorAll('nav[aria-label="Administración"]')).toHaveLength(ONE);
  });

  test('el total no sale de contar filas: 137 con 5 filas muestra 137', async () => {
    installPanelBackend();
    const { doc } = await get();
    expect(orderRows(doc)).toHaveLength(PREPARE_ROWS);
    expect(kpiValue(doc, KPI_LABELS.toPrepare)).not.toBe(String(PREPARE_ROWS));
  });
});

describe('GET /admin · las llamadas al backend', () => {
  test('pide /identity/me y exactamente 4 GET de datos con sus consultas exactas, todas con el Bearer de la sesión', async () => {
    const be = installPanelBackend();
    await get();
    expect(be.me()).toHaveLength(ONE);
    expect(be.data().map(signature).sort()).toEqual([...EXPECTED_SIGNATURES].sort());
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
    expect(be.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(be.others()).toHaveLength(NONE);
  });

  test('«identity/me» se resuelve antes de pedir datos (los datos no se piden sin un administrador verificado)', async () => {
    const be = installPanelBackend();
    await get();
    expect(be.calls[NONE].url.pathname).toBe('/api/v1/identity/me');
  });

  test('las 4 llamadas de datos salen a la vez (ninguna espera a otra)', async () => {
    installPanelBackend({ barrier: true });
    const { res } = await get();
    expect(res.status).toBe(OK);
  }, TIMEOUT_MS);

  test('ninguna llamada a reportes ni a otros recursos; «Ventas del período» no llama a la API', async () => {
    const be = installPanelBackend();
    await get();
    expect(be.calls.some((c) => c.url.pathname.includes('report'))).toBe(false);
    expect(be.data()).toHaveLength(EXPECTED_SIGNATURES.length);
  });

  test('los parámetros de la URL no viajan al backend ni cambian la consulta (?status, ?page, ?user_id, ?role)', async () => {
    const be = installPanelBackend();
    await get({ query: `?status=cancelado&page=3&user_id=${OTHER_USER}&role=admin&page_size=500&q=x` });
    expect(be.data().map(signature).sort()).toEqual([...EXPECTED_SIGNATURES].sort());
  });

  test('solo lectura: ninguna llamada distinta de GET y ningún cuerpo', async () => {
    const be = installPanelBackend();
    await get();
    expect(be.calls.every((c) => c.method === 'GET' && c.body === null)).toBe(true);
  });
});

describe('GET /admin · vacíos', () => {
  const empty = () => ({ items: [], total: NONE, page: ONE, page_size: ONE });

  test('sin pedidos pagados: «Nada por preparar» y KPI 0 (un dato, no un error)', async () => {
    installPanelBackend({ replies: { pagado: empty } });
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(text(doc.body)).toContain('Nada por preparar');
    expect(kpiValue(doc, KPI_LABELS.toPrepare)).toBe('0');
    expect(kpiState(doc, KPI_LABELS.toPrepare)).toBe('data');
    expect(orderRows(doc)).toHaveLength(NONE);
  });

  test('sin stock bajo: «Sin productos con stock bajo», KPI 0 y sin alerta «con stock bajo»', async () => {
    installPanelBackend({ replies: { low_stock: empty } });
    const { doc } = await get();
    expect(text(doc.body)).toContain('Sin productos con stock bajo');
    expect(kpiValue(doc, KPI_LABELS.lowStock)).toBe('0');
    expect(text(doc.body)).not.toContain('0 con stock bajo');
    expect(text(doc.body)).not.toContain('0 productos con stock bajo');
  });

  test('sin agotados: no hay alerta de agotados', async () => {
    installPanelBackend({ replies: { out_of_stock: empty } });
    const { doc } = await get();
    expect(text(doc.body).toLowerCase()).not.toContain('productos agotados');
  });

  test('todo vacío: 200, KPI en 0, ambos estados vacíos y ninguna alerta', async () => {
    installPanelBackend({ replies: { pagado: empty, pendiente_pago: empty, low_stock: empty, out_of_stock: empty } });
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    DATA_LABELS.forEach((l) => expect(kpiValue(doc, l), l).toBe('0'));
    expect(text(doc.body)).toContain('Nada por preparar');
    expect(text(doc.body)).toContain('Sin productos con stock bajo');
    expect(retries(doc)).toHaveLength(NONE);
  });
});

describe('GET /admin · un fallo parcial degrada solo su bloque (la página responde 200)', () => {
  const failures = KEYS.flatMap((key) => [
    ...SERVER_ERRORS.map((status) => [key, `HTTP ${status}`, fail(status)] as const),
    [key, 'red caída', throwNetwork] as const,
  ]);

  test.each(failures)('%s · %s: 200, sin trazas, y los otros KPI conservan su total', async (key, _kind, reply) => {
    installPanelBackend({ replies: { [key]: reply } });
    const { res, html, doc } = await get();
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    noLeaks(html);
    noGarbage(html);
    const label = KPI_BY_KEY[key];
    if (label) {
      expect(kpiState(doc, label)).toBe('error');
      expect(text(kpi(doc, label)?.querySelector('.value'))).toBe('No disponible');
      DATA_LABELS.filter((l) => l !== label).forEach((l) => {
        expect(kpiState(doc, l), l).toBe('data');
        expect(kpiValue(doc, l), l).not.toBe('No disponible');
      });
      expect(errorKpis(doc)).toHaveLength(ONE);
    } else {
      DATA_LABELS.forEach((l) => expect(kpiState(doc, l), l).toBe('data'));
      expect(errorKpis(doc).length).toBeLessThanOrEqual(ONE);
    }
    expect(kpiState(doc, KPI_LABELS.sales)).toBe('pending');
  });

  test('«pagado» falla: el bloque de pedidos muestra el error con «Reintentar» (a la propia página) y no dice «Nada por preparar»; el stock sigue', async () => {
    installPanelBackend({ replies: { pagado: fail(ST.SERVER_ERROR) } });
    const { doc } = await get();
    expect(orderRows(doc)).toHaveLength(NONE);
    expect(text(doc.body)).not.toContain('Nada por preparar');
    const retry = retries(doc);
    expect(retry.length).toBeGreaterThanOrEqual(ONE);
    retry.forEach((r) => r.tagName === 'A' && expect(path(r)).toBe(PATH));
    expect(stockRows(doc)).toHaveLength(LOW_ROWS);
  });

  test('«low_stock» falla: la mini tabla muestra el error con «Reintentar» y no dice «Sin productos con stock bajo»; los pedidos siguen', async () => {
    installPanelBackend({ replies: { low_stock: throwNetwork } });
    const { doc } = await get();
    expect(stockRows(doc)).toHaveLength(NONE);
    expect(text(doc.body)).not.toContain('Sin productos con stock bajo');
    expect(retries(doc).length).toBeGreaterThanOrEqual(ONE);
    expect(orderRows(doc)).toHaveLength(PREPARE_ROWS);
  });

  test('«pendiente_pago» o «out_of_stock» caen: las dos tablas siguen completas y sin «Reintentar»', async () => {
    installPanelBackend({ replies: { pendiente_pago: fail(ST.SERVER_ERROR), out_of_stock: throwNetwork } });
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(orderRows(doc)).toHaveLength(PREPARE_ROWS);
    expect(stockRows(doc)).toHaveLength(LOW_ROWS);
    expect(retries(doc)).toHaveLength(NONE);
  });

  test('«out_of_stock» cae: no se inventa la alerta de agotados', async () => {
    installPanelBackend({ replies: { out_of_stock: fail(ST.SERVER_ERROR) } });
    const { doc } = await get();
    expect(text(doc.body).toLowerCase()).not.toContain('productos agotados');
  });

  test('las 4 caen: 200 con el panel en pie (sin cifras), sin trazas', async () => {
    const boom = fail(ST.UNAVAILABLE);
    installPanelBackend({ replies: { pagado: boom, pendiente_pago: boom, low_stock: boom, out_of_stock: boom } });
    const { res, html, doc } = await get();
    expect(res.status).toBe(OK);
    expect(text(doc.querySelector('h1'))).toBe('Panel');
    [TOTALS.toPrepare, TOTALS.pendingPayment, TOTALS.lowStock].forEach((n) => expect(text(doc.body)).not.toContain(String(n)));
    noLeaks(html);
  });

  test('el mensaje del backend nunca se muestra (se traduce)', async () => {
    installPanelBackend({ replies: { pagado: fail(ST.SERVER_ERROR) } });
    const { html } = await get();
    expect(html).not.toContain(BACKEND_MSG);
  });
});

describe('GET /admin · 200 con forma inesperada: ese KPI no está disponible, nunca un 500', () => {
  const shapes: [string, unknown][] = [
    ['null', null],
    ['un objeto vacío', {}],
    ['un arreglo', []],
    ['un texto', 'texto'],
    ['total como texto', { items: [], total: '7', page: ONE, page_size: ONE }],
    ['sin total', { items: [], page: ONE, page_size: ONE }],
  ];
  const matrix = (['pagado', 'pendiente_pago', 'low_stock'] as Key[]).flatMap((k) => shapes.map(([n, b]) => [k, n, b] as const));

  test.each(matrix)('%s con %s: 200, su KPI en «No disponible» y los demás intactos', async (key, _name, body) => {
    installPanelBackend({ replies: { [key]: () => body } });
    const { res, html, doc } = await get();
    expect(res.status).toBe(OK);
    noGarbage(html);
    noLeaks(html);
    const label = KPI_BY_KEY[key] as string;
    expect(kpiState(doc, label)).toBe('error');
    DATA_LABELS.filter((l) => l !== label).forEach((l) => expect(kpiState(doc, l), l).toBe('data'));
  });

  test('«out_of_stock» con forma inesperada: 200 y sin alerta de agotados', async () => {
    installPanelBackend({ replies: { out_of_stock: () => ({ unexpected: true }) } });
    const { res, doc } = await get();
    expect(res.status).toBe(OK);
    expect(text(doc.body).toLowerCase()).not.toContain('productos agotados');
  });

  test('filas de pedido con campos faltantes o null: nunca un 500 y la página sigue', async () => {
    installPanelBackend({ replies: { pagado: () => ({ items: [null, {}, { id: 'x' }], total: TOTALS.toPrepare, page: ONE, page_size: PREPARE_ROWS }) } });
    const { res, html } = await get();
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    noGarbage(html);
  });

  test('filas de stock con campos faltantes o null: nunca un 500', async () => {
    installPanelBackend({ replies: { low_stock: () => ({ items: [null, {}, { product_id: 'x' }], total: TOTALS.lowStock, page: ONE, page_size: LOW_ROWS }) } });
    const { res, html } = await get();
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    noGarbage(html);
  });

  test('un cuerpo que no es JSON (200 con HTML) cuenta como fallo de ese bloque', async () => {
    installPanelBackend({ replies: { pendiente_pago: () => new Response('<html>oops</html>', { status: OK, headers: { 'content-type': 'text/html' } }) } });
    const { res, html, doc } = await get();
    expect(res.status).toBe(OK);
    expect(kpiState(doc, KPI_LABELS.pendingPayment)).toBe('error');
    expect(html).not.toContain('oops');
  });
});

describe('GET /admin · autorización (sesión, rol, 401 y 403)', () => {
  test('sin sesión (locals.session = null): 302 a /ingresar?next=%2Fadmin, no-store y ninguna llamada a la API', async () => {
    const be = installPanelBackend();
    const { res } = await get({ session: null });
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fadmin');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.calls).toHaveLength(NONE);
  });

  test.each(['customer', '', 'ADMIN', 'superadmin', null, ONE])('perfil con role %j → «Sin permiso» (403 o 503 de seguridad), sin datos y sin pedir listados', async (role) => {
    const be = installPanelBackend({ role });
    const { res, html } = await get();
    expect([FORBIDDEN, UNAVAILABLE]).toContain(res.status);
    expect(be.data()).toHaveLength(NONE);
    expect(html).not.toContain(String(TOTALS.toPrepare));
    ordersToPrepare().forEach((o) => expect(html).not.toContain(o.number));
  });

  test('un cliente recibe exactamente 403 (rewrite a /admin/sin-permiso)', async () => {
    const be = installPanelBackend({ role: 'customer' });
    const { res } = await get();
    expect(res.status).toBe(FORBIDDEN);
    expect(hoisted.rewrites).toEqual(['/admin/sin-permiso']);
    expect(be.me()).toHaveLength(ONE);
    expect(be.data()).toHaveLength(NONE);
  });

  test('/identity/me responde 403 → «Sin permiso» (403) sin pedir los listados', async () => {
    const be = installPanelBackend({ me: () => apiError(ST.FORBIDDEN, 'forbidden') });
    const { res } = await get();
    expect(res.status).toBe(FORBIDDEN);
    expect(be.data()).toHaveLength(NONE);
  });

  test('/identity/me responde 401 → cierra la sesión local (signOut) y 302 al ingreso con next', async () => {
    const be = installPanelBackend({ me: () => apiError(ST.UNAUTHORIZED, 'unauthenticated') });
    const { res } = await get();
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fadmin');
    expect(signOut).toHaveBeenCalledTimes(ONE);
    expect(be.data()).toHaveLength(NONE);
  });

  test.each([ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE])('/identity/me responde %i → 503 «No disponible» sin datos', async (status) => {
    const be = installPanelBackend({ me: () => apiError(status, 'internal_error') });
    const { res } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(be.data()).toHaveLength(NONE);
  });

  test('/identity/me con un 200 de forma inesperada (null) → 503, nunca un acceso ni un 500', async () => {
    const be = installPanelBackend({ me: () => json(null) });
    const { res } = await get();
    expect(res.status).toBe(UNAVAILABLE);
    expect(be.data()).toHaveLength(NONE);
  });

  test.each(KEYS)('el listado «%s» responde 401 → endSession (signOut) y 302 al ingreso con next; sin datos en la respuesta', async (key) => {
    installPanelBackend({ replies: { [key]: () => apiError(ST.UNAUTHORIZED, 'unauthenticated') } });
    const { res, html } = await get();
    expect(res.status).toBe(FOUND);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fadmin');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(signOut).toHaveBeenCalledTimes(ONE);
    expect(html).not.toContain(String(TOTALS.toPrepare));
  });

  test.each(KEYS)('el listado «%s» responde 403 (rol retirado a media sesión) → 403 «Sin permiso», sin tablas ni cifras', async (key) => {
    installPanelBackend({ replies: { [key]: () => apiError(ST.FORBIDDEN, 'forbidden') } });
    const { res, html } = await get();
    expect(res.status).toBe(FORBIDDEN);
    expect(hoisted.rewrites).toContain('/admin/sin-permiso');
    expect(html).not.toContain(String(TOTALS.toPrepare));
    ordersToPrepare().forEach((o) => expect(html).not.toContain(o.number));
  });

  test('un 403 manda sobre un 5xx de otra llamada: 403 (no se muestra un panel degradado a quien no debe verlo)', async () => {
    installPanelBackend({ replies: { pagado: fail(ST.SERVER_ERROR), low_stock: () => apiError(ST.FORBIDDEN, 'forbidden') } });
    const { res } = await get();
    expect(res.status).toBe(FORBIDDEN);
  });

  test('un 401 manda sobre un 5xx de otra llamada: 302 al ingreso', async () => {
    installPanelBackend({ replies: { pendiente_pago: fail(ST.UNAVAILABLE), out_of_stock: () => apiError(ST.UNAUTHORIZED, 'unauthenticated') } });
    const { res } = await get();
    expect(res.status).toBe(FOUND);
    expect(signOut).toHaveBeenCalledTimes(ONE);
  });

  test('el rol sale del perfil del backend, no de la URL ni de la sesión: ?role=admin no abre nada a un cliente', async () => {
    const be = installPanelBackend({ role: 'customer' });
    const { res } = await get({ query: '?role=admin&admin=1' });
    expect(res.status).toBe(FORBIDDEN);
    expect(be.data()).toHaveLength(NONE);
  });
});

describe('GET /admin · privacidad y respuestas sin filtraciones', () => {
  test('nunca se pinta el user_id, el Bearer ni la cookie de sesión', async () => {
    installPanelBackend();
    const { html } = await get();
    expect(html).not.toContain(OTHER_USER);
    expect(html).not.toContain(USER_ID);
    expect(html).not.toContain(BEARER);
    expect(html).not.toContain('base64-QUJD');
  });

  test('destinatario y nombre de producto hostiles se pintan como texto, sin scripts ni elementos inyectados', async () => {
    installPanelBackend({
      replies: {
        pagado: () => ({ items: [summary({ recipient_name: HOSTILE })], total: ONE, page: ONE, page_size: PREPARE_ROWS }),
        low_stock: () => ({ items: [stockItem(NONE, { name: HOSTILE })], total: ONE, page: ONE, page_size: LOW_ROWS }),
      },
    });
    const { html, doc } = await get();
    expect(html).not.toContain('<script>window.__pwn');
    expect(doc.querySelector('tbody img')).toBeNull();
    expect(text(orderRows(doc)[NONE])).toContain(HOSTILE);
    expect(text(stockRows(doc)[NONE])).toContain(HOSTILE);
  });

  test('console limpia: la página no escribe en la consola del servidor (ni con fallos)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    installPanelBackend({ replies: { pagado: fail(ST.SERVER_ERROR), low_stock: throwNetwork } });
    await get();
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  });

  test('no pinta teléfono ni dirección (el listado no los trae y el panel no los necesita)', async () => {
    installPanelBackend();
    const { html } = await get();
    ['phone', 'address_line', '+51987654321', 'Av. Larco'].forEach((w) => expect(html).not.toContain(w));
  });

  test('«Reintentar» es de la propia página: no apunta a un host ajeno ni al API', async () => {
    installPanelBackend({ replies: { pagado: fail(ST.SERVER_ERROR) } });
    const { doc } = await get();
    retries(doc).forEach((r) => {
      const href = r.getAttribute('href');
      if (href) expect(href.startsWith('/') && !href.startsWith('//')).toBe(true);
    });
  });
});
