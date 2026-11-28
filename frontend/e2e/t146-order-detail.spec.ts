import { expect, test, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { adminOrder, api, makeAdult, pickStockProduct, placeOrder, PickupUnavailable, purgeSuiteOrders, stockOf, suiteOrderCount, type OrderRef, type Stock } from './helpers/orders-live';
import { collectConsoleErrors } from './helpers/page';

// T-146 · detalle de pedido del backoffice con un administrador real (D-050): el cliente de la suite compra por el API (tarjeta 4242, clave UUID),
// el administrador recorre preparar → enviar → entregar, cancela y reembolsa, y todo se comprueba con el API. Se borra todo al terminar.
// Requiere `npm run db:start`, el backend en :8000 y Docker (D-AB3). Solo escritorio: escribe datos y mide una vez.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 240_000;
const TEST_TIMEOUT = 60_000;
const FOUND = 302;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNSUPPORTED = 415;
const SEE_OTHER = 303;
const OK = 200;
const NO_STORE = 'private, no-store';
const UNITS_NEEDED = 7; // 5 pagados + 1 pendiente + margen
const MAX_TABS = 80;
const TRAP_TABS = 8;
const FOCUS_YELLOW = 'rgb(255, 217, 0)';
const FOCUS_WIDTH = 2;
const MOBILE_W = 375;
const MOBILE_H = 812;
const DESKTOP_W = 1280;
const DESKTOP_H = 800;
const UNPROCESSABLE = 422;
const NARROW = { width: MOBILE_W, height: MOBILE_H };
const WIDE = { width: DESKTOP_W, height: DESKTOP_H };
const FOREIGN_ORIGINS: (string | undefined)[] = ['https://evil.example', 'null', undefined];
const HOSTILE_NAME = 'Lucía <i>Torres</i> & "Co"';
const HOSTILE_NOTE = 'Pieza <b>dañada</b> <script>window.__pwned=1</script>';
const SHORT_ID = 8;

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;
let product: Stock;
let baseline: Stock;
const orders: { ship?: OrderRef; cancelPaid?: OrderRef; pending?: OrderRef; pickup?: OrderRef; stale?: OrderRef; proto?: OrderRef } = {};
let pickupOk = true;

test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT });
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'escribe pedidos reales: se ejecuta una vez (escritorio)'));

test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'desktop') return;
  info.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't146-admin', 'admin');
  customer = await createQaUser(env, 't146-cust', 'customer');
  await makeAdult(customer);
  product = await pickStockProduct(admin, UNITS_NEEDED);
  baseline = await stockOf(admin, product.product_id);
  orders.ship = await placeOrder(customer, product.product_id, { recipient: HOSTILE_NAME });
  orders.cancelPaid = await placeOrder(customer, product.product_id);
  orders.proto = await placeOrder(customer, product.product_id);
  orders.stale = await placeOrder(customer, product.product_id);
  orders.pending = await placeOrder(customer, product.product_id, { pay: false });
  orders.pickup = await placeOrder(customer, product.product_id, { method: 'pickup' }).catch((e2: unknown) => {
    if (e2 instanceof PickupUnavailable) {
      pickupOk = false;
      return undefined;
    }
    throw e2;
  });
});

test.afterAll(async ({}, info) => {
  if (info.project.name !== 'desktop' || !customer) return;
  info.setTimeout(HOOK_TIMEOUT);
  purgeSuiteOrders([customer, admin].filter(Boolean), product.product_id, baseline.on_hand);
  const after = await stockOf(admin, product.product_id);
  const left = suiteOrderCount([customer, admin].filter(Boolean));
  await deleteQaUser(env, customer);
  await deleteQaUser(env, admin);
  expect(left, 'quedaron pedidos de la suite').toBe(0);
  expect(after.on_hand, 'on_hand no volvió a su valor inicial').toBe(baseline.on_hand);
  expect(after.reserved, 'reservas no volvieron a su valor inicial').toBe(baseline.reserved);
});

// --- ayudantes --------------------------------------------------------------------------------------------------
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const url = (o: OrderRef, query = ''): string => `${BASE}/admin/pedidos/${o.id}${query}`;
const mustRef = (o: OrderRef | undefined): OrderRef => {
  if (!o) throw new Error('pedido de la suite no creado');
  return o;
};
const pill = (page: Page) => page.locator('main span.pill').first();
const updated = (page: Page) => page.getByRole('status').filter({ hasText: 'Pedido actualizado' });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const trigger = (page: Page) => page.locator('button[command="show-modal"]');
const dialog = (page: Page) => page.locator('dialog');
const note = (page: Page) => dialog(page).getByLabel('Motivo de la cancelación', { exact: false });
const actionLabels = (page: Page): Promise<string[]> =>
  page.locator('main button').evaluateAll((els) => els.filter((e) => !e.closest('dialog')).map((e) => (e.textContent ?? '').replaceAll(String.fromCharCode(10), ' ').split(' ').filter(Boolean).join(' ')).filter(Boolean));
const open = async (page: Page, o: OrderRef, query = ''): Promise<void> => {
  const res = await page.goto(url(o, query));
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(o.number);
};
const postsTo = (page: Page, o: OrderRef): string[] => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/admin/pedidos/${o.id}`)) seen.push(r.url());
  });
  return seen;
};
const sameStock = async (): Promise<{ on_hand: number; reserved: number }> => {
  const s = await stockOf(admin, product.product_id);
  return { on_hand: s.on_hand, reserved: s.reserved };
};

// --- acceso -----------------------------------------------------------------------------------------------------
test.describe('acceso', () => {
  test('sin sesión: 302 al ingreso con next y sin datos', async ({ request }) => {
    const o = mustRef(orders.ship);
    const res = await request.get(url(o), { maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBe(FOUND);
    expect(res.headers().location).toBe(`/ingresar?next=${encodeURIComponent(`/admin/pedidos/${o.id}`)}`);
    expect(await res.text()).toBe('');
  });

  test('un cliente recibe 403 (GET y POST directo), sin ver ni cambiar nada', async ({ request }) => {
    const o = mustRef(orders.proto);
    const get = await request.get(url(o), { headers: { cookie: customer.cookie }, maxRedirects: 0, failOnStatusCode: false });
    expect(get.status()).toBe(FORBIDDEN);
    const body = await get.text();
    ['Lucía', '+51987654321', 'Av. Larco', o.number].forEach((pii) => expect(body, pii).not.toContain(pii));
    expect(get.headers()['cache-control']).toContain('no-store');
    const post = await request.post(url(o), { headers: { cookie: customer.cookie, origin: BASE }, form: { _action: 'transition', to: 'cancelado', note: 'intruso' }, maxRedirects: 0, failOnStatusCode: false });
    expect(post.status()).toBe(FORBIDDEN);
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
  });
});

// --- protocolo del POST -----------------------------------------------------------------------------------------
test.describe('protocolo del POST (Origin, formulario, PRG)', () => {
  test('Origin ajeno, null o ausente → 403 y el pedido no cambia', async ({ request }) => {
    const o = mustRef(orders.proto);
    await Promise.all(FOREIGN_ORIGINS.map(async (origin) => {
      const res = await request.post(url(o), { headers: { cookie: admin.cookie, ...(origin ? { origin } : {}) }, form: { _action: 'transition', to: 'cancelado', note: 'x' }, maxRedirects: 0, failOnStatusCode: false });
      // El 403 puede venir de la comprobación de origen de Astro (antes de la página): aquí solo importa que se rechace.
      expect(res.status(), String(origin)).toBe(FORBIDDEN);
    }));
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
  });

  test('cuerpo que no es un formulario → 415 y sin cambios', async ({ request }) => {
    const o = mustRef(orders.proto);
    const res = await request.post(url(o), { headers: { cookie: admin.cookie, origin: BASE }, data: { to: 'cancelado', note: 'x' }, maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBe(UNSUPPORTED);
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
  });

  test('un destino no válido (pagado, expirado, vacío) → 422 sin cambios; ninguna acción por GET', async ({ request }) => {
    const o = mustRef(orders.proto);
    await Promise.all(['pagado', 'expirado', 'pendiente_pago', '', 'x'].map(async (to) => {
      const res = await request.post(url(o), { headers: { cookie: admin.cookie, origin: BASE }, form: { _action: 'transition', to }, maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), to).toBe(UNPROCESSABLE);
    }));
    const get = await request.get(url(o, '?_action=transition&to=cancelado&note=x'), { headers: { cookie: admin.cookie }, maxRedirects: 0, failOnStatusCode: false });
    expect(get.status()).toBe(OK);
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
  });

  test('un avance válido responde 303 con no-store; repetirlo es 409 con aviso y el pedido cambia una sola vez', async ({ request }) => {
    const o = mustRef(orders.proto);
    const headers = { cookie: admin.cookie, origin: BASE };
    const first = await request.post(url(o), { headers, form: { _action: 'transition', to: 'en_preparacion' }, maxRedirects: 0, failOnStatusCode: false });
    expect(first.status()).toBe(SEE_OTHER);
    expect(first.headers()['cache-control']).toBe(NO_STORE);
    expect(first.headers().location).toContain(`/admin/pedidos/${o.id}`);
    const again = await request.post(url(o), { headers, form: { _action: 'transition', to: 'en_preparacion' }, maxRedirects: 0, failOnStatusCode: false });
    expect(again.status()).toBe(CONFLICT);
    expect(await again.text()).toContain('El estado del pedido cambió');
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('en_preparacion');
    expect(after.history.filter((h) => h.status === 'en_preparacion')).toHaveLength(1);
  });

  test('«volver» hostil: el enlace y la redirección siguen dentro de /admin/pedidos', async ({ page, request }) => {
    const o = mustRef(orders.proto);
    const hostile = ['https://evil.example', '//evil.example', String.raw`/\evil`, 'javascript:alert(1)', 'status=en_preparacion&evil=1&next=//evil.example'];
    await asUser(page, admin);
    await hostile.reduce(async (prev, v) => {
      await prev;
      await page.goto(url(o, `?volver=${encodeURIComponent(v)}`));
      const href = (await page.getByRole('link', { name: 'Volver a pedidos' }).getAttribute('href')) ?? '';
      expect(href.startsWith('/admin/pedidos'), `${v} → ${href}`).toBe(true);
      expect(href.toLowerCase()).not.toContain('evil.example');
      expect(href.toLowerCase()).not.toContain('javascript');
      expect(new URL(href, BASE).origin).toBe(BASE);
    }, Promise.resolve());
    // Un 303 con `volver` hostil tampoco sale del sitio (el pedido está en preparación: se usa el avance válido «enviado»).
    const sent = await request.post(url(o, `?volver=${encodeURIComponent('https://evil.example')}`), { headers: { cookie: admin.cookie, origin: BASE }, form: { _action: 'transition', to: 'enviado' }, maxRedirects: 0, failOnStatusCode: false });
    expect(sent.status()).toBe(SEE_OTHER);
    const location = sent.headers().location ?? '';
    expect(location.startsWith(`/admin/pedidos/${o.id}`)).toBe(true);
    expect(location.toLowerCase()).not.toContain('evil');
  });
});

// --- recorrido de envío ----------------------------------------------------------------------------------------
test.describe('envío: pagado → en preparación → enviado → entregado', () => {
  test('pagado: datos reales, solo las acciones válidas, texto hostil como texto, axe', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const o = mustRef(orders.ship);
    await asUser(page, admin);
    await page.setViewportSize(WIDE);
    await open(page, o);
    await expect(pill(page)).toContainText('Pagado');
    await expect(page.locator('main')).toContainText('S/');
    await expect(page.locator('main')).toContainText(product.sku);
    await expect(page.locator('main')).toContainText(HOSTILE_NAME);
    expect(await page.locator('main i').count()).toBe(0);
    await expect(page.locator('main')).toContainText(customer.id.slice(0, SHORT_ID));
    expect(await page.content()).not.toContain(customer.id);
    expect(await actionLabels(page)).toEqual(expect.arrayContaining(['Preparar pedido', 'Cancelar y reembolsar']));
    expect(await actionLabels(page)).not.toContain('Marcar como enviado');
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
    await expectNoA11yViolations(page);
    expect(errors).toEqual([]);
  });

  test('«Volver a pedidos» conserva la consulta del listado con la lista blanca y apunta a la fila', async ({ page }) => {
    const o = mustRef(orders.ship);
    await asUser(page, admin);
    await open(page, o, `?volver=${encodeURIComponent('status=pagado&page=2&q=ana&evil=1')}`);
    await expect(page.getByRole('link', { name: 'Volver a pedidos' })).toHaveAttribute('href', `/admin/pedidos?page=2&q=ana&status=pagado#o-${o.id}`);
    await expect(page.locator('nav[aria-label="Migas de pan"] a[href="/admin/pedidos"]')).toBeVisible();
  });

  test('sin JavaScript: «Preparar pedido» funciona (PRG) y muestra el aviso', async ({ browser }) => {
    const o = mustRef(orders.ship);
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
    await context.addCookies(browserCookies(admin.cookies));
    const page = await context.newPage();
    await open(page, o);
    await button(page, 'Preparar pedido').click();
    await expect(updated(page)).toBeVisible();
    await expect(pill(page)).toContainText('En preparación');
    expect((await adminOrder(admin, o.id)).status).toBe('en_preparacion');
    await context.close();
  });

  test('en preparación: «Marcar como enviado» con transportista; un doble clic envía una sola vez', async ({ page }) => {
    const o = mustRef(orders.ship);
    await asUser(page, admin);
    await open(page, o);
    expect(await actionLabels(page)).toEqual(expect.arrayContaining(['Marcar como enviado', 'Cancelar y reembolsar']));
    expect(await actionLabels(page)).not.toContain('Preparar pedido');
    await expectNoA11yViolations(page);
    await page.getByLabel('Transportista', { exact: false }).fill('Olva Courier');
    await page.getByLabel('Código de seguimiento', { exact: false }).fill('OL-998877');
    const posts = postsTo(page, o);
    await button(page, 'Marcar como enviado').dblclick();
    await expect(updated(page)).toBeVisible();
    await expect(pill(page)).toContainText('Enviado');
    await expect(page.locator('main')).toContainText('Olva Courier');
    await expect(page.locator('main')).toContainText('OL-998877');
    expect(posts).toHaveLength(1);
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('enviado');
    expect(after.delivery.carrier).toBe('Olva Courier');
    expect(after.delivery.tracking_code).toBe('OL-998877');
    expect(after.history.filter((h) => h.status === 'enviado')).toHaveLength(1);
  });

  test('enviado: solo «Marcar como entregado»; al entregar, sin acciones y con el historial completo', async ({ page }) => {
    const o = mustRef(orders.ship);
    await asUser(page, admin);
    await open(page, o);
    expect(await actionLabels(page)).toEqual(['Marcar como entregado']);
    await button(page, 'Marcar como entregado').click();
    await expect(updated(page)).toBeVisible();
    await expect(pill(page)).toContainText('Entregado');
    expect(await actionLabels(page)).toEqual([]);
    expect(await dialog(page).count()).toBe(0);
    const history = page.getByRole('list', { name: 'Historial de estados' });
    await Promise.all(['Pendiente de pago', 'Pagado', 'En preparación', 'Enviado', 'Entregado'].map((label) => expect(history).toContainText(label)));
    await expectNoA11yViolations(page);
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('entregado');
    expect(after.history.map((h) => h.status)).toEqual(['pendiente_pago', 'pagado', 'en_preparacion', 'enviado', 'entregado']);
    expect(after.refund).toBeNull();
  });
});

// --- recojo ----------------------------------------------------------------------------------------------------
test.describe('recojo: pagado → en preparación → listo para recojo → entregado', () => {
  test('recorrido completo con la tienda de recojo', async ({ page }) => {
    test.skip(!pickupOk, 'la boutique de recojo no está configurada en el backend local (PICKUP_STORE_*): se cubre con la Container API');
    const o = mustRef(orders.pickup);
    await asUser(page, admin);
    await open(page, o);
    await expect(page.locator('main')).toContainText('Recojo en tienda');
    await button(page, 'Preparar pedido').click();
    await expect(updated(page)).toBeVisible();
    expect(await actionLabels(page)).toEqual(expect.arrayContaining(['Marcar listo para recojo']));
    expect(await actionLabels(page)).not.toContain('Marcar como enviado');
    expect(await page.getByLabel('Transportista', { exact: false }).count()).toBe(0);
    await button(page, 'Marcar listo para recojo').click();
    await expect(pill(page)).toContainText('Listo para recojo');
    expect(await actionLabels(page)).toEqual(['Marcar como entregado']);
    await button(page, 'Marcar como entregado').click();
    await expect(pill(page)).toContainText('Entregado');
    expect((await adminOrder(admin, o.id)).history.map((h) => h.status)).toEqual(['pendiente_pago', 'pagado', 'en_preparacion', 'listo_para_recojo', 'entregado']);
  });
});

// --- cancelar y reembolsar ------------------------------------------------------------------------------------
test.describe('cancelar y reembolsar', () => {
  test('el diálogo es modal y accesible; sin motivo no se envía; con espacios, el servidor lo rechaza en el campo', async ({ page }) => {
    const o = mustRef(orders.cancelPaid);
    await asUser(page, admin);
    await open(page, o);
    await trigger(page).click();
    const dlg = page.getByRole('dialog', { name: 'Cancelar y reembolsar' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('reembolsará');
    await expect(dlg).toContainText('stock');
    expect(await dlg.evaluate((d: HTMLDialogElement) => d.matches(':modal'))).toBe(true);
    await expectNoA11yViolations(page);
    // Sin motivo: el navegador no envía (required) y el pedido no cambia.
    const posts = postsTo(page, o);
    await dlg.getByRole('button', { name: 'Cancelar y reembolsar' }).click();
    expect(posts).toHaveLength(0);
    expect(await note(page).evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    // Solo espacios: pasa el navegador, el servidor responde 422 y el diálogo vuelve abierto con el error junto al campo.
    await note(page).fill('   ');
    await dlg.getByRole('button', { name: 'Cancelar y reembolsar' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(note(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('dialog [role="alert"], dialog [id$="-error"]').first()).not.toBeEmpty();
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
    // «Volver» solo cierra.
    await dialog(page).getByRole('button', { name: 'Volver' }).click();
    await expect(dialog(page)).toBeHidden();
    expect((await adminOrder(admin, o.id)).status).toBe('pagado');
  });

  test('cancelar un pagado: estado cancelado, reembolso del total, nota hostil como texto, doble clic = una operación, stock intacto', async ({ page }) => {
    const o = mustRef(orders.cancelPaid);
    const before = await sameStock();
    await asUser(page, admin);
    await open(page, o);
    await trigger(page).click();
    await note(page).fill(HOSTILE_NOTE);
    const posts = postsTo(page, o);
    await dialog(page).getByRole('button', { name: 'Cancelar y reembolsar' }).dblclick();
    await expect(updated(page)).toBeVisible();
    await expect(pill(page)).toContainText('Cancelado');
    expect(posts).toHaveLength(1);
    const main = page.locator('main');
    await expect(main).toContainText('Reembolso');
    await expect(main).toContainText('El stock no se repone automáticamente');
    await expect(main).toContainText(HOSTILE_NOTE);
    expect(await page.locator('main b').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await actionLabels(page)).toEqual([]);
    await expectNoA11yViolations(page);
    // API: una sola cancelación y un solo reembolso por el total; el cliente también lo ve.
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('cancelado');
    expect(after.refund?.amount).toEqual(o.total);
    expect(after.refund?.at).toBeTruthy();
    expect(after.history.filter((h) => h.status === 'cancelado')).toHaveLength(1);
    expect(after.history.find((h) => h.status === 'cancelado')?.note).toBe(HOSTILE_NOTE);
    const mine = await api<{ status: string; refund: { amount: { amount: number } } | null }>(customer, 'GET', `/orders/${o.id}`);
    expect(mine.body.status).toBe('cancelado');
    expect(mine.body.refund?.amount.amount).toBe(o.total.amount);
    // R15: cancelar un pagado no repone el stock.
    expect(await sameStock()).toEqual(before);
  });

  test('cancelar un pendiente de pago: sin reembolso y libera la reserva', async ({ page }) => {
    const o = mustRef(orders.pending);
    const before = await sameStock();
    await asUser(page, admin);
    await open(page, o);
    await expect(pill(page)).toContainText('Pendiente de pago');
    expect(await actionLabels(page)).toEqual(['Cancelar pedido']);
    await trigger(page).click();
    await expect(dialog(page)).toContainText('reservas');
    await expect(dialog(page)).not.toContainText('reembolsará');
    await note(page).fill('Pedido duplicado');
    await dialog(page).getByRole('button', { name: 'Cancelar pedido' }).click();
    await expect(pill(page)).toContainText('Cancelado');
    await expect(page.locator('main')).not.toContainText('Reembolso');
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('cancelado');
    expect(after.refund).toBeNull();
    const now = await sameStock();
    expect(now.on_hand).toBe(before.on_hand);
    expect(now.reserved).toBe(before.reserved - 1);
  });
});

// --- teclado, foco, otra pestaña y sin JavaScript -----------------------------------------------------------------
test.describe('teclado y concurrencia', () => {
  test('teclado: las acciones se alcanzan con Tab, el foco es amarillo de 2 px, el diálogo atrapa el foco, Esc lo cierra y devuelve el foco', async ({ page }) => {
    const o = mustRef(orders.stale);
    await asUser(page, admin);
    await page.setViewportSize(WIDE);
    await open(page, o);
    const focusedName = (): Promise<string> => page.evaluate(() => (document.activeElement?.textContent ?? '').replaceAll(String.fromCharCode(10), ' ').split(' ').filter(Boolean).join(' '));
    const tabTo = async (name: string): Promise<void> => {
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const names = await Array.from({ length: MAX_TABS }).reduce<Promise<string[]>>(async (acc) => {
        const seen = await acc;
        if (seen.includes(name)) return seen;
        await page.keyboard.press('Tab');
        return [...seen, await focusedName()];
      }, Promise.resolve([]));
      expect(names, `no se llegó a «${name}» con Tab`).toContain(name);
    };
    await tabTo('Preparar pedido');
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { color: cs.outlineColor, width: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.color).toBe(FOCUS_YELLOW);
    expect(ring.width).toBeGreaterThanOrEqual(FOCUS_WIDTH);
    await tabTo('Cancelar y reembolsar');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    // Modal nativo: el resto de la página es inerte; el foco nunca cae en contenido de fuera (puede pasar al navegador, es decir, al <body>).
    const inside = await Array.from({ length: TRAP_TABS }).reduce<Promise<boolean[]>>(async (acc) => {
      const seen = await acc;
      await page.keyboard.press('Tab');
      return [...seen, await page.evaluate(() => !!document.activeElement?.closest('dialog') || document.activeElement === document.body)];
    }, Promise.resolve([]));
    expect(inside.every(Boolean)).toBe(true);
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('command'))).toBe('show-modal');
    // Móvil: el mismo detalle sin violaciones y sin desbordar la página.
    await page.setViewportSize(NARROW);
    await expectNoA11yViolations(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize(WIDE);
  });

  test('otra pestaña ya cambió el estado → 409 con aviso, estado actual y sin cambios extra', async ({ browser }) => {
    const o = mustRef(orders.stale);
    const ctx = await browser.newContext({ baseURL: BASE });
    await ctx.addCookies(browserCookies(admin.cookies));
    const first = await ctx.newPage();
    const second = await ctx.newPage();
    await open(first, o);
    await open(second, o); // se queda con la vista "pagado"
    await button(first, 'Preparar pedido').click();
    await expect(updated(first)).toBeVisible();
    const [response] = await Promise.all([
      second.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(o.id)),
      button(second, 'Preparar pedido').click(),
    ]);
    expect(response.status()).toBe(CONFLICT);
    await expect(second.locator('[data-tone="warning"]')).toContainText('cambió');
    await expect(pill(second)).toContainText('En preparación');
    expect(await actionLabels(second)).not.toContain('Preparar pedido');
    expect(await actionLabels(second)).toEqual(expect.arrayContaining(['Marcar como enviado']));
    const after = await adminOrder(admin, o.id);
    expect(after.history.filter((h) => h.status === 'en_preparacion')).toHaveLength(1);
    await ctx.close();
  });

  test('sin JavaScript: «Cancelar y reembolsar» abre el diálogo nativo, exige motivo y reembolsa', async ({ browser }) => {
    const o = mustRef(orders.stale);
    const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
    await ctx.addCookies(browserCookies(admin.cookies));
    const page = await ctx.newPage();
    await open(page, o);
    await trigger(page).click();
    await expect(dialog(page)).toBeVisible();
    await note(page).fill('Cancelado sin JavaScript');
    await dialog(page).getByRole('button', { name: 'Cancelar y reembolsar' }).click();
    await expect(pill(page)).toContainText('Cancelado');
    await expect(page.locator('main')).toContainText('Reembolso');
    const after = await adminOrder(admin, o.id);
    expect(after.status).toBe('cancelado');
    expect(after.refund?.amount).toEqual(o.total);
    await ctx.close();
  });
});

test.describe('cierre', () => {
  test('el stock refleja solo las ventas: el on_hand baja una vez por pedido pagado y las reservas quedan en su valor inicial', async () => {
    const now = await stockOf(admin, product.product_id);
    const paid = [orders.ship, orders.cancelPaid, orders.proto, orders.stale, orders.pickup].filter(Boolean).length;
    expect(now.on_hand).toBe(baseline.on_hand - paid);
    expect(now.reserved).toBe(baseline.reserved);
  });
});

