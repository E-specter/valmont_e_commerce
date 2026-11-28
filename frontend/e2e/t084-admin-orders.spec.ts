import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { formatMoney } from '../src/lib/format';
import { API, browserCookies, createQaUser, deleteQaUser, setRole, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { countOrders, madeToOrderProductId, makeAdult, purgeOrders, seedOrder, setCreatedAt, waitForApi, type OrderStatus, type Seeded } from './helpers/orders';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-084 · listado de pedidos /admin/pedidos con administrador y pedidos REALES (API como cliente) contra el Supabase local y el backend reales.
// Requiere `npm run db:start`, el backend en :8000 y Docker. Los pedidos y usuarios son `qa-t142-*` y se borran al terminar; no se toca nada ajeno.
// Una sola pasada en escritorio (cambia el ancho dentro de las pruebas: 1280, 1440 y 375).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const PATH = '/admin/pedidos';
const HOOK_TIMEOUT = 300_000;
const NAV_TIMEOUT = 20_000;
const OK = 200;
const FOUND = 302;
const FORBIDDEN = 403;
const UNPROCESSABLE = 422;
const SEE_OTHER = 303;
const NOT_FOUND = 404;
const NOT_ALLOWED = 405;
const SERVER_ERROR = 500;
const LONG_Q = 150;
const MAX_Q = 100;
const OVERSIZE = 500;
const NO_STORE = 'private, no-store';
const PAGE_SIZE = 20;
const LOTE = 16;
const DESKTOP = 1440;
const MOBILE = 375;
const LAPTOP = 1280;
const WIDTHS = [LAPTOP, DESKTOP, MOBILE];
const HEIGHT = 900;
const FOCUS_YELLOW = 'rgb(255, 217, 0)';
const RING = 2;
const CONTROL = 44;
const BUTTON = 40;
const MIN_TARGET = 24;
const MAX_TABS = 40;
const MAX_FIELD_STOPS = 16;
const ALL_STOPS = 90;
const SKIP = 2;
const SUFFIX_LEN = 7;
const RADIX = 36;
const DAY_MS = 86_400_000;
const NIGHT = '2026-03-10T03:30:00Z';
const LATE = '2026-03-10T04:59:00Z';
const MIDNIGHT = '2026-03-10T05:00:00Z';
const NIGHT_LIMA = '09/03/2026 22:30';
const LATE_LIMA = '09/03/2026 23:59';
const MIDNIGHT_LIMA = '10/03/2026 00:00';
const HOSTILE_TAIL = '<img src=x onerror=window.__pwn=1>';
const STATUS_LABEL: Record<OrderStatus, string> = {
  pendiente_pago: 'Pendiente de pago', pagado: 'Pagado', en_preparacion: 'En preparación', enviado: 'Enviado', listo_para_recojo: 'Listo para recojo',
  entregado: 'Entregado', cancelado: 'Cancelado', expirado: 'Expirado',
};
const STATUSES = Object.keys(STATUS_LABEL) as OrderStatus[];
// «dd/mm/aaaa hh:mm» en cualquier parte del texto de una celda.
// Acepta "27/11/2026 15:04"; rechaza "2026-11-27T20:04:00Z" y "27/11/2026".
// https://regex101.com/?regex=%5Cd%7B2%7D%2F%5Cd%7B2%7D%2F%5Cd%7B4%7D%20%5Cd%7B2%7D%3A%5Cd%7B2%7D&testString=27%2F11%2F2026%2015%3A04
// Cualquier valor no vacío (el atributo existe y dice algo).
// Acepta "page" y "true"; rechaza "".
// https://regex101.com/?regex=.%2B&testString=page
const ANY_VALUE = /.+/;
const DATE_TIME = /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/;

let env: LiveEnv;
test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'escribe usuarios y pedidos y mide el escritorio y el móvil: una sola pasada (escritorio)');
  await waitForApi(); // el backend de desarrollo se recarga al editar código: no se culpa a la página de una caída ajena
});
test.beforeAll(() => {
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
});

// El chip activo se anuncia con un «✓» delante: el nombre se busca por contenido, no exacto.
// --- ayudantes --------------------------------------------------------------------------------------------------
const mark = `t84${Date.now().toString(RADIX).slice(-SUFFIX_LEN)}${Math.random().toString(RADIX).slice(SKIP, SKIP + SKIP)}`;
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const q = (extra = ''): string => `${PATH}?q=${encodeURIComponent(mark)}${extra}`;
const rows = (page: Page): Locator => page.locator('tbody tr');
const numbersOf = (page: Page): Promise<string[]> => page.locator('tbody tr td:first-child a').allInnerTexts();
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const limaDay = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(ms));
const chip = (page: Page, label: string): Locator => page.getByRole('navigation', { name: 'Filtrar por estado' }).getByRole('link', { name: label });
const searchBox = (page: Page): Locator => page.getByLabel('Número o destinatario', { exact: true });
const apply = (page: Page): Locator => page.getByRole('button', { name: 'Aplicar' });
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const rowOf = (page: Page, seeded: Seeded): Locator => page.locator(`tr#o-${seeded.id}`);

/** Entra con la sesión de `user` y devuelve la respuesta (sin exigir 200: para probar errores). */
async function visit(page: Page, user: QaUser, path: string, width = DESKTOP) {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, user);
  return page.goto(`${BASE}${path}`);
}

async function open(page: Page, user: QaUser, path: string, width = DESKTOP): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, user);
  const res = await page.goto(`${BASE}${path}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1, name: 'Pedidos' })).toBeVisible();
}

/** Texto y destino del elemento enfocado. */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}|${el.getAttribute('aria-label') ?? ''}|${((el as HTMLElement).innerText ?? '').trim()}|${el.getAttribute('href') ?? ''}` : '';
  });
const tabOrder = (page: Page, count = MAX_TABS): Promise<string[]> =>
  Array.from({ length: count }).reduce<Promise<string[]>>(async (acc) => {
    const seen = await acc;
    await page.keyboard.press('Tab');
    return [...seen, await focused(page)];
  }, Promise.resolve([]));

/** El listado tal como lo ve la API del administrador (verdad del backend contra la que se compara la pantalla). */
async function adminList(admin: QaUser, query: Record<string, string>): Promise<{ items: { number: string; total: { amount: number; currency: 'PEN' }; status: string }[]; total: number }> {
  await waitForApi();
  const res = await fetch(`${API}/api/v1/orders/admin?${new URLSearchParams(query).toString()}`, { headers: { authorization: `Bearer ${admin.token}` } });
  expect(res.status).toBe(OK);
  return (await res.json()) as { items: { number: string; total: { amount: number; currency: 'PEN' }; status: string }[]; total: number };
}

// --- sin datos: no necesita pedidos ------------------------------------------------------------------------------
test.describe('acceso · sin sesión', () => {
  [PATH, `${PATH}?status=pagado`, `${PATH}?q=zzz&page=2`, `${PATH}/`, '/Admin/pedidos', '/%61dmin/pedidos'].forEach((path) =>
    test(`${path} sin sesión → 302 al ingreso con next, no-store y sin cuerpo`, async ({ request }) => {
      const res = await get(request, path);
      expect(res.status()).toBe(FOUND);
      expect(res.headers().location?.startsWith('/ingresar?next=')).toBe(true);
      expect(res.headers()['cache-control']).toBe(NO_STORE);
      expect(await res.text()).toBe('');
    }));

  test('el destino de vuelta conserva la consulta y es una ruta interna', async ({ request }) => {
    const res = await get(request, `${PATH}?status=pagado&q=Ana`);
    expect(res.headers().location).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=pagado&q=Ana`)}`);
  });

  test('un navegador sin sesión termina en el ingreso, sin ver nada del listado', async ({ page }) => {
    await page.goto(`${BASE}${PATH}`);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe('/ingresar');
    expect(await page.locator('body').innerText()).not.toContain('Pedidos');
  });

  test('una cookie de sesión basura no da acceso: 302', async ({ request }) => {
    const res = await get(request, PATH, 'sb-127-auth-token=base64-QUJDREVGRw; sb-127-auth-token.1=garbage');
    expect(res.status()).toBe(FOUND);
  });
});

// --- con administrador y pedidos reales ---------------------------------------------------------------------------
test.describe('listado de pedidos · administrador real y pedidos sembrados por la API', () => {
  // `default`: un solo worker (comparten usuarios y pedidos) sin saltarse el resto si una prueba falla.
  test.describe.configure({ mode: 'default' });
  let admin: QaUser;
  let demoted: QaUser;
  let buyer: QaUser;
  let buyerTwo: QaUser;
  let spy: QaUser;
  const seeded: Seeded[] = [];
  const byStatus = (s: OrderStatus): Seeded => seeded.find((o) => o.status === s && o.recipient.endsWith(STATUS_LABEL[s]))!;
  const own = (): Seeded[] => seeded;

  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    admin = await createQaUser(env, 'adm084', 'admin');
    demoted = await createQaUser(env, 'adm084b', 'admin');
    buyer = await createQaUser(env, 'cli084a', 'customer');
    buyerTwo = await createQaUser(env, 'cli084b', 'customer');
    spy = await createQaUser(env, 'cli084c', 'customer');
    await Promise.all([makeAdult(buyer), makeAdult(buyerTwo)]);
    const product = await madeToOrderProductId();
    // Secuencial: el carrito y el límite de pedidos pendientes son por usuario.
    const plan: { who: QaUser; recipient: string; to: OrderStatus; method?: 'pickup' }[] = [
      ...STATUSES.map((to) => ({ who: buyer, recipient: `${mark} ${STATUS_LABEL[to]}`, to, ...(to === 'listo_para_recojo' ? { method: 'pickup' as const } : {}) })),
      { who: buyer, recipient: `${mark} ${HOSTILE_TAIL}`, to: 'pagado' },
      ...Array.from({ length: LOTE }, (_, i) => ({ who: buyerTwo, recipient: `${mark} Lote ${String(i + 1).padStart(SKIP, '0')}`, to: 'pagado' as OrderStatus })),
    ];
    await plan.reduce(async (prev, spec) => {
      await prev;
      seeded.push(await seedOrder(spec.who, admin, product, spec));
    }, Promise.resolve());
    // Días de Lima: 03:30 UTC es el 9 de marzo (22:30); 04:59 UTC, las 23:59; 05:00 UTC ya es el 10 (00:00).
    setCreatedAt(byStatus('entregado').id, NIGHT);
    setCreatedAt(byStatus('expirado').id, LATE);
    setCreatedAt(byStatus('cancelado').id, MIDNIGHT);
  });

  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    purgeOrders(own().map((o) => o.id));
    const left = countOrders(own().map((o) => o.id));
    await Promise.all([admin, demoted, buyer, buyerTwo, spy].map((u) => deleteQaUser(env, u)));
    expect(left, 'pedidos de la suite sin borrar').toBe(0);
  });

  // --- seguridad -----------------------------------------------------------------------------------------------
  test.describe('seguridad', () => {
    test('administrador: 200, private no-store, noindex y las filas del backend', async ({ request }) => {
      const res = await get(request, q('&status=pendiente_pago'), admin.cookie);
      expect(res.status()).toBe(OK);
      expect(res.headers()['cache-control']).toBe(NO_STORE);
      const html = await res.text();
      expect(html).toContain('noindex');
      expect(html).toContain(byStatus('pendiente_pago').number);
    });

    // El título no puede llevar valores aleatorios (`mark`): Playwright reencuentra la prueba por su título en cada worker.
    const CUSTOMER_PATHS: [string, () => string][] = [
      ['sin consulta', () => PATH],
      ['por estado', () => `${PATH}?status=pagado`],
      ['por texto del lote sembrado', () => `${PATH}?q=${encodeURIComponent(mark)}`],
      ['con página y fecha', () => `${PATH}?q=VAL&page=2&created_from=2026-01-01`],
    ];
    CUSTOMER_PATHS.forEach(([label, pathOf]) =>
      test(`cliente (${label}): 403 «Sin permiso», no-store y sin ningún dato de pedidos`, async ({ request }) => {
        const res = await get(request, pathOf(), spy.cookie);
        expect(res.status()).toBe(FORBIDDEN);
        expect(res.headers()['cache-control'] ?? '').toContain('no-store');
        const html = await res.text();
        expect(html).toContain('No tienes permiso');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('Lote');
        own().forEach((o) => {
          expect(html).not.toContain(o.number);
          expect(html).not.toContain(o.id);
        });
        [buyer.email, buyer.id, buyerTwo.email, buyerTwo.id].forEach((leak) => expect(html).not.toContain(leak));
      }));

    test('cliente en el navegador: ve «Sin permiso», sin tabla, sin menú del backoffice y sin pedidos ajenos', async ({ page }) => {
      await asUser(page, spy);
      const res = await page.goto(`${BASE}${q()}`);
      expect(res?.status()).toBe(FORBIDDEN);
      await expect(page.getByRole('heading', { level: 1, name: 'No tienes permiso' })).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByLabel('Número o destinatario')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(mark);
    });

    test('un cliente no ve los pedidos de otros ni en su propia cuenta (los datos de la tabla son solo del administrador)', async ({ request }) => {
      const res = await get(request, '/cuenta', spy.cookie);
      expect(res.status()).toBe(OK);
      const html = await res.text();
      expect(html).not.toContain(mark);
      own().forEach((o) => expect(html).not.toContain(o.number));
    });

    test('la respuesta del administrador no contiene su Bearer, ni el user_id de los clientes, ni teléfono ni dirección', async ({ request }) => {
      const html = await (await get(request, q(), admin.cookie)).text();
      [admin.token, buyer.token, buyer.id, buyerTwo.id, '+51999000111', 'Calle de prueba 123'].forEach((leak) => expect(html).not.toContain(leak));
    });

    test('el rol lo decide el backend en cada petición: un administrador degradado a cliente recibe 403 en la siguiente', async ({ page }) => {
      await open(page, demoted, q());
      await expect(rows(page).first()).toBeVisible();
      await setRole(demoted, 'customer');
      const res = await page.goto(`${BASE}${q()}`);
      expect(res?.status()).toBe(FORBIDDEN);
      await expect(page.getByRole('table')).toHaveCount(0);
      expect(await page.locator('body').innerText()).not.toContain(mark);
      await setRole(demoted, 'admin'); // por si hay reintentos: el resto del archivo no lo usa
    });

    test('el backend filtra: ?user_id=… y claves ajenas no cambian el resultado ni se reflejan en la página', async ({ page }) => {
      const base = await (await get(page.request, q('&status=pagado'), admin.cookie)).text();
      const tampered = await (await get(page.request, q(`&status=pagado&user_id=${buyer.id}&role=customer&page_size=${OVERSIZE}&sort=asc`), admin.cookie)).text();
      const numbers = (html: string): string[] => own().map((o) => o.number).filter((n) => html.includes(n));
      expect(numbers(tampered)).toEqual(numbers(base));
      expect(tampered).not.toContain(buyer.id);
    });

    test('solo lectura: un POST a la página no cambia nada (no hay acción de escritura)', async ({ request }) => {
      const before = (await adminList(admin, { q: mark, page_size: '50' })).total;
      const res = await request.post(`${BASE}${PATH}`, { headers: { cookie: admin.cookie, origin: BASE }, form: { status: 'cancelado' }, failOnStatusCode: false, maxRedirects: 0 });
      expect([OK, SEE_OTHER, NOT_FOUND, NOT_ALLOWED]).toContain(res.status());
      expect((await adminList(admin, { q: mark, page_size: '50' })).total).toBe(before);
    });
  });

  // --- contenido de la tabla ------------------------------------------------------------------------------------
  test.describe('contenido', () => {
    test('los 25 pedidos sembrados existen en el backend (precondición)', async () => {
      const res = await adminList(admin, { q: mark, page_size: '50' });
      expect(res.total).toBe(own().length);
    });

    STATUSES.forEach((s) =>
      test(`el pedido «${STATUS_LABEL[s]}» se pinta con su StatusPill y su texto`, async ({ page }) => {
        await open(page, admin, q(`&status=${s}`));
        const row = rowOf(page, byStatus(s));
        await expect(row).toBeVisible();
        await expect(row.locator('.pill')).toHaveText(STATUS_LABEL[s]);
        await expect(row.locator('.pill')).toHaveAttribute('data-tone', ANY_VALUE);
      }));

    test('cada fila: número, destinatario, unidades, importe de formatMoney (sin .00), fecha dd/mm/aaaa hh:mm en Lima', async ({ page }) => {
      await open(page, admin, q('&status=pagado'));
      const api = await adminList(admin, { q: mark, status: 'pagado', page_size: '50' });
      const todayLima = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
      const row = rowOf(page, byStatus('pagado'));
      const text = await row.innerText();
      const expected = api.items.find((i) => i.number === byStatus('pagado').number)!;
      expect(text).toContain(byStatus('pagado').number);
      expect(text).toContain(byStatus('pagado').recipient);
      expect(text.replaceAll(' ', ' ')).toContain(formatMoney(expected.total).replaceAll(' ', ' '));
      expect(text).not.toContain('.00');
      expect(text).toMatch(DATE_TIME);
      expect(text).toContain(todayLima);
      expect(text).toContain('Miraflores');
    });

    test('«Vence …» solo en el pendiente de pago', async ({ page }) => {
      await open(page, admin, q('&status=pendiente_pago'));
      await expect(rowOf(page, byStatus('pendiente_pago'))).toContainText('Vence');
      await STATUSES.filter((s) => s !== 'pendiente_pago').reduce(async (prev, s) => {
        await prev;
        await page.goto(`${BASE}${q(`&status=${s}`)}`);
        await expect(rowOf(page, byStatus(s)), s).not.toContainText('Vence');
      }, Promise.resolve());
    });

    test('el recojo en tienda (district nulo) dice «Recojo en tienda»; los demás, su distrito', async ({ page }) => {
      await open(page, admin, q('&status=listo_para_recojo'));
      await expect(rowOf(page, byStatus('listo_para_recojo'))).toContainText('Recojo en tienda');
      await page.goto(`${BASE}${q('&status=enviado')}`);
      await expect(rowOf(page, byStatus('enviado'))).toContainText('Miraflores');
      await expect(rowOf(page, byStatus('enviado'))).not.toContainText('Recojo en tienda');
    });

    test('el destinatario con HTML se pinta como texto: sin imagen inyectada, sin ejecutar nada', async ({ page }) => {
      const dialogs: string[] = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
      const errors = collectConsoleErrors(page);
      await open(page, admin, q('&status=pagado'));
      await expect(page.locator('tbody img')).toHaveCount(0);
      await expect(page.locator('tbody')).toContainText(HOSTILE_TAIL);
      expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
      expect(dialogs).toEqual([]);
      expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
    });

    test('el número enlaza al detalle con la consulta actual en `volver`, y la fila tiene id para recuperar el foco', async ({ page }) => {
      await open(page, admin, q('&status=pagado'));
      const target = byStatus('pagado');
      const link = rowOf(page, target).getByRole('link', { name: target.number });
      const href = (await link.getAttribute('href')) ?? '';
      const url = new URL(href, BASE);
      expect(url.pathname).toBe(`${PATH}/${target.id}`);
      expect(new URLSearchParams(url.searchParams.get('volver') ?? '').get('status')).toBe('pagado');
      expect(new URLSearchParams(url.searchParams.get('volver') ?? '').get('q')).toBe(mark);
      await page.evaluate((hash) => (window.location.hash = hash), `o-${target.id}`);
      await expect(rowOf(page, target)).toBeVisible();
      await expect(page.locator(`tr:target`)).toHaveAttribute('id', `o-${target.id}`);
    });

    test('el número abre el detalle real (T-146) y «Volver a pedidos» regresa al listado con los filtros y a la fila', async ({ page }) => {
      const target = byStatus('pagado');
      await open(page, admin, q('&status=pagado&created_from=2026-01-01'));
      await rowOf(page, target).getByRole('link', { name: target.number }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`${PATH}/${target.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(target.number);
      await page.getByRole('link', { name: 'Volver a pedidos' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(PATH);
      expect(param(page, 'status')).toBe('pagado');
      expect(param(page, 'q')).toBe(mark);
      expect(param(page, 'created_from')).toBe('2026-01-01');
      expect(new URL(page.url()).hash).toBe(`#o-${target.id}`);
      await expect(rowOf(page, target)).toBeVisible();
    });

    test('un `volver` manipulado no saca del sitio: solo vuelve al listado con la lista blanca', async ({ page }) => {
      const target = byStatus('pagado');
      const res = await visit(page, admin, `${PATH}/${target.id}?volver=${encodeURIComponent('status=pagado&evil=1&next=https://evil.test')}`);
      expect(res?.status()).toBe(OK);
      const href = (await page.getByRole('link', { name: 'Volver a pedidos' }).getAttribute('href')) ?? '';
      expect(href.startsWith(`${PATH}`)).toBe(true);
      expect(href).not.toContain('evil');
    });

    test('el importe y el estado de cada fila coinciden con los del backend (no se calcula nada en la página)', async ({ page }) => {
      await open(page, admin, q('&status=pagado'));
      const api = await adminList(admin, { q: mark, status: 'pagado', page_size: '50' });
      const shown = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => (tr as HTMLElement).innerText.replaceAll(' ', ' ')));
      const fresh = (await adminList(admin, { q: mark, status: 'pagado', page_size: '50' })).items.slice(0, PAGE_SIZE);
      expect(shown).toHaveLength(Math.min(api.total, PAGE_SIZE));
      fresh.forEach((i) => expect(shown.join('\n')).toContain(formatMoney(i.total).replaceAll(' ', ' ')));
    });
  });

  // --- filtros --------------------------------------------------------------------------------------------------
  test.describe('filtros', () => {
    test('por estado: cada chip filtra, queda activo (aria-current) y la URL lo conserva', async ({ page }) => {
      await open(page, admin, q());
      await chip(page, 'Enviado').click();
      await expect.poll(() => param(page, 'status')).toBe('enviado');
      expect(param(page, 'q')).toBe(mark);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first().locator('.pill')).toHaveText('Enviado');
      await expect(chip(page, 'Enviado')).toHaveAttribute('aria-current', ANY_VALUE);
      await expect(chip(page, 'Todos')).not.toHaveAttribute('aria-current', ANY_VALUE);
    });

    test('«Todos» quita el estado y conserva el texto', async ({ page }) => {
      await open(page, admin, q('&status=enviado'));
      await chip(page, 'Todos').click();
      await expect.poll(() => param(page, 'status')).toBeNull();
      expect(param(page, 'q')).toBe(mark);
      await expect(rows(page)).toHaveCount(PAGE_SIZE);
    });

    test('por texto: el destinatario sin distinguir mayúsculas, parcial', async ({ page }) => {
      await open(page, admin, `${PATH}?q=${encodeURIComponent(`${mark.toUpperCase()} lote 01`)}`);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText(`${mark} Lote 01`);
    });

    test('por texto: el número completo (VAL-000123) y solo sus dígitos devuelven ese pedido', async ({ page }) => {
      const target = byStatus('entregado');
      await open(page, admin, `${PATH}?q=${encodeURIComponent(target.number)}`);
      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).first()).toContainText(target.number);
      const digits = String(Number(target.number.replace('VAL-', '')));
      await open(page, admin, `${PATH}?q=${digits}`);
      await expect(rowOf(page, target)).toBeVisible();
    });

    test('por fechas (días de Lima): 9 y 10 de marzo separan 03:30/04:59 UTC de 05:00 UTC', async ({ page }) => {
      await open(page, admin, q('&created_from=2026-03-09&created_to=2026-03-09'));
      await expect(rows(page)).toHaveCount(SKIP);
      await expect(rowOf(page, byStatus('entregado'))).toContainText(NIGHT_LIMA);
      await expect(rowOf(page, byStatus('expirado'))).toContainText(LATE_LIMA);
      await open(page, admin, q('&created_from=2026-03-10&created_to=2026-03-10'));
      await expect(rows(page)).toHaveCount(1);
      await expect(rowOf(page, byStatus('cancelado'))).toContainText(MIDNIGHT_LIMA);
      await open(page, admin, q('&created_from=2026-03-09&created_to=2026-03-10'));
      await expect(rows(page)).toHaveCount(SKIP + 1);
    });

    test('«Desde» sin «Hasta» y al revés', async ({ page }) => {
      const today = limaDay(Date.now());
      await open(page, admin, q(`&created_from=${today}`));
      expect(await numbersOf(page)).toHaveLength(PAGE_SIZE);
      await open(page, admin, q(`&created_to=${limaDay(Date.now() - DAY_MS)}`));
      await expect(rows(page)).toHaveCount(SKIP + 1);
    });

    test('combinados: estado + texto + fechas', async ({ page }) => {
      await open(page, admin, q('&status=cancelado&created_from=2026-03-10&created_to=2026-03-10'));
      await expect(rows(page)).toHaveCount(1);
      await open(page, admin, q('&status=pagado&created_from=2026-03-10&created_to=2026-03-10'));
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByText('No hay pedidos con estos filtros')).toBeVisible();
    });

    test('lista blanca: status inválido, page=0, fechas basura y claves ajenas se ignoran sin error', async ({ page }) => {
      const res = await visit(page, admin, q(`&status=otro&page=0&created_from=x&created_to=y&user_id=1&page_size=${OVERSIZE}&sort=asc`));
      expect(res?.status()).toBe(OK);
      await expect(rows(page)).toHaveCount(PAGE_SIZE);
      await expect(page.getByLabel('Desde', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Hasta', { exact: true })).toHaveValue('');
      await expect(chip(page, 'Todos')).toHaveAttribute('aria-current', ANY_VALUE);
    });

    test('la URL se conserva al recargar: campos, chip activo y filas iguales', async ({ page }) => {
      await open(page, admin, q('&status=pagado&created_from=2026-01-01&page=2'));
      const before = await numbersOf(page);
      await page.reload();
      expect(await numbersOf(page)).toEqual(before);
      await expect(searchBox(page)).toHaveValue(mark);
      await expect(page.getByLabel('Desde', { exact: true })).toHaveValue('2026-01-01');
      await expect(chip(page, 'Pagado')).toHaveAttribute('aria-current', ANY_VALUE);
    });

    test('aplicar el formulario escribe la consulta en la URL, vuelve a la página 1 y conserva el estado activo', async ({ page }) => {
      await open(page, admin, q('&status=pagado&page=2'));
      await page.getByLabel('Desde', { exact: true }).fill('2026-01-01');
      await page.getByLabel('Hasta', { exact: true }).fill('2099-12-31');
      await apply(page).click();
      await expect.poll(() => param(page, 'created_from')).toBe('2026-01-01');
      expect(param(page, 'created_to')).toBe('2099-12-31');
      expect(param(page, 'status')).toBe('pagado');
      expect(param(page, 'q')).toBe(mark);
      expect([null, '1']).toContain(param(page, 'page'));
      expect(new URL(page.url()).searchParams.has('page_size')).toBe(false);
    });

    test('«Limpiar filtros» deja la página sin consulta', async ({ page }) => {
      await open(page, admin, q('&status=pagado&created_from=2026-01-01'));
      await page.getByRole('link', { name: 'Limpiar filtros' }).first().click();
      await expect.poll(() => new URL(page.url()).search).toBe('');
      await expect(searchBox(page)).toHaveValue('');
    });

    test('sin JavaScript: el formulario GET filtra y los chips y la paginación navegan', async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE, viewport: { width: DESKTOP, height: HEIGHT } });
      await context.addCookies(browserCookies(admin.cookies));
      const page = await context.newPage();
      await page.goto(`${BASE}${PATH}`);
      await searchBox(page).fill(`${mark} Lote 03`);
      await apply(page).click();
      await expect.poll(() => param(page, 'q')).toBe(`${mark} Lote 03`);
      await expect(rows(page)).toHaveCount(1);
      await page.goto(`${BASE}${q()}`);
      await page.getByRole('link', { name: 'Página 2' }).click();
      await expect.poll(() => param(page, 'page')).toBe('2');
      expect(await rows(page).count()).toBe(own().length - PAGE_SIZE);
      await chip(page, 'Pagado').click();
      await expect.poll(() => param(page, 'status')).toBe('pagado');
      expect(await rows(page).count()).toBeGreaterThan(0);
      await context.close();
    });
  });

  // --- paginación -----------------------------------------------------------------------------------------------
  test.describe('paginación', () => {
    test('25 pedidos, 20 por página: la página 1 tiene 20 filas y la 2, 5; sin repetidos ni faltantes', async ({ page }) => {
      await open(page, admin, q());
      const first = await numbersOf(page);
      expect(first).toHaveLength(PAGE_SIZE);
      await page.getByRole('link', { name: 'Página 2' }).click();
      await expect.poll(() => param(page, 'page')).toBe('2');
      const second = await numbersOf(page);
      expect(second).toHaveLength(own().length - PAGE_SIZE);
      expect(new Set([...first, ...second]).size).toBe(own().length);
      expect([...first, ...second].sort()).toEqual(own().map((o) => o.number).sort());
    });

    test('los enlaces de página conservan los filtros y la página actual lleva aria-current', async ({ page }) => {
      await open(page, admin, q('&created_from=2026-01-01'));
      await page.getByRole('link', { name: 'Siguiente' }).click();
      await expect.poll(() => param(page, 'page')).toBe('2');
      expect(param(page, 'q')).toBe(mark);
      expect(param(page, 'created_from')).toBe('2026-01-01');
      await expect(page.getByRole('link', { name: 'Página 2' })).toHaveAttribute('aria-current', 'page');
      await page.getByRole('link', { name: 'Anterior' }).click();
      await expect.poll(() => param(page, 'page')).not.toBe('2');
      expect(param(page, 'created_from')).toBe('2026-01-01');
    });

    test('cambiar de estado desde la página 2 vuelve a la 1', async ({ page }) => {
      await open(page, admin, q('&page=2'));
      await chip(page, 'Pagado').click();
      await expect.poll(() => param(page, 'status')).toBe('pagado');
      expect([null, '1']).toContain(param(page, 'page'));
      await expect(rows(page)).toHaveCount(own().filter((o) => o.status === 'pagado').length);
    });

    test('una página fuera de rango no rompe ni afirma que no hay pedidos (sí los hay) y deja volver a la lista', async ({ page }) => {
      const res = await visit(page, admin, q('&page=999'));
      expect(res?.status()).toBeLessThan(SERVER_ERROR);
      await expect(page.getByRole('heading', { level: 1, name: 'Pedidos' })).toBeVisible();
      await expect(page.getByText('Aún no hay pedidos')).toHaveCount(0);
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByText('Esta página no existe')).toBeVisible();
      const back = page.getByRole('link', { name: 'Ir a la página 1' });
      expect(new URL((await back.getAttribute('href')) ?? '', BASE).searchParams.get('q')).toBe(mark);
      await back.click();
      await expect(rows(page)).toHaveCount(PAGE_SIZE);
    });

    test('con una sola página no hay paginación', async ({ page }) => {
      await open(page, admin, q('&status=enviado'));
      await expect(page.getByRole('navigation', { name: 'Paginación' })).toHaveCount(0);
    });
  });

  // --- estados --------------------------------------------------------------------------------------------------
  test.describe('estados', () => {
    test('vacío con filtros: mensaje, «Limpiar filtros», ninguna tabla; «Limpiar» recupera el listado', async ({ page }) => {
      await open(page, admin, `${PATH}?q=zzzz-${mark}-nada`);
      await expect(page.getByText('No hay pedidos con estos filtros')).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Paginación' })).toHaveCount(0);
      await page.getByRole('link', { name: 'Limpiar filtros' }).last().click();
      await expect.poll(() => new URL(page.url()).search).toBe('');
      await expect(page.getByRole('table')).toBeVisible();
    });

    [['created_from', '1999-12-31', 'Desde'], ['created_to', '2101-01-01', 'Hasta'], ['created_from', '2026-02-31', 'Desde']].forEach(([field, value, label]) =>
      test(`el backend rechaza ${field}=${value} (422): mensaje junto a «${label}», sin tabla ni vacío y sin texto en inglés`, async ({ page }) => {
        const res = await visit(page, admin, q(`&${field}=${value}`));
        expect([OK, UNPROCESSABLE]).toContain(res?.status());
        const input = page.getByLabel(label, { exact: true });
        await expect(input).toHaveAttribute('aria-invalid', 'true');
        const described = (await input.getAttribute('aria-describedby')) ?? '';
        const msg = await page.locator(`[id="${described.split(' ').filter(Boolean).pop()}"]`).innerText();
        expect(msg.trim().length).toBeGreaterThan(0);
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByText('Aún no hay pedidos')).toHaveCount(0);
        await expect(page.getByText('No hay pedidos con estos filtros')).toHaveCount(0);
        const body = await page.locator('body').innerText();
        ['Input should', 'validation', 'String should', 'detail', 'Traceback'].forEach((w) => expect(body).not.toContain(w));
      }));

    test('un q de 150 caracteres se recorta a 100 y la página responde', async ({ page }) => {
      const res = await visit(page, admin, `${PATH}?q=${'a'.repeat(LONG_Q)}`);
      expect(res?.status()).toBeLessThan(SERVER_ERROR);
      expect((await searchBox(page).inputValue()).length).toBeLessThanOrEqual(MAX_Q);
    });

    test('q con comillas y signos de SQL no rompe la página (parámetro, no concatenación)', async ({ page }) => {
      const res = await visit(page, admin, `${PATH}?q=${encodeURIComponent(`'; DROP TABLE orders; --`)}`);
      expect(res?.status()).toBe(OK);
      await expect(page.getByText('No hay pedidos con estos filtros')).toBeVisible();
      expect((await adminList(admin, { q: mark, page_size: '50' })).total).toBe(own().length);
    });
  });

  // --- teclado y foco -------------------------------------------------------------------------------------------
  test.describe('teclado', () => {
    test('se puede filtrar solo con teclado: escribir y Enter aplican, y Tab llega a Desde, Hasta y Aplicar', async ({ page }) => {
      await open(page, admin, PATH);
      await searchBox(page).focus();
      await page.keyboard.type(`${mark} Lote 05`);
      await page.keyboard.press('Enter');
      await expect.poll(() => param(page, 'q')).toBe(`${mark} Lote 05`);
      await expect(rows(page)).toHaveCount(1);
      // Un campo de fecha de Chromium tiene varios segmentos (día, mes, año): se avanza con Tab hasta llegar a «Aplicar».
      await searchBox(page).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('Desde', { exact: true })).toBeFocused();
      const stops = await tabOrder(page, MAX_FIELD_STOPS);
      expect(stops.findIndex((f) => f.toLowerCase().startsWith('button||aplicar'))).toBeGreaterThan(-1); // innerText respeta text-transform
      expect(stops.some((f) => f.startsWith('INPUT||'))).toBe(true);
    });

    test('los chips y la paginación se activan con Enter', async ({ page }) => {
      await open(page, admin, q());
      await page.getByRole('link', { name: 'Siguiente' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => param(page, 'page')).toBe('2');
      await chip(page, 'Pagado').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => param(page, 'status')).toBe('pagado');
    });

    test('el enlace del número es el único foco de cada fila; el recorrido llega a los enlaces y a la paginación', async ({ page }) => {
      await open(page, admin, q());
      const count = await rows(page).count();
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          expect(rows(page).nth(i).locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(1)),
      );
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
      const order = await tabOrder(page, ALL_STOPS);
      expect(order.join(' ## ').toLowerCase()).toContain('siguiente');
      const rowLinks = order.filter((f) => f.startsWith('A|') && f.includes('/admin/pedidos/'));
      expect(rowLinks.length).toBeGreaterThanOrEqual(PAGE_SIZE);
    });

    const FOCUS_TARGETS: [string, (page: Page) => Locator][] = [
      ['el campo de búsqueda', (page) => searchBox(page)],
      ['«Aplicar»', (page) => apply(page)],
      ['un chip de estado', (page) => chip(page, 'Pagado')],
      ['el enlace del número', (page) => rows(page).first().getByRole('link')],
      ['«Siguiente»', (page) => page.getByRole('link', { name: 'Siguiente' })],
    ];
    FOCUS_TARGETS.forEach(([label, target]) =>
      test(`foco visible en ${label}: anillo amarillo de 2 px (en el control o en su caja)`, async ({ page }) => {
        await open(page, admin, q());
        const el = target(page);
        await el.focus();
        // El campo dibuja el anillo en su caja contenedora (:focus-within): se mira el propio elemento y hasta 2 ancestros.
        const ring = await el.evaluate((node) => {
          const chain = [node, node.parentElement, node.parentElement?.parentElement].filter((n): n is HTMLElement => !!n);
          const found = chain.map((n) => getComputedStyle(n)).find((s) => s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0);
          return found ? { color: found.outlineColor, width: parseFloat(found.outlineWidth) } : null;
        });
        expect(ring, 'sin anillo de foco').not.toBeNull();
        expect(ring!.width).toBeGreaterThanOrEqual(RING);
        expect(ring!.color).toBe(FOCUS_YELLOW);
      }));
  });

  // --- anchos, accesibilidad y capturas -----------------------------------------------------------------------------
  test.describe('anchos y accesibilidad', () => {
    WIDTHS.forEach((width) =>
      test(`${width} px: sin desbordamiento horizontal de la página, un h1, tabla con encabezados y axe sin violaciones`, async ({ page }) => {
        const errors = collectConsoleErrors(page);
        const external = collectExternalRequests(page, BASE);
        await open(page, admin, q('&status=pagado'), width);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.locator('main#contenido')).toHaveCount(1);
        await expect(page.locator('nav[aria-label="Administración"]')).toHaveCount(1); // en 375 px vive en el menú desplegable
        await expect(page.locator('thead th[scope="col"]').first()).toBeAttached();
        await expectNoA11yViolations(page);
        expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
        expect(external).toEqual([]);
      }));

    WIDTHS.forEach((width) =>
      test(`${width} px: axe también en vacío, con 422 y con la segunda página`, async ({ page }) => {
        await open(page, admin, `${PATH}?q=zzzz-${mark}-nada`, width);
        await expectNoA11yViolations(page);
        await page.goto(`${BASE}${q('&created_from=1999-12-31')}`);
        await expectNoA11yViolations(page);
        await page.goto(`${BASE}${q('&page=2')}`);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expectNoA11yViolations(page);
      }));

    test('1440 px: la tabla de 8 columnas cabe en la retícula sin desplazamiento interno (si no, escalar: STATUS T-084)', async ({ page }) => {
      await open(page, admin, q('&status=pendiente_pago'), DESKTOP);
      const fits = await page.locator('[role="region"]').first().evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(fits).toBeLessThanOrEqual(1);
    });

    test('375 px: la tabla se desplaza dentro de su región enfocable, no la página; filtros y chips caben', async ({ page }) => {
      await open(page, admin, q('&status=pendiente_pago'), MOBILE);
      const region = page.locator('[role="region"]').first();
      await expect(region).toHaveAttribute('tabindex', '0');
      expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expect(searchBox(page)).toBeVisible();
      await expect(apply(page)).toBeVisible();
      const box = await searchBox(page).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(MOBILE);
    });

    test('objetivos táctiles: campos ≥ 44 px, botón ≥ 40 px, chips y enlaces ≥ 24 px (WCAG 2.2)', async ({ page }) => {
      await open(page, admin, q());
      const height = async (l: Locator): Promise<number> => (await l.boundingBox())?.height ?? 0;
      expect(await height(searchBox(page))).toBeGreaterThanOrEqual(CONTROL - 1);
      expect(await height(page.getByLabel('Desde', { exact: true }))).toBeGreaterThanOrEqual(CONTROL - 1);
      expect(await height(apply(page))).toBeGreaterThanOrEqual(BUTTON - 1);
      expect(await height(chip(page, 'Pagado'))).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(await height(rows(page).first().getByRole('link'))).toBeGreaterThanOrEqual(MIN_TARGET);
      expect(await height(page.getByRole('link', { name: 'Siguiente' }))).toBeGreaterThanOrEqual(CONTROL - 1);
    });

    test('capturas a 1440 px para la revisión frente a Figma (197:200 lista, 197:554 filtrada/vacía)', async ({ page }) => {
      await open(page, admin, q(), DESKTOP);
      await page.screenshot({ path: 'test-results/t084-1440-lista.png', fullPage: true });
      await open(page, admin, `${q('&status=pagado')}`, DESKTOP);
      await page.screenshot({ path: 'test-results/t084-1440-filtrada.png', fullPage: true });
      await open(page, admin, `${PATH}?q=zzzz-${mark}-nada`, DESKTOP);
      await page.screenshot({ path: 'test-results/t084-1440-vacia.png', fullPage: true });
    });
  });

  // --- regresión ------------------------------------------------------------------------------------------------
  test.describe('regresión', () => {
    test('el menú: «Pedidos» es un enlace con aria-current="page" y el resto sigue como estaba', async ({ page }) => {
      await open(page, admin, q());
      const nav = page.getByRole('navigation', { name: 'Administración' });
      await expect(nav.getByRole('link', { name: 'Pedidos' })).toHaveAttribute('aria-current', 'page');
      await expect(nav.getByRole('link', { name: 'Pedidos' })).toHaveAttribute('href', PATH);
      await expect(nav.getByRole('link', { name: 'Panel' })).not.toHaveAttribute('aria-current', 'page');
      await expect(nav.locator('[aria-disabled="true"]').filter({ hasText: 'Pronto' })).toHaveCount(['Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría', 'Productos'].length);
    });

    test('las migas y el marco: Backoffice › Pedidos, «Ver tienda» y menú de usuario', async ({ page }) => {
      await open(page, admin, q());
      const crumbs = page.getByRole('navigation', { name: 'Migas de pan' });
      await expect(crumbs).toContainText('Backoffice');
      await expect(crumbs).toContainText('Pedidos');
      await expect(page.getByRole('link', { name: 'Ver tienda' })).toBeVisible();
    });

    test('la tienda no cambia: la portada y el catálogo responden 200 y no usan el tema del backoffice', async ({ request }) => {
      await Promise.all(
        ['/', '/relojes'].map(async (path) => {
          const res = await request.get(`${BASE}${path}`, { failOnStatusCode: false });
          expect(res.status(), path).toBe(OK);
          const html = await res.text();
          expect(html.slice(0, html.indexOf('<head>')), path).not.toContain('data-context');
        }),
      );
    });
  });
});
