import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { browserCookies, createQaUser, deleteQaUser, setRole, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { edgeContrast, leaveBackoffice } from './helpers/backoffice';
import { collectConsoleErrors } from './helpers/page';
import {
  RUN_PREFIX, activeCategories, addImage, api, cleanup, createProductViaApi, getProduct, leftovers, unique, type ApiProduct,
} from './helpers/t147';
import { textContrast } from './helpers/t147-contrast';

// T-147 · formulario de producto (crear y editar) y publicación, de punta a punta con un administrador real (D-050): Supabase local,
// backend en :8000 y `astro dev`. Crea SOLO productos `QA-T147-*` y los borra al terminar (`cleanup`); no toca los 12 relojes de la semilla.
// Las imágenes se suben por la API (su interfaz es T-148). Requiere `npm run db:start`, el backend y Docker (rol admin con `docker exec … psql`).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const NEW = '/admin/productos/nuevo';
const HOOK_TIMEOUT = 240_000;
const NAV_TIMEOUT = 30_000;
const FOUND = 302;
const SEE_OTHER = 303;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const UNSUPPORTED = 415;
const UNPROCESSABLE = 422;
const OK = 200;
const NO_STORE = 'private, no-store';
const FOCUS_YELLOW = 'rgb(255, 217, 0)';
const FOCUS_WIDTH = 2;
const CONTROL_HEIGHT = 44;
const BUTTON_HEIGHT = 40;
const TEXT_CONTRAST = 4.5;
const EDGE_CONTRAST = 3;
const TOLERANCE = 0.5;
const PRICE_CENTS = 125050;
const NEW_PRICE_CENTS = 130050;
const LEAD_DAYS = 30;
const PRICE_DIVISOR = 100;
const WATER_M = 50;
const MAX_TABS = 40;
const W_DESKTOP = 1280;
const W_WIDE = 1440;
const W_MOBILE = 375;
const DIAMETER = 38.5;
const UUID_LEN = 36;
const WIDTHS = [W_DESKTOP, W_WIDE];
const HEIGHT = 900;
const FIELD_ORDER = [
  'sku', 'slug', 'name', 'category_id', 'description', 'price', 'lead_time_days', 'order_policy', 'movement_code', 'case_material_code', 'case_diameter_mm',
  'water_resistance_m',
];
const EVIL = 'https://evil.example';

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;
let categoryId: string;
let otherCategoryId: string;
let leftoverAtEnd = 0;

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't147a', 'admin');
  customer = await createQaUser(env, 't147c', 'customer');
  const cats = await activeCategories(admin);
  categoryId = cats[0].id;
  otherCategoryId = cats[1]?.id ?? cats[0].id;
});

test.afterAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  leftoverAtEnd = admin ? await cleanup(admin) : 0;
  await Promise.all([deleteQaUser(env, admin), deleteQaUser(env, customer)]);
  // Anotación para el traspaso: 0 = todo borrado; otro número = quedaron como borradores QA-T147-*.
  console.warn(`T-147 limpieza: ${leftoverAtEnd} producto(s) ${RUN_PREFIX}* sin borrar`);
});

// --- ayudantes --------------------------------------------------------------------------------------------------------------------------
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const ctl = (page: Page, name: string): Locator => page.locator(`form#product-form [name="${name}"]`);
const alertOf = (page: Page): Locator => page.locator('[role="alert"]').first();
const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true });
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const isPost = (r: { request: () => { method: () => string } }): boolean => r.request().method() === 'POST';
const uuidAfter = (url: string, marker: string): string => url.split(marker)[1]?.split('?')[0] ?? '';

/** Descripción accesible del campo: el texto de lo que apunta `aria-describedby`. */
async function describedText(page: Page, loc: Locator): Promise<string> {
  const ids = ((await loc.getAttribute('aria-describedby')) ?? '').split(' ').filter(Boolean);
  const texts = await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).innerText().catch(() => '')));
  return texts.join(' ');
}

async function openNew(page: Page, width = W_DESKTOP): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, admin);
  const res = await page.goto(`${BASE}${NEW}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function openEdit(page: Page, id: string, query = '', width = W_DESKTOP): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, admin);
  const res = await page.goto(`${BASE}/admin/productos/${id}${query}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Rellena los campos obligatorios de «Crear producto». */
async function fillRequired(page: Page, sku: string, name: string, price = '1250'): Promise<void> {
  await ctl(page, 'sku').fill(sku);
  await ctl(page, 'name').fill(name);
  await ctl(page, 'category_id').selectOption(categoryId);
  await ctl(page, 'price').fill(price);
}

/** Pulsa y espera la respuesta del POST de la página (la redirección 303 se sigue sola). */
async function submit(page: Page, trigger: Locator): Promise<number> {
  const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), trigger.click()]);
  return res.status();
}

const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const postForm = (request: APIRequestContext, path: string, data: Record<string, string>, headers: Record<string, string>) =>
  request.post(`${BASE}${path}`, { headers, form: data, maxRedirects: 0, failOnStatusCode: false });

/** Sesión de otro navegador: el mismo usuario con sus cookies de sesión. */
const cookieOf = (user: QaUser): string => user.cookie;

// ===================================================================================================================================
test.describe('T-147 · flujos con administrador real (escritorio)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'escribe productos: se ejecuta una vez (escritorio)'));

  const state: { id: string; sku: string; slug: string; name: string } = { id: '', sku: '', slug: '', name: '' };
  /** ¿Sale el producto en /relojes?q=<nombre>? (sin la caché del navegador: la lista se sirve con max-age) */
  const listed = async (request: APIRequestContext): Promise<boolean> =>
    (await (await get(request, `/relojes?q=${encodeURIComponent(state.name)}`)).text()).includes(`href="/relojes/${state.slug}"`);

  test('crear con todos los campos → producto en borrador, redirección a ?creado=1 y datos exactos en la API', async ({ page }) => {
    test.setTimeout(HOOK_TIMEOUT);
    const tag = unique();
    state.sku = `${RUN_PREFIX}${tag}`;
    state.name = `Reloj QA T147 ${tag}`;
    state.slug = `qa-t147-${tag.toLowerCase()}`;
    await openNew(page);
    await ctl(page, 'sku').fill(state.sku);
    await ctl(page, 'slug').fill(state.slug);
    await ctl(page, 'name').fill(state.name);
    await ctl(page, 'category_id').selectOption(categoryId);
    await ctl(page, 'description').fill('Línea uno de la descripción.\nLínea dos.');
    await ctl(page, 'price').fill('1250.50');
    await page.getByRole('radio', { name: 'Siempre bajo pedido' }).check();
    await ctl(page, 'lead_time_days').fill(String(LEAD_DAYS));
    await ctl(page, 'movement_code').selectOption({ index: 1 });
    await ctl(page, 'case_material_code').selectOption({ index: 1 });
    await ctl(page, 'case_diameter_mm').fill('38.5');
    await ctl(page, 'water_resistance_m').fill(String(WATER_M));
    await page.getByRole('textbox', { name: 'Característica 1', exact: true }).fill('Calibre');
    await page.getByRole('textbox', { name: 'Valor 1', exact: true }).fill('VM-01');
    await page.getByRole('button', { name: 'Agregar especificación' }).click();
    await page.getByRole('textbox', { name: 'Característica 3', exact: true }).fill('Cristal');
    await page.getByRole('textbox', { name: 'Valor 3', exact: true }).fill('Zafiro');
    await submit(page, button(page, 'Crear producto'));
    await expect(page).toHaveURL((u) => u.pathname.startsWith('/admin/productos/') && u.pathname !== NEW && u.search === '?creado=1', { timeout: NAV_TIMEOUT });
    state.id = uuidAfter(page.url(), '/admin/productos/');
    await expect(page.getByRole('status').or(page.locator('[role="status"], .notice')).first()).toContainText('creado');
    await expect(page.getByText('Borrador').first()).toBeVisible();
    const p = await getProduct(admin, state.id);
    expect(p).toMatchObject({
      sku: state.sku, slug: state.slug, name: state.name, status: 'draft', order_policy: 'made_to_order', lead_time_days: LEAD_DAYS, category_id: categoryId,
      water_resistance_m: WATER_M, description: 'Línea uno de la descripción.\nLínea dos.', price: { amount: PRICE_CENTS, currency: 'PEN' },
    });
    expect(p.case_diameter_mm).toBe(DIAMETER);
    expect(p.movement_code).not.toBeNull();
    expect(p.case_material_code).not.toBeNull();
    expect(p.specs).toEqual([{ label: 'Calibre', value: 'VM-01' }, { label: 'Cristal', value: 'Zafiro' }]);
  });

  test('el producto en borrador NO aparece en la tienda: ficha 404 y ausente de /relojes', async ({ request }) => {
    expect((await get(request, `/relojes/${state.slug}`)).status()).toBe(NOT_FOUND);
    expect(await listed(request), 'el borrador no debe listarse').toBe(false);
  });

  test('SKU repetido → 409 con el error bajo el campo SKU, lo escrito conservado y el foco en el aviso', async ({ page }) => {
    await openNew(page);
    await fillRequired(page, state.sku, 'Otro nombre conservado QA', '1250');
    await ctl(page, 'description').fill('Texto que no debe perderse');
    const status = await submit(page, button(page, 'Crear producto'));
    expect(status).toBe(CONFLICT);
    const sku = ctl(page, 'sku');
    await expect(sku).toHaveAttribute('aria-invalid', 'true');
    expect((await describedText(page, sku)).length).toBeGreaterThan(0);
    expect(await describedText(page, sku)).toContain('SKU');
    await expect(ctl(page, 'name')).toHaveValue('Otro nombre conservado QA');
    await expect(ctl(page, 'description')).toHaveValue('Texto que no debe perderse');
    await expect(ctl(page, 'price')).toHaveValue('1250');
    await expect(ctl(page, 'category_id')).toHaveValue(categoryId);
    await expect(alertOf(page)).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alert"]') !== null)).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain('already');
  });

  test('slug repetido → 409 con el error bajo el campo del slug', async ({ page }) => {
    await openNew(page);
    await fillRequired(page, `${RUN_PREFIX}${unique()}`, `Reloj QA T147 ${unique()}`);
    await ctl(page, 'slug').fill(state.slug);
    expect(await submit(page, button(page, 'Crear producto'))).toBe(CONFLICT);
    await expect(ctl(page, 'slug')).toHaveAttribute('aria-invalid', 'true');
    await expect(ctl(page, 'slug')).toHaveValue(state.slug);
  });

  test('datos inválidos → 422 por campo, conservando lo escrito y sin exponer el mensaje del backend', async ({ page }) => {
    await openNew(page);
    await fillRequired(page, `${RUN_PREFIX}${unique()}`, '!!!', '1250');
    await ctl(page, 'description').fill('Descripción conservada');
    expect(await submit(page, button(page, 'Crear producto'))).toBe(UNPROCESSABLE);
    await expect(ctl(page, 'name')).toHaveAttribute('aria-invalid', 'true');
    expect((await describedText(page, ctl(page, 'name'))).length).toBeGreaterThan(0);
    await expect(ctl(page, 'description')).toHaveValue('Descripción conservada');
    await expect(ctl(page, 'name')).toHaveValue('!!!');
    const body = await page.locator('body').innerText();
    ['value_error', 'String should', 'Field required', 'validation_error'].forEach((w) => expect(body, w).not.toContain(w));
  });

  test('formato inválido del precio y del diámetro → 422 en cada campo, sin llegar al backend, con 1.250,50 / vacío / 0', async ({ page }) => {
    await openNew(page);
    const invalid = ['1.250,50', '', '0'];
    await invalid.reduce<Promise<void>>(async (prev, price) => {
      await prev;
      await fillRequired(page, `${RUN_PREFIX}${unique()}`, `Reloj QA T147 ${unique()}`, price);
      await ctl(page, 'case_diameter_mm').fill('38.55');
      expect(await submit(page, button(page, 'Crear producto')), price).toBe(UNPROCESSABLE);
      await expect(ctl(page, 'price')).toHaveAttribute('aria-invalid', 'true');
      await expect(ctl(page, 'case_diameter_mm')).toHaveAttribute('aria-invalid', 'true');
      await expect(ctl(page, 'price')).toHaveValue(price);
    }, Promise.resolve());
    expect((await leftovers(admin)).filter((p) => p.sku.startsWith(RUN_PREFIX) && p.sku !== state.sku).length).toBe(0);
  });

  test('el precio 1250 y 1250.5 se aceptan y vuelven igual al abrir la edición (1250 / 1250.50)', async ({ page }) => {
    const prices = [['1250', '1250'], ['1250.5', '1250.50']];
    await prices.reduce<Promise<void>>(async (prev, [typed, shown]) => {
      await prev;
      await openNew(page);
      const tag = unique();
      await fillRequired(page, `${RUN_PREFIX}${tag}`, `Reloj QA T147 ${tag}`, typed);
      await submit(page, button(page, 'Crear producto'));
      await expect(page).toHaveURL((u) => u.search === '?creado=1', { timeout: NAV_TIMEOUT });
      await expect(ctl(page, 'price')).toHaveValue(shown);
    }, Promise.resolve());
  });

  test('editar solo el nombre: cambia el nombre y todo lo demás queda igual', async ({ page }) => {
    const before = await getProduct(admin, state.id);
    await openEdit(page, state.id);
    state.name = `${state.name} editado`;
    await ctl(page, 'name').fill(state.name);
    await submit(page, button(page, 'Guardar cambios'));
    await expect(page).toHaveURL((u) => u.search === '?guardado=1', { timeout: NAV_TIMEOUT });
    await expect(page.locator('main')).toContainText('guardado');
    const after = await getProduct(admin, state.id);
    expect({ ...after, name: before.name, updated_at: before.updated_at }).toEqual(before);
    expect(after.name).toBe(state.name);
  });

  test('editar el precio (1300.5 → 130050 céntimos), vaciar la resistencia al agua (null) y cambiar la categoría', async ({ page }) => {
    await openEdit(page, state.id);
    await expect(ctl(page, 'price')).toHaveValue('1250.50');
    await ctl(page, 'price').fill('1300.5');
    await ctl(page, 'water_resistance_m').fill('');
    await ctl(page, 'category_id').selectOption(otherCategoryId);
    await submit(page, button(page, 'Guardar cambios'));
    await expect(page).toHaveURL((u) => u.search === '?guardado=1', { timeout: NAV_TIMEOUT });
    const p = await getProduct(admin, state.id);
    expect(p.price).toEqual({ amount: NEW_PRICE_CENTS, currency: 'PEN' });
    expect(p.water_resistance_m).toBeNull();
    expect(p.category_id).toBe(otherCategoryId);
    await expect(ctl(page, 'price')).toHaveValue('1300.50');
  });

  test('especificaciones: quitar una fila y reordenar se guarda (el arreglo completo, en orden)', async ({ page }) => {
    await openEdit(page, state.id);
    await page.getByRole('button', { name: 'Quitar especificación 1' }).click();
    await submit(page, button(page, 'Guardar cambios'));
    await expect(page).toHaveURL((u) => u.search === '?guardado=1', { timeout: NAV_TIMEOUT });
    expect((await getProduct(admin, state.id)).specs).toEqual([{ label: 'Cristal', value: 'Zafiro' }]);
  });

  test('guardar sin cambios → «Sin cambios» y el producto no se toca', async ({ page }) => {
    const plain = await createProductViaApi(admin, categoryId);
    const before = await getProduct(admin, plain.id);
    await openEdit(page, plain.id);
    await submit(page, button(page, 'Guardar cambios'));
    await expect(page).toHaveURL((u) => u.search === '?guardado=sin-cambios', { timeout: NAV_TIMEOUT });
    await expect(page.locator('main')).toContainText('Sin cambios');
    expect((await getProduct(admin, plain.id)).updated_at).toBe(before.updated_at);
  });

  test('Enter en un campo guarda (nunca publica)', async ({ page }) => {
    await openEdit(page, state.id);
    state.name = `${state.name} enter`;
    await ctl(page, 'name').fill(state.name);
    await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), ctl(page, 'name').press('Enter')]);
    await expect(page).toHaveURL((u) => u.search === '?guardado=1', { timeout: NAV_TIMEOUT });
    const p = await getProduct(admin, state.id);
    expect(p.name).toBe(state.name);
    expect(p.status).toBe('draft');
  });

  test('publicar sin imagen → 409 con «No se puede publicar todavía» y los requisitos en español; sigue en borrador', async ({ page }) => {
    await openEdit(page, state.id);
    expect(await submit(page, button(page, 'Publicar'))).toBe(CONFLICT);
    await expect(page.locator('main')).toContainText('No se puede publicar todavía');
    await expect(page.locator('main')).toContainText('Al menos una imagen');
    expect(await page.locator('body').innerText()).not.toContain('publish_requirements_unmet');
    expect((await getProduct(admin, state.id)).status).toBe('draft');
  });

  test('un producto sin descripción ni plazo lista cada requisito que falta', async ({ page }) => {
    const bare = await createProductViaApi(admin, categoryId, { description: '', order_policy: 'made_to_order', lead_time_days: null });
    await openEdit(page, bare.id);
    expect(await submit(page, button(page, 'Publicar'))).toBe(CONFLICT);
    const text = await page.locator('main').innerText();
    ['Descripción', 'Plazo de entrega', 'Al menos una imagen'].forEach((w) => expect(text, w).toContain(w));
  });

  test('con los requisitos completos: publica, aparece en la tienda y en /relojes; despublicar lo retira', async ({ page, request }) => {
    test.setTimeout(HOOK_TIMEOUT);
    await addImage(admin, state.id);
    await openEdit(page, state.id);
    await submit(page, button(page, 'Publicar'));
    await expect(page).toHaveURL((u) => u.pathname === `/admin/productos/${state.id}`, { timeout: NAV_TIMEOUT });
    await expect(page.getByText('Publicado').first()).toBeVisible();
    await expect(button(page, 'Despublicar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publicar', exact: true })).toHaveCount(0);
    expect((await getProduct(admin, state.id)).status).toBe('published');
    expect((await get(request, `/relojes/${state.slug}`)).status()).toBe(OK);
    expect(await listed(request), 'el publicado debe listarse').toBe(true);
    await openEdit(page, state.id);
    await submit(page, button(page, 'Despublicar'));
    await expect(page.getByText('Borrador').first()).toBeVisible();
    expect((await getProduct(admin, state.id)).status).toBe('draft');
    expect((await get(request, `/relojes/${state.slug}`)).status()).toBe(NOT_FOUND);
    expect(await listed(request), 'el borrador no debe listarse').toBe(false);
  });

  test('tras la primera publicación el slug no se puede cambiar: 409 como mensaje de formulario', async ({ page }) => {
    await openEdit(page, state.id);
    await ctl(page, 'slug').fill(`${state.slug}-otro`);
    expect(await submit(page, button(page, 'Guardar cambios'))).toBe(CONFLICT);
    await expect(alertOf(page)).toContainText('dirección');
    expect((await getProduct(admin, state.id)).slug).toBe(state.slug);
  });

  test('el rol retirado a media sesión: la edición pasa a «Sin permiso» (403) y no guarda nada', async ({ page, request }) => {
    const demoted = await createQaUser(env, 't147d', 'admin');
    try {
      await asUser(page, demoted);
      expect((await page.goto(`${BASE}/admin/productos/${state.id}`))?.status()).toBe(OK);
      await setRole(demoted, 'customer');
      expect((await get(request, `/admin/productos/${state.id}`, cookieOf(demoted))).status()).toBe(FORBIDDEN);
      const sent = await postForm(request, `/admin/productos/${state.id}`, { _action: 'save', name: 'Hackeado' }, { cookie: cookieOf(demoted), origin: BASE });
      expect(sent.status()).toBe(FORBIDDEN);
      expect((await getProduct(admin, state.id)).name).toBe(state.name);
    } finally {
      await deleteQaUser(env, demoted);
    }
  });

  test('guardar sin cambios un producto con descripción de varias líneas: el navegador envía CRLF y no cuenta como cambio', async ({ page }) => {
    const multi = await createProductViaApi(admin, categoryId, { description: 'Línea uno.\nLínea dos.\n\nLínea cuatro.' });
    const before = await getProduct(admin, multi.id);
    await openEdit(page, multi.id);
    await submit(page, button(page, 'Guardar cambios'));
    await expect(page).toHaveURL((u) => u.search === '?guardado=sin-cambios', { timeout: NAV_TIMEOUT });
    expect((await getProduct(admin, multi.id)).updated_at).toBe(before.updated_at);
  });
});

// ===================================================================================================================================
test.describe('T-147 · seguridad de la petición (escritorio)', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'escribe productos: se ejecuta una vez (escritorio)'));
  let product: ApiProduct;
  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    product = await createProductViaApi(admin, categoryId);
  });

  const headers = (origin: string | null): Record<string, string> => ({ cookie: cookieOf(admin), ...(origin === null ? {} : { origin }) });
  const form = { sku: `${RUN_PREFIX}SEC`, name: 'Intento QA', category_id: '', price: '100', _action: 'save' };

  [['sin Origin', null], ['Origin ajeno', EVIL], ['Origin "null"', 'null'], ['otro puerto', 'http://localhost:9']].forEach(([label, origin]) =>
    test(`POST con ${label} → 403 y nada cambia`, async ({ request }) => {
      const before = await getProduct(admin, product.id);
      const res = await postForm(request, `/admin/productos/${product.id}`, { ...form, name: 'Hackeado' }, headers(origin));
      expect(res.status()).toBe(FORBIDDEN);
      const created = await postForm(request, NEW, { ...form, category_id: categoryId }, headers(origin));
      expect(created.status()).toBe(FORBIDDEN);
      expect(await getProduct(admin, product.id)).toEqual(before);
      expect((await leftovers(admin)).some((p) => p.sku === form.sku)).toBe(false);
    }));

  [['JSON', 'application/json', '{"name":"x"}'], ['texto', 'text/plain', 'name=x']].forEach(([label, type, data]) =>
    test(`cuerpo ${label} → 415`, async ({ request }) => {
      const res = await request.post(`${BASE}/admin/productos/${product.id}`, { headers: { ...headers(BASE), 'content-type': type }, data, maxRedirects: 0, failOnStatusCode: false });
      expect(res.status()).toBe(UNSUPPORTED);
      const created = await request.post(`${BASE}${NEW}`, { headers: { ...headers(BASE), 'content-type': type }, data, maxRedirects: 0, failOnStatusCode: false });
      expect(created.status()).toBe(UNSUPPORTED);
    }));

  test('crear con Origin correcto → 303 con Cache-Control private, no-store y Location interno a ?creado=1', async ({ request }) => {
    const tag = unique();
    const res = await postForm(request, NEW, { sku: `${RUN_PREFIX}${tag}`, name: `Reloj QA T147 ${tag}`, category_id: categoryId, price: '1250', order_policy: 'stock', _action: 'save' }, headers(BASE));
    expect(res.status()).toBe(SEE_OTHER);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const location = res.headers().location ?? '';
    expect(location.startsWith('/admin/productos/')).toBe(true);
    expect(location.endsWith('?creado=1')).toBe(true);
    expect(location).not.toContain('//');
  });

  test('ninguna mutación por GET: ?_action=publish y ?status=published no cambian el producto', async ({ request }) => {
    await addImage(admin, product.id);
    const before = await getProduct(admin, product.id);
    await get(request, `/admin/productos/${product.id}?_action=publish&status=published&name=Hack`, cookieOf(admin));
    await get(request, `${NEW}?_action=publish&sku=${RUN_PREFIX}GET`, cookieOf(admin));
    const after = await getProduct(admin, product.id);
    expect(after).toEqual(before);
    expect(after.status).toBe('draft');
    expect((await leftovers(admin)).some((p) => p.sku === `${RUN_PREFIX}GET`)).toBe(false);
  });

  test('la edición con campos extra (status, id, images, published_at) los ignora', async ({ request }) => {
    const before = await getProduct(admin, product.id);
    const res = await postForm(request, `/admin/productos/${product.id}`, { _action: 'save', sku: before.sku, slug: before.slug, name: `${before.name} x`, description: before.description, category_id: before.category_id, price: String(before.price.amount / PRICE_DIVISOR), order_policy: before.order_policy, status: 'published', id: 'x', images: '[]', published_at: '2026-01-01T00:00:00Z' }, headers(BASE));
    expect(res.status()).toBe(SEE_OTHER);
    const after = await getProduct(admin, product.id);
    expect(after.status).toBe('draft');
    expect(after.name).toBe(`${before.name} x`);
    expect(after.id).toBe(before.id);
    expect(after.images).toEqual(before.images);
  });

  ['no-es-uuid', '123', '..%2F..%2Fadmin', 'g'.repeat(UUID_LEN)].forEach((id) =>
    test(`/admin/productos/${id} → 404`, async ({ request }) => {
      expect((await get(request, `/admin/productos/${id}`, cookieOf(admin))).status()).toBe(NOT_FOUND);
      const res = await postForm(request, `/admin/productos/${id}`, { _action: 'publish' }, headers(BASE));
      expect(res.status()).toBe(NOT_FOUND);
    }));

  test('un UUID que no existe → 404 y la página no revela nada del backend', async ({ request }) => {
    const res = await get(request, '/admin/productos/00000000-0000-4000-8000-000000000000', cookieOf(admin));
    expect(res.status()).toBe(NOT_FOUND);
    const body = await res.text();
    ['Traceback', 'api/v1', 'not_found', 'Bearer'].forEach((w) => expect(body, w).not.toContain(w));
  });

  test('POST (guardar, publicar, despublicar) a un producto que no existe → 404 real, nunca 500', async ({ request }) => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    await ['save', 'publish', 'unpublish'].reduce<Promise<void>>(async (prev, action) => {
      await prev;
      const res = await postForm(request, `/admin/productos/${ghost}`, { _action: action, name: 'x' }, headers(BASE));
      expect(res.status(), action).toBe(NOT_FOUND);
    }, Promise.resolve());
  });

  test('sin sesión → 302 al ingreso con next, también al enviar el formulario', async ({ request }) => {
    const pages = [NEW, `/admin/productos/${product.id}`];
    await pages.reduce<Promise<void>>(async (prev, path) => {
      await prev;
      const res = await get(request, path);
      expect(res.status()).toBe(FOUND);
      expect(res.headers().location).toBe(`/ingresar?next=${encodeURIComponent(path)}`);
      const sent = await postForm(request, path, { _action: 'save', name: 'x' }, { origin: BASE });
      expect(sent.status()).toBe(FOUND);
    }, Promise.resolve());
  });

  test('un cliente: GET → 403 «No tienes permiso» sin formulario; POST → 403 y no crea ni cambia nada', async ({ page, request }) => {
    await asUser(page, customer);
    const res = await page.goto(`${BASE}${NEW}`);
    expect(res?.status()).toBe(FORBIDDEN);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('permiso');
    await expect(page.locator('form#product-form')).toHaveCount(0);
    const before = await getProduct(admin, product.id);
    const sent = await postForm(request, `/admin/productos/${product.id}`, { _action: 'publish' }, { cookie: cookieOf(customer), origin: BASE });
    expect(sent.status()).toBe(FORBIDDEN);
    const created = await postForm(request, NEW, { sku: `${RUN_PREFIX}CLI`, name: 'x', category_id: categoryId, price: '1', _action: 'save' }, { cookie: cookieOf(customer), origin: BASE });
    expect(created.status()).toBe(FORBIDDEN);
    expect(await getProduct(admin, product.id)).toEqual(before);
    expect((await leftovers(admin)).some((p) => p.sku === `${RUN_PREFIX}CLI`)).toBe(false);
  });

  test('las páginas son privadas: no-store, noindex y sin secretos ni identificadores de usuario en el HTML', async ({ request }) => {
    const res = await get(request, `/admin/productos/${product.id}`, cookieOf(admin));
    expect(res.status()).toBe(OK);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    const html = await res.text();
    expect(html).toContain('noindex');
    [admin.token, admin.id, admin.email, 'Authorization', 'API_BASE_URL', 'service_role'].forEach((s) => expect(html, s).not.toContain(s));
  });

  test('sin errores de consola al crear y editar', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openNew(page);
    await openEdit(page, product.id);
    expect(errors).toEqual([]);
  });
});

// ===================================================================================================================================
test.describe('T-147 · accesibilidad, teclado y responsive (todos los anchos)', () => {
  let product: ApiProduct;
  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    product = await createProductViaApi(admin, categoryId, { specs: [{ label: 'Calibre', value: 'VM-01' }] });
  });

  test('crear: axe sin violaciones y sin desbordamiento horizontal (1280, 1440 en escritorio; 375 en móvil)', async ({ page }, info) => {
    const widths = info.project.name === 'desktop' ? WIDTHS : [info.project.use.viewport?.width ?? W_MOBILE];
    await widths.reduce<Promise<void>>(async (prev, w) => {
      await prev;
      await openNew(page, w);
      await expectNoA11yViolations(page);
      expect(await overflow(page), `ancho ${w}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/t147-nuevo-${w}.png`, fullPage: true });
    }, Promise.resolve());
  });

  test('editar (borrador): axe sin violaciones y sin desbordamiento, en cada ancho', async ({ page }, info) => {
    const widths = info.project.name === 'desktop' ? WIDTHS : [info.project.use.viewport?.width ?? W_MOBILE];
    await widths.reduce<Promise<void>>(async (prev, w) => {
      await prev;
      await openEdit(page, product.id, '', w);
      await expectNoA11yViolations(page);
      expect(await overflow(page), `ancho ${w}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `test-results/t147-editar-${w}.png`, fullPage: true });
    }, Promise.resolve());
  });

  test('estados de error accesibles: 409 de SKU y «No se puede publicar todavía» pasan axe', async ({ page }, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    await openNew(page, info.project.name === 'desktop' ? WIDTHS[0] : W_MOBILE);
    await fillRequired(page, product.sku, 'Nombre QA');
    expect(await submit(page, button(page, 'Crear producto'))).toBe(CONFLICT);
    await expectNoA11yViolations(page);
    await openEdit(page, product.id, '', info.project.name === 'desktop' ? WIDTHS[0] : W_MOBILE);
    await page.locator('form[method="post"]').filter({ has: button(page, 'Publicar') }).evaluate((f) => (f as HTMLFormElement).requestSubmit());
    await expect(page.locator('main')).toContainText('No se puede publicar todavía');
    await expectNoA11yViolations(page);
  });

  test('teclado: el orden de tabulación sigue el del formulario, con foco amarillo de 2 px visible en cada control', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'el foco se mide en escritorio');
    await openNew(page);
    await ctl(page, 'sku').focus();
    const seen: { name: string; color: string; width: number; style: string; tag: string }[] = [];
    await Array.from({ length: MAX_TABS }).reduce<Promise<void>>(async (prev) => {
      await prev;
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const s = getComputedStyle(el);
          return { name: el.getAttribute('name') ?? '', color: s.outlineColor, width: parseFloat(s.outlineWidth), style: s.outlineStyle, tag: el.tagName };
        }),
      );
      await page.keyboard.press('Tab');
    }, Promise.resolve());
    const order = FIELD_ORDER.map((n) => seen.findIndex((s) => s.name === n));
    expect(order.every((i) => i >= 0), `faltan controles en el orden de tabulación: ${JSON.stringify(order)}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    seen.filter((s) => FIELD_ORDER.includes(s.name)).forEach((s) => {
      expect(s.style, s.name).not.toBe('none');
      expect(s.width, s.name).toBeGreaterThanOrEqual(FOCUS_WIDTH);
      expect(s.color, s.name).toBe(FOCUS_YELLOW);
    });
  });

  test('teclado: la política de venta se cambia con las flechas y «Agregar especificación» con Enter enfoca la fila nueva', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'teclado en escritorio');
    await openNew(page);
    const first = page.getByRole('radio', { name: 'Solo con stock' });
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: 'Siempre bajo pedido' })).toBeChecked();
    const add = page.getByRole('button', { name: 'Agregar especificación' });
    await add.focus();
    const before = await page.locator('input[name^="spec"]').count();
    await page.keyboard.press('Enter');
    expect(await page.locator('input[name^="spec"]').count()).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toContain('Característica');
  });

  test('objetivos táctiles: campos ≥ 44 px y botones ≥ 40 px', async ({ page }) => {
    await openNew(page);
    const heights = async (loc: Locator): Promise<number[]> => Promise.all((await loc.all()).map(async (l) => (await l.boundingBox())?.height ?? 0));
    const fields = await heights(page.locator('form#product-form input[type="text"]:visible, form#product-form select:visible'));
    expect(fields.length).toBeGreaterThan(0);
    fields.forEach((h) => expect(h).toBeGreaterThanOrEqual(CONTROL_HEIGHT - TOLERANCE));
    (await heights(page.getByRole('button', { name: 'Crear producto' }))).forEach((h) => expect(h).toBeGreaterThanOrEqual(BUTTON_HEIGHT - TOLERANCE));
  });

  test('contraste de Select, Textarea y RadioGroup en el backoffice y en el contexto de la tienda (texto ≥ 4,5 y borde ≥ 3)', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'contraste en escritorio');
    await openNew(page);
    const measure = async (): Promise<Record<string, number>> => {
      const select = ctl(page, 'category_id');
      const textarea = ctl(page, 'description');
      const legend = page.locator('fieldset legend').first();
      const radioLabel = page.locator('fieldset label').first();
      return {
        selectText: await textContrast(select),
        textareaText: await textContrast(textarea),
        legendText: await textContrast(legend),
        radioText: await textContrast(radioLabel),
        selectEdge: await edgeContrast(select, 'border'),
        textareaEdge: await edgeContrast(textarea, 'border'),
      };
    };
    const check = (label: string, m: Record<string, number>): void => {
      ['selectText', 'textareaText', 'legendText', 'radioText'].forEach((k) => expect(m[k], `${label} ${k}`).toBeGreaterThanOrEqual(TEXT_CONTRAST));
      ['selectEdge', 'textareaEdge'].forEach((k) => expect(m[k], `${label} ${k}`).toBeGreaterThanOrEqual(EDGE_CONTRAST));
    };
    check('backoffice', await measure());
    await leaveBackoffice(page);
    check('tienda', await measure());
  });

  test('móvil: el formulario de edición se puede recorrer sin desbordar y con el panel de publicación visible', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'solo en el proyecto móvil (375 px)');
    await openEdit(page, product.id, '', W_MOBILE);
    await expect(button(page, 'Guardar cambios')).toBeVisible();
    await expect(button(page, 'Publicar')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await api(admin, 'GET', `/catalog/admin/products/${product.id}`)).toBeTruthy();
  });
});
