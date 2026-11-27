import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { NOT_THE_PHRASE, createQaUser, deleteQaUser, ghostEmail, type QaUser } from '../tests/helpers/t127-live';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-127 · pantalla de ingreso /ingresar contra el Supabase local real. El servidor de desarrollo recibe SUPABASE_URL y la clave
// anónima desde playwright.config.ts (en memoria). Los usuarios `qa-t127-*` los crea y borra esta suite; nunca se tocan otros.
// Límite de intentos de Supabase local: 30 inicios de sesión cada 5 min por IP; el caso 429 no se provoca aquí (lo cubren las
// pruebas unitarias) para no bloquear al resto de suites. Se limita el número de inicios de sesión reales de la suite.
const PORT = process.env.E2E_PORT ?? '4322';
const BASE = `http://localhost:${PORT}`;
const EVIL_ORIGIN = 'https://evil.test';
const OK = 200;
const SEE_OTHER = 303;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const UNPROCESSABLE = 422;
const UNSUPPORTED_MEDIA = 415;
const FIRST_ERROR_STATUS = 400;
const NO_STORE = 'private, no-store';
const BAD_CREDENTIALS = 'Correo o contraseña incorrectos';
const NOT_CONFIRMED = 'Confirma tu correo para ingresar';
const TIMING_SAMPLES = 3;
const TIMING_MARGIN_MS = 400;
const VIEWPORT_HEIGHT = 800;
const MOBILE_ART_MAX_HEIGHT = 200;
const TOUCH_TARGET = 44;
const SMALL_WIDTH = 360;
const PHONE_WIDTH = 375;
const TABLET_FROM = 800;
const DESKTOP_WIDTH = 1280;
const WIDTHS = [SMALL_WIDTH, PHONE_WIDTH, TABLET_FROM, DESKTOP_WIDTH];
const SRGB_MAX = 255;
const SRGB_KNEE = 0.03928;
const SRGB_LOW_DIV = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const CONTRAST_OFFSET = 0.05;
const HALF = 2;
const MIN_CONTRAST = 4.5;
const RGB_MINT = 'rgb(179, 239, 178)';
const RGB_INK = 'rgb(15, 15, 15)';
const FOCUS_TIMEOUT = 5000;
const LANDING_TIMEOUT = 15_000;
const LIVE_ENV_MESSAGE = 'Supabase local no disponible (npm run db:start)';

let env: LiveEnv;
let user: QaUser;
let pending: QaUser;

test.beforeAll(async () => {
  const e = liveEnv();
  if (!e) throw new Error(LIVE_ENV_MESSAGE);
  env = e;
  user = await createQaUser(env, 'ok');
  pending = await createQaUser(env, 'pending', false);
});
test.afterAll(async () => {
  await Promise.all([user && deleteQaUser(env, user), pending && deleteQaUser(env, pending)]);
});

// --- ayudantes -------------------------------------------------------------------------------------------------
const emailBox = (page: Page): Locator => page.locator('input[autocomplete="email"]');
const passwordBox = (page: Page): Locator => page.locator('input[autocomplete="current-password"]');
const submit = (page: Page): Locator => page.getByRole('button', { name: 'Ingresar', exact: true });
const alertBox = (page: Page): Locator => page.getByRole('alert');
const isPost = (r: { request: () => { method: () => string }; url: () => string }): boolean => r.request().method() === 'POST' && r.url().includes('/ingresar');

async function fillAndSubmit(page: Page, email: string, secret: string): Promise<number> {
  await emailBox(page).fill(email);
  await passwordBox(page).fill(secret);
  const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
  return res.status();
}

/** POST crudo de formulario con el `Origin` indicado (el navegador siempre lo manda; aquí se manipula). */
async function rawPost(request: APIRequestContext, fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }, query = '') {
  return request.post(`${BASE}/ingresar${query}`, { form: fields, headers, maxRedirects: 0, failOnStatusCode: false });
}

/** Nombres reales de los campos (del formulario servido), para los POST crudos. */
async function fieldNames(request: APIRequestContext): Promise<{ email: string; password: string; next: string | null }> {
  const html = await (await request.get(`${BASE}/ingresar`)).text();
  const tags = html.split('<input').slice(1).map((t) => t.split('>')[0]);
  const attr = (tag: string, name: string): string | null => {
    const marker = ` ${name}="`;
    const at = tag.indexOf(marker);
    return at < 0 ? null : tag.slice(at + marker.length).split('"')[0];
  };
  const nameWhere = (name: string, value: string): string | null => tags.filter((t) => attr(t, name) === value).map((t) => attr(t, 'name'))[0] ?? null;
  const email = nameWhere('autocomplete', 'email');
  const password = nameWhere('autocomplete', 'current-password');
  if (!email || !password) throw new Error('No se encontraron los campos del formulario');
  return { email, password, next: nameWhere('type', 'hidden') };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / HALF)];
const setCookies = (headers: { name: string; value: string }[]): string[] => headers.filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
const channel = (v: number): number => {
  const s = v / SRGB_MAX;
  return s <= SRGB_KNEE ? s / SRGB_LOW_DIV : ((s + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
};
const luminance = (rgb: string): number => {
  const [r, g, b] = rgb.replace('rgb(', '').replace(')', '').split(',').map(Number);
  return LUMA_R * channel(r) + LUMA_G * channel(g) + LUMA_B * channel(b);
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + CONTRAST_OFFSET) / (lo + CONTRAST_OFFSET);
};

/** Navegó a `path` en el propio sitio (origen y ruta; ignora la query). */
const landedOn = (page: Page, path: string) =>
  expect.poll(() => {
    const u = new URL(page.url());
    return `${u.origin}${u.pathname}`;
  }, { timeout: LANDING_TIMEOUT }).toBe(`${BASE}${path}`);

// --- flujos con JavaScript ---------------------------------------------------------------------------------------
test.describe('ingreso · con JavaScript', () => {
  test('login correcto desde /carrito vuelve a /carrito, con cookie HttpOnly + SameSite=Lax y sin token en document.cookie', async ({ page, context }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page, BASE);
    await page.goto(`${BASE}/carrito`);
    await expect(page).toHaveURL(`${BASE}/ingresar?next=%2Fcarrito`);
    await expect(submit(page)).toBeVisible();
    // Solo la carga de /ingresar: la página de destino (/carrito) aún no existe y respondería 404.
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    const status = await fillAndSubmit(page, user.email, user.secret);
    expect(status).toBe(SEE_OTHER);
    await landedOn(page, '/carrito');
    const cookies = (await context.cookies(BASE)).filter((c) => c.name.startsWith('sb-'));
    expect(cookies.length).toBeGreaterThan(0);
    cookies.forEach((c) => {
      expect(c.httpOnly, c.name).toBe(true);
      expect(c.sameSite, c.name).toBe('Lax');
    });
    expect(await page.evaluate(() => document.cookie)).not.toContain('sb-');
  });

  test('sin `next`, el login lleva a /cuenta; un next hostil en la URL y en el campo oculto se ignora (sin redirección abierta)', async ({ page }) => {
    await page.goto(`${BASE}/ingresar?next=//evil.test`);
    const hidden = page.locator('input[type="hidden"]').first();
    if ((await hidden.count()) > 0) await hidden.evaluate((el, v) => ((el as HTMLInputElement).value = v), '//evil.test/robo');
    await fillAndSubmit(page, user.email, user.secret);
    await landedOn(page, '/cuenta');
    expect(new URL(page.url()).origin).toBe(BASE);
  });

  test('contraseña errónea → 401, el mensaje del paquete, foco en el aviso, correo conservado y contraseña vacía', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const status = await fillAndSubmit(page, user.email, NOT_THE_PHRASE);
    expect(status).toBe(UNAUTHORIZED);
    await expect(alertBox(page)).toContainText(BAD_CREDENTIALS);
    await expect.poll(() => alertBox(page).evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), { timeout: FOCUS_TIMEOUT }).toBe(true);
    await expect(emailBox(page)).toHaveValue(user.email);
    await expect(passwordBox(page)).toHaveValue('');
    expect(await page.content()).not.toContain(NOT_THE_PHRASE);
  });

  test('correo inexistente → el MISMO estado y el MISMO mensaje que una contraseña errónea', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const wrongStatus = await fillAndSubmit(page, user.email, NOT_THE_PHRASE);
    const wrongText = await alertBox(page).innerText();
    await page.goto(`${BASE}/ingresar`);
    const ghostStatus = await fillAndSubmit(page, ghostEmail(), NOT_THE_PHRASE);
    const ghostText = await alertBox(page).innerText();
    expect(ghostStatus).toBe(wrongStatus);
    expect(ghostStatus).toBe(UNAUTHORIZED);
    expect(ghostText.trim()).toBe(wrongText.trim());
    expect(ghostText).toContain(BAD_CREDENTIALS);
  });

  test('correo sin confirmar → 403 con "Confirma tu correo para ingresar" y sin más pistas', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const status = await fillAndSubmit(page, pending.email, pending.secret);
    expect(status).toBe(FORBIDDEN);
    await expect(alertBox(page)).toContainText(NOT_CONFIRMED);
    expect(await alertBox(page).innerText()).not.toContain(pending.email);
    expect(new URL(page.url()).pathname).not.toBe('/cuenta');
  });

  test('formulario vacío → 422, error en cada campo (aria-invalid), resumen con role="alert" y foco', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    expect(res.status()).toBe(UNPROCESSABLE);
    await expect(emailBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(alertBox(page)).toBeVisible();
    await expect.poll(() => alertBox(page).evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), { timeout: FOCUS_TIMEOUT }).toBe(true);
  });

  test('correo mal formado → 422 solo en el correo y se conserva lo escrito', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const status = await fillAndSubmit(page, 'ana-sin-arroba', NOT_THE_PHRASE);
    expect(status).toBe(UNPROCESSABLE);
    await expect(emailBox(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(passwordBox(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(emailBox(page)).toHaveValue('ana-sin-arroba');
    await expect(passwordBox(page)).toHaveValue('');
  });

  test('el ojo muestra y oculta la contraseña (aria-pressed y nombre accesible) sin perder lo escrito', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const eye = page.getByRole('button', { name: 'Mostrar contraseña' });
    await passwordBox(page).fill(NOT_THE_PHRASE);
    await expect(eye).toHaveAttribute('aria-pressed', 'false');
    await eye.click();
    await expect(passwordBox(page)).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Ocultar contraseña' })).toHaveAttribute('aria-pressed', 'true');
    await expect(passwordBox(page)).toHaveValue(NOT_THE_PHRASE);
    await page.getByRole('button', { name: 'Ocultar contraseña' }).click();
    await expect(passwordBox(page)).toHaveAttribute('type', 'password');
  });

  test('"Crear cuenta Valmont +" enlaza a /registro conservando next; no hay "Recuérdame" ni "¿Olvidaste…?"', async ({ page }) => {
    await page.goto(`${BASE}/ingresar?next=%2Fcarrito`);
    const link = page.getByRole('link', { name: 'Crear cuenta Valmont' });
    const href = (await link.getAttribute('href')) ?? '';
    expect(href.startsWith('/registro')).toBe(true);
    expect(new URL(href, BASE).searchParams.get('next')).toBe('/carrito');
    await expect(page.getByText('recuérdame')).toHaveCount(0);
    await expect(page.getByText('olvidaste')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });

  test('con la sesión ya iniciada, /ingresar redirige sin mostrar el formulario', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await fillAndSubmit(page, user.email, user.secret);
    await landedOn(page, '/cuenta');
    await page.goto(`${BASE}/ingresar?next=%2Fcarrito`);
    await landedOn(page, '/carrito');
    await expect(emailBox(page)).toHaveCount(0);
  });
});

// --- respuestas HTTP crudas (cabeceras, cookies, CSRF, tiempos) --------------------------------------------------
test.describe('ingreso · HTTP crudo y seguridad', () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'las comprobaciones HTTP no dependen del viewport: se ejecutan una vez'));

  test('GET: 200 con Cache-Control private, no-store; sin Set-Cookie', async ({ request }) => {
    const res = await request.get(`${BASE}/ingresar`);
    expect(res.status()).toBe(OK);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(setCookies(res.headersArray())).toEqual([]);
  });

  test('éxito: 303 a next con no-store; cookies HttpOnly + SameSite=Lax; sin token en el cuerpo; luego /ingresar redirige', async ({ request }) => {
    const names = await fieldNames(request);
    const form = { [names.email]: user.email, [names.password]: user.secret };
    const res = await rawPost(request, form, { origin: BASE }, '?next=%2Fcarrito');
    expect(res.status()).toBe(SEE_OTHER);
    expect(res.headers().location).toBe('/carrito');
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const cookies = setCookies(res.headersArray()).filter((c) => c.startsWith('sb-'));
    expect(cookies.length).toBeGreaterThan(0);
    cookies.forEach((c) => {
      expect(c.toLowerCase()).toContain('httponly');
      expect(c.toLowerCase()).toContain('samesite=lax');
    });
    expect(await res.text()).not.toContain(user.secret);
    // La misma sesión (cookies en el contexto de `request`) hace que /ingresar redirija y siga sin cachearse.
    const again = await request.get(`${BASE}/ingresar?next=%2Fcarrito`, { maxRedirects: 0, failOnStatusCode: false });
    expect(again.status()).toBe(SEE_OTHER);
    expect(again.headers().location).toBe('/carrito');
    expect(again.headers()['cache-control']).toBe(NO_STORE);
    expect(await again.text()).not.toContain('<form');
  });

  test('error 401 por POST crudo: Cache-Control no-store, sin Set-Cookie de sesión, sin la contraseña en el HTML ni en las cabeceras', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const names = await fieldNames(request);
    const res = await rawPost(request, { [names.email]: user.email, [names.password]: NOT_THE_PHRASE });
    expect(res.status()).toBe(UNAUTHORIZED);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(setCookies(res.headersArray()).filter((c) => c.startsWith('sb-'))).toEqual([]);
    expect(await res.text()).not.toContain(NOT_THE_PHRASE);
    expect(JSON.stringify(res.headersArray())).not.toContain(NOT_THE_PHRASE);
    await request.dispose();
  });

  test('CSRF: el POST sin Origin, con Origin ajeno o "null" se rechaza (403) y no inicia sesión', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const names = await fieldNames(request);
    const form = { [names.email]: user.email, [names.password]: user.secret };
    const cases: Record<string, string>[] = [{}, { origin: EVIL_ORIGIN }, { origin: 'null' }, { origin: `${BASE}.evil.test` }, { referer: `${BASE}/ingresar` }];
    const results = await Promise.all(cases.map((headers) => rawPost(request, form, headers)));
    results.forEach((res) => {
      expect(res.status()).toBe(FORBIDDEN);
      expect(res.headers().location).toBeUndefined();
      expect(setCookies(res.headersArray()).filter((c) => c.startsWith('sb-'))).toEqual([]);
    });
    await request.dispose();
  });

  test('un cuerpo que no es un formulario (JSON o texto) responde 415 sin trazas', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const json = await request.post(`${BASE}/ingresar`, { data: { email: user.email }, headers: { origin: BASE }, failOnStatusCode: false });
    const plain = await request.post(`${BASE}/ingresar`, { data: 'basura', headers: { origin: BASE, 'content-type': 'text/plain' }, failOnStatusCode: false });
    [json, plain].forEach((res) => {
      expect(res.status()).toBe(UNSUPPORTED_MEDIA);
      expect(res.headers()['cache-control']).toBe(NO_STORE);
    });
    const bodies = await Promise.all([json.text(), plain.text()]);
    bodies.forEach((b) => ['at ', '.ts:', 'node_modules', 'TypeError'].forEach((w) => expect(b).not.toContain(w)));
    await request.dispose();
  });

  test('anti-enumeración: tiempo comparable entre correo inexistente y contraseña errónea (mediana de 3, margen de 400 ms)', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const names = await fieldNames(request);
    const time = async (email: string): Promise<number> => {
      const t0 = performance.now();
      const res = await rawPost(request, { [names.email]: email, [names.password]: NOT_THE_PHRASE });
      expect(res.status()).toBe(UNAUTHORIZED);
      return performance.now() - t0;
    };
    await time(user.email); // calienta
    const wrong: number[] = [];
    const ghost: number[] = [];
    await Array.from({ length: TIMING_SAMPLES }).reduce<Promise<void>>(async (prev) => {
      await prev;
      wrong.push(await time(user.email));
      ghost.push(await time(ghostEmail()));
    }, Promise.resolve());
    const drift = Math.abs(median(wrong) - median(ghost));
    test.info().annotations.push({ type: 'tiempos', description: `contraseña errónea ${Math.round(median(wrong))} ms; inexistente ${Math.round(median(ghost))} ms` });
    expect(drift).toBeLessThan(TIMING_MARGIN_MS);
    await request.dispose();
  });

  test('los cuerpos de 401 para correo inexistente y contraseña errónea son idénticos salvo el correo escrito', async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const names = await fieldNames(request);
    const other = ghostEmail();
    const [a, b] = await Promise.all([
      rawPost(request, { [names.email]: user.email, [names.password]: NOT_THE_PHRASE }),
      rawPost(request, { [names.email]: other, [names.password]: NOT_THE_PHRASE }),
    ]);
    expect(a.status()).toBe(b.status());
    expect((await a.text()).split(user.email).join('<correo>')).toBe((await b.text()).split(other).join('<correo>'));
    await request.dispose();
  });
});

// --- sin JavaScript ----------------------------------------------------------------------------------------------
test.describe('ingreso · sin JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('el formulario funciona completo: /carrito → ingresar → vuelve a /carrito', async ({ page }) => {
    await page.goto(`${BASE}/carrito`);
    await expect(page).toHaveURL(`${BASE}/ingresar?next=%2Fcarrito`);
    await emailBox(page).fill(user.email);
    await passwordBox(page).fill(user.secret);
    await submit(page).click();
    await landedOn(page, '/carrito');
  });

  test('contraseña errónea sin JavaScript: 401 con el aviso (role="alert"), correo conservado y contraseña vacía', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await emailBox(page).fill(user.email);
    await passwordBox(page).fill(NOT_THE_PHRASE);
    const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    expect(res.status()).toBe(UNAUTHORIZED);
    await expect(alertBox(page)).toContainText(BAD_CREDENTIALS);
    await expect(emailBox(page)).toHaveValue(user.email);
    await expect(passwordBox(page)).toHaveValue('');
  });

  test('sin JavaScript el botón del ojo no se muestra (no hay controles muertos)', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await expect(page.getByRole('button', { name: 'contraseña' })).toBeHidden();
  });

  test('formulario vacío sin JavaScript → 422 con errores por campo', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const [res] = await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    expect(res.status()).toBeGreaterThanOrEqual(FIRST_ERROR_STATUS);
    expect(res.status()).toBe(UNPROCESSABLE);
    await expect(emailBox(page)).toHaveAttribute('aria-invalid', 'true');
  });
});

// --- accesibilidad y responsive ----------------------------------------------------------------------------------
test.describe('ingreso · accesibilidad (axe, WCAG 2.2 AA)', () => {
  test('reposo', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await expect(submit(page)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('con errores por campo (422)', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await Promise.all([page.waitForResponse(isPost), submit(page).click()]);
    await expect(alertBox(page)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('con la contraseña visible', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await page.getByRole('button', { name: 'Mostrar contraseña' }).click();
    await expectNoA11yViolations(page);
  });

  test('estructura: un h1, un main, etiquetas asociadas, destino táctil mínimo y orden de tabulación lógico', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    const labelOf = (loc: Locator): Promise<string> => loc.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? '');
    expect((await labelOf(emailBox(page))).toLowerCase()).toContain('correo');
    expect((await labelOf(passwordBox(page))).toLowerCase()).toContain('contraseña');
    const box = await submit(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET);
    await emailBox(page).focus();
    await page.keyboard.press('Tab');
    await expect(passwordBox(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Mostrar contraseña' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(submit(page)).toBeFocused();
  });
});

test.describe('ingreso · diseño (BRIEF §12.2–3)', () => {
  test('botón Ingresar: tinta sobre menta con contraste AA; campos con --stroke-control', async ({ page }) => {
    await page.goto(`${BASE}/ingresar`);
    const colors = await submit(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(colors.background).toBe(RGB_MINT);
    expect(colors.color).toBe(RGB_INK);
    expect(contrast(colors.color, colors.background)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    const border = await emailBox(page).evaluate((el) => {
      const probe = document.createElement('div');
      probe.style.border = '1px solid var(--stroke-control)';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return { actual: getComputedStyle(el).borderTopColor, expected };
    });
    expect(border.actual).toBe(border.expected);
  });
});

test.describe('ingreso · responsive (360, 375, 800 y 1280)', () => {
  test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== 'desktop', 'cada ancho se fija aquí: se ejecuta una vez'));

  WIDTHS.forEach((width) => {
    test(`${width} px: sin desbordamiento horizontal, formulario usable y arte decorativo ${width < TABLET_FROM ? 'oculto o reducido' : 'visible'}`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.goto(`${BASE}/ingresar`);
      await expect(submit(page)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const formBox = await submit(page).boundingBox();
      expect((formBox?.x ?? 0) + (formBox?.width ?? 0)).toBeLessThanOrEqual(width);
      const art = page.locator('svg').filter({ hasNot: page.locator('use') }).locator('xpath=ancestor-or-self::*[@aria-hidden="true"][1]').first();
      await expect(art, 'el arte debe ser aria-hidden').toHaveCount(1);
      const artBox = (await art.isVisible()) ? await art.boundingBox() : null;
      if (width < TABLET_FROM) {
        // Oculto o reducido: si se ve, no ocupa más que una franja baja.
        if (artBox) expect(artBox.height).toBeLessThanOrEqual(MOBILE_ART_MAX_HEIGHT);
      } else {
        expect(artBox, 'el arte debe verse desde 800 px').not.toBeNull();
        expect(artBox!.width).toBeGreaterThan(0);
      }
      if (width === SMALL_WIDTH) await expectNoA11yViolations(page);
    });
  });

  test('1280 px: axe sin violaciones y el rótulo del arte está en español', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP_WIDTH, height: VIEWPORT_HEIGHT });
    await page.goto(`${BASE}/ingresar`);
    await expectNoA11yViolations(page);
    const art = (await page.locator('[aria-hidden="true"]:has(svg)').first().textContent())?.toLowerCase() ?? '';
    expect(art).toContain('calibre valmont 2026');
    expect(art).toContain('24 rubíes');
  });
});
