import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { PRIVACY_VERSION } from '../src/lib/site';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { ADULT_BIRTH, FAKE_NAME, addDays, limaOf, shiftYears } from '../tests/helpers/t128';
import { QA_PHRASE, contrast, createConfirmedUser, deleteByEmail, findUser, jwtPayload, leftovers, qaEmail, sessionFromCookies } from '../tests/helpers/t128-live';
import { expectNoA11yViolations } from './helpers/axe';
import { firstLink, waitForMail } from './helpers/mailpit';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-128 + T-131 · registro /registro con fecha de nacimiento contra el stack real (Supabase local + Mailpit + backend).
// El servidor de desarrollo recibe SUPABASE_URL y la clave anónima desde playwright.config.ts (en memoria).
// Los usuarios `qa-t128-*` los crea esta suite (por el formulario) y los borra al terminar; nunca se tocan otros.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000';
const EVIL_ORIGIN = 'https://evil.test';
const OK = 200;
const FORBIDDEN = 403;
const UNPROCESSABLE = 422;
const UNSUPPORTED_MEDIA = 415;
const NO_STORE = 'private, no-store';
const LANDING_TIMEOUT = 20_000;
const NO_MAIL_WAIT_MS = 2500;
const MINOR_AGE = 17;
const ADULT_AGE = 18;
const SMALL_WIDTH = 360;
const PHONE_WIDTH = 375;
const TABLET_FROM = 800;
const DESKTOP_WIDTH = 1280;
const WIDTHS = [SMALL_WIDTH, PHONE_WIDTH, TABLET_FROM, DESKTOP_WIDTH];
const VIEWPORT_HEIGHT = 800;
const MIN_TEXT_CONTRAST = 4.5;
const MIN_UI_CONTRAST = 3;
const TOUCH_TARGET = 44;
const LIVE_ENV_MESSAGE = 'Supabase local no disponible (npm run db:start)';

let env: LiveEnv;
const created: string[] = [];
const track = (email: string): string => (created.push(email), email);

test.beforeAll(() => {
  const e = liveEnv();
  if (!e) throw new Error(LIVE_ENV_MESSAGE);
  env = e;
});
test.afterAll(async () => {
  if (!env) return;
  await Promise.all(created.map((e) => deleteByEmail(env, e)));
  expect((await leftovers(env)).filter((e) => created.includes(e))).toEqual([]);
});

// --- ayudantes -------------------------------------------------------------------------------------------------
const nameBox = (p: Page): Locator => p.locator('input[autocomplete="name"]');
const emailBox = (p: Page): Locator => p.locator('input[autocomplete="email"]');
const passwordBoxes = (p: Page): Locator => p.locator('input[autocomplete="new-password"]');
const birthBox = (p: Page): Locator => p.locator('input[autocomplete="bday"]');
const termsBox = (p: Page): Locator => p.locator('input[name="accept_terms"]');
const submit = (p: Page): Locator => p.getByRole('button', { name: 'Crear cuenta', exact: true });
const alertBox = (p: Page): Locator => p.getByRole('alert');
const statusBox = (p: Page): Locator => p.getByRole('status');
const isPost = (r: { request: () => { method: () => string }; url: () => string }): boolean => r.request().method() === 'POST' && new URL(r.url()).pathname === '/registro';
const today = (): string => limaOf(new Date());

type Form = { name?: string; email: string; password?: string; confirm?: string; birth?: string; terms?: boolean };
async function fill(page: Page, f: Form): Promise<void> {
  await nameBox(page).fill(f.name ?? FAKE_NAME);
  await emailBox(page).fill(f.email);
  await passwordBoxes(page).nth(0).fill(f.password ?? QA_PHRASE);
  await passwordBoxes(page).nth(1).fill(f.confirm ?? f.password ?? QA_PHRASE);
  await birthBox(page).fill(f.birth ?? ADULT_BIRTH);
  if (f.terms ?? true) await termsBox(page).check();
}
async function send(page: Page, f: Form): Promise<number> {
  await fill(page, f);
  const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
  return res.status();
}

/** Nombres reales de los campos, para los POST crudos. */
async function fieldNames(request: APIRequestContext): Promise<Record<'full_name' | 'email' | 'password' | 'password_confirm' | 'birth_date' | 'accept_terms', string>> {
  const html = await (await request.get(`${BASE}/registro`)).text();
  const tags = html.split('<input').slice(1).map((t) => t.split('>')[0]);
  const attr = (tag: string, name: string): string | null => {
    const marker = ` ${name}="`;
    const at = tag.indexOf(marker);
    return at < 0 ? null : tag.slice(at + marker.length).split('"')[0];
  };
  const nameWhere = (name: string, value: string): string[] => tags.filter((t) => attr(t, name) === value).map((t) => attr(t, 'name') ?? '');
  const [pw, pw2] = nameWhere('type', 'password');
  return { full_name: nameWhere('autocomplete', 'name')[0], email: nameWhere('autocomplete', 'email')[0], password: pw, password_confirm: pw2, birth_date: nameWhere('type', 'date')[0], accept_terms: nameWhere('type', 'checkbox')[0] };
}

/** POST crudo con el `Origin` indicado (el navegador siempre lo manda; aquí se manipula). */
async function rawPost(request: APIRequestContext, form: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  return request.post(`${BASE}/registro`, { form, headers, maxRedirects: 0, failOnStatusCode: false });
}

/** Sigue el enlace del correo hasta /auth/callback del sitio (aunque Supabase local solo permita :4321, la ruta se conserva). */
async function followConfirmation(page: Page, link: string, next = '/cuenta'): Promise<void> {
  const verify = await page.context().request.get(link, { maxRedirects: 0, failOnStatusCode: false });
  const location = verify.headers().location;
  if (!location) throw new Error(`El enlace de confirmación no redirigió (HTTP ${verify.status()})`);
  const target = new URL(location);
  const code = target.searchParams.get('code');
  if (!code) throw new Error('La redirección de Auth no trae código PKCE');
  const callback = target.pathname === '/auth/callback' && target.origin === BASE ? target : new URL(`${BASE}/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
  await page.goto(callback.toString());
}
const landedOn = (page: Page, path: string) =>
  expect.poll(() => {
    const u = new URL(page.url());
    return `${u.origin}${u.pathname}`;
  }, { timeout: LANDING_TIMEOUT }).toBe(`${BASE}${path}`);

/** Color de fondo opaco más cercano (sube por los ancestros hasta encontrar uno con alfa 1). */
const opaqueBackground = (loc: Locator): Promise<string> =>
  loc.evaluate((el) => {
    let node: Element | null = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      const alpha = /rgba\(.*,\s*([\d.]+)\)/.exec(bg)?.[1];
      if (bg !== 'rgba(0, 0, 0, 0)' && (alpha === undefined || Number(alpha) === 1)) return bg;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';
  });

// --- flujo completo con JavaScript -----------------------------------------------------------------------------------
test.describe('registro · flujo completo de un adulto (JavaScript)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'el flujo crea usuarios reales: una sola vez'));

  test('registro → correo en Mailpit → /auth/callback → sesión; /identity/me con nombre, versión y fecha; Auth sin birth_date', async ({ page, context, request }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    const email = track(qaEmail('adult'));

    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email })).toBe(OK);
    await expect(page.locator('body')).toContainText(/revisa tu correo/i);
    await expect(statusBox(page).first()).toContainText(/enlace para confirmar/i);
    await expect(alertBox(page)).toHaveCount(0);
    await expect(passwordBoxes(page)).toHaveCount(0); // el formulario se sustituye por el aviso
    expect((await context.cookies(BASE)).filter((c) => /auth-token$|auth-token\.\d+$/.test(c.name))).toEqual([]); // sin sesión todavía

    // En tránsito la fecha vive en user_metadata (D-045): se comprueba para que el borrado posterior signifique algo.
    const pending = await findUser(env, email);
    expect(pending, 'Auth debe haber creado el usuario').toBeDefined();
    expect(JSON.stringify(pending?.user_metadata ?? pending?.raw_user_meta_data)).toContain(ADULT_BIRTH);

    const mail = await waitForMail(email);
    const link = firstLink(mail);
    expect(`${mail.text}${mail.html}`).not.toContain(ADULT_BIRTH);
    expect(`${mail.text}${mail.html}`).not.toContain(QA_PHRASE);
    const redirectTo = new URL(link).searchParams.get('redirect_to') ?? '';
    expect(new URL(redirectTo).pathname).toBe('/auth/callback');
    expect(redirectTo).not.toContain(ADULT_BIRTH);

    await followConfirmation(page, link);
    await landedOn(page, '/cuenta'); // la guardia deja pasar: hay sesión (la página de cuenta puede ser un 404 hasta T-129)
    const jar = await context.cookies(BASE);
    const sessionCookies = jar.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
    expect(sessionCookies.length).toBeGreaterThan(0);
    sessionCookies.forEach((c) => {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Lax');
    });
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/auth-token/);

    // Perfil en el backend con el token de la sesión del navegador.
    const session = sessionFromCookies(jar);
    const me = await request.get(`${API}/api/v1/identity/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(me.status()).toBe(OK);
    expect(me.headers()['cache-control']).toContain('no-store');
    const profile = await me.json();
    expect(profile.full_name).toBe(FAKE_NAME);
    expect(profile.privacy_version).toBe(PRIVACY_VERSION);
    expect(profile.birth_date).toBe(ADULT_BIRTH);

    // La fecha ya no está en los metadatos de Auth (API de administración) ni en la sesión guardada en la cookie.
    const after = await findUser(env, email);
    const meta = after?.user_metadata ?? after?.raw_user_meta_data ?? {};
    expect(meta).not.toHaveProperty('birth_date');
    expect(JSON.stringify(after)).not.toContain(ADULT_BIRTH);
    expect(session.user.user_metadata ?? {}).not.toHaveProperty('birth_date');
    // Residuo conocido del diseño: el claim del token ya emitido conserva la fecha hasta el siguiente refresco (se anota, no se exige).
    const claim = (jwtPayload(session.access_token).user_metadata ?? {}) as Record<string, unknown>;
    test.info().annotations.push({ type: 'claim del access token', description: claim.birth_date ? 'conserva birth_date hasta el refresco' : 'sin birth_date' });

    // La fecha nunca viajó por URL (ni en ninguna petición del navegador).
    expect(urls.filter((u) => u.includes(ADULT_BIRTH))).toEqual([]);
    expect(errors.filter((e) => !/404/.test(e))).toEqual([]); // /cuenta aún puede responder 404 (recurso)
    expect(external).toEqual([]);
  });

  test('correo ya registrado: el mismo aviso de éxito que un correo nuevo, sin revelar que la cuenta existe', async ({ page, browser }) => {
    const existing = track(qaEmail('dup'));
    await createConfirmedUser(env, existing); // cliente ya confirmado (como uno que se registró antes)
    const fresh = track(qaEmail('fresh'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email: fresh })).toBe(OK);
    const expected = (await page.getByRole('main').innerText()).trim();

    const other = await browser.newContext();
    const again = await other.newPage();
    await again.goto(`${BASE}/registro`);
    expect(await send(again, { email: existing })).toBe(OK);
    await expect(alertBox(again)).toHaveCount(0);
    expect((await again.getByRole('main').innerText()).trim()).toBe(expected);
    await expect(again.locator('body')).not.toContainText(/ya (está|existe|tiene)|registrad/i);
    // No se le crea otra cuenta ni se le cambia nada: sigue habiendo un único usuario con ese correo y sin fecha en sus metadatos.
    const user = await findUser(env, existing);
    expect(JSON.stringify(user)).not.toContain(ADULT_BIRTH);
    await other.close();
  });

  test('contraseñas distintas → 422 en la repetición, sin crear usuario y sin devolver las contraseñas', async ({ page }) => {
    const email = track(qaEmail('mismatch'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email, confirm: `${QA_PHRASE}x` })).toBe(UNPROCESSABLE);
    await expect(passwordBoxes(page).nth(1)).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordBoxes(page).nth(0)).toHaveValue('');
    await expect(passwordBoxes(page).nth(1)).toHaveValue('');
    expect(await page.content()).not.toContain(QA_PHRASE);
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('contraseña corta (5) → 422 en el campo, sin crear usuario', async ({ page }) => {
    const email = track(qaEmail('short'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email, password: 'abc12', confirm: 'abc12' })).toBe(UNPROCESSABLE);
    await expect(passwordBoxes(page).nth(0)).toHaveAttribute('aria-invalid', 'true');
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('sin aceptar los términos → 422 en la casilla, sin crear usuario', async ({ page }) => {
    const email = track(qaEmail('terms'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email, terms: false })).toBe(UNPROCESSABLE);
    await expect(termsBox(page)).toHaveAttribute('aria-invalid', 'true');
    expect(await findUser(env, email)).toBeUndefined();
  });
});

// --- menores: no se registran -------------------------------------------------------------------------------------------
test.describe('registro · un menor no crea usuario en Auth (D-045 P-IDENTITY-7)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'basta una vez'));

  const cases: [string, () => string][] = [
    ['17 años', () => shiftYears(today(), -MINOR_AGE)],
    ['cumple 18 mañana (víspera)', () => shiftYears(addDays(today(), 1), -ADULT_AGE)],
    ['nacido hoy', () => today()],
  ];
  cases.forEach(([label, birth]) => {
    test(`${label}: 422 con el aviso de 18 años, sin usuario en Auth, sin correo y sin la fecha en la respuesta`, async ({ page }) => {
      const email = track(qaEmail('minor'));
      const date = birth();
      await page.goto(`${BASE}/registro`);
      expect(await send(page, { email, birth: date })).toBe(UNPROCESSABLE);
      await expect(birthBox(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(alertBox(page)).toBeVisible();
      await expect(page.locator('body')).toContainText(/18 años/);
      await expect(statusBox(page)).toHaveCount(0);
      expect(await findUser(env, email)).toBeUndefined();
      await expect(waitForMail(email, NO_MAIL_WAIT_MS)).rejects.toThrow(/Sin correo/);
      await expect(passwordBoxes(page).nth(0)).toHaveValue('');
    });
  });

  test('un menor tampoco entra con un POST crudo (sin JavaScript, Origin propio)', async ({ request }) => {
    const names = await fieldNames(request);
    const email = track(qaEmail('minor-raw'));
    const res = await rawPost(request, { [names.full_name]: FAKE_NAME, [names.email]: email, [names.password]: QA_PHRASE, [names.password_confirm]: QA_PHRASE, [names.birth_date]: shiftYears(today(), -MINOR_AGE), [names.accept_terms]: 'on' });
    expect(res.status()).toBe(UNPROCESSABLE);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(await findUser(env, email)).toBeUndefined();
  });
});

// --- seguridad de la ruta -------------------------------------------------------------------------------------------------
test.describe('registro · Origin, tipo de contenido y cabeceras', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'basta una vez'));

  const goodForm = async (request: APIRequestContext, email: string): Promise<Record<string, string>> => {
    const n = await fieldNames(request);
    return { [n.full_name]: FAKE_NAME, [n.email]: email, [n.password]: QA_PHRASE, [n.password_confirm]: QA_PHRASE, [n.birth_date]: ADULT_BIRTH, [n.accept_terms]: 'on' };
  };

  test('Origin ajeno → 403 y no se crea el usuario', async ({ request }) => {
    const email = track(qaEmail('evil'));
    const res = await rawPost(request, await goodForm(request, email), { origin: EVIL_ORIGIN });
    expect(res.status()).toBe(FORBIDDEN);
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('sin Origin ni Referer propio → 403 y no se crea el usuario', async ({ request }) => {
    const email = track(qaEmail('noorigin'));
    const res = await rawPost(request, await goodForm(request, email), {});
    expect(res.status()).toBe(FORBIDDEN);
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('cuerpo JSON → 415 (nunca 500) y sin trazas', async ({ request }) => {
    const res = await request.post(`${BASE}/registro`, { data: { email: 'x@example.com' }, headers: { origin: BASE }, failOnStatusCode: false });
    expect(res.status()).toBe(UNSUPPORTED_MEDIA);
    expect(await res.text()).not.toMatch(/SUPABASE|\.ts:|stack/i);
  });

  test('GET y POST con errores llevan Cache-Control: private, no-store', async ({ request }) => {
    expect((await request.get(`${BASE}/registro`)).headers()['cache-control']).toBe(NO_STORE);
    const bad = await rawPost(request, {});
    expect(bad.status()).toBe(UNPROCESSABLE);
    expect(bad.headers()['cache-control']).toBe(NO_STORE);
  });

  test('un GET con datos en la query no registra nada ni los devuelve', async ({ request }) => {
    const email = track(qaEmail('getquery'));
    const n = await fieldNames(request);
    const res = await request.get(`${BASE}/registro?${n.email}=${email}&${n.password}=${QA_PHRASE}&${n.birth_date}=${ADULT_BIRTH}`);
    expect(res.status()).toBe(OK);
    const html = await res.text();
    expect(html).not.toContain(QA_PHRASE);
    expect(html).not.toContain(ADULT_BIRTH);
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('el campo de fecha lleva max = hoy en Lima y es de tipo date con autocomplete bday', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await expect(birthBox(page)).toHaveAttribute('type', 'date');
    await expect(birthBox(page)).toHaveAttribute('autocomplete', 'bday');
    expect([today(), addDays(today(), -1), addDays(today(), 1)]).toContain(await birthBox(page).getAttribute('max'));
  });

  test('un cliente con sesión es redirigido fuera de /registro', async ({ page }) => {
    // Sin crear otra cuenta: una cookie de sesión falsa no basta (se valida con Auth) y el formulario sigue disponible.
    await page.context().addCookies([{ name: 'sb-127-auth-token', value: 'base64-e30', url: BASE, httpOnly: true }]);
    const res = await page.goto(`${BASE}/registro`);
    expect(res?.status()).toBeLessThan(500);
  });
});

// --- sin JavaScript ----------------------------------------------------------------------------------------------------------
test.describe('registro · sin JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'el flujo crea usuarios reales: una sola vez'));

  test('el formulario funciona completo: un adulto con exactamente 18 años cumplidos hoy queda registrado y recibe el aviso', async ({ page }) => {
    const email = track(qaEmail('nojs'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email, birth: shiftYears(today(), -ADULT_AGE) })).toBe(OK);
    await expect(page.locator('body')).toContainText(/revisa tu correo/i);
    await expect(statusBox(page).first()).toContainText(/enlace para confirmar/i);
    expect(await findUser(env, email)).toBeDefined();
    expect((await waitForMail(email)).to).toContain(email);
  });

  test('un menor sin JavaScript: 422, sin usuario en Auth', async ({ page }) => {
    const email = track(qaEmail('nojs-minor'));
    await page.goto(`${BASE}/registro`);
    expect(await send(page, { email, birth: shiftYears(today(), -MINOR_AGE) })).toBe(UNPROCESSABLE);
    await expect(alertBox(page)).toBeVisible();
    expect(await findUser(env, email)).toBeUndefined();
  });

  test('formulario vacío → 422 con errores por campo (también la fecha y la casilla)', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    expect(res.status()).toBe(UNPROCESSABLE);
    await expect(nameBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(birthBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(termsBox(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('los botones del ojo no se muestran (no hay controles muertos)', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await expect(page.getByRole('button', { name: 'Mostrar contraseña' })).toHaveCount(0);
  });
});

// --- con JavaScript: el ojo ----------------------------------------------------------------------------------------------------
test.describe('registro · isla del ojo de contraseña', () => {
  test('cada ojo alterna SU campo entre password y text sin afectar al otro', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    const eyes = page.getByRole('button', { name: 'Mostrar contraseña' });
    await expect(eyes).toHaveCount(2);
    await passwordBoxes(page).nth(0).fill(QA_PHRASE);
    await eyes.nth(0).click();
    await expect(page.locator('input#password')).toHaveAttribute('type', 'text');
    await expect(page.locator('input#password_confirm')).toHaveAttribute('type', 'password');
  });
});

// --- accesibilidad ---------------------------------------------------------------------------------------------------------------
test.describe('registro · accesibilidad (axe, WCAG 2.2 AA)', () => {
  test('reposo', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await expect(submit(page)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('con errores en todos los campos (422): resumen, mensajes y casilla en error sobre forest', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    await expect(alertBox(page)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('con el error de menor de edad', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await fill(page, { email: qaEmail('axe'), birth: shiftYears(today(), -MINOR_AGE) });
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    await expect(birthBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expectNoA11yViolations(page);
  });

  test('con las contraseñas visibles y la casilla marcada', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    const eyes = page.getByRole('button', { name: 'Mostrar contraseña' });
    await eyes.nth(0).click();
    await termsBox(page).check();
    await expectNoA11yViolations(page);
  });

  test('estructura: un h1, un main, etiquetas asociadas, enlaces legales y destino táctil mínimo', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    const labelOf = (loc: Locator): Promise<string> => loc.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? '');
    expect((await labelOf(nameBox(page))).toLowerCase()).toContain('nombre');
    expect((await labelOf(emailBox(page))).toLowerCase()).toContain('correo');
    expect((await labelOf(birthBox(page))).toLowerCase()).toContain('nacimiento');
    expect((await labelOf(passwordBoxes(page).nth(1))).toLowerCase()).toContain('repetir');
    await expect(page.getByRole('link', { name: /términos/i })).toHaveAttribute('href', '/terminos');
    await expect(page.getByRole('link', { name: /política de privacidad/i })).toHaveAttribute('href', '/privacidad');
    await expect(page.locator('label[for="accept_terms"]')).toContainText(PRIVACY_VERSION);
    expect((await submit(page).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  test('foco: el resumen de errores recibe el foco al cargar la respuesta 422', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    await expect(alertBox(page)).toBeVisible();
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? a.closest('[role="alert"]') !== null || a.getAttribute('role') === 'alert' : false;
    });
    expect(focused).toBe(true);
  });
});

// --- diseño: casilla sobre forest (Checkbox tone="dark") ---------------------------------------------------------------
test.describe('registro · contraste de la casilla sobre forest', () => {
  test('texto ≥ 4,5:1 y borde ≥ 3:1 en reposo, marcada y con error', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    const label = page.locator('label[for="accept_terms"]');
    const control = termsBox(page);
    const panel = await opaqueBackground(label);

    const textColor = await label.evaluate((el) => getComputedStyle(el.querySelector('.text') ?? el).color);
    expect(contrast(textColor, panel), `texto ${textColor} sobre ${panel}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);

    const border = await control.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(contrast(border, panel), `borde ${border} sobre ${panel}`).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);

    // Marcada: el relleno sigue distinguiéndose del fondo y la marca se ve sobre el relleno.
    await control.check();
    const filled = await control.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(contrast(filled, panel), `relleno ${filled} sobre ${panel}`).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
    const mark = await label.evaluate((el) => {
      const svg = el.querySelector('.control svg');
      return svg ? getComputedStyle(svg).color : '';
    });
    if (mark) expect(contrast(mark, filled), `marca ${mark} sobre ${filled}`).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);

    // Con error: el mensaje bajo la casilla se lee sobre forest.
    await control.uncheck();
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    const err = page.locator('#accept_terms-error span, [id$="accept_terms-error"] span').first();
    await expect(err).toBeVisible();
    const errColor = await err.evaluate((el) => getComputedStyle(el).color);
    const errBg = await opaqueBackground(err);
    expect(contrast(errColor, errBg), `error ${errColor} sobre ${errBg}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    const errBorder = await termsBox(page).evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(contrast(errBorder, await opaqueBackground(label)), `borde con error ${errBorder}`).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
  });

  test('el texto de los enlaces dentro de la casilla también contrasta (≥ 4,5:1)', async ({ page }) => {
    await page.goto(`${BASE}/registro`);
    const link = page.getByRole('link', { name: /términos/i });
    const color = await link.evaluate((el) => getComputedStyle(el).color);
    const bg = await opaqueBackground(link);
    expect(contrast(color, bg), `enlace ${color} sobre ${bg}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

// --- responsive -------------------------------------------------------------------------------------------------------------------
test.describe('registro · responsive (360, 375, 800 y 1280)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'cada ancho se fija aquí: se ejecuta una vez'));

  WIDTHS.forEach((width) => {
    test(`${width} px: sin desbordamiento horizontal, ni en reposo ni con errores; fecha y botón dentro de la pantalla`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.goto(`${BASE}/registro`);
      await expect(submit(page)).toBeVisible();
      const overflow = (): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      for (const loc of [birthBox(page), submit(page), passwordBoxes(page).nth(0), passwordBoxes(page).nth(1)]) {
        const box = await loc.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0), 'dentro del ancho').toBeLessThanOrEqual(width);
        expect(box?.x ?? 0).toBeGreaterThanOrEqual(0);
      }
      await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
      await expect(alertBox(page)).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  });

  test('en 360 y 1280 las dos contraseñas van en columna / en fila según el ancho (800 en adelante: lado a lado)', async ({ page }) => {
    await page.setViewportSize({ width: SMALL_WIDTH, height: VIEWPORT_HEIGHT });
    await page.goto(`${BASE}/registro`);
    const [a, b] = await Promise.all([passwordBoxes(page).nth(0).boundingBox(), passwordBoxes(page).nth(1).boundingBox()]);
    expect((b?.y ?? 0) - (a?.y ?? 0)).toBeGreaterThan(0);
    expect(Math.abs((b?.x ?? 0) - (a?.x ?? 0))).toBeLessThan(1); // misma columna en móvil
  });
});

// --- consola y peticiones externas ----------------------------------------------------------------------------------------------
test.describe('registro · consola limpia', () => {
  test('sin errores de consola ni peticiones a hosts externos al cargar y al enviar un formulario con errores', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    await page.goto(`${BASE}/registro`);
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    await expect(alertBox(page)).toBeVisible();
    // El navegador registra "Failed to load resource" para respuestas 4xx de navegación; se excluyen.
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    expect(external).toEqual([]);
  });
});
