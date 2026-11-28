import { App } from 'astro/app';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import NotFound from '../../src/pages/404.astro';
import NoAccess from '../../src/pages/admin/sin-permiso.astro';
import Unavailable from '../../src/pages/admin/no-disponible.astro';
import OrderPage from '../../src/pages/admin/pedidos/[order_id].astro';
import { orderQueryString, parseOrderQuery } from '../../src/lib/admin/order-query';
import { ORDER_STATUS_LABEL } from '../../src/lib/admin/status';
import { formatDateTimeNumeric } from '../../src/lib/format';
import { parseHtml } from '../helpers/render';
import { inSequence } from '../helpers/t129';
import {
  ADMIN_ACTOR_ID, ALL_STATUSES, API_BASE, BEARER, CUSTOMER_ID, ME_URL, NO_STORE, ORDER_ID, ORIGIN, OTHER_USER_ID, SESSION, ST, SHIPPING_FEE, LINE_PRICE,
  apiError, bodyDetail, detail, flat, historyEntry, installOrderBackend, line, money, postBody, shippingDelivery, soles, validationError, type Backend, type Modality,
} from '../helpers/t146';
import { text } from '../helpers/ui';
import type { AdminOrderDetail, OrderStatus } from '../../src/lib/api/admin-orders';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-146 · ruta GET|POST /admin/pedidos/[order_id] con la Container API y un backend de orders simulado (reglas de SPEC §4 y §7).
// El middleware (guardia de sesión) no corre aquí: se cubre `session: null` por la red de seguridad de `requireAdmin` y, de punta a punta, en el E2E.
// `rewrite` se resuelve contra las páginas reales (/404, sin permiso, no disponible) para ver el estado HTTP que verá el usuario.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const MAX_URL_LEN = 600;
const MAX_NOTE = 500;
const MAX_TEXT = 60;
const LONG_Q = 100_000;
const MANY_KEYS = 2000;
const SHORT_ID = 8;
const CLIENT_ERROR_MIN = 400;
const E401 = 401;
const SERVER_CODES = [500, 502, 503, 504];
const FRACTION_LINE = 8_450_050;
const FRACTION_TOTAL = 8_455_050;
const SKIP_MAX = 80;
const SB_COOKIES = ['sb-127-auth-token', 'sb-127-auth-token.1'];
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
const FOREIGN_ORIGINS = ['https://evil.example', 'null', 'http://localhost:4322', 'http://localhost:4321.evil.example', 'http://127.0.0.1:4321', 'https://localhost:4321'];
const QUERY_WHITELIST = ['created_from', 'created_to', 'page', 'q', 'status'];
const LEAK_WORDS = ['MSG-DEL-BACKEND-QX', 'fetch failed', 'TypeError', 'ECONNREFUSED', 'api.test', '.ts:', BEARER];
const HOSTILE = '<script id="pwn">window.__pwned=1</script><img src=x onerror=alert(1)>';
const BAD_TARGETS = ['pagado', 'expirado', 'pendiente_pago', '', 'x', 'ENVIADO', ' cancelado', 'en_preparacion;DROP', '../x', 'null'];
const BAD_IDS = ['abc', '123', '..', '.', '../../catalogo', `${ORDER_ID}x`, `x${ORDER_ID}`, `${ORDER_ID}/x`, ORDER_ID.slice(NONE, -ONE), ORDER_ID.replaceAll('-', ''), '%00', `${ORDER_ID}%0A`, '<script>', 'null', 'undefined'];

type Init = {
  method?: string;
  query?: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  origin?: string | null;
  session?: unknown;
  body?: string;
  contentType?: string;
};

function supabaseMock() {
  const signOut = vi.fn(async () => ({ error: null }));
  return { auth: { signOut }, signOut };
}
let sb: ReturnType<typeof supabaseMock>;

async function renderPage(id: string, init: Init = {}) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? (init.body ?? new URLSearchParams(init.fields ?? {}).toString()) : undefined;
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  const headers: Record<string, string> = {
    cookie: COOKIE_HEADER,
    ...(hasBody ? { 'content-type': init.contentType ?? 'application/x-www-form-urlencoded' } : {}),
    ...(hasBody && origin !== null ? { origin } : {}),
    ...init.headers,
  };
  const request = new Request(`${ORIGIN}/admin/pedidos/${encodeURIComponent(id)}${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  container.insertPageRoute('/404', NotFound);
  container.insertPageRoute('/admin/sin-permiso', NoAccess);
  container.insertPageRoute('/admin/no-disponible', Unavailable);
  const session = 'session' in init ? init.session : SESSION;
  const res = await container.renderToResponse(OrderPage, {
    request,
    params: { order_id: id },
    locals: { session: session as App.Locals['session'], supabase: sb as unknown as App.Locals['supabase'] },
    routeType: 'page',
  });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}
const get = (init: Init = {}, id = ORDER_ID) => renderPage(id, init);
const post = (fields: Record<string, string>, init: Init = {}, id = ORDER_ID) => renderPage(id, { method: 'POST', fields: { _action: 'transition', ...fields }, ...init });
type Rendered = Awaited<ReturnType<typeof renderPage>>;

/** Sigue una redirección como un navegador: misma ruta y consulta de `Location` y las cookies que puso la respuesta. */
async function follow(res: Response, init: Init = {}): Promise<Rendered> {
  const target = new URL(res.headers.get('location') ?? '/', ORIGIN);
  const cookies = [...App.getSetCookieFromResponse(res)].map((c) => c.split(';')[NONE]);
  const id = decodeURIComponent(target.pathname.split('/').pop() ?? '');
  return renderPage(id, { ...init, query: target.search, headers: { ...(cookies.length ? { cookie: [COOKIE_HEADER, ...cookies].join('; ') } : {}), ...init.headers } });
}

const main = (doc: Document): string => flat(text(doc.querySelector('main')));
const buttons = (doc: Document): string[] => [...doc.querySelectorAll('main button, main a')].filter((el) => !el.closest('dialog')).map((el) => flat(text(el))).filter(Boolean);
const status = (doc: Document): string => flat(text(doc.querySelector('main')));
const isRedirect = (res: Response): boolean => res.status === ST.FOUND || res.status === ST.SEE_OTHER;
const cacheOk = (res: Response): boolean => (res.headers.get('cache-control') ?? '').includes('no-store');
const hasLeak = (html: string): string[] => LEAK_WORDS.filter((w) => html.includes(w));
const posts = (be: Backend) => be.posts().filter((c) => c.url.endsWith('/transitions'));
const backLink = (doc: Document): HTMLAnchorElement | undefined => [...doc.querySelectorAll('a')].find((a) => text(a).includes('Volver a pedidos')) as HTMLAnchorElement | undefined;
const fieldIn = (doc: Document, name: string): Element | null => doc.querySelector(`[name="${name}"]`);
const describedText = (doc: Document, el: Element | null): string =>
  (el?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => text(doc.querySelector(`[id="${id}"]`))).join(' ');
const valueOf = (el: Element | null): string => (el?.tagName === 'TEXTAREA' ? (el.textContent ?? '') : (el?.getAttribute('value') ?? ''));

/** Un `href` o `Location` interno, hacia la ruta dada, sin origen ajeno, sin saltos de línea ni parámetros fuera de la lista blanca. */
function expectInternal(raw: string, pathname: string): URL {
  expect(raw.includes('\n') || raw.includes('\r') || raw.includes('\\'), `caracteres de control o barra invertida en ${raw.slice(NONE, SKIP_MAX)}`).toBe(false);
  expect(raw.startsWith('//')).toBe(false);
  expect(raw.length).toBeLessThan(MAX_URL_LEN);
  const url = new URL(raw, 'http://internal.test');
  expect(url.origin).toBe('http://internal.test');
  expect(url.pathname).toBe(pathname);
  // Un `q` con texto hostil viaja codificado dentro de la consulta (es solo un término de búsqueda): el destino nunca es ajeno.
  expect(`${url.pathname}${url.hash}`.toLowerCase()).not.toContain('evil');
  return url;
}
function expectSafeBack(rendered: Rendered, back = '/admin/pedidos'): void {
  const link = backLink(rendered.doc);
  expect(link, 'falta «Volver a pedidos»').toBeDefined();
  const url = expectInternal(link!.getAttribute('href') ?? '', back);
  expect(url.hash).toBe(`#o-${ORDER_ID}`);
  expect([...url.searchParams.keys()].filter((k) => !QUERY_WHITELIST.includes(k))).toEqual([]);
  [...rendered.doc.querySelectorAll('a[href], form[action]')].filter((el) => el !== link).forEach((el) => {
    const href = (el.getAttribute('href') ?? el.getAttribute('action') ?? '').toLowerCase();
    expect(href.startsWith('javascript:'), href).toBe(false);
    expect(href.includes('evil'), href).toBe(false);
  });
  expect(link!.getAttribute('href')?.toLowerCase().startsWith('javascript:')).toBe(false);
}
function expectSafeLocation(res: Response): void {
  const loc = res.headers.get('location') ?? '';
  const url = expectInternal(loc, `/admin/pedidos/${ORDER_ID}`);
  const volver = url.searchParams.get('volver');
  if (volver !== null) expect([...new URLSearchParams(volver).keys()].filter((k) => !QUERY_WHITELIST.includes(k))).toEqual([]);
}

beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET · lectura del pedido', () => {
  test('200: un único h1 con el número, StatusPill con texto, noindex y no-store', async () => {
    installOrderBackend(detail('pagado'));
    const { res, doc } = await get();
    expect(res.status).toBe(ST.OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1'))).toContain('VAL-000123');
    expect(flat(text(doc.querySelector('main')))).toContain('Pagado');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(cacheOk(res)).toBe(true);
    expect(doc.documentElement.getAttribute('data-context')).toBe('backoffice');
  });

  test('los 8 estados pintan su etiqueta (punto + texto), sin deducir nada', async () => {
    await inSequence(ALL_STATUSES, async (s) => {
      installOrderBackend(detail(s));
      const { res, doc } = await get();
      expect(res.status, s).toBe(ST.OK);
      expect(flat(text(doc.querySelector('main'))), s).toContain(ORDER_STATUS_LABEL[s]);
      vi.unstubAllGlobals();
    });
  });

  test('solo dos llamadas: GET /identity/me y GET /orders/admin/{id}, con el Bearer de la sesión y sin query', async () => {
    const be = installOrderBackend(detail('pagado'));
    await get({ query: `?user_id=${OTHER_USER_ID}&role=admin&volver=status%3Dpagado` });
    expect(be.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${ME_URL}`, `GET ${API_BASE}/orders/admin/${ORDER_ID}`]);
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
  });

  test('el id de la URL se usa tal cual en la ruta; la identidad sale de la sesión (nunca de la URL)', async () => {
    const be = installOrderBackend(detail('pagado'));
    await get({ query: `?user_id=${CUSTOMER_ID}&customer_id=${CUSTOMER_ID}` });
    expect(be.calls.map((c) => c.url).some((u) => u.includes(CUSTOMER_ID))).toBe(false);
  });

  test('migas «Pedidos › VAL-…» con el último elemento como página actual', async () => {
    installOrderBackend(detail('pagado'));
    const { doc } = await get();
    const nav = doc.querySelector('nav[aria-label="Migas de pan"]')!;
    expect(nav.querySelector('a[href="/admin/pedidos"]')).not.toBeNull();
    expect(text(nav.querySelector('[aria-current="page"]'))).toContain('VAL-000123');
  });

  test('líneas, totales, entrega y cuenta abreviada vienen del pedido', async () => {
    installOrderBackend(detail('pagado'));
    const t = main((await get()).doc);
    ['Demo Gaviota 42', 'DEMO-007', soles(LINE_PRICE), soles(SHIPPING_FEE), soles(LINE_PRICE + SHIPPING_FEE), 'Lucía Fernández', '+51987654321', 'Av. Larco 1234, piso 5', OTHER_USER_ID.slice(NONE, SHORT_ID)].forEach((part) => expect(t, part).toContain(part));
    expect(t).toContain('S/ 84,500');
  });

  test('el cliente se muestra con el id abreviado: el user_id completo no sale en el HTML', async () => {
    installOrderBackend(detail('pagado'));
    expect((await get()).html).not.toContain(OTHER_USER_ID);
  });

  test('recojo: tienda y «Recojo en tienda»; sin dirección de envío', async () => {
    installOrderBackend(detail('listo_para_recojo', 'pickup'));
    const t = main((await get()).doc);
    ['Recojo en tienda', 'Boutique Valmont San Isidro', 'Calle Las Begonias 415', 'Mateo Quispe'].forEach((part) => expect(t, part).toContain(part));
  });

  test('historial: orden cronológico, estado de cada paso, actor en español, nota como texto y fechas de Lima', async () => {
    const d = detail('cancelado', 'shipping', {
      refund: { amount: money(LINE_PRICE + SHIPPING_FEE), at: '2026-11-28T03:30:00Z' },
      history: [
        historyEntry({ status: 'pendiente_pago', at: '2026-11-27T20:00:00Z', actor: 'customer', note: null }),
        historyEntry({ from_status: 'pendiente_pago', status: 'pagado', at: '2026-11-27T20:01:00Z', actor: 'system', actor_id: null }),
        historyEntry({ from_status: 'pagado', status: 'cancelado', at: '2026-11-28T03:30:00Z', actor: 'admin', actor_id: ADMIN_ACTOR_ID, note: HOSTILE }),
      ],
    });
    installOrderBackend(d);
    const { doc } = await get();
    const items = [...doc.querySelectorAll('ol li')].filter((li) => li.closest('main'));
    expect(items).toHaveLength(d.history.length);
    // El orden es el cronológico (del más antiguo al más reciente) o su inverso: nunca otro. Cada paso lleva estado, fecha de Lima y actor.
    const steps = [
      { label: 'Pendiente de pago', when: formatDateTimeNumeric('2026-11-27T20:00:00Z'), actor: 'Cliente' },
      { label: 'Pagado', when: formatDateTimeNumeric('2026-11-27T20:01:00Z'), actor: 'Sistema' },
      { label: 'Cancelado', when: formatDateTimeNumeric('2026-11-28T03:30:00Z'), actor: 'Administrador' },
    ];
    const actual = items.map((li) => flat(text(li)));
    const matches = (order: typeof steps) => order.every((s, i) => [s.label, s.when, s.actor].every((part) => actual[i].includes(part)));
    expect(matches(steps) || matches([...steps].reverse()), actual.join(' | ')).toBe(true);
    expect(steps[TWO].when).toBe('27/11/2026 22:30');
    expect(steps[NONE].when).toBe('27/11/2026 15:00');
    expect(actual.some((t) => t.includes(HOSTILE))).toBe(true);
    expect(doc.querySelector('#pwn, img[onerror]')).toBeNull();
    const current = items.filter((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(ONE);
    expect(flat(text(current[NONE]))).toContain('Cancelado');
  });

  test('una línea sin imagen no rompe la página', async () => {
    installOrderBackend(detail('pagado', 'shipping', { lines: [line({ image: null }), line({ sku: 'DEMO-001', name: 'Demo Alba 38' })] }));
    const { res, doc } = await get();
    expect(res.status).toBe(ST.OK);
    expect(doc.querySelectorAll('main tbody tr')).toHaveLength(TWO);
  });

  test('datos hostiles (destinatario, línea, nota) salen como texto: ni elementos ni atributos inyectados', async () => {
    installOrderBackend(detail('pagado', 'shipping', { lines: [line({ name: HOSTILE })], delivery: shippingDelivery({ recipient_name: HOSTILE, address_line: HOSTILE }) }));
    const { doc, html } = await get();
    expect(doc.querySelector('#pwn, img[onerror]')).toBeNull();
    expect(html).not.toContain('<script id="pwn">');
  });

  test('«Reembolso» solo si hay refund: monto de formatMoney y la nota fija del stock (R15)', async () => {
    const total = LINE_PRICE + SHIPPING_FEE;
    installOrderBackend(detail('cancelado', 'shipping', { refund: { amount: money(total), at: '2026-11-27T21:05:00Z' }, paid_at: '2026-11-27T20:01:00Z' }));
    const t = main((await get()).doc);
    expect(t).toContain('Reembolso');
    expect(t).toContain(soles(total));
    expect(t).toContain('27/11/2026 16:05');
    expect(t).toContain('El stock no se repone automáticamente');
    installOrderBackend(detail('cancelado', 'shipping', { refund: null }));
    const none = main((await get()).doc);
    expect(none).not.toContain('Reembolso');
    expect(none).not.toContain('El stock no se repone');
  });

  test('un pedido terminal no muestra ninguna acción', async () => {
    await inSequence(['entregado', 'cancelado', 'expirado'] as const, async (s) => {
      installOrderBackend(detail(s));
      const { doc } = await get();
      expect(doc.querySelectorAll('main form, main dialog'), s).toHaveLength(NONE);
      vi.unstubAllGlobals();
    });
  });

  test('acciones por estado salen de can_transition_to (pagado: Preparar y Cancelar y reembolsar)', async () => {
    installOrderBackend(detail('pagado'));
    expect(buttons((await get()).doc)).toEqual(expect.arrayContaining(['Preparar pedido', 'Cancelar y reembolsar']));
    installOrderBackend(detail('pagado', 'shipping', { can_transition_to: ['cancelado'] }));
    expect(buttons((await get()).doc)).not.toContain('Preparar pedido');
  });

  test('GET nunca modifica nada: ni con `_action`, `to` o `note` en la consulta', async () => {
    const be = installOrderBackend(detail('pagado'));
    await get({ query: '?_action=transition&to=cancelado&note=hola&volver=status%3Dpagado' });
    expect(be.posts()).toHaveLength(NONE);
    expect(be.state.status).toBe('pagado');
  });

  test('PUT, PATCH y DELETE no cambian el pedido ni responden 5xx', async () => {
    const be = installOrderBackend(detail('pagado'));
    await inSequence(['PUT', 'PATCH', 'DELETE'], async (method) => {
      const { res } = await renderPage(ORDER_ID, { method, fields: { _action: 'transition', to: 'cancelado', note: 'x' } });
      expect(res.status, method).toBeLessThan(ST.SERVER);
    });
    expect(posts(be)).toHaveLength(NONE);
    expect(be.state.status).toBe('pagado');
  });
});

describe('«Volver a pedidos» · `volver` solo es la consulta del listado (whitelist)', () => {
  test('conserva la consulta válida, en el orden canónico y con ancla a la fila', async () => {
    installOrderBackend(detail('pagado'));
    const { doc } = await get({ query: `?volver=${encodeURIComponent('status=pagado&q=ana&page=2&created_from=2026-11-01')}` });
    expect(backLink(doc)?.getAttribute('href')).toBe(`/admin/pedidos?created_from=2026-11-01&page=2&q=ana&status=pagado#o-${ORDER_ID}`);
  });

  test('sin `volver`, `volver` vacío o con page=1: enlace limpio', async () => {
    installOrderBackend(detail('pagado'));
    const clean = `/admin/pedidos#o-${ORDER_ID}`;
    expect(backLink((await get()).doc)?.getAttribute('href')).toBe(clean);
    expect(backLink((await get({ query: '?volver=' })).doc)?.getAttribute('href')).toBe(clean);
    expect(backLink((await get({ query: `?volver=${encodeURIComponent('page=1')}` })).doc)?.getAttribute('href')).toBe(clean);
  });

  test('se calcula con parseOrderQuery + orderQueryString (nunca se copia el valor crudo)', async () => {
    installOrderBackend(detail('pagado'));
    const raw = 'q=%20Ana%20&status=otro&page=0&created_to=x&created_from=2026-11-02';
    const expected = orderQueryString(parseOrderQuery(new URLSearchParams(raw)).query);
    const href = backLink((await get({ query: `?volver=${encodeURIComponent(raw)}` })).doc)?.getAttribute('href');
    expect(href).toBe(`/admin/pedidos${expected ? `?${expected}` : ''}#o-${ORDER_ID}`);
    expect(href).not.toContain('otro');
    expect(href).not.toContain('page=0');
  });

  const HOSTILE_VOLVER: Record<string, string> = {
    'URL absoluta': `?volver=${encodeURIComponent('https://evil.example')}`,
    'URL absoluta con consulta': `?volver=${encodeURIComponent('https://evil.example/?status=pagado')}`,
    'ruta sin esquema': `?volver=${encodeURIComponent('//evil.example')}`,
    'barra invertida': `?volver=${encodeURIComponent('/\\evil')}`,
    'javascript:': `?volver=${encodeURIComponent('javascript:alert(1)')}`,
    'javascript: vacío': `?volver=${encodeURIComponent('javascript:')}`,
    '%2F%2Fevil (una vez codificado)': '?volver=%2F%2Fevil',
    '%2F%2Fevil (doble codificado)': '?volver=%252F%252Fevil',
    'claves fuera de la lista blanca': `?volver=${encodeURIComponent('status=pagado&evil=1&next=//evil.example&redirect=https://evil.example&user_id=x&__proto__=y&constructor=z&to=cancelado')}`,
    'saltos de línea codificados': `?volver=${encodeURIComponent('q=a\r\nSet-Cookie: pwn=1\r\nLocation: https://evil.example')}`,
    'saltos de línea en el estado': `?volver=${encodeURIComponent('status=pagado\r\nX-Evil: 1')}`,
    NUL: `?volver=${encodeURIComponent('q=a\u0000b')}`,
    'fragmento': `?volver=${encodeURIComponent('status=pagado#https://evil.example')}`,
    'valor muy largo': `?volver=${encodeURIComponent(`q=${'a'.repeat(LONG_Q)}`)}`,
    'muchas claves': `?volver=${encodeURIComponent(Array.from({ length: MANY_KEYS }, (_, i) => `k${i}=evil`).join('&'))}`,
    'repetido': `?volver=status%3Dpagado&volver=https%3A%2F%2Fevil.example`,
    'HTML en q': `?volver=${encodeURIComponent('q=<script>alert(1)</script>"><a href=//evil.example>')}`,
  };
  Object.entries(HOSTILE_VOLVER).forEach(([name, query]) =>
    test(`GET con volver hostil (${name}): el enlace sigue en /admin/pedidos, sin parámetros ajenos`, async () => {
      installOrderBackend(detail('pagado'));
      const rendered = await get({ query });
      expect(rendered.res.status).toBe(ST.OK);
      expectSafeBack(rendered);
    }),
  );

  Object.entries(HOSTILE_VOLVER).forEach(([name, query]) =>
    test(`POST con volver hostil (${name}): la redirección sigue en el pedido y el enlace del resultado, en /admin/pedidos`, async () => {
      installOrderBackend(detail('pagado'));
      const sent = await post({ to: 'en_preparacion' }, { query });
      expect(sent.res.status).toBe(ST.SEE_OTHER);
      expectSafeLocation(sent.res);
      expectSafeBack(await follow(sent.res));
    }),
  );

  test('campos hostiles en el cuerpo (volver, next, redirect, return_to, url) no gobiernan la redirección', async () => {
    installOrderBackend(detail('pagado'));
    const fields = { to: 'en_preparacion', volver: 'https://evil.example', next: '//evil.example', redirect: 'https://evil.example', return_to: '/\\evil', url: 'javascript:alert(1)', location: 'https://evil.example' };
    const sent = await post(fields);
    expect(sent.res.status).toBe(ST.SEE_OTHER);
    expectSafeLocation(sent.res);
  });

  test('un error (422) con volver hostil también deja el enlace limpio', async () => {
    installOrderBackend(detail('pagado'));
    const rendered = await post({ to: 'cancelado', note: '' }, { query: HOSTILE_VOLVER['URL absoluta'] });
    expect(rendered.res.status).toBe(ST.UNPROCESSABLE);
    expectSafeBack(rendered);
  });
});

describe('POST · transiciones con Origin, formulario y PRG', () => {
  test('avance válido: 303 a la misma página con Cache-Control privado y no-store, y el cuerpo enviado es solo { to }', async () => {
    const be = installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expectSafeLocation(res);
    expect(posts(be)).toHaveLength(ONE);
    expect(posts(be)[NONE].url).toBe(`${API_BASE}/orders/admin/${ORDER_ID}/transitions`);
    expect(posts(be)[NONE].auth).toBe(`Bearer ${BEARER}`);
    expect(postBody(be.calls)).toEqual({ to: 'en_preparacion' });
  });

  test('tras el 303, la vista muestra el estado nuevo y «Pedido actualizado» con role=status', async () => {
    installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'en_preparacion' });
    const next = await follow(res);
    expect(next.res.status).toBe(ST.OK);
    const notice = [...next.doc.querySelectorAll('[role="status"]')].map((n) => flat(text(n))).join(' | ');
    expect(notice).toContain('Pedido actualizado');
    expect(flat(text(next.doc.querySelector('main')))).toContain('En preparación');
    expect(buttons(next.doc)).toEqual(expect.arrayContaining(['Marcar como enviado', 'Cancelar y reembolsar']));
    expect(buttons(next.doc)).not.toContain('Preparar pedido');
  });

  test('recorrido de envío completo: pagado → en preparación → enviado (con transportista) → entregado', async () => {
    const be = installOrderBackend(detail('pagado'));
    const step1 = await post({ to: 'en_preparacion' });
    expect(step1.res.status).toBe(ST.SEE_OTHER);
    const step2 = await post({ to: 'enviado', carrier: 'Olva Courier', tracking_code: 'OL-998877' });
    expect(step2.res.status).toBe(ST.SEE_OTHER);
    expect(posts(be)[ONE].body).toEqual({ to: 'enviado', carrier: 'Olva Courier', tracking_code: 'OL-998877' });
    const sent = await follow(step2.res);
    expect(main(sent.doc)).toContain('Enviado');
    expect(main(sent.doc)).toContain('Olva Courier');
    expect(main(sent.doc)).toContain('OL-998877');
    expect(buttons(sent.doc)).toEqual(expect.arrayContaining(['Marcar como entregado']));
    const step3 = await post({ to: 'entregado' });
    expect(step3.res.status).toBe(ST.SEE_OTHER);
    const done = await follow(step3.res);
    expect(main(done.doc)).toContain('Entregado');
    expect(done.doc.querySelectorAll('main form')).toHaveLength(NONE);
    expect(be.state.history.map((h) => h.status)).toEqual(['pendiente_pago', 'pagado', 'en_preparacion', 'enviado', 'entregado']);
  });

  test('recorrido de recojo: pagado → en preparación → listo para recojo → entregado', async () => {
    const be = installOrderBackend(detail('pagado', 'pickup'));
    const prepared = await follow((await post({ to: 'en_preparacion' })).res);
    expect(buttons(prepared.doc)).toEqual(expect.arrayContaining(['Marcar listo para recojo']));
    expect(buttons(prepared.doc)).not.toContain('Marcar como enviado');
    const ready = await follow((await post({ to: 'listo_para_recojo' })).res);
    expect(main(ready.doc)).toContain('Listo para recojo');
    const done = await follow((await post({ to: 'entregado' })).res);
    expect(main(done.doc)).toContain('Entregado');
    expect(be.state.status).toBe('entregado');
  });

  test('enviar sin transportista ni seguimiento: viaja solo { to } (nunca cadenas vacías)', async () => {
    const be = installOrderBackend(detail('en_preparacion'));
    const { res } = await post({ to: 'enviado', carrier: '', tracking_code: '' });
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(postBody(be.calls)).toEqual({ to: 'enviado' });
  });

  test('solo viajan to, note, carrier y tracking_code: lo demás del formulario se descarta', async () => {
    const be = installOrderBackend(detail('en_preparacion'));
    const { res } = await post({ to: 'enviado', carrier: 'DHL', user_id: CUSTOMER_ID, role: 'admin', total: '1', amount: '1', status: 'entregado', can_transition_to: 'entregado', refund: '1', actor: 'system', volver: 'x' });
    expect(res.status).toBe(ST.SEE_OTHER);
    const keys = Object.keys(postBody(be.calls) ?? {});
    expect(keys.filter((k) => !['to', 'note', 'carrier', 'tracking_code'].includes(k))).toEqual([]);
    expect(postBody(be.calls)).toMatchObject({ to: 'enviado', carrier: 'DHL' });
  });

  test('destino fuera de los 5 válidos → 422 y NINGUNA llamada de escritura', async () => {
    const be = installOrderBackend(detail('pagado'));
    await inSequence(BAD_TARGETS, async (to) => {
      const { res } = await post({ to });
      expect(res.status, `to=${to}`).toBe(ST.UNPROCESSABLE);
      expect(cacheOk(res)).toBe(true);
    });
    expect(posts(be)).toHaveLength(NONE);
    expect(be.state.status).toBe('pagado');
  });

  test('sin `to`, sin `_action` o con otra acción → error de cliente (no 5xx) y sin escritura', async () => {
    const be = installOrderBackend(detail('pagado'));
    const a = await renderPage(ORDER_ID, { method: 'POST', fields: {} });
    const b = await renderPage(ORDER_ID, { method: 'POST', fields: { to: 'cancelado', note: 'x' } });
    const c = await renderPage(ORDER_ID, { method: 'POST', fields: { _action: 'delete', to: 'cancelado', note: 'x' } });
    [a, b, c].forEach(({ res }) => {
      expect(res.status).toBeGreaterThanOrEqual(CLIENT_ERROR_MIN);
      expect(res.status).toBeLessThan(ST.SERVER);
      expect(res.status).not.toBe(ST.SEE_OTHER);
    });
    expect(posts(be)).toHaveLength(NONE);
  });

  test('Origin ajeno, ausente o null → 403, no-store y sin escritura (RT-B1)', async () => {
    const be = installOrderBackend(detail('pagado'));
    const origins: (string | null)[] = [...FOREIGN_ORIGINS, null];
    await inSequence(origins, async (origin) => {
      const { res } = await post({ to: 'en_preparacion' }, { origin });
      expect(res.status, String(origin)).toBe(ST.FORBIDDEN);
      expect(cacheOk(res)).toBe(true);
    });
    expect(posts(be)).toHaveLength(NONE);
    expect(be.state.status).toBe('pagado');
  });

  test('el Origin se comprueba antes de leer el cuerpo: un cuerpo roto con Origin ajeno es 403, no 415', async () => {
    installOrderBackend(detail('pagado'));
    const { res } = await renderPage(ORDER_ID, { method: 'POST', origin: 'https://evil.example', contentType: 'application/json', body: '{"to":"cancelado"}' });
    expect(res.status).toBe(ST.FORBIDDEN);
  });

  test('cuerpo que no es un formulario → 415 (nunca 500) y sin escritura (RT-B2)', async () => {
    const be = installOrderBackend(detail('pagado'));
    const bodies: Init[] = [
      { contentType: 'application/json', body: '{"to":"cancelado","note":"x"}' },
      { contentType: 'text/plain', body: 'to=cancelado&note=x' },
      { contentType: 'multipart/form-data', body: 'sin-frontera' },
      { contentType: 'application/octet-stream', body: 'abc' },
      { contentType: 'multipart/form-data; boundary=zz', body: '--zz\r\nbroken' },
    ];
    await inSequence(bodies, async (b) => {
      const { res } = await renderPage(ORDER_ID, { method: 'POST', ...b });
      expect(res.status, b.contentType).toBe(ST.UNSUPPORTED);
      expect(cacheOk(res)).toBe(true);
    });
    expect(posts(be)).toHaveLength(NONE);
  });

  test('un cuerpo vacío no es un 500', async () => {
    installOrderBackend(detail('pagado'));
    const { res } = await renderPage(ORDER_ID, { method: 'POST', body: '' });
    expect(res.status).toBeLessThan(ST.SERVER);
  });

  test('hostil: carrier/tracking_code con un destino que no es `enviado` nunca da 5xx ni cambia el estado equivocado', async () => {
    const be = installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'en_preparacion', carrier: 'DHL', tracking_code: 'X-1' });
    expect([ST.SEE_OTHER, ST.UNPROCESSABLE]).toContain(res.status);
    expect(be.state.status === 'pagado' || be.state.status === 'en_preparacion').toBe(true);
    expect(be.state.delivery.carrier).toBeNull();
  });

  test('doble envío: la segunda es un 409 y el pedido cambia UNA sola vez; ninguna reintenta sola', async () => {
    const be = installOrderBackend(detail('pagado'));
    const first = await post({ to: 'en_preparacion' });
    const second = await post({ to: 'en_preparacion' });
    expect(first.res.status).toBe(ST.SEE_OTHER);
    expect(second.res.status).toBe(ST.CONFLICT);
    expect(posts(be)).toHaveLength(TWO);
    expect(be.state.history.filter((h) => h.status === 'en_preparacion')).toHaveLength(ONE);
    expect(be.state.history.filter((h) => h.status === 'pagado')).toHaveLength(ONE);
  });

  test('doble envío simultáneo: una gana y la otra recibe el 409', async () => {
    const be = installOrderBackend(detail('pagado'));
    const [a, b] = await Promise.all([post({ to: 'en_preparacion' }), post({ to: 'en_preparacion' })]);
    expect([a.res.status, b.res.status].sort()).toEqual([ST.SEE_OTHER, ST.CONFLICT]);
    expect(be.state.history.filter((h) => h.status === 'en_preparacion')).toHaveLength(ONE);
  });
});

describe('POST · cancelar y reembolsar', () => {
  test('pagado + motivo: cancelado, reembolso del total en el historial, nota R15 y sin acciones', async () => {
    const be = installOrderBackend(detail('pagado'));
    const sent = await post({ to: 'cancelado', note: 'Pieza dañada en taller' });
    expect(sent.res.status).toBe(ST.SEE_OTHER);
    expect(postBody(be.calls)).toEqual({ to: 'cancelado', note: 'Pieza dañada en taller' });
    const next = await follow(sent.res);
    const t = main(next.doc);
    expect(t).toContain('Cancelado');
    expect(t).toContain('Reembolso');
    expect(t).toContain(soles(LINE_PRICE + SHIPPING_FEE));
    expect(t).toContain('Pieza dañada en taller');
    expect(t).toContain('El stock no se repone automáticamente');
    expect(next.doc.querySelectorAll('main form, main dialog')).toHaveLength(NONE);
    expect(be.state.refund?.amount).toEqual(money(LINE_PRICE + SHIPPING_FEE));
  });

  test('en preparación (envío y recojo): también reembolsa', async () => {
    await inSequence<Modality, void>(['shipping', 'pickup'], async (method) => {
      const be = installOrderBackend(detail('en_preparacion', method));
      const next = await follow((await post({ to: 'cancelado', note: 'Cliente lo pidió' })).res);
      expect(main(next.doc), method).toContain('Reembolso');
      expect(be.state.refund).not.toBeNull();
      vi.unstubAllGlobals();
    });
  });

  test('pendiente de pago: cancelado sin reembolso y sin la nota de stock', async () => {
    const be = installOrderBackend(detail('pendiente_pago'));
    const next = await follow((await post({ to: 'cancelado', note: 'Duplicado' })).res);
    const t = main(next.doc);
    expect(t).toContain('Cancelado');
    expect(t).not.toContain('Reembolso');
    expect(t).not.toContain('El stock no se repone');
    expect(be.state.refund).toBeNull();
  });

  test('sin motivo, vacío o solo espacios → 422 con el error junto al motivo, el diálogo abierto y NADA cambia', async () => {
    const be = installOrderBackend(detail('pagado'));
    await inSequence(['', '   ', '\t\n '], async (note) => {
      const { res, doc } = await post({ to: 'cancelado', note });
      expect(res.status, JSON.stringify(note)).toBe(ST.UNPROCESSABLE);
      expect(doc.querySelector('dialog')?.hasAttribute('open')).toBe(true);
      const field = fieldIn(doc, 'note');
      expect(field?.getAttribute('aria-invalid')).toBe('true');
      expect(describedText(doc, field)).not.toBe('');
      expect(hasLeak(doc.documentElement.outerHTML)).toEqual([]);
      expect(cacheOk(res)).toBe(true);
    });
    expect(be.state.status).toBe('pagado');
    expect(be.state.refund).toBeNull();
    expect(be.state.history).toHaveLength(TWO);
  });

  test('sin el campo `note` en el cuerpo → 422 igual', async () => {
    const be = installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'cancelado' });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.state.status).toBe('pagado');
  });

  test('motivo de más de 500 caracteres → 422, el texto escrito se conserva y no se cancela', async () => {
    const be = installOrderBackend(detail('pagado'));
    const long = 'a'.repeat(MAX_NOTE + ONE);
    const { res, doc } = await post({ to: 'cancelado', note: long });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(valueOf(fieldIn(doc, 'note'))).toBe(long);
    expect(doc.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(be.state.status).toBe('pagado');
  });

  test('un motivo de exactamente 500 caracteres se acepta', async () => {
    installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'cancelado', note: 'a'.repeat(MAX_NOTE) });
    expect(res.status).toBe(ST.SEE_OTHER);
  });

  test('un motivo escrito se conserva tras un 422 del servidor', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? validationError(bodyDetail('note', 'string_too_long')) : undefined) });
    const { res, doc } = await post({ to: 'cancelado', note: 'Mi motivo' });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(valueOf(fieldIn(doc, 'note'))).toBe('Mi motivo');
    expect(describedText(doc, fieldIn(doc, 'note'))).not.toBe('');
    expect(hasLeak(doc.documentElement.outerHTML)).toEqual([]);
  });

  test('motivo hostil: se guarda y se muestra como texto', async () => {
    installOrderBackend(detail('pagado'));
    const next = await follow((await post({ to: 'cancelado', note: HOSTILE })).res);
    expect(next.doc.querySelector('#pwn, img[onerror]')).toBeNull();
    expect(main(next.doc)).toContain(HOSTILE);
  });

  test('cancelar un pedido ya cancelado (otra pestaña) → 409 con relectura y sin segundo reembolso', async () => {
    const be = installOrderBackend(detail('pagado'));
    await post({ to: 'cancelado', note: 'Primera' });
    const again = await post({ to: 'cancelado', note: 'Segunda' });
    expect(again.res.status).toBe(ST.CONFLICT);
    expect(be.state.history.filter((h) => h.status === 'cancelado')).toHaveLength(ONE);
    expect(main(again.doc)).toContain('Cancelado');
    expect(be.state.refund?.amount).toEqual(money(LINE_PRICE + SHIPPING_FEE));
  });
});

describe('POST · errores del backend', () => {
  // «Otra pestaña» cambió el estado en el servidor mientras esta vista seguía abierta.
  const STALE = (be: Backend, to: OrderStatus, can: OrderStatus[]) => Object.assign(be.state, { status: to, can_transition_to: can });

  test('409 invalid_transition: vuelve a leer el detalle, muestra el estado actual y un aviso; no cambia nada ni reintenta', async () => {
    const be = installOrderBackend(detail('pagado'));
    STALE(be, 'en_preparacion', ['enviado', 'cancelado']); // otra pestaña ya lo preparó
    const { res, doc } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.CONFLICT);
    expect(cacheOk(res)).toBe(true);
    expect(main(doc)).toContain('En preparación');
    expect(buttons(doc)).toEqual(expect.arrayContaining(['Marcar como enviado']));
    expect(buttons(doc)).not.toContain('Preparar pedido');
    const warning = doc.querySelector('[data-tone="warning"]');
    expect(flat(text(warning))).toContain('El estado del pedido cambió: se muestra el estado actual');
    expect(posts(be)).toHaveLength(ONE);
    expect(be.orderGets().length).toBeGreaterThanOrEqual(ONE);
    expect(be.state.history).toHaveLength(TWO);
    expect(hasLeak(doc.documentElement.outerHTML)).toEqual([]);
  });

  test('409 con el estado ya entregado: sin acciones y con el aviso', async () => {
    const be = installOrderBackend(detail('pagado'));
    STALE(be, 'entregado', []);
    const { res, doc } = await post({ to: 'cancelado', note: 'tarde' });
    expect(res.status).toBe(ST.CONFLICT);
    expect(doc.querySelectorAll('main form, main dialog')).toHaveLength(NONE);
    expect(main(doc)).toContain('Entregado');
  });

  const FIELDS_422: { field: string; fields: Record<string, string>; expected: string }[] = [
    { field: 'carrier', fields: { to: 'enviado', carrier: 'Olva', tracking_code: 'OL-1' }, expected: 'Olva' },
    { field: 'tracking_code', fields: { to: 'enviado', carrier: 'Olva', tracking_code: 'OL-1' }, expected: 'OL-1' },
    { field: 'note', fields: { to: 'cancelado', note: 'Motivo escrito' }, expected: 'Motivo escrito' },
  ];
  FIELDS_422.forEach(({ field, fields, expected }) =>
    test(`422 en ${field}: error junto a su campo (en español, sin el texto del servidor) y lo escrito se conserva`, async () => {
      const startsAt: OrderStatus = fields.to === 'enviado' ? 'en_preparacion' : 'pagado';
      const be = installOrderBackend(detail(startsAt), { override: (c) => (c.method === 'POST' ? validationError(bodyDetail(field, 'string_too_long')) : undefined) });
      const { res, doc } = await post(fields);
      expect(res.status).toBe(ST.UNPROCESSABLE);
      const el = fieldIn(doc, field);
      expect(el?.getAttribute('aria-invalid')).toBe('true');
      expect(describedText(doc, el)).not.toBe('');
      expect(valueOf(fieldIn(doc, field))).toBe(expected);
      if (field !== 'note') expect(valueOf(fieldIn(doc, field === 'carrier' ? 'tracking_code' : 'carrier'))).not.toBe('');
      expect(hasLeak(doc.documentElement.outerHTML)).toEqual([]);
      expect(be.state.status).toBe(startsAt);
      expect(cacheOk(res)).toBe(true);
    }),
  );

  test('transportista o seguimiento de más de 60 caracteres → 422 en su campo, valores conservados y sin cambio', async () => {
    const be = installOrderBackend(detail('en_preparacion'));
    const long = 'x'.repeat(MAX_TEXT + ONE);
    const { res, doc } = await post({ to: 'enviado', carrier: long, tracking_code: 'OL-1' });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(fieldIn(doc, 'carrier')?.getAttribute('aria-invalid')).toBe('true');
    expect(valueOf(fieldIn(doc, 'carrier'))).toBe(long);
    expect(valueOf(fieldIn(doc, 'tracking_code'))).toBe('OL-1');
    expect(be.state.status).toBe('en_preparacion');
  });

  test('un 422 sin campo conocido da un mensaje de formulario (role=alert) y no filtra el texto del servidor', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? validationError(bodyDetail('desconocido', 'value_error')) : undefined) });
    const { res, doc } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(flat(text(doc.querySelector('[role="alert"]')))).not.toBe('');
    expect(hasLeak(doc.documentElement.outerHTML)).toEqual([]);
  });

  test('404 en el POST (el pedido ya no existe) → página 404', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? apiError(ST.NOT_FOUND, 'not_found') : undefined) });
    const { res } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.NOT_FOUND);
  });

  test('401 en el POST: cierra la sesión local y 302 al ingreso', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? apiError(E401, 'unauthenticated') : undefined) });
    const { res } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location') ?? '').toContain('/ingresar');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test('403 en el POST (rol retirado a media sesión) → «Sin permiso» y sin datos del pedido', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? apiError(ST.FORBIDDEN, 'forbidden') : undefined) });
    const { res, html } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(html).not.toContain('Lucía Fernández');
  });

  test('5xx o corte de red en el POST → 503 con «Reintentar», sin filtrar detalles', async () => {
    await inSequence(SERVER_CODES, async (code) => {
      const be = installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'POST' ? apiError(code, 'internal_error') : undefined) });
      const { res, html, doc } = await post({ to: 'en_preparacion' });
      expect(res.status, String(code)).toBe(ST.UNAVAILABLE);
      // El formulario sigue en pantalla (se puede reenviar) y un aviso con role=alert explica el fallo.
      expect(flat(text(doc.querySelector('main [role="alert"]')))).not.toBe('');
      expect(hasLeak(html)).toEqual([]);
      expect(be.state.status).toBe('pagado');
      vi.unstubAllGlobals();
    });
    const throwing = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('fetch failed');
      return fetch(input, init);
    });
    const be = installOrderBackend(detail('pagado'));
    const real = be.fetchMock.getMockImplementation()!;
    throwing.mockImplementation(async (input, init) => (init?.method === 'POST' ? Promise.reject(new TypeError('fetch failed')) : real(input, init)));
    vi.stubGlobal('fetch', throwing);
    const { res, html } = await post({ to: 'en_preparacion' });
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(hasLeak(html)).toEqual([]);
  });
});

describe('Seguridad y errores de lectura', () => {
  test('sin sesión: 302 al ingreso con next y ninguna llamada al backend', async () => {
    const be = installOrderBackend(detail('pagado'));
    const { res } = await get({ session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location') ?? '').toContain('/ingresar?next=');
    expect(be.calls).toHaveLength(NONE);
  });

  test('sin sesión, un POST tampoco escribe', async () => {
    const be = installOrderBackend(detail('pagado'));
    const { res } = await post({ to: 'cancelado', note: 'x' }, { session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(be.calls).toHaveLength(NONE);
  });

  test('un cliente (no administrador) recibe 403 y NO se pide ni se pinta el pedido', async () => {
    const be = installOrderBackend(detail('pagado'), { role: 'customer' });
    const { res, html } = await get();
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.beyondMe()).toHaveLength(NONE);
    ['Lucía Fernández', '+51987654321', 'Av. Larco', 'VAL-000123', 'Demo Gaviota', OTHER_USER_ID.slice(NONE, SHORT_ID)].forEach((pii) => expect(html, pii).not.toContain(pii));
    expect(cacheOk(res)).toBe(true);
  });

  test('un cliente tampoco puede cancelar con un POST directo', async () => {
    const be = installOrderBackend(detail('pagado'), { role: 'customer' });
    const { res } = await post({ to: 'cancelado', note: 'x' });
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(posts(be)).toHaveLength(NONE);
    expect(be.state.status).toBe('pagado');
  });

  test('un rol que no es exactamente «admin» no entra', async () => {
    await inSequence(['Admin', 'ADMIN', 'admin ', '', 'staff', 'superuser'], async (role) => {
      const be = installOrderBackend(detail('pagado'), { role });
      const { res } = await get();
      expect(res.status, role).toBe(ST.FORBIDDEN);
      expect(be.beyondMe(), role).toHaveLength(NONE);
      vi.unstubAllGlobals();
    });
  });

  test('401 de /identity/me: cierra la sesión local (cookies de Supabase) y 302 al ingreso', async () => {
    const be = installOrderBackend(detail('pagado'), { override: (c) => (c.url === ME_URL ? apiError(E401, 'unauthenticated') : undefined) });
    const { res } = await get();
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location') ?? '').toContain('/ingresar');
    expect(sb.signOut).toHaveBeenCalled();
    expect(be.beyondMe()).toHaveLength(NONE);
    const cleared = [...App.getSetCookieFromResponse(res)].map((c) => c.split('=')[NONE]);
    SB_COOKIES.forEach((name) => expect(cleared).toContain(name));
  });

  test('401 de la lectura del pedido: endSession y 302 al ingreso', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'GET' && c.url.includes('/orders/') ? apiError(E401, 'unauthenticated') : undefined) });
    const { res } = await get();
    expect(res.status).toBe(ST.FOUND);
    expect(sb.signOut).toHaveBeenCalled();
  });

  test('403 de la lectura del pedido (rol retirado) → «Sin permiso» sin datos', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'GET' && c.url.includes('/orders/') ? apiError(ST.FORBIDDEN, 'forbidden') : undefined) });
    const { res, html } = await get();
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(html).not.toContain('Lucía Fernández');
  });

  test('pedido inexistente (404 del backend) → página 404', async () => {
    installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'GET' && c.url.includes('/orders/') ? apiError(ST.NOT_FOUND, 'not_found') : undefined) });
    const { res, html } = await get();
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(html).not.toContain('VAL-000123');
  });

  test('un id que no es UUID → 404 SIN llamar al backend (ni al pedido ni a la escritura)', async () => {
    const be = installOrderBackend(detail('pagado'));
    await inSequence(BAD_IDS, async (id) => {
      const g = await get({}, id);
      expect(g.res.status, `GET ${id}`).toBe(ST.NOT_FOUND);
      const p = await post({ to: 'cancelado', note: 'x' }, {}, id);
      expect(p.res.status, `POST ${id}`).toBe(ST.NOT_FOUND);
    });
    expect(be.beyondMe()).toEqual([]);
  });

  test('un UUID en mayúsculas es válido y se consulta', async () => {
    const be = installOrderBackend(detail('pagado'));
    const upper = ORDER_ID.toUpperCase();
    be.fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      return url === ME_URL ? Response.json({ role: 'admin', user_id: ORDER_ID, full_name: 'Ana' }) : Response.json(be.state);
    });
    const { res } = await get({}, upper);
    expect(res.status).toBe(ST.OK);
  });

  test('5xx o corte de red al leer → 503 con «Reintentar», sin datos de pedidos ni del servidor', async () => {
    await inSequence(SERVER_CODES, async (code) => {
      installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'GET' && c.url.includes('/orders/') ? apiError(code, 'internal_error') : undefined) });
      const { res, html, doc } = await get();
      expect(res.status, String(code)).toBe(ST.UNAVAILABLE);
      expect(flat(text(doc.body))).toContain('Reintentar');
      expect(html).not.toContain('Lucía Fernández');
      expect(hasLeak(html)).toEqual([]);
      expect(cacheOk(res)).toBe(true);
      vi.unstubAllGlobals();
    });
    const be = installOrderBackend(detail('pagado'));
    const real = be.fetchMock.getMockImplementation()!;
    be.fetchMock.mockImplementation(async (input, init) => (String(input).includes('/orders/') ? Promise.reject(new TypeError('fetch failed')) : real(input, init)));
    const { res, html } = await get();
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(hasLeak(html)).toEqual([]);
  });

  const ODD_SHAPES: Record<string, unknown> = { null: null, 'objeto vacío': {}, 'solo id': { id: ORDER_ID }, texto: 'texto', arreglo: [] };
  Object.entries(ODD_SHAPES).forEach(([name, shape]) =>
    test(`una respuesta 200 con forma inesperada (${name}) es 503 «No disponible», nunca un 500 ni un 200 vacío`, async () => {
      installOrderBackend(detail('pagado'), { override: (c) => (c.method === 'GET' && c.url.includes('/orders/') ? Response.json(shape) : undefined) });
      const { res, html } = await get();
      expect(res.status).toBe(ST.UNAVAILABLE);
      expect(hasLeak(html)).toEqual([]);
    }),
  );

  test('ninguna respuesta de error filtra trazas, rutas internas, el Bearer ni el texto del backend', async () => {
    const cases: Init[] = [{}, { query: '?volver=%00' }];
    await inSequence(cases, async (init) => {
      installOrderBackend(detail('pagado'), { override: (c) => (c.url.includes('/orders/') ? apiError(ST.SERVER, 'internal_error') : undefined) });
      const { html } = await get(init);
      expect(hasLeak(html)).toEqual([]);
      vi.unstubAllGlobals();
    });
  });

  test('ningún dato ajeno al pedido: ni la contraseña, ni cookies, ni el id del actor completo', async () => {
    installOrderBackend(detail('en_preparacion'));
    const { html } = await get();
    expect(html).not.toContain(COOKIE_HEADER);
    expect(html).not.toContain(BEARER);
    expect(html).not.toContain('sb-127-auth-token');
  });

  test('el pedido se pide con GET /orders/admin/{id} y nunca con otro verbo ni ruta (solo lectura)', async () => {
    const be = installOrderBackend(detail('pagado'));
    await get();
    expect(be.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(be.calls.every((c) => c.url === ME_URL || c.url === `${API_BASE}/orders/admin/${ORDER_ID}`)).toBe(true);
  });

  test('el estado y las acciones salen del cuerpo recibido: un pagado «ya entregado» por el servidor no ofrece nada', async () => {
    installOrderBackend(detail('entregado'));
    const { doc } = await get();
    expect(buttons(doc).filter((b) => ['Preparar pedido', 'Marcar como enviado', 'Cancelar y reembolsar', 'Cancelar pedido'].includes(b))).toEqual([]);
    expect(status(doc)).toContain('Entregado');
  });
});

describe('Datos del detalle (D-B5 A, D-B6 B)', () => {
  const check = (d: AdminOrderDetail) => installOrderBackend(d);

  test('importes con formatMoney: S/ 84,500 sin decimales; con céntimos, dos decimales', async () => {
    check(detail('pagado', 'shipping', { lines: [line({ quantity: 1, unit_price: money(FRACTION_LINE), line_total: money(FRACTION_LINE) })], subtotal: money(FRACTION_LINE), total: money(FRACTION_TOTAL) }));
    const t = main((await get()).doc);
    expect(t).toContain('S/ 84,500.50');
    expect(t).toContain('S/ 84,550.50');
  });

  test('fechas en hora de Lima con 24 h: un instante cerca de la medianoche UTC cae en el día anterior', async () => {
    check(detail('pagado', 'shipping', { history: [historyEntry({ at: '2026-11-28T03:30:00Z' }), historyEntry({ from_status: null, status: 'pagado', at: '2026-11-28T04:59:00Z', actor: 'system', actor_id: null })], paid_at: '2026-11-28T04:59:00Z' }));
    const t = main((await get()).doc);
    expect(t).toContain('27/11/2026 22:30');
    expect(t).toContain('27/11/2026 23:59');
    expect(t).not.toContain('28/11/2026');
  });
});
