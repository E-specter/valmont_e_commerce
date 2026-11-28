import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { liveEnv, sessionCookies, signIn, type LiveEnv } from '../tests/helpers/supabase-live';
import { QA_PHRASE, browserCookies, createQaUser, deleteQaUser, setRole, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-142 · marco del backoffice, tema, guardia de administrador y «Sin permiso» contra el Supabase local y el backend reales.
// Requiere `npm run db:start`, el backend en :8000 y Docker (el rol admin se fija con `docker exec … psql` SOLO para los `qa-t142-*`, D-AB3).
// En T-142 aún no existe `/admin` (llega con T-145): la guardia con datos reales se ejercita en `/dev/admin-layout` (que usa `requireAdmin`).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const LAYOUT = '/dev/admin-layout';
const HOOK_TIMEOUT = 180_000;
const NAV_TIMEOUT = 20_000;
const FOUND = 302;
const OK = 200;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const UNAVAILABLE = 503;
const NO_STORE = 'private, no-store';
const SIDEBAR = 260;
const TOPBAR = 72;
const CONTENT_MAX = 1180;
const GUTTER = 32;
const FOCUS_YELLOW = 'rgb(255, 217, 0)';
const FOREST = 'rgb(0, 35, 18)';
const FOREST_DEEP = 'rgb(0, 26, 11)';
const IVORY = 'rgb(255, 253, 228)';
const ADMIN_LABELS = ['Panel', 'Pedidos', 'Productos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría'];
// Entradas sin pantalla todavía (T-147 habilitó «Productos»; cada tarea posterior saca la suya de esta lista).
const SOON = ['Pedidos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría'];
const ENABLED_LINKS = ['Panel', 'Productos'];
const MENU_WORDS = ['Pedidos', 'Productos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría', 'Pronto'];
const WIDTHS = [1280, 1440];
const MAX_TABS = 24;
const EVIL = 'https://evil.test';

let env: LiveEnv;
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'escribe usuarios y mide el escritorio: se ejecuta una vez (escritorio)'));

// --- ayudantes --------------------------------------------------------------------------------------------------
const nav = (page: Page) => page.locator('nav[aria-label="Administración"]');
const sidebar = (page: Page) => page.locator('[popover]:has(nav[aria-label="Administración"])');
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const menuLeaks = (text: string): string[] => MENU_WORDS.filter((w) => text.includes(w));

/** Sesión nueva (otro `session_id`) del mismo usuario: cerrar sesión la revoca en el servidor y no debe afectar al resto de pruebas. */
async function freshCookie(user: QaUser): Promise<{ name: string; value: string }[]> {
  const s = await signIn(env, { id: user.id, email: user.email, secret: QA_PHRASE });
  return sessionCookies(env, s);
}

async function openLayout(page: Page, user: QaUser, width = 1440, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await asUser(page, user);
  const res = await page.goto(`${BASE}${LAYOUT}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Texto y destino del elemento enfocado. */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}|${el.getAttribute('aria-label') ?? ''}|${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}|${el.getAttribute('href') ?? ''}` : '';
  });

async function tabOrder(page: Page, count = MAX_TABS): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    seen.push(await focused(page));
  }
  return seen;
}

test.beforeAll(() => {
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
});

// --- sin sesión -------------------------------------------------------------------------------------------------
test.describe('guardia · sin sesión', () => {
  const LOGIN = (path: string) => `/ingresar?next=${encodeURIComponent(path)}`;

  const GUARDED = [
    '/admin', '/admin/', '/admin/x', '/admin/pedidos', '/Admin', '/ADMIN/x', '/%61dmin', '/%61dmin/x', '/a%64min/pedidos', '/admin//x', '/admin/sin-permiso',
    '/admin/no-disponible', '/%2e/admin', '/x/../admin', '/admin%2Fx',
  ];
  GUARDED.forEach((path) =>
  test(`${path} → 302 al ingreso con next, no-store y sin cuerpo`, async ({ request }) => {
    const res = await get(request, path);
    expect(res.status()).toBe(FOUND);
    const location = res.headers().location ?? '';
    expect(location.startsWith('/ingresar?next=')).toBe(true);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(await res.text()).toBe('');
    // El destino de vuelta es una ruta interna del propio sitio (nunca un origen ajeno).
    expect(decodeURIComponent(location.split('next=')[1] ?? '').startsWith('/')).toBe(true);
    expect(location).not.toContain('//evil');
    if (['/admin', '/admin/x', '/admin/pedidos'].includes(path)) expect(location).toBe(LOGIN(path));
  }));

  test('/administracion y /admins NO se protegen (no hay redirección al ingreso): 404', async ({ request }) => {
    for (const path of ['/administracion', '/admins', '/administracion/x']) {
      const res = await get(request, path);
      expect(res.status(), path).toBe(NOT_FOUND);
    }
  });

  test('un navegador sin sesión que abre /admin termina en /ingresar?next=%2Fadmin, sin ver nada del backoffice', async ({ page }) => {
    await page.goto(`${BASE}/admin`);
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search, { timeout: NAV_TIMEOUT }).toBe(LOGIN('/admin'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('Backoffice');
    expect(await nav(page).count()).toBe(0);
  });

  test('POST /admin/sin-permiso y cualquier método sin sesión → 302 (la guardia no depende del método)', async ({ request }) => {
    const res = await request.post(`${BASE}/admin/sin-permiso`, { headers: { origin: BASE }, maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBe(FOUND);
  });

  test('/dev/admin-layout sin sesión → 302 al ingreso (requireAdmin es la red de seguridad)', async ({ request }) => {
    const res = await get(request, LAYOUT);
    expect(res.status()).toBe(FOUND);
    expect(res.headers().location).toBe(LOGIN(LAYOUT));
  });

  test('una cookie de sesión basura no da acceso: 302', async ({ request }) => {
    const res = await get(request, '/admin/x', 'sb-127-auth-token=base64-QUJDREVGRw; sb-127-auth-token.1=garbage');
    expect(res.status()).toBe(FOUND);
  });

  test('una ruta con barra invertida codificada no deja ver el backoffice (404 o 302, nunca el marco)', async ({ request }) => {
    const res = await get(request, '/%5cadmin');
    expect([FOUND, NOT_FOUND]).toContain(res.status());
    expect(await res.text()).not.toContain('Administración');
  });

  test('/bff/orders/admin sigue en 404 (lista cerrada del proxy; AB-1)', async ({ request }) => {
    for (const path of ['/bff/orders/admin', '/bff/orders/admin/x', '/bff/orders/Admin', '/bff/admin']) {
      const res = await get(request, path);
      expect([NOT_FOUND, 401], path).toContain(res.status());
      expect(res.status()).not.toBe(OK);
    }
  });
});

// --- cliente ----------------------------------------------------------------------------------------------------
test.describe('guardia · cliente (sin permiso)', () => {
  // `default`: un solo worker por grupo (comparten usuario e inicio de sesión) sin saltarse el resto si una prueba falla.
  test.describe.configure({ mode: 'default' });
  let customer: QaUser | undefined;
  test.beforeAll(async ({}, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (info.project.name === 'desktop') customer = await createQaUser(env, 'cliente', 'customer');
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteQaUser(env, customer);
  });

  test('/dev/admin-layout → 403 «No tienes permiso», no-store, noindex, sin menú, sin enlaces /admin y sin datos de la cuenta', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    await asUser(page, customer!);
    const res = await page.goto(`${BASE}${LAYOUT}`);
    expect(res?.status()).toBe(FORBIDDEN);
    expect(res?.headers()['cache-control']).toContain('no-store');
    await expect(page.getByRole('heading', { level: 1, name: 'No tienes permiso' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('html')).toHaveAttribute('data-context', 'backoffice');
    expect(await nav(page).count()).toBe(0);
    // La barra de herramientas de Astro (solo en `astro dev`) también usa popovers: se ignora.
    expect(await page.evaluate(() => [...document.querySelectorAll('[popover]')].filter((e) => !e.tagName.startsWith('ASTRO-') && !e.closest('astro-dev-toolbar')).length)).toBe(0);
    // querySelectorAll no atraviesa el shadow DOM: se ignoran los enlaces de la barra de herramientas de Astro (solo en `astro dev`).
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => !a.closest('astro-dev-toolbar')).map((a) => a.getAttribute('href')));
    expect(hrefs.filter((h) => h !== '/' && h !== '#contenido')).toEqual([]);
    expect(menuLeaks(await page.locator('body').innerText())).toEqual([]);
    const html = await res!.text();
    [customer!.email, customer!.id, customer!.token, 'customer', 'Authorization', 'api/v1', 'identity/me', 'Pedidos', 'Inventario'].forEach((s) => expect(html, s).not.toContain(s));
    expect(external).toEqual([]);
    // El propio 403 del documento aparece como «Failed to load resource»: es el estado esperado, no un error de la página.
    expect(errors.filter((e) => !/status of 403/.test(e))).toEqual([]);
  });

  test('tiene salida: enlace a la tienda y «Cerrar sesión»; accesible (axe) a 1280 y 1440', async ({ page }) => {
    await asUser(page, customer!);
    await page.goto(`${BASE}${LAYOUT}`);
    await expect(page.getByRole('link', { name: /tienda/i }).first()).toHaveAttribute('href', '/');
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoA11yViolations(page);
    }
  });

  test('/admin/sin-permiso y el «Sin permiso» de la guardia muestran lo mismo: no se revela si la ruta consultada existe', async ({ page }) => {
    await asUser(page, customer!);
    const read = async (path: string) => {
      const res = await page.goto(`${BASE}${path}`);
      return { status: res?.status(), text: await page.locator('main').innerText(), title: await page.title() };
    };
    const direct = await read('/admin/sin-permiso');
    const viaGuard = await read(LAYOUT);
    expect(direct.status).toBe(FORBIDDEN);
    expect(viaGuard.status).toBe(FORBIDDEN);
    expect(viaGuard.text).toBe(direct.text);
    expect(viaGuard.title).toBe(direct.title);
    expect(`${viaGuard.text} ${viaGuard.title}`).not.toMatch(/dev|layout/i);
  });

  ['/admin', '/admin/x', '/admin/pedidos', '/Admin', '/%61dmin/x', '/admin//pedidos'].forEach((path) =>
    test(`${path} con sesión de cliente: 403 o 404 (aún sin pantalla), nunca 200 ni datos de administración`, async ({ request }) => {
      const res = await get(request, path, customer!.cookie);
      expect([FORBIDDEN, NOT_FOUND], path).toContain(res.status());
      const body = await res.text();
      menuLeaks(body).filter((w) => w !== 'Pronto').forEach((w) => expect(body).not.toContain(`>${w}<`));
      expect(body).not.toContain(customer!.email);
      expect(res.headers()['cache-control'] ?? '').toContain('no-store');
    }),
  );

  test('/bff/orders/admin con sesión de cliente → 404', async ({ request }) => {
    for (const path of ['/bff/orders/admin', '/bff/orders/admin/x/transitions']) {
      expect((await get(request, path, customer!.cookie)).status(), path).toBe(NOT_FOUND);
    }
  });

  test('POST con Origin ajeno a una ruta de administración no hace nada: nunca 2xx', async ({ request }) => {
    const res = await request.post(`${BASE}/admin/sin-permiso`, { headers: { cookie: customer!.cookie, origin: EVIL }, form: { to: 'cancelado' }, maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBeGreaterThanOrEqual(FORBIDDEN);
    expect((await res.text()).toLowerCase()).not.toContain('cancelado');
  });

  test('«Cerrar sesión» desde el 403 cierra la sesión y borra las cookies: después /admin pide ingresar', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await ctx.addCookies(browserCookies(await freshCookie(customer!)));
    await page.goto(`${BASE}${LAYOUT}`);
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe('/');
    expect((await ctx.cookies()).filter((c) => c.name.startsWith('sb-') && c.value !== '')).toEqual([]);
    const res = await page.goto(`${BASE}/admin`);
    expect(new URL(page.url()).pathname).toBe('/ingresar');
    expect(res?.status()).toBe(OK);
    await ctx.close();
  });
});

// --- administrador ----------------------------------------------------------------------------------------------
test.describe('backoffice · administrador', () => {
  // `default`: un solo worker por grupo (comparten usuario e inicio de sesión) sin saltarse el resto si una prueba falla.
  test.describe.configure({ mode: 'default' });
  let admin: QaUser | undefined;
  test.beforeAll(async ({}, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (info.project.name === 'desktop') admin = await createQaUser(env, 'admin', 'admin');
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteQaUser(env, admin);
  });

  test('/dev/admin-layout → 200 no-store con el marco: data-context, lang, noindex, un h1, main#contenido, sin errores ni recursos externos', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    await asUser(page, admin!);
    const res = await page.goto(`${BASE}${LAYOUT}`);
    expect(res?.status()).toBe(OK);
    expect(res?.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('html')).toHaveAttribute('data-context', 'backoffice');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(1);
    await expect(page.locator('main#contenido')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('el HTML entregado no lleva credenciales, la URL de la API ni datos del perfil más allá del nombre', async ({ page }) => {
    await asUser(page, admin!);
    const res = await page.goto(`${BASE}${LAYOUT}`);
    const html = await res!.text();
    ['Authorization', 'Bearer', 'API_BASE_URL', 'api/v1', admin!.token, admin!.id, admin!.email, '"role"', 'identity/me'].forEach((s) => expect(html, s).not.toContain(s));
    const scripts = await page.locator('script:not([src])').allInnerTexts();
    scripts.forEach((t) => ['Authorization', admin!.token, 'api/v1'].forEach((s) => expect(t).not.toContain(s)));
  });

  for (const width of WIDTHS) {
    test(`retícula a ${width} px: barra lateral de 260, barra superior de 72, contenido de ${Math.min(width - SIDEBAR, CONTENT_MAX) - 2 * GUTTER} útiles, sin desbordamiento`, async ({ page }) => {
      await openLayout(page, admin!, width);
      const side = (await sidebar(page).boundingBox())!;
      expect(side.x).toBe(0);
      expect(side.y).toBe(0);
      expect(side.width).toBe(SIDEBAR);
      const top = (await page.locator('header').first().boundingBox())!;
      expect(top.height).toBe(TOPBAR);
      expect(top.x).toBe(SIDEBAR);
      const content = await page.locator('main > div').first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { box: el.getBoundingClientRect().width, inner: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
      });
      expect(content.box).toBe(Math.min(width - SIDEBAR, CONTENT_MAX));
      expect(content.inner).toBe(Math.min(width - SIDEBAR, CONTENT_MAX) - 2 * GUTTER);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/t142-admin-${width}.png` });
    });
  }

  test('tema oscuro: fondo verde, texto marfil, color-scheme dark, barras en forest-deep y foco amarillo', async ({ page }) => {
    await openLayout(page, admin!);
    const s = await page.evaluate(() => {
      const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
      return {
        scheme: css('html', 'color-scheme'),
        htmlBg: css('html', 'background-color') || css('body', 'background-color'),
        bodyBg: css('body', 'background-color'),
        text: css('body', 'color'),
        sidebarBg: css('[popover]', 'background-color'),
        topbarBg: css('header', 'background-color'),
        focus: getComputedStyle(document.documentElement).getPropertyValue('--focus-color').trim(),
        bgPage: getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim(),
        ring: getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim(),
      };
    });
    expect(s.scheme).toContain('dark');
    expect(s.bodyBg === FOREST || s.htmlBg === FOREST).toBe(true);
    expect(s.text).toBe(IVORY);
    expect(s.sidebarBg).toBe(FOREST_DEEP);
    expect(s.topbarBg).toBe(FOREST_DEEP);
    expect(s.bgPage.toLowerCase()).toBe('#002312');
    expect(s.focus.toLowerCase()).toBe('#ffd900');
    // El anillo compuesto se recompone en el contexto: amarillo, no la tinta de :root (1,1:1 sobre el fondo oscuro).
    expect(s.ring.toLowerCase()).toContain('#ffd900');
    expect(s.ring.toLowerCase()).not.toContain('#0f0f0f');
  });

  test('navegación: 8 entradas en orden; Panel (página actual) y Productos son enlaces; las demás sin href con «Pronto»', async ({ page }) => {
    await openLayout(page, admin!);
    const items = nav(page).locator('li');
    expect(await items.count()).toBe(ADMIN_LABELS.length);
    const texts = await items.allInnerTexts();
    ADMIN_LABELS.forEach((label, i) => expect(texts[i]).toContain(label));
    const panel = nav(page).getByRole('link', { name: /Panel/ });
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute('href', '/admin');
    await expect(panel).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).locator('a[href]')).toHaveCount(ENABLED_LINKS.length);
    await expect(nav(page).locator('[aria-disabled="true"]')).toHaveCount(SOON.length);
    await Promise.all(SOON.map((l) => expect(nav(page).locator('li', { hasText: l })).toContainText('Pronto')));
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
  });

  ['Reportes', 'Clientes', 'Auditoría'].forEach((label) =>
  test(`«${label}» muestra «Pronto», no es enlace, no navega y no recibe el foco (D-B1)`, async ({ page }) => {
    await openLayout(page, admin!);
    const item = nav(page).locator('li', { hasText: label });
    await expect(item).toContainText('Pronto');
    await expect(item).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(label) })).toHaveCount(0);
    await expect(item.locator('[aria-disabled="true"]')).toHaveCount(1);
    const before = page.url();
    await item.click({ force: true });
    expect(page.url()).toBe(before);
    const order = await tabOrder(page);
    expect(order.some((f) => f.includes(`|${label}`) || f.includes(label))).toBe(false);
  }));

  test('teclado: el primer Tab es «Saltar al contenido»; recorre Panel, «Ver tienda» y el menú de usuario; nunca una entrada deshabilitada; el foco es amarillo de 2 px', async ({ page }) => {
    await openLayout(page, admin!);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /saltar al contenido/i })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#contenido')).toBeFocused();
    await page.reload();
    const order = await tabOrder(page);
    expect(order.some((f) => f.endsWith('|/admin') && f.includes('Panel'))).toBe(true);
    expect(order.some((f) => /Ver tienda/.test(f))).toBe(true);
    expect(order.some((f) => /Administrador|Cuenta/.test(f))).toBe(true);
    SOON.forEach((l) => expect(order.filter((f) => f.includes(l) && f.startsWith('A|')), l).toEqual([]));
    await page.reload();
    const panel = nav(page).getByRole('link', { name: /Panel/ });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await panel.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(panel).toBeFocused();
    const ring = await panel.evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.outlineColor, width: parseFloat(s.outlineWidth), style: s.outlineStyle };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.color).toBe(FOCUS_YELLOW);
  });

  test('menú de usuario: se abre con Enter, trae «Ver tienda» y «Cerrar sesión», Escape lo cierra y devuelve el foco', async ({ page }) => {
    await openLayout(page, admin!);
    const trigger = page.locator('header button[popovertarget="menu-usuario"]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator('#menu-usuario, [popover]:has(form[action="/salir"])').first();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    // En escritorio «Ver tienda» está en la barra superior (el del panel es el respaldo de pantallas estrechas).
    await expect(page.getByRole('link', { name: 'Ver tienda' }).first()).toHaveAttribute('href', '/');
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('«Ver tienda» lleva a la tienda, que NO tiene el contexto del backoffice', async ({ page }) => {
    await openLayout(page, admin!);
    await page.getByRole('link', { name: 'Ver tienda' }).first().click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe('/');
    expect(await page.locator('html').getAttribute('data-context')).toBeNull();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(255, 253, 228)');
  });

  test('accesibilidad (axe, WCAG 2.2 AA, incluye contraste) a 1440 y 1280', async ({ page }) => {
    for (const width of WIDTHS) {
      await openLayout(page, admin!, width);
      await expectNoA11yViolations(page);
    }
  });

  test('1025 px: barra lateral fija; 1024 px: se sustituye por un menú (popover) que se abre y cierra con teclado, y el nav sigue siendo navegable', async ({ page }) => {
    await openLayout(page, admin!, 1025, 800);
    await expect(nav(page)).toBeVisible();
    await expect(page.getByRole('button', { name: /Abrir menú/ })).toBeHidden();
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(nav(page)).toBeHidden();
    const opener = page.getByRole('button', { name: 'Abrir menú de administración' });
    await expect(opener).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(nav(page)).toBeVisible();
    await expect(sidebar(page)).toHaveJSProperty('popover', 'auto');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[popover]'))).toBe(true);
    await expect(nav(page).getByRole('link', { name: /Panel/ })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.screenshot({ path: 'test-results/t142-admin-1024.png' });
    await page.keyboard.press('Escape');
    await expect(nav(page)).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('sin JavaScript el menú de tableta sigue siendo un <nav> utilizable (popover declarativo)', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1024, height: 768 } });
    await ctx.addCookies(browserCookies(admin!.cookies));
    const page = await ctx.newPage();
    await page.goto(`${BASE}${LAYOUT}`);
    await page.getByRole('button', { name: 'Abrir menú de administración' }).click();
    await expect(nav(page)).toBeVisible();
    await expect(nav(page).getByRole('link', { name: /Panel/ })).toHaveAttribute('href', '/admin');
    await ctx.close();
  });

  test('móvil (375): sin desbordamiento horizontal y con un único h1', async ({ page }) => {
    await openLayout(page, admin!, 375, 812);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('/bff/orders/admin sigue en 404 también para un administrador (AB-1: sin proxy de administración)', async ({ request }) => {
    for (const path of ['/bff/orders/admin', '/bff/orders/admin/x', '/bff/orders/admin/x/transitions']) {
      expect((await get(request, path, admin!.cookie)).status(), path).toBe(NOT_FOUND);
    }
  });

  test('«Cerrar sesión» (POST /salir) cierra la sesión; después /dev/admin-layout pide ingresar', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await ctx.addCookies(browserCookies(await freshCookie(admin!)));
    await page.goto(`${BASE}${LAYOUT}`);
    await page.locator('header button[popovertarget="menu-usuario"]').click();
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe('/');
    expect((await ctx.cookies()).filter((c) => c.name.startsWith('sb-') && c.value !== '')).toEqual([]);
    await page.goto(`${BASE}${LAYOUT}`);
    expect(new URL(page.url()).pathname).toBe('/ingresar');
    await ctx.close();
  });
});

// --- rol retirado a media sesión (el backend decide, no la cookie) -----------------------------------------------
test.describe('guardia · el rol se lee del backend en cada petición', () => {
  // `default`: un solo worker por grupo (comparten usuario e inicio de sesión) sin saltarse el resto si una prueba falla.
  test.describe.configure({ mode: 'default' });
  let user: QaUser | undefined;
  test.beforeAll(async ({}, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (info.project.name === 'desktop') user = await createQaUser(env, 'rol', 'admin');
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteQaUser(env, user);
  });

  test('admin → 200; rol retirado con la misma cookie → 403 sin menú; rol devuelto → 200 otra vez (sin cachés ni estado en la cookie)', async ({ request }) => {
    expect((await get(request, LAYOUT, user!.cookie)).status()).toBe(OK);
    await setRole(user!, 'customer');
    const denied = await get(request, LAYOUT, user!.cookie);
    expect(denied.status()).toBe(FORBIDDEN);
    expect(menuLeaks(await denied.text())).toEqual([]);
    await setRole(user!, 'admin');
    expect((await get(request, LAYOUT, user!.cookie)).status()).toBe(OK);
  });

  test('setRole solo actúa sobre usuarios de la suite: un id ajeno no cambia nada', async () => {
    const stranger: QaUser = { ...user!, id: '00000000-0000-0000-0000-000000000000' };
    await expect(setRole(stranger, 'admin')).rejects.toThrow();
  });
});

// --- /admin/no-disponible (el estado 503 de la guardia) -----------------------------------------------------------------
// Las respuestas 401/403/5xx de `/identity/me` se prueban con unitarias (un solo `astro dev` por proyecto impide levantar un servidor auxiliar con la
// API simulada; el backend real no se detiene aquí). Esta página es a la que reescribe `requireAdmin` ante un 5xx o una caída.
test.describe('guardia · /admin/no-disponible', () => {
  // `default`: un solo worker por grupo (comparten usuario e inicio de sesión) sin saltarse el resto si una prueba falla.
  test.describe.configure({ mode: 'default' });
  let customer: QaUser | undefined;
  test.beforeAll(async ({}, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (info.project.name === 'desktop') customer = await createQaUser(env, 'nodisp', 'customer');
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteQaUser(env, customer);
  });

  test('con sesión: 503, no-store, aviso con «Reintentar», sin menú de administración ni datos de la cuenta; accesible (axe)', async ({ page }) => {
    await asUser(page, customer!);
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.goto(`${BASE}/admin/no-disponible`);
    expect(res?.status()).toBe(UNAVAILABLE);
    expect(res?.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await expect(page.getByRole('link', { name: /reintentar/i })).toBeVisible();
    expect(await nav(page).count()).toBe(0);
    expect(menuLeaks(await page.locator('body').innerText())).toEqual([]);
    const html = await res!.text();
    [customer!.email, customer!.id, customer!.token, 'Authorization', 'api/v1', 'ECONNREFUSED'].forEach((s) => expect(html, s).not.toContain(s));
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expectNoA11yViolations(page);
  });

  test('«Reintentar» no sale del sitio', async ({ page }) => {
    await asUser(page, customer!);
    await page.goto(`${BASE}/admin/no-disponible`);
    const href = await page.getByRole('link', { name: /reintentar/i }).getAttribute('href');
    expect(href?.startsWith('/')).toBe(true);
    expect(href?.startsWith('//')).toBe(false);
  });
});
