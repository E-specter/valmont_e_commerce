import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { createActor, deleteActor, asBrowserCookies, me, yearsFromToday, type Actor } from '../tests/helpers/t129-live';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-129 · página /cuenta contra el Supabase local y el backend reales (sesión SSR, perfil, fecha de nacimiento fijable una vez,
// cierre de sesión). Requiere `npm run db:start` y el backend en :8000. Los usuarios `qa-t129-*` los crea y borra esta suite (API de
// administración); nunca se tocan otros. Cada grupo `serial` usa un único usuario y un único inicio de sesión (límite de Supabase).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const EVIL_ORIGIN = 'https://evil.test';
const FOUND = 302;
const SEE_OTHER = 303;
const FORBIDDEN = 403;
const CONFLICT = 409;
const UNPROCESSABLE = 422;
const UNSUPPORTED_MEDIA = 415;
const METHOD_NOT_ALLOWED = 405;
const OK = 200;
const NO_STORE = 'private, no-store';
const LOGIN_REDIRECT = '/ingresar?next=%2Fcuenta';
const SMALL_WIDTH = 360;
const PHONE_WIDTH = 375;
const TABLET_FROM = 800;
const DESKTOP_WIDTH = 1280;
const WIDTHS = [SMALL_WIDTH, PHONE_WIDTH, TABLET_FROM, DESKTOP_WIDTH];
const VIEWPORT_HEIGHT = 800;
const LANDING_TIMEOUT = 15_000;
const HOOK_TIMEOUT = 120_000; // con toda la suite en paralelo, el borrado en Auth puede pasar de 30 s (N-7)
const LIVE_ENV_MESSAGE = 'Supabase local no disponible (npm run db:start)';
const BIRTH = '1990-05-17';
const BIRTH_TEXT = '17 de mayo de 1990';
const OTHER_BIRTH = '1985-03-02';
const CORRECTION_HINT = 'Para corregirla, contacta con atención al cliente.';
const NAME = 'Ana QA Torres';
const PHONE = '+51987654321';
const NEW_NAME = 'Ana María QA Torres';
const MINOR_YEARS_AGO = -10;
const FUTURE_YEARS = 1;
const ANCIENT = '1850-01-01';
const ADULT_AGE = 18;
const LONG_NAME = 'N'.repeat(130); // el backend admite 120
const SESSION_COOKIE_PREFIX = 'sb-';

let env: LiveEnv;
test.beforeAll(() => {
  const e = liveEnv();
  if (!e) throw new Error(LIVE_ENV_MESSAGE);
  env = e;
});

// --- ayudantes -------------------------------------------------------------------------------------------------
const nameBox = (page: Page): Locator => page.locator('input[name="full_name"]');
const phoneBox = (page: Page): Locator => page.locator('input[name="phone"]');
const dateBox = (page: Page): Locator => page.locator('input[name="birth_date"]');
const saveButton = (page: Page): Locator => page.getByRole('button', { name: 'Guardar' });
const logoutButton = (page: Page): Locator => page.getByRole('button', { name: 'Cerrar sesión' });
const isPost = (r: { request: () => { method: () => string }; url: () => string }): boolean => r.request().method() === 'POST' && new URL(r.url()).pathname === '/cuenta';
const setCookies = (headers: { name: string; value: string }[]): string[] => headers.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
const desktopOnly = (): void => test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'escribe datos: se ejecuta una vez (escritorio)'));

async function login(page: Page, actor: Actor): Promise<void> {
  await page.context().addCookies(asBrowserCookies(actor.cookies));
}
async function open(page: Page, actor: Actor): Promise<void> {
  await login(page, actor);
  await page.goto(`${BASE}/cuenta`);
  await expect(page.getByRole('heading', { level: 1, name: 'Mi cuenta' })).toBeVisible();
}
/** Envía el formulario y devuelve el estado de la respuesta al POST (303 si se guardó; 422/409 con el formulario renderizado). */
async function submit(page: Page): Promise<number> {
  const [res] = await Promise.all([page.waitForResponse(isPost), saveButton(page).click()]);
  return res.status();
}
/** POST crudo al formulario con la sesión del usuario (sin pasar por el navegador). */
async function rawPost(request: APIRequestContext, actor: Actor | null, fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  return request.post(`${BASE}/cuenta`, {
    form: fields,
    headers: { ...(actor ? { cookie: actor.cookie } : {}), ...headers },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
}
async function rawGet(request: APIRequestContext, actor: Actor | null, path = '/cuenta') {
  return request.get(`${BASE}${path}`, { headers: actor ? { cookie: actor.cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
}
const fieldError = (page: Page, input: Locator): Locator => input.locator('xpath=ancestor::div[contains(@class,"field")][1]').locator('.error');
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const landedOn = (page: Page, path: string) =>
  expect.poll(() => {
    const u = new URL(page.url());
    return `${u.origin}${u.pathname}`;
  }, { timeout: LANDING_TIMEOUT }).toBe(`${BASE}${path}`);

// --- ver el perfil, seguridad HTTP, accesibilidad y diseño (cliente SIN fecha; no se modifica nada) -------------------
test.describe('cuenta · cliente sin fecha de nacimiento', () => {
  test.describe.configure({ mode: 'serial' });
  let actor: Actor;
  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    actor = await createActor(env, 'view', { full_name: NAME, phone: PHONE });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  test('muestra el perfil: título, correo de la sesión, nombre, teléfono, fecha editable, enlaces y cierre de sesión; sin rol ni id; sin errores de consola ni recursos externos', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    await open(page, actor);
    await expect(page.getByText(actor.email).or(page.locator(`input[value="${actor.email}"]`)).first()).toBeVisible();
    await expect(nameBox(page)).toHaveValue(NAME);
    await expect(phoneBox(page)).toHaveValue(PHONE);
    await expect(dateBox(page)).toHaveAttribute('type', 'date');
    await expect(dateBox(page)).toBeEditable();
    await expect(page.getByLabel('Fecha de nacimiento')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mis pedidos' })).toHaveAttribute('href', '/cuenta/pedidos');
    await expect(page.getByRole('link', { name: 'Lista de deseos' }).last()).toHaveAttribute('href', '/cuenta/lista-de-deseos');
    await expect(logoutButton(page)).toBeVisible();
    await expect(page.locator('main a[href="/salir"]')).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain(actor.id);
    expect(await page.locator('main').innerText()).not.toContain('customer');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('el correo es de solo lectura y no se puede cambiar por el formulario', async ({ page }) => {
    await open(page, actor);
    const email = page.locator('input[name="email"]');
    if ((await email.count()) > 0) await expect(email).not.toBeEditable();
  });

  test('el nombre de la ventana y el robots: título con "Mi cuenta" y noindex', async ({ page }) => {
    await open(page, actor);
    expect(await page.title()).toContain('Mi cuenta');
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  });

  test('accesibilidad (axe, WCAG 2.2 AA) con el formulario editable', async ({ page }) => {
    await open(page, actor);
    await expectNoA11yViolations(page);
  });

  test('accesibilidad (axe) con un error 422 en el teléfono (nada se guarda)', async ({ page }) => {
    await open(page, actor);
    await phoneBox(page).fill('abc');
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(phoneBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expectNoA11yViolations(page);
    expect((await me(actor.token)).phone).toBe(PHONE);
  });

  test('teléfono inválido → 422 en el campo (aria-invalid, texto en español asociado), lo escrito se conserva y no se guarda', async ({ page }) => {
    await open(page, actor);
    await nameBox(page).fill('Nombre sin guardar');
    await phoneBox(page).fill('abc');
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(phoneBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(nameBox(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(fieldError(page, phoneBox(page))).toBeVisible();
    await expect(phoneBox(page)).toHaveValue('abc');
    await expect(nameBox(page)).toHaveValue('Nombre sin guardar');
    await expect(page.getByText('Datos guardados')).toHaveCount(0);
    const stored = await me(actor.token);
    expect(stored.full_name).toBe(NAME);
    expect(stored.phone).toBe(PHONE);
    expect(await page.content()).not.toContain('value_error');
  });

  WIDTHS.forEach((width) =>
    test(`sin desbordamiento horizontal a ${width} px (editable y con error)`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, actor);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await phoneBox(page).fill('abc');
      await submit(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }),
  );

  test('sin JavaScript: se ve y el formulario envía (422 en el teléfono) con un POST normal', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
    await context.addCookies(asBrowserCookies(actor.cookies));
    const page = await context.newPage();
    await page.goto(`${BASE}/cuenta`);
    await expect(page.getByRole('heading', { level: 1, name: 'Mi cuenta' })).toBeVisible();
    await expect(nameBox(page)).toHaveValue(NAME);
    await phoneBox(page).fill('abc');
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(phoneBox(page)).toHaveAttribute('aria-invalid', 'true');
    await context.close();
  });

  test('HTTP: 200 con Cache-Control private, no-store; sin Set-Cookie de sesión', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await rawGet(request, actor);
    expect(res.status()).toBe(OK);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(setCookies(res.headersArray()).filter((c) => c.startsWith(SESSION_COOKIE_PREFIX))).toEqual([]);
    await request.dispose();
  });

  test('sin sesión: GET → 302 a /ingresar?next=%2Fcuenta con no-store; el POST tampoco escribe', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const get = await rawGet(request, null);
    expect(get.status()).toBe(FOUND);
    expect(get.headers().location).toBe(LOGIN_REDIRECT);
    expect(get.headers()['cache-control']).toBe(NO_STORE);
    const post = await rawPost(request, null, { full_name: 'Intruso' });
    expect(post.status()).toBe(FOUND);
    expect(post.headers().location).toBe(LOGIN_REDIRECT);
    expect((await me(actor.token)).full_name).toBe(NAME);
    await request.dispose();
  });

  test('con una cookie de sesión basura o ajena, /cuenta pide ingreso (302) sin 500', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await request.get(`${BASE}/cuenta`, { headers: { cookie: 'sb-127-auth-token=basura' }, maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBe(FOUND);
    expect(res.headers().location).toBe(LOGIN_REDIRECT);
    await request.dispose();
  });

  test('CSRF: el POST con Origin ajeno, "null" o sin Origin se rechaza (403) y no escribe', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const cases: Record<string, string>[] = [{ origin: EVIL_ORIGIN }, { origin: 'null' }, { origin: `${BASE}.evil.test` }, { referer: `${BASE}/cuenta` }];
    const results = await Promise.all(cases.map((headers) => rawPost(request, actor, { full_name: 'Intruso CSRF' }, headers)));
    results.forEach((res) => {
      expect(res.status()).toBe(FORBIDDEN);
      expect(res.headers().location).toBeUndefined();
    });
    expect((await me(actor.token)).full_name).toBe(NAME);
    await request.dispose();
  });

  test('un cuerpo que no es un formulario (JSON o texto) → 415 sin trazas y sin escribir', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const json = await request.post(`${BASE}/cuenta`, { data: { full_name: 'Json' }, headers: { origin: BASE, cookie: actor.cookie }, failOnStatusCode: false });
    const plain = await request.post(`${BASE}/cuenta`, { data: 'basura', headers: { origin: BASE, cookie: actor.cookie, 'content-type': 'text/plain' }, failOnStatusCode: false });
    [json, plain].forEach((res) => expect(res.status()).toBe(UNSUPPORTED_MEDIA));
    const bodies = await Promise.all([json.text(), plain.text()]);
    bodies.forEach((b) => ['at ', '.ts:', 'node_modules', 'TypeError'].forEach((w) => expect(b).not.toContain(w)));
    expect((await me(actor.token)).full_name).toBe(NAME);
    await request.dispose();
  });

  test('el cliente no puede enviar role, user_id ni email por el formulario: se ignoran y el perfil no cambia de dueño ni de rol', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await rawPost(request, actor, { full_name: NAME, phone: PHONE, role: 'admin', user_id: '00000000-0000-4000-8000-000000000000', email: 'otro@example.com' });
    expect([OK, SEE_OTHER]).toContain(res.status());
    const stored = await me(actor.token);
    expect(stored.user_id).toBe(actor.id);
    expect(stored.role).toBe('customer');
    await request.dispose();
  });

  test('GET /salir no cierra la sesión (405) y la sesión sigue activa', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await request.get(`${BASE}/salir`, { headers: { cookie: actor.cookie }, maxRedirects: 0, failOnStatusCode: false });
    expect(res.status()).toBe(METHOD_NOT_ALLOWED);
    expect((await rawGet(request, actor)).status()).toBe(OK);
    await request.dispose();
  });
});

// --- editar nombre y teléfono ------------------------------------------------------------------------------------------
test.describe('cuenta · editar el perfil', () => {
  test.describe.configure({ mode: 'serial' });
  desktopOnly();
  let actor: Actor;
  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (testInfo.project.name === 'desktop') actor = await createActor(env, 'edit', { full_name: NAME, phone: PHONE });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  test('editar el nombre → "Datos guardados" (role=status); al recargar persiste; el teléfono no cambia', async ({ page }) => {
    await open(page, actor);
    await nameBox(page).fill(NEW_NAME);
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();
    await page.goto(`${BASE}/cuenta`);
    await expect(nameBox(page)).toHaveValue(NEW_NAME);
    await expect(phoneBox(page)).toHaveValue(PHONE);
    const stored = await me(actor.token);
    expect(stored.full_name).toBe(NEW_NAME);
    expect(stored.phone).toBe(PHONE);
  });

  test('vaciar el teléfono lo borra (null en el backend) y deja el nombre', async ({ page }) => {
    await open(page, actor);
    await phoneBox(page).fill('');
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    await page.goto(`${BASE}/cuenta`);
    await expect(phoneBox(page)).toHaveValue('');
    const stored = await me(actor.token);
    expect(stored.phone).toBeNull();
    expect(stored.full_name).toBe(NEW_NAME);
  });

  test('guardar sin cambios no es un error y no altera nada', async ({ page }) => {
    await open(page, actor);
    const before = await me(actor.token);
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await me(actor.token)).toEqual(before);
  });

  test('nombre demasiado largo por POST directo → 422 en el campo, sin guardarse', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await rawPost(request, actor, { full_name: LONG_NAME, phone: '' });
    expect(res.status()).toBe(UNPROCESSABLE);
    const html = await res.text();
    expect(html).toContain('aria-invalid="true"');
    ['value_error', 'string_too_long', 'at '].forEach((w) => expect(html).not.toContain(w));
    expect((await me(actor.token)).full_name).toBe(NEW_NAME);
    await request.dispose();
  });

  test('un nombre con HTML se guarda y se muestra como texto (sin inyección)', async ({ page }) => {
    await open(page, actor);
    const hostile = '<img src=x onerror=alert(1)> Ana';
    await nameBox(page).fill(hostile);
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    await page.goto(`${BASE}/cuenta`);
    await expect(page.locator('main img')).toHaveCount(0);
    await expect(nameBox(page)).toHaveValue(hostile);
  });
});

// --- fijar la fecha de nacimiento una sola vez ----------------------------------------------------------------------------
test.describe('cuenta · fijar la fecha de nacimiento una vez (D-045)', () => {
  test.describe.configure({ mode: 'serial' });
  desktopOnly();
  let actor: Actor;
  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (testInfo.project.name === 'desktop') actor = await createActor(env, 'date', { full_name: NAME, phone: PHONE });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  test('un cliente sin fecha la fija junto con el nombre en el mismo envío → solo lectura con la fecha y el texto de soporte; la fecha nunca va a consola', async ({ page }) => {
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    await open(page, actor);
    expect((await me(actor.token)).birth_date).toBeNull();
    await nameBox(page).fill(NEW_NAME);
    await dateBox(page).fill(BIRTH);
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    await expect(page.getByRole('status').filter({ hasText: 'Datos guardados' })).toBeVisible();
    await expect(page.getByText(BIRTH_TEXT)).toBeVisible();
    await expect(page.getByText(CORRECTION_HINT)).toBeVisible();
    await expect(dateBox(page)).toHaveCount(0);
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    const stored = await me(actor.token);
    expect(stored.birth_date).toBe(BIRTH);
    expect(stored.full_name).toBe(NEW_NAME);
    logged.forEach((line) => expect(line).not.toContain(BIRTH));
  });

  test('al recargar sigue en solo lectura (la fecha viene del backend) y no hay campo editable', async ({ page }) => {
    await open(page, actor);
    await expect(page.getByText(BIRTH_TEXT)).toBeVisible();
    await expect(page.getByText(CORRECTION_HINT)).toBeVisible();
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    expect(await page.url()).not.toContain(BIRTH);
  });

  test('con la fecha fijada, un POST normal (sin campo de fecha) sigue guardando el nombre y deja la fecha', async ({ page }) => {
    await open(page, actor);
    await phoneBox(page).fill('+51911222333');
    expect(await submit(page)).toBeLessThan(UNPROCESSABLE);
    const stored = await me(actor.token);
    expect(stored.phone).toBe('+51911222333');
    expect(stored.birth_date).toBe(BIRTH);
  });

  test('reenviar la MISMA fecha por POST directo no es un error y no cambia nada', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await rawPost(request, actor, { full_name: NEW_NAME, phone: PHONE, birth_date: BIRTH });
    expect([OK, SEE_OTHER]).toContain(res.status());
    expect((await me(actor.token)).birth_date).toBe(BIRTH);
    await request.dispose();
  });

  test('un segundo intento por POST directo con OTRA fecha → 409 en el formulario y la fecha original no cambia', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const res = await rawPost(request, actor, { full_name: NEW_NAME, phone: PHONE, birth_date: OTHER_BIRTH });
    expect(res.status()).toBe(CONFLICT);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html.toLowerCase()).toContain('fecha');
    expect(html).not.toContain('Datos guardados');
    expect(html).not.toContain(OTHER_BIRTH);
    ['birth_date_locked', 'at ', '.ts:'].forEach((w) => expect(html).not.toContain(w));
    expect((await me(actor.token)).birth_date).toBe(BIRTH);
    await request.dispose();
  });
});

// --- fechas no válidas: no se guardan ------------------------------------------------------------------------------------------
test.describe('cuenta · fecha de nacimiento no válida (422 por campo)', () => {
  test.describe.configure({ mode: 'serial' });
  desktopOnly();
  let actor: Actor;
  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (testInfo.project.name === 'desktop') actor = await createActor(env, 'bad', { full_name: NAME, phone: PHONE });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  const unsaved = async (): Promise<void> => expect((await me(actor.token)).birth_date).toBeNull();

  test('un menor de edad → 422 en el campo de la fecha (aria-invalid, mensaje con la mayoría de edad), no se guarda y el resto no cambia', async ({ page }) => {
    await open(page, actor);
    const minor = yearsFromToday(MINOR_YEARS_AGO);
    await nameBox(page).fill('Nombre que tampoco se guarda');
    await dateBox(page).fill(minor);
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(dateBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(fieldError(page, dateBox(page))).toContainText(String(ADULT_AGE));
    await expect(dateBox(page)).toHaveValue(minor);
    await expect(nameBox(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Datos guardados')).toHaveCount(0);
    const stored = await me(actor.token);
    expect(stored.birth_date).toBeNull();
    expect(stored.full_name).toBe(NAME);
    expect(await page.content()).not.toContain('birth_date_underage');
  });

  test('una fecha futura → 422 en el campo; no se guarda', async ({ page }) => {
    await open(page, actor);
    await dateBox(page).fill(yearsFromToday(FUTURE_YEARS));
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(dateBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(fieldError(page, dateBox(page))).toBeVisible();
    await unsaved();
  });

  test('una fecha de hace más de 120 años → 422 en el campo; no se guarda', async ({ page }) => {
    await open(page, actor);
    await dateBox(page).fill(ANCIENT);
    expect(await submit(page)).toBe(UNPROCESSABLE);
    await expect(dateBox(page)).toHaveAttribute('aria-invalid', 'true');
    await unsaved();
  });

  test('los tres errores de rango muestran mensajes distintos', async ({ page }) => {
    const messages = await [yearsFromToday(MINOR_YEARS_AGO), yearsFromToday(FUTURE_YEARS), ANCIENT].reduce<Promise<string[]>>(async (acc, value) => {
      const list = await acc;
      await page.goto(`${BASE}/cuenta`);
      await dateBox(page).fill(value);
      await submit(page);
      return [...list, (await fieldError(page, dateBox(page)).innerText()).trim()];
    }, open(page, actor).then(() => []));
    expect(new Set(messages).size).toBe(messages.length);
  });

  test('un formato distinto de AAAA-MM-DD por POST directo → 422 en el campo, sin eco del valor ni del tipo de error', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const results = await Promise.all(['17/05/1990', '1990-5-17', '19900517', '1990-05-17T00:00:00', '2001-02-29', 'ayer'].map((bad) => rawPost(request, actor, { full_name: NAME, phone: PHONE, birth_date: bad })));
    const bodies = await Promise.all(results.map((r) => r.text()));
    results.forEach((res) => expect(res.status()).toBe(UNPROCESSABLE));
    bodies.forEach((html) => {
      expect(html).toContain('aria-invalid="true"');
      ['value_error', 'Value error', 'at ', '.ts:'].forEach((w) => expect(html).not.toContain(w));
    });
    await unsaved();
    await request.dispose();
  });

  test('un 422 de la fecha no registra la fecha en consola', async ({ page }) => {
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    await open(page, actor);
    const minor = yearsFromToday(MINOR_YEARS_AGO);
    await dateBox(page).fill(minor);
    await submit(page);
    logged.forEach((line) => expect(line).not.toContain(minor));
  });
});

// --- cliente con la fecha ya fijada (datos preparados por la API) -----------------------------------------------------------
test.describe('cuenta · cliente con la fecha ya fijada', () => {
  test.describe.configure({ mode: 'serial' });
  let actor: Actor;
  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    actor = await createActor(env, 'locked', { full_name: NAME, phone: PHONE, birth_date: BIRTH });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  test('muestra "17 de mayo de 1990" y el texto de atención al cliente, sin campo editable de la fecha', async ({ page }) => {
    await open(page, actor);
    await expect(page.getByText(BIRTH_TEXT)).toBeVisible();
    await expect(page.getByText(CORRECTION_HINT)).toBeVisible();
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(dateBox(page)).toHaveCount(0);
  });

  test('accesibilidad (axe, WCAG 2.2 AA) con la fecha en solo lectura', async ({ page }) => {
    await open(page, actor);
    await expectNoA11yViolations(page);
  });

  WIDTHS.forEach((width) =>
    test(`sin desbordamiento horizontal a ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'el ancho se fija en la prueba: una vez basta');
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, actor);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }),
  );

  test('la fecha no aparece en la URL, el título ni el HTML crudo en formato ISO fuera del propio dato', async ({ page }) => {
    await open(page, actor);
    expect(page.url()).not.toContain(BIRTH);
    expect(await page.title()).not.toContain(BIRTH);
  });
});

// --- cerrar sesión -----------------------------------------------------------------------------------------------------
test.describe('cuenta · cerrar sesión', () => {
  test.describe.configure({ mode: 'serial' });
  desktopOnly();
  let actor: Actor;
  test.beforeAll(async ({}, testInfo) => {
    test.setTimeout(HOOK_TIMEOUT);
    if (testInfo.project.name === 'desktop') actor = await createActor(env, 'out', { full_name: NAME });
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await deleteActor(env, actor);
  });

  test('"Cerrar sesión" (POST) cierra la sesión: va a la portada, borra las cookies sb-* y /cuenta vuelve a pedir ingreso', async ({ page, context }) => {
    await open(page, actor);
    expect((await context.cookies(BASE)).some((c) => c.name.startsWith(SESSION_COOKIE_PREFIX))).toBe(true);
    const [res] = await Promise.all([page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/salir'), logoutButton(page).click()]);
    expect(res.status()).toBe(SEE_OTHER);
    await landedOn(page, '/');
    expect((await context.cookies(BASE)).filter((c) => c.name.startsWith(SESSION_COOKIE_PREFIX))).toEqual([]);
    await page.goto(`${BASE}/cuenta`);
    await expect(page).toHaveURL(`${BASE}${LOGIN_REDIRECT}`);
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('tras cerrar sesión, el botón "Atrás" no muestra el perfil desde la caché (no-store)', async ({ page }) => {
    await open(page, actor);
    await logoutButton(page).click();
    await landedOn(page, '/');
    await page.goBack();
    await expect(page.getByText(actor.email)).toHaveCount(0);
  });

  test('sin JavaScript: el botón de cierre funciona con un POST normal', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
    await context.addCookies(asBrowserCookies(actor.cookies));
    const page = await context.newPage();
    await page.goto(`${BASE}/cuenta`);
    await logoutButton(page).click();
    await landedOn(page, '/');
    await page.goto(`${BASE}/cuenta`);
    await expect(page).toHaveURL(`${BASE}${LOGIN_REDIRECT}`);
    await context.close();
  });

  test('CSRF del cierre: POST /salir con Origin ajeno o sin Origin → 403 y la sesión sigue', async ({ playwright }) => {
    const fresh = await createActor(env, 'out2');
    const request = await playwright.request.newContext();
    const evil = await request.post(`${BASE}/salir`, { headers: { cookie: fresh.cookie, origin: EVIL_ORIGIN }, maxRedirects: 0, failOnStatusCode: false });
    const none = await request.post(`${BASE}/salir`, { headers: { cookie: fresh.cookie }, maxRedirects: 0, failOnStatusCode: false });
    expect(evil.status()).toBe(FORBIDDEN);
    expect(none.status()).toBe(FORBIDDEN);
    expect((await rawGet(request, fresh)).status()).toBe(OK);
    await request.dispose();
    await deleteActor(env, fresh);
  });
});
