import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { QA_PHRASE, browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { countOrders, madeToOrderProductId, makeAdult, purgeOrders, seedOrder, waitForApi, type Seeded } from './helpers/orders';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { RUN_PREFIX, activeCategories, api, cleanup, createProductViaApi, unique, type ApiProduct } from './helpers/t147';

// T-145 · panel /admin y acceso al backoffice, de punta a punta con un administrador REAL (D-050): Supabase local, backend en :8000 y `astro dev`.
// Requiere `npm run db:start`, el backend y Docker. Usuarios `qa-t142-*`, pedidos propios y productos `QA-T147-*`: todo se borra al terminar y no se
// toca nada ajeno. Los totales del panel se comparan con los de la API de administración (que es la verdad): como otras suites pueden mover
// datos a la vez, se acepta el valor leído justo antes o justo después de cargar la página.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 90_000;
const NAV_TIMEOUT = 30_000;
const OK = 200;
const FOUND = 302;
const FORBIDDEN = 403;
const SERVER_ERROR = 500;
const CREATED = 201;
const NO_STORE = 'private, no-store';
const W_LAPTOP = 1280;
const W_WIDE = 1440;
const W_MOBILE = 375;
const WIDTHS = [W_LAPTOP, W_WIDE, W_MOBILE];
const HEIGHT = 900;
const ORDER_ROWS = 5;
const STOCK_ROWS = 4;
const MIN_TARGET = 24;
const NONE = 0;
const ONE = 1;
const UNITS_LOW = 1;
const STOCK_NOTE = 'Alta de prueba QA T-145';
const KPI = { toPrepare: 'Por preparar', pendingPayment: 'Pendientes de pago', lowStock: 'Stock bajo', sales: 'Ventas del período' } as const;
const BACKOFFICE_LINK = 'Ir al backoffice';

type Totals = { pagado: number; pendiente: number; low: number; out: number; orders: string[]; lowNames: string[]; lowIds: string[]; orderIds: string[] };
type OrderPage = { total: number; items: { id: string; number: string }[] };
type StockPage = { total: number; items: { product_id: string; name: string }[] };

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;
let buyer: QaUser;
let seeded: Seeded | undefined;
const products: ApiProduct[] = [];

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'escribe usuarios y pedidos y mide 1280, 1440 y 375 dentro de la prueba: una sola pasada (escritorio)');
  await waitForApi(); // el backend de desarrollo se recarga al editar código: no se culpa a la página de una caída ajena
});
test.describe.configure({ mode: 'default', timeout: TEST_TIMEOUT });

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 'adm145', 'admin');
  customer = await createQaUser(env, 'cli145', 'customer');
  buyer = await createQaUser(env, 'buy145', 'customer');
  await makeAdult(buyer);
  // Un pedido PAGADO real (el pedido se pide como cliente y se paga con el simulador).
  seeded = await seedOrder(buyer, admin, await madeToOrderProductId(), { recipient: `QA T145 ${unique()}`, to: 'pagado' });
  // Un producto con stock bajo (1 unidad ≤ umbral) y uno agotado (sin existencias), ambos borradores `QA-T147-*`.
  const [category] = await activeCategories(admin);
  const low = await createProductViaApi(admin, category.id, { name: `QA T145 stock bajo ${unique()}` });
  const out = await createProductViaApi(admin, category.id, { name: `QA T145 agotado ${unique()}` });
  products.push(low, out);
  const moved = await api(admin, 'POST', `/inventory/admin/stock/${low.id}/movements`, { kind: 'entrada', quantity: UNITS_LOW, note: STOCK_NOTE });
  if (moved.status !== CREATED) throw new Error(`no se pudo dar de alta el stock de prueba: ${moved.status}`);
});

test.afterAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const left = seeded ? (purgeOrders([seeded.id]), countOrders([seeded.id])) : NONE;
  const productsLeft = admin ? await cleanup(admin) : NONE;
  await Promise.all([admin, customer, buyer].map((u) => deleteQaUser(env, u)));
  expect(left, 'pedidos de la suite sin borrar').toBe(NONE);
  expect(productsLeft, 'productos QA-T147 de esta ejecución sin borrar').toBe(NONE);
});

// --- ayudantes --------------------------------------------------------------------------------------------------
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const kpi = (page: Page, label: string): Locator => page.locator('.kpi', { has: page.locator('.label', { hasText: label }) });
const value = async (page: Page, label: string): Promise<string> => (await kpi(page, label).locator('.value').innerText()).trim();
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** Lo que dice la API de administración ahora (la verdad contra la que se compara la pantalla). */
async function snapshot(): Promise<Totals> {
  await waitForApi();
  const orders = await api<OrderPage>(admin, 'GET', '/orders/admin?status=pagado&page_size=5');
  const pend = await api<OrderPage>(admin, 'GET', '/orders/admin?status=pendiente_pago&page_size=1');
  const low = await api<StockPage>(admin, 'GET', '/inventory/admin/stock?status=low_stock&page_size=4');
  const out = await api<StockPage>(admin, 'GET', '/inventory/admin/stock?status=out_of_stock&page_size=1');
  [orders, pend, low, out].forEach((r) => expect(r.status).toBe(OK));
  return {
    pagado: orders.body.total,
    pendiente: pend.body.total,
    low: low.body.total,
    out: out.body.total,
    orders: orders.body.items.map((o) => o.number),
    orderIds: orders.body.items.map((o) => o.id),
    lowNames: low.body.items.map((s) => s.name),
    lowIds: low.body.items.map((s) => s.product_id),
  };
}

/** Abre /admin con la sesión de `user` a un ancho dado y devuelve la API antes y después. */
async function openPanel(page: Page, user: QaUser, width = W_WIDE): Promise<{ before: Totals; after: Totals }> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, user);
  const before = await snapshot();
  const res = await page.goto(`${BASE}/admin`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1, name: 'Panel' })).toBeVisible();
  return { before, after: await snapshot() };
}

/** Ingreso real por el formulario (cuenta un intento de inicio de sesión: el Supabase local limita 30 cada 5 min). */
async function signInViaForm(page: Page, user: QaUser, next?: string): Promise<void> {
  await page.goto(`${BASE}/ingresar${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`);
  await page.locator('input[autocomplete="email"]').fill(user.email);
  await page.locator('input[autocomplete="current-password"]').fill(QA_PHRASE);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/ingresar'), { timeout: NAV_TIMEOUT }),
    page.getByRole('button', { name: 'Ingresar', exact: true }).click(),
  ]);
}

/** El valor mostrado cae entre lo que decía la API antes y después de cargar (otras suites pueden mover los totales a la vez). */
const expectBetween = (shown: number, a: number, b: number): void => {
  expect(shown).toBeGreaterThanOrEqual(Math.min(a, b));
  expect(shown).toBeLessThanOrEqual(Math.max(a, b));
};
const numbersInTable = (page: Page, caption: string): Promise<string[]> =>
  page.locator(`table:has(caption:text-is("${caption}")) tbody tr td:first-child`).allInnerTexts();

// --- ingreso y acceso -----------------------------------------------------------------------------------------
test.describe('acceso al backoffice', () => {
  test('el administrador que ingresa SIN next va a /admin y ve los KPI', async ({ page }) => {
    await page.setViewportSize({ width: W_LAPTOP, height: HEIGHT });
    await signInViaForm(page, admin);
    expect(new URL(page.url()).pathname).toBe('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Panel' })).toBeVisible();
    await Promise.all(Object.values(KPI).map((label) => expect(kpi(page, label)).toBeVisible()));
    await expect(kpi(page, KPI.sales)).toContainText('Sin contrato');
  });

  test('el cliente que ingresa SIN next sigue yendo a /cuenta y no ve ningún enlace al backoffice', async ({ page }) => {
    await page.setViewportSize({ width: W_LAPTOP, height: HEIGHT });
    await signInViaForm(page, customer);
    expect(new URL(page.url()).pathname).toBe('/cuenta');
    await expect(page.getByRole('heading', { level: 1, name: 'Mi cuenta' })).toBeVisible();
    await expect(page.getByRole('link', { name: BACKOFFICE_LINK })).toHaveCount(NONE);
    await expect(page.locator('a[href^="/admin"]')).toHaveCount(NONE);
  });

  test('con `next` explícito válido se respeta también al administrador: /cuenta', async ({ page }) => {
    await page.setViewportSize({ width: W_LAPTOP, height: HEIGHT });
    await signInViaForm(page, admin, '/cuenta');
    expect(new URL(page.url()).pathname).toBe('/cuenta');
  });

  test('con `next` hostil el administrador va a /admin y el cliente a /cuenta (nunca fuera del sitio)', async ({ page, browser }) => {
    await page.setViewportSize({ width: W_LAPTOP, height: HEIGHT });
    await signInViaForm(page, admin, '//evil.test');
    expect(new URL(page.url()).origin).toBe(BASE);
    expect(new URL(page.url()).pathname).toBe('/admin');
    const other = await browser.newContext({ baseURL: BASE, locale: 'es-PE' });
    const second = await other.newPage();
    await signInViaForm(second, customer, '//evil.test');
    expect(new URL(second.url()).origin).toBe(BASE);
    expect(new URL(second.url()).pathname).toBe('/cuenta');
    await other.close();
  });

  test('/cuenta del administrador muestra «Ir al backoffice» y el enlace lleva a /admin', async ({ page }) => {
    await page.setViewportSize({ width: W_LAPTOP, height: HEIGHT });
    await asUser(page, admin);
    const res = await page.goto(`${BASE}/cuenta`);
    expect(res?.status()).toBe(OK);
    const link = page.getByRole('link', { name: BACKOFFICE_LINK });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/admin');
    const box = await link.boundingBox();
    expect(box?.height ?? NONE).toBeGreaterThanOrEqual(MIN_TARGET);
    await link.click();
    await page.waitForURL('**/admin', { timeout: NAV_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: 'Panel' })).toBeVisible();
  });

  test('/cuenta del cliente NO contiene el enlace (ni en el HTML recibido)', async ({ request }) => {
    const res = await get(request, '/cuenta', customer.cookie);
    expect(res.status()).toBe(OK);
    const html = await res.text();
    expect(html).not.toContain(BACKOFFICE_LINK);
    expect(html).not.toContain('href="/admin');
  });

  test('/cuenta del administrador cumple axe a 1280 y 375, sin desbordamiento', async ({ page }) => {
    await asUser(page, admin);
    await [W_LAPTOP, W_MOBILE].reduce(async (prev, width) => {
      await prev;
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`${BASE}/cuenta`);
      await expect(page.getByRole('link', { name: BACKOFFICE_LINK })).toBeVisible();
      await expectNoA11yViolations(page);
      expect(await overflow(page), `desbordamiento a ${width}`).toBeLessThanOrEqual(NONE);
    }, Promise.resolve());
  });
});

// --- seguridad -------------------------------------------------------------------------------------------------
test.describe('seguridad del panel', () => {
  test('sin sesión: 302 a /ingresar?next=%2Fadmin, sin cuerpo útil y no-store', async ({ request }) => {
    const res = await get(request, '/admin');
    expect(res.status()).toBe(FOUND);
    expect(res.headers().location).toBe('/ingresar?next=%2Fadmin');
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.text()).not.toContain('Por preparar');
  });

  test('cliente: 403 «Sin permiso», no-store y ninguna cifra ni pedido en el HTML', async ({ request }) => {
    const res = await get(request, '/admin', customer.cookie);
    expect(res.status()).toBe(FORBIDDEN);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const html = await res.text();
    expect(html).not.toContain('Por preparar');
    if (seeded) expect(html).not.toContain(seeded.number);
  });

  test('administrador: 200, private no-store, noindex y la sesión no se filtra', async ({ request }) => {
    const res = await get(request, '/admin', admin.cookie);
    expect(res.status()).toBe(OK);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const html = await res.text();
    expect(html).toContain('noindex');
    expect(html).not.toContain(admin.token);
    expect(html).not.toContain(admin.id);
  });

  test('un cliente que añade ?role=admin no obtiene el panel', async ({ request }) => {
    const res = await get(request, '/admin?role=admin&admin=1', customer.cookie);
    expect(res.status()).toBe(FORBIDDEN);
  });

  test('el panel no responde a POST (solo lectura)', async ({ request }) => {
    const res = await request.post(`${BASE}/admin`, { headers: { cookie: admin.cookie, origin: BASE }, maxRedirects: 0, failOnStatusCode: false, form: { x: '1' } });
    expect(res.status()).toBeLessThan(SERVER_ERROR);
  });
});

// --- datos reales ----------------------------------------------------------------------------------------------
test.describe('datos reales: un pedido pagado y productos con stock bajo y agotado', () => {
  test('los KPI muestran los totales de la API; «Ventas del período» está pending', async ({ page }) => {
    const { before, after } = await openPanel(page, admin);
    expectBetween(Number(await value(page, KPI.toPrepare)), before.pagado, after.pagado);
    expectBetween(Number(await value(page, KPI.pendingPayment)), before.pendiente, after.pendiente);
    expectBetween(Number(await value(page, KPI.lowStock)), before.low, after.low);
    expect(before.pagado, 'el pedido sembrado cuenta como «por preparar»').toBeGreaterThanOrEqual(ONE);
    expect(before.low, 'el producto sembrado cuenta como stock bajo').toBeGreaterThanOrEqual(ONE);
    expect(before.out, 'el producto sembrado cuenta como agotado').toBeGreaterThanOrEqual(ONE);
    await expect(kpi(page, KPI.sales)).toHaveAttribute('data-state', 'pending');
    await expect(kpi(page, KPI.sales)).toContainText('Sin contrato');
  });

  test('«Pedidos por preparar»: las filas son las que devuelve la API, en su orden, con enlace al detalle', async ({ page }) => {
    const { before, after } = await openPanel(page, admin);
    const shown = await numbersInTable(page, 'Pedidos por preparar');
    expect(shown.length).toBeLessThanOrEqual(ORDER_ROWS);
    expect([JSON.stringify(before.orders), JSON.stringify(after.orders)]).toContain(JSON.stringify(shown));
    const links = page.locator('table:has(caption:text-is("Pedidos por preparar")) tbody tr td:first-child a');
    const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const expected = [before.orderIds, after.orderIds].map((ids) => ids.map((id) => `/admin/pedidos/${id}`));
    expect(expected.map((e) => JSON.stringify(e))).toContain(JSON.stringify(hrefs));
  });

  test('la mini tabla «Stock bajo» y la alerta de agotados salen de la API; los nombres enlazan al producto', async ({ page }) => {
    const { before, after } = await openPanel(page, admin);
    const names = await page.locator('table:has(caption:text-is("Productos con stock bajo")) tbody tr td:first-child').allInnerTexts();
    expect(names.length).toBeLessThanOrEqual(STOCK_ROWS);
    expect([JSON.stringify(before.lowNames), JSON.stringify(after.lowNames)]).toContain(JSON.stringify(names.map((n) => n.trim())));
    const alert = page.locator('li', { hasText: 'agotado' }).first();
    await expect(alert).toBeVisible();
    expectBetween(parseInt((await alert.innerText()).trim(), 10), before.out, after.out);
    const first = page.locator('table:has(caption:text-is("Productos con stock bajo")) tbody tr:first-child a');
    await expect(first, 'cada producto de «Stock bajo» enlaza a su detalle').toHaveCount(ONE);
    const href = (await first.getAttribute('href')) ?? '';
    expect([before.lowIds[NONE], after.lowIds[NONE]].map((id) => `/admin/productos/${id}`)).toContain(href);
  });

  test('los enlaces funcionan: pedido → detalle, «Ver todos…» → listado filtrado, producto → su ficha', async ({ page }) => {
    await openPanel(page, admin);
    const firstOrder = page.locator('table:has(caption:text-is("Pedidos por preparar")) tbody tr:first-child td:first-child a');
    const detail = (await firstOrder.getAttribute('href')) ?? '';
    await firstOrder.click();
    await page.waitForURL(`**${detail}`, { timeout: NAV_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: 'Ver todos' }).click();
    await page.waitForURL('**/admin/pedidos?status=pagado', { timeout: NAV_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: 'Pedidos' })).toBeVisible();
    await page.goBack();
    const firstProduct = page.locator('table:has(caption:text-is("Productos con stock bajo")) tbody tr:first-child a');
    await expect(firstProduct, 'cada producto de «Stock bajo» enlaza a su detalle').toHaveCount(ONE);
    const product = (await firstProduct.getAttribute('href')) ?? '';
    await firstProduct.click();
    await page.waitForURL(`**${product}`, { timeout: NAV_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('«Panel» del menú lleva aria-current="page" y es el único', async ({ page }) => {
    await openPanel(page, admin, W_LAPTOP);
    const current = page.locator('nav[aria-label="Administración"] [aria-current]');
    await expect(current).toHaveCount(ONE);
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', '/admin');
    await expect(current).toContainText('Panel');
  });

  test('nunca se pinta el correo, el user_id ni los datos de entrega del comprador', async ({ page }) => {
    await openPanel(page, admin);
    const html = await page.content();
    [buyer.email, buyer.id, '+51999000111', 'Calle de prueba 123'].forEach((s) => expect(html).not.toContain(s));
  });

  WIDTHS.forEach((width) => {
    test(`a ${width}px: axe sin violaciones, sin desbordamiento, sin errores de consola ni recursos externos, KPI visibles`, async ({ page }, info) => {
      const errors = collectConsoleErrors(page);
      const external = collectExternalRequests(page, BASE);
      await openPanel(page, admin, width);
      await Promise.all(Object.values(KPI).map((label) => expect(kpi(page, label)).toBeVisible()));
      await expect(page.locator('main#contenido h1')).toHaveCount(ONE);
      await expect(page.locator('main#contenido')).toHaveCount(ONE);
      expect(await overflow(page), `desbordamiento a ${width}`).toBeLessThanOrEqual(NONE);
      await expectNoA11yViolations(page);
      await page.screenshot({ path: info.outputPath(`panel-${width}.png`), fullPage: true });
      await info.attach(`panel-${width}`, { path: info.outputPath(`panel-${width}.png`), contentType: 'image/png' });
      expect(errors, 'errores de consola').toEqual([]);
      expect(external, 'recursos externos').toEqual([]);
    });
  });

  test('a 375 px las dos tablas caben (desplazamiento propio, no de la página) y «Reintentar» no aparece con la API sana', async ({ page }) => {
    await openPanel(page, admin, W_MOBILE);
    expect(await overflow(page)).toBeLessThanOrEqual(NONE);
    await expect(page.getByRole('link', { name: 'Reintentar' })).toHaveCount(NONE);
  });
});
