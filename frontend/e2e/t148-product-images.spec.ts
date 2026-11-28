import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import {
  FIVE_MIB, SIX_MIB, animatedWebpBytes, apngBytes, bigPng, corruptPng, gifBytes, isWebp, jpegBytes, pngBytes, pngOfSize, textBytes, webpBytes,
} from '../tests/helpers/t148-files';
import {
  RE_ALT_LABEL, RE_BACKEND_ENGLISH, RE_BACK_WORD, RE_DEL_BTN, RE_DOWN_BTN, RE_GALLERY_MAIN, RE_GALLERY_THUMBS, RE_POSITION_MSG, RE_SAVE_BTN, RE_TOO_BIG_MSG, RE_TYPE_MSG, RE_UP_BTN,
  RE_WEBP_URL,
} from '../tests/helpers/t148-re';
import { browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import {
  activeCategories, cleanup, createProduct, imagesOf, newRunPrefix, seenUrls, unique, uploadMany, urlBytes, urlStatus, api, getProduct,
  type ApiImage, type ApiProduct,
} from './helpers/t148';

// T-148 · imágenes del producto en el backoffice, de punta a punta con un administrador real (D-050): Supabase local, backend en :8000 y `astro dev`.
// Crea SOLO productos `QA-T148-*` con imágenes generadas por la suite y los borra al terminar (`cleanup`); no toca los 12 relojes de la semilla ni otros
// archivos del bucket `products`. Requiere `npm run db:start`, el backend y Docker (rol admin con `docker exec … psql`).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 240_000;
const TEST_TIMEOUT = 120_000;
const NAV_TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 60_000;
const FOUND = 302;
const SEE_OTHER = 303;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const TOO_LARGE = 413;
const UNSUPPORTED = 415;
const UNPROCESSABLE = 422;
const OK = 200;
const NO_STORE = 'private, no-store';
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const W_DESKTOP = 1280;
const W_WIDE = 1440;
const HEIGHT = 900;
const TALL_VIEWPORT = 3400; // las tres filas caben a la vez: el arrastre nativo no desplaza la página
const DROP_X = 40;
const DROP_Y = 6;
const MAX_TABS = 30;
const PRIVATE_NAMES = ['sneaky-QXNAME.png'];
const PREFIX = newRunPrefix();
const EVIL = 'https://evil.example';
const WIDE_PX = 5000;
const TALL_PX = 5001; // 25 005 000 px: justo sobre el tope de 25 MP
const ALT_TOO_LONG = 151;
const HALF_SECOND_MS = 500;
const BAD_REQUEST = 400;
const SERVER_ERROR = 500;
const MSG_LAST = 'Un producto publicado necesita al menos una imagen';

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;
let categoryId: string;
let leftoverAtEnd = NONE;
let productA: ApiProduct; // borrador: subir, describir, mover y borrar
let productS: ApiProduct; // publicado: la ficha de la tienda y «última imagen»
let productB: ApiProduct; // ajeno: aislamiento entre productos
let imageOfB: ApiImage;

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't148a', 'admin');
  customer = await createQaUser(env, 't148c', 'customer');
  categoryId = (await activeCategories(admin))[NONE].id;
  productA = await createProduct(admin, categoryId, PREFIX);
  productB = await createProduct(admin, categoryId, PREFIX);
  imageOfB = (await uploadMany(admin, productB.id, ONE, 'QA ajena'))[NONE];
  productS = await createProduct(admin, categoryId, PREFIX);
});

test.afterAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const urls = [...seenUrls];
  leftoverAtEnd = admin ? await cleanup(admin, PREFIX) : NONE;
  // Storage queda limpio: ninguna de las imágenes de prueba se sigue sirviendo.
  const alive = (await Promise.all(urls.map(async (u) => ((await urlStatus(u)) === OK ? u : null)))).filter(Boolean);
  await Promise.all([deleteQaUser(env, admin), deleteQaUser(env, customer)]);
  console.warn(`T-148 limpieza: ${leftoverAtEnd} producto(s) ${PREFIX}* sin borrar; ${alive.length} de ${urls.length} imágenes aún servidas por Storage`);
  expect(alive).toEqual([]);
});

// --- ayudantes --------------------------------------------------------------------------------------------------------------------------
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const region = (page: Page): Locator => page.getByRole('region', { name: 'Imágenes' });
const rows = (page: Page): Locator => region(page).locator('ol > li');
const uploadForm = (page: Page): Locator => region(page).locator('form:has(input[type="file"])');
const isPost = (r: { request: () => { method: () => string } }): boolean => r.request().method() === 'POST';
const button = (row: Locator, name: RegExp): Locator => row.getByRole('button', { name });
const altValues = (page: Page): Promise<string[]> => rows(page).locator('input[type="text"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const alts = (images: ApiImage[]): string[] => images.map((i) => i.alt);
const describedText = async (page: Page, loc: Locator): Promise<string> => {
  const ids = ((await loc.getAttribute('aria-describedby')) ?? '').split(' ').filter(Boolean);
  return (await Promise.all(ids.map((id) => page.locator(`[id="${id}"]`).innerText().catch(() => '')))).join(' ');
};

async function openEdit(page: Page, id: string, width = W_DESKTOP): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, admin);
  const res = await page.goto(`${BASE}/admin/productos/${id}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(region(page)).toBeVisible();
}

type Upload = { name: string; mimeType: string; buffer: Buffer };
const file = (name: string, mimeType: string, data: Uint8Array): Upload => ({ name, mimeType, buffer: Buffer.from(data) });

/** Elige el archivo, escribe el alt y pulsa «Subir imagen»; devuelve el estado de la respuesta del POST (303 si salió bien). */
async function uploadFile(page: Page, f: Upload, alt: string, opts: { noValidate?: boolean } = {}): Promise<number> {
  const form = uploadForm(page);
  await form.locator('input[type="file"]').setInputFiles(f);
  await form.getByRole('textbox').fill(alt);
  if (opts.noValidate) await form.evaluate((el) => ((el as HTMLFormElement).noValidate = true));
  const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: UPLOAD_TIMEOUT }), form.getByRole('button', { name: RE_UP_BTN }).click()]);
  return res.status();
}

/** Pulsa un control de fila y espera la respuesta del POST. */
async function postVia(page: Page, trigger: Locator): Promise<number> {
  const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), trigger.click()]);
  return res.status();
}

const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const postForm = (request: APIRequestContext, path: string, data: Record<string, string>, headers: Record<string, string>) =>
  request.post(`${BASE}${path}`, { headers, form: data, maxRedirects: 0, failOnStatusCode: false });
const asAdmin = (extra: Record<string, string> = {}) => ({ cookie: admin.cookie, origin: BASE, ...extra });

// ===================================================================================================================================
test.describe('T-148 · flujos con administrador real (escritorio)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'escribe imágenes: se ejecuta una vez (escritorio)');
    test.setTimeout(TEST_TIMEOUT);
  });

  test('sin imágenes: mensaje de vacío, zona de subida con alt obligatorio y accesible (axe a 1280 y 1440)', async ({ page }) => {
    await openEdit(page, productA.id);
    await expect(rows(page)).toHaveCount(NONE);
    await expect(uploadForm(page).locator('input[type="file"]')).toBeVisible();
    await expect(uploadForm(page).getByRole('textbox')).toBeVisible();
    await expect(uploadForm(page).getByRole('textbox')).toHaveAttribute('required', '');
    await expectNoA11yViolations(page);
    await openEdit(page, productA.id, W_WIDE);
    await expectNoA11yViolations(page);
  });

  test('subir un JPEG: aparece en la lista con su alt recortado, es la principal y el servidor la convirtió a WebP', async ({ page }) => {
    await openEdit(page, productA.id);
    expect(await uploadFile(page, file('frente.jpg', 'image/jpeg', jpegBytes()), '  Frente QA JPEG  ')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(ONE, { timeout: NAV_TIMEOUT });
    await expect(rows(page).first().getByText('Principal', { exact: true })).toBeVisible();
    expect(await altValues(page)).toEqual(['Frente QA JPEG']);
    const [img] = await imagesOf(admin, productA.id);
    expect(img.alt).toBe('Frente QA JPEG');
    expect(img.url).toMatch(RE_WEBP_URL);
    const served = await urlBytes(img.url);
    expect(served.status).toBe(OK);
    expect(served.type).toBe('image/webp');
    expect(isWebp(served.data)).toBe(true);
    const src = await rows(page).first().locator('img').getAttribute('src');
    expect(src).toBe(img.url);
    expect(await rows(page).first().locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(NONE);
  });

  test('subir un PNG y un WebP: se suman al final, sin cambiar la principal, y todos se sirven como WebP', async ({ page }) => {
    await openEdit(page, productA.id);
    expect(await uploadFile(page, file('perfil.png', 'image/png', pngBytes({ rgb: Uint8Array.from(Buffer.from('285aa0', 'hex')) })), 'Perfil QA PNG')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(TWO, { timeout: NAV_TIMEOUT });
    expect(await uploadFile(page, file('corona.webp', 'image/webp', webpBytes()), 'Corona QA WebP')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(THREE, { timeout: NAV_TIMEOUT });
    expect(await altValues(page)).toEqual(['Frente QA JPEG', 'Perfil QA PNG', 'Corona QA WebP']);
    const images = await imagesOf(admin, productA.id);
    expect(alts(images)).toEqual(['Frente QA JPEG', 'Perfil QA PNG', 'Corona QA WebP']);
    const bodies = await Promise.all(images.map((i) => urlBytes(i.url)));
    bodies.forEach((b) => {
      expect(b.status).toBe(OK);
      expect(isWebp(b.data)).toBe(true);
    });
    await expect(rows(page).first().getByText('Principal', { exact: true })).toBeVisible();
    await expect(region(page).getByText('Principal', { exact: true }).filter({ visible: true })).toHaveCount(ONE);
  });

  test('el alt es obligatorio: el navegador lo exige y, si se salta, el servidor responde 422 en su campo sin subir nada', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = (await imagesOf(admin, productA.id)).length;
    await uploadForm(page).locator('input[type="file"]').setInputFiles(file('x.png', 'image/png', pngBytes()));
    await uploadForm(page).getByRole('button', { name: RE_UP_BTN }).click();
    expect(await uploadForm(page).getByRole('textbox').evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    // Sin validación del navegador, el servidor decide: vacío y solo espacios → 422 junto al campo.
    const empties = ['', '   '];
    await empties.reduce<Promise<void>>(async (prev, alt) => {
      await prev;
      await openEdit(page, productA.id);
      expect(await uploadFile(page, file('x.png', 'image/png', pngBytes()), alt, { noValidate: true }), JSON.stringify(alt)).toBe(UNPROCESSABLE);
      await expect(uploadForm(page).getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
      expect((await describedText(page, uploadForm(page).getByRole('textbox'))).length).toBeGreaterThan(NONE);
      expect(await page.locator('body').innerText()).not.toMatch(RE_BACKEND_ENGLISH);
    }, Promise.resolve());
    expect((await imagesOf(admin, productA.id)).length).toBe(before);
  });

  test('sin archivo (con la validación del navegador saltada) → 422 en el campo del archivo', async ({ page }) => {
    await openEdit(page, productA.id);
    const form = uploadForm(page);
    await form.getByRole('textbox').fill('Sin archivo QA');
    await form.evaluate((el) => ((el as HTMLFormElement).noValidate = true));
    const status = await postVia(page, form.getByRole('button', { name: RE_UP_BTN }));
    expect(status).toBe(UNPROCESSABLE);
    await expect(form.locator('input[type="file"]')).toHaveAttribute('aria-invalid', 'true');
  });

  const rejected: [string, () => Upload, number, RegExp | null][] = [
    ['un GIF → 415 «Formato no admitido: usa JPEG, PNG o WebP»', () => file('animacion.gif', 'image/gif', gifBytes()), UNSUPPORTED, RE_TYPE_MSG],
    ['un texto renombrado a .png → 415', () => file('falso.png', 'image/png', textBytes()), UNSUPPORTED, RE_TYPE_MSG],
    ['un PNG corrupto → 422 (invalid_image)', () => file('roto.png', 'image/png', corruptPng()), UNPROCESSABLE, null],
    ['una imagen de más de 25 megapíxeles → 422 (image_dimensions_exceeded)', () => file('enorme.png', 'image/png', bigPng(WIDE_PX, TALL_PX)), UNPROCESSABLE, null],
    ['un WebP animado → 422 (animated_image)', () => file('anim.webp', 'image/webp', animatedWebpBytes()), UNPROCESSABLE, null],
    ['un PNG animado (APNG) → 422 (animated_image)', () => file('anim.png', 'image/png', apngBytes()), UNPROCESSABLE, null],
    ['5 MiB + 1 byte → 413 «El archivo supera los 5 MiB»', () => file('grande.png', 'image/png', pngOfSize(FIVE_MIB + ONE)), TOO_LARGE, RE_TOO_BIG_MSG],
    ['6 MiB + 1 byte (más que el cuerpo permitido) → 413 con el mismo mensaje', () => file('gigante.png', 'image/png', pngOfSize(SIX_MIB + ONE)), TOO_LARGE, RE_TOO_BIG_MSG],
  ];
  rejected.forEach(([title, make, status, message]) => {
    test(`rechazo de archivo: ${title}; el error va en el campo, sin el msg del backend ni perder la lista`, async ({ page }) => {
      await openEdit(page, productA.id);
      const before = await imagesOf(admin, productA.id);
      expect(await uploadFile(page, make(), 'QA error de archivo')).toBe(status);
      const fileInput = uploadForm(page).locator('input[type="file"]');
      await expect(fileInput).toHaveAttribute('aria-invalid', 'true');
      const shown = await describedText(page, fileInput);
      expect(shown.length).toBeGreaterThan(NONE);
      if (message) expect(shown).toMatch(message);
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(RE_BACKEND_ENGLISH);
      PRIVATE_NAMES.concat(['animacion.gif', 'falso.png', 'roto.png', 'enorme.png', 'anim.webp', 'anim.png', 'grande.png', 'gigante.png']).forEach((n) =>
        expect(body, n).not.toContain(n),
      );
      await expect(rows(page)).toHaveCount(before.length);
      expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual(before.map((i) => i.id));
      await expect(uploadForm(page)).toBeVisible();
    });
  });

  test('tras los errores el formulario sigue sirviendo: una subida válida funciona y el nombre del cliente no aparece en ningún sitio', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = (await imagesOf(admin, productA.id)).length;
    expect(await uploadFile(page, file(PRIVATE_NAMES[NONE], 'image/png', pngBytes({ rgb: Uint8Array.from(Buffer.from('c83c3c', 'hex')) })), 'Cuarta QA')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(before + ONE, { timeout: NAV_TIMEOUT });
    expect(await page.locator('body').innerHTML()).not.toContain('QXNAME');
    const list = await imagesOf(admin, productA.id);
    expect(list.at(-ONE)?.url ?? '').not.toContain('QXNAME');
  });

  test('un archivo de exactamente 5 MiB (el límite) se acepta y queda convertido a WebP', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = (await imagesOf(admin, productA.id)).length;
    expect(await uploadFile(page, file('justo.png', 'image/png', pngOfSize(FIVE_MIB)), 'QA 5 MiB exactos')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(before + ONE, { timeout: NAV_TIMEOUT });
    const last = (await imagesOf(admin, productA.id)).at(-ONE) as ApiImage;
    expect(last.alt).toBe('QA 5 MiB exactos');
    const served = await urlBytes(last.url);
    expect(isWebp(served.data)).toBe(true);
    expect(served.data.length).toBeLessThan(FIVE_MIB);
  });

  test('editar el alt de una imagen: Enter envía, el texto queda como texto y la API lo guarda', async ({ page }) => {
    await openEdit(page, productA.id);
    const second = rows(page).nth(ONE);
    const field = second.getByRole('textbox', { name: RE_ALT_LABEL });
    await field.fill('Perfil <b>izquierdo</b> & "más"');
    const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), field.press('Enter')]);
    expect(res.status()).toBe(SEE_OTHER);
    await expect(rows(page).nth(ONE).getByRole('textbox', { name: RE_ALT_LABEL })).toHaveValue('Perfil <b>izquierdo</b> & "más"');
    await expect(region(page).locator('b')).toHaveCount(NONE);
    expect((await imagesOf(admin, productA.id))[ONE].alt).toBe('Perfil <b>izquierdo</b> & "más"');
  });

  test('alt vacío o de más de 150 caracteres → 422 en el campo de esa imagen, sin tocar las demás ni la API', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = alts(await imagesOf(admin, productA.id));
    const bad = ['', 'a'.repeat(ALT_TOO_LONG)];
    await bad.reduce<Promise<void>>(async (prev, value) => {
      await prev;
      await openEdit(page, productA.id);
      const row = rows(page).nth(ONE);
      const field = row.getByRole('textbox', { name: RE_ALT_LABEL });
      // `maxlength` del navegador recorta lo que se teclea: el valor largo se fija sin teclear, como lo haría un envío manipulado.
      await field.evaluate((el, v) => ((el as HTMLInputElement).value = v), value);
      await row.locator('form:has(input[type="text"])').evaluate((el) => ((el as HTMLFormElement).noValidate = true));
      const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), field.press('Enter')]);
      expect(res.status(), `${value.length} caracteres`).toBe(UNPROCESSABLE);
      await expect(rows(page).nth(ONE).getByRole('textbox', { name: RE_ALT_LABEL })).toHaveAttribute('aria-invalid', 'true');
      await expect(rows(page).nth(NONE).getByRole('textbox', { name: RE_ALT_LABEL })).not.toHaveAttribute('aria-invalid', 'true');
    }, Promise.resolve());
    expect(alts(await imagesOf(admin, productA.id))).toEqual(before);
  });

  test('mover con los botones «Subir» y «Bajar»: cambia el orden, la principal sigue al primero y los extremos no rompen', async ({ page }) => {
    await openEdit(page, productA.id);
    const start = await imagesOf(admin, productA.id);
    expect(await postVia(page, button(rows(page).nth(NONE), RE_DOWN_BTN))).toBe(SEE_OTHER);
    await expect(rows(page).nth(NONE).getByText('Principal', { exact: true })).toBeVisible();
    let now = (await imagesOf(admin, productA.id)).map((i) => i.id);
    expect(now.slice(NONE, TWO)).toEqual([start[ONE].id, start[NONE].id]);
    expect(await altValues(page)).toEqual(alts(await imagesOf(admin, productA.id)));
    // Subir la segunda la devuelve al primer lugar.
    expect(await postVia(page, button(rows(page).nth(ONE), RE_UP_BTN))).toBe(SEE_OTHER);
    now = (await imagesOf(admin, productA.id)).map((i) => i.id);
    expect(now).toEqual(start.map((i) => i.id));
    // Extremos: subir la primera y bajar la última no cambian nada ni dan error.
    const last = rows(page).last();
    expect(await postVia(page, button(rows(page).nth(NONE), RE_UP_BTN))).toBe(SEE_OTHER);
    expect(await postVia(page, button(last, RE_DOWN_BTN))).toBe(SEE_OTHER);
    expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual(start.map((i) => i.id));
    await expect(page.locator('[role="alert"]')).toHaveCount(NONE);
  });

  test('el orden por teclado es completo: Tab llega a «Subir», «Bajar» y «Eliminar» y Enter y Espacio los accionan (WCAG 2.5.7)', async ({ page }) => {
    await openEdit(page, productA.id);
    const start = (await imagesOf(admin, productA.id)).map((i) => i.id);
    const second = rows(page).nth(ONE);
    await second.getByRole('textbox', { name: RE_ALT_LABEL }).focus();
    const reached = new Set<string>();
    await Array.from({ length: MAX_TABS }).reduce<Promise<void>>(async (prev) => {
      await prev;
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '');
      reached.add(label.toLowerCase());
    }, Promise.resolve());
    expect([...reached].some((l) => l.startsWith('subir'))).toBe(true);
    expect([...reached].some((l) => l.startsWith('bajar'))).toBe(true);
    expect([...reached].some((l) => l.startsWith('eliminar'))).toBe(true);
    // Enter sobre «Subir» de la segunda imagen.
    await openEdit(page, productA.id);
    const up = button(rows(page).nth(ONE), RE_UP_BTN);
    await up.focus();
    const [enter] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), page.keyboard.press('Enter')]);
    expect(enter.status()).toBe(SEE_OTHER);
    expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual([start[ONE], start[NONE], ...start.slice(TWO)]);
    // Espacio sobre «Subir» de la segunda lo vuelve a poner como estaba.
    await openEdit(page, productA.id);
    await button(rows(page).nth(ONE), RE_UP_BTN).focus();
    const [space] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), page.keyboard.press('Space')]);
    expect(space.status()).toBe(SEE_OTHER);
    expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual(start);
  });

  test('arrastrar y soltar: la tercera pasa al primer lugar, se anuncia «Imagen movida a la posición 1» y se guarda el mismo orden que con botones', async ({ page }) => {
    // La página se recarga tras soltar (PRG): el texto del aria-live se guarda en el momento del envío y en cada cambio, para leerlo después.
    await page.addInitScript(() => {
      const keep = (): void => {
        const t = document.getElementById('imagenes-titulo')?.closest('section')?.querySelector('[aria-live]')?.textContent?.trim();
        if (t) sessionStorage.setItem('qa-live', t);
      };
      document.addEventListener('submit', keep, true);
      new MutationObserver(keep).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await openEdit(page, productA.id);
    await page.setViewportSize({ width: W_DESKTOP, height: TALL_VIEWPORT });
    const start = await imagesOf(admin, productA.id);
    await expect(rows(page).nth(TWO)).toHaveAttribute('draggable', 'true');
    const dragged = await rows(page).nth(TWO).locator('input[type="text"]').inputValue();
    const [res] = await Promise.all([
      page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }),
      // Se arrastra desde la miniatura (el centro de la fila cae sobre el campo de texto, que no inicia arrastres).
      rows(page).nth(TWO).locator('img').dragTo(rows(page).nth(NONE), { targetPosition: { x: DROP_X, y: DROP_Y } }),
    ]);
    expect(res.status()).toBe(SEE_OTHER);
    const after = (await imagesOf(admin, productA.id)).map((i) => i.id);
    expect(after).toEqual([start[TWO].id, start[NONE].id, start[ONE].id, ...start.slice(THREE).map((i) => i.id)]);
    await expect(rows(page).nth(NONE).getByRole('textbox', { name: RE_ALT_LABEL })).toHaveValue(dragged);
    await expect(rows(page).nth(NONE).getByText('Principal', { exact: true })).toBeVisible();
    const announced = await page.evaluate(() => sessionStorage.getItem('qa-live'));
    expect(announced ?? '').toMatch(RE_POSITION_MSG);
    expect(Number(RE_POSITION_MSG.exec(announced ?? '')?.[ONE])).toBe(ONE);
  });

  test('soltar sin mover (la misma posición) no envía nada', async ({ page }) => {
    await openEdit(page, productA.id);
    await page.setViewportSize({ width: W_DESKTOP, height: TALL_VIEWPORT });
    const before = (await imagesOf(admin, productA.id)).map((i) => i.id);
    let posts = NONE;
    page.on('request', (r) => {
      if (r.method() === 'POST') posts += ONE;
    });
    await rows(page).nth(ONE).locator('img').dragTo(rows(page).nth(ONE), { targetPosition: { x: DROP_X, y: DROP_Y } });
    await page.waitForTimeout(HALF_SECOND_MS);
    expect(posts).toBe(NONE);
    expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual(before);
  });

  test('borrar pide confirmación: Esc y «Volver» no borran; confirmar borra la imagen, Storage deja de servirla y la lista se actualiza', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = await imagesOf(admin, productA.id);
    const victim = before.at(-ONE) as ApiImage; // la de 5 MiB
    expect((await urlStatus(victim.url))).toBe(OK);
    const last = rows(page).last();
    await button(last, RE_DEL_BTN).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect((await imagesOf(admin, productA.id)).length).toBe(before.length);
    await button(last, RE_DEL_BTN).click();
    await dialog.getByRole('button', { name: RE_BACK_WORD }).click();
    await expect(dialog).toBeHidden();
    expect((await imagesOf(admin, productA.id)).length).toBe(before.length);
    await button(last, RE_DEL_BTN).click();
    const status = await postVia(page, dialog.getByRole('button', { name: RE_DEL_BTN }));
    expect(status).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(before.length - ONE, { timeout: NAV_TIMEOUT });
    const after = await imagesOf(admin, productA.id);
    expect(after.map((i) => i.id)).toEqual(before.slice(NONE, -ONE).map((i) => i.id));
    expect(await urlStatus(victim.url)).not.toBe(OK);
  });

  test('borrar la primera hace principal a la siguiente', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = await imagesOf(admin, productA.id);
    await button(rows(page).nth(NONE), RE_DEL_BTN).click();
    expect(await postVia(page, page.getByRole('dialog').getByRole('button', { name: RE_DEL_BTN }))).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(before.length - ONE, { timeout: NAV_TIMEOUT });
    await expect(rows(page).nth(NONE).getByText('Principal', { exact: true })).toBeVisible();
    expect((await imagesOf(admin, productA.id))[NONE].id).toBe(before[ONE].id);
    expect(await urlStatus(before[NONE].url)).not.toBe(OK);
  });

  // --- ficha de la tienda y «última imagen» (producto publicado) ----------------------------------------------------------------
  test('la primera imagen es la principal en la ficha de la tienda y el orden de las miniaturas sigue el de la administración', async ({ page, request }) => {
    const images = await uploadMany(admin, productS.id, THREE, 'QA tienda');
    expect((await api(admin, 'POST', `/catalog/admin/products/${productS.id}/publish`)).status).toBe(OK);
    const storePage = async (): Promise<string> => (await (await get(request, `/relojes/${productS.slug}`)).text());
    const mainSrc = (html: string): string => RE_GALLERY_MAIN.exec(html)?.slice(ONE).find(Boolean) ?? '';
    expect(mainSrc(await storePage())).toBe(images[NONE].url);
    await openEdit(page, productS.id);
    await expect(rows(page)).toHaveCount(THREE);
    expect(await postVia(page, button(rows(page).nth(TWO), RE_UP_BTN))).toBe(SEE_OTHER);
    expect(await postVia(page, button(rows(page).nth(ONE), RE_UP_BTN))).toBe(SEE_OTHER);
    const reordered = await imagesOf(admin, productS.id);
    expect(reordered.map((i) => i.id)).toEqual([images[TWO].id, images[NONE].id, images[ONE].id]);
    const html = await storePage();
    expect(mainSrc(html)).toBe(reordered[NONE].url);
    const order = [...html.matchAll(RE_GALLERY_THUMBS)].map((m) => m[ONE] ?? m[TWO]);
    expect(order).toEqual(reordered.map((i) => i.url));
  });

  test('borrar la última imagen de un producto publicado → 409 con «Un producto publicado necesita al menos una imagen» y la imagen sigue', async ({ page }) => {
    await openEdit(page, productS.id);
    // Quedan tres: se borran dos (204 mientras sobre más de una) y después se intenta con la última.
    await Array.from({ length: TWO }).reduce<Promise<void>>(async (prev, _, i) => {
      await prev;
      await button(rows(page).nth(ONE), RE_DEL_BTN).click();
      expect(await postVia(page, page.getByRole('dialog').getByRole('button', { name: RE_DEL_BTN }))).toBe(SEE_OTHER);
      await expect(rows(page)).toHaveCount(THREE - ONE - i, { timeout: NAV_TIMEOUT });
    }, Promise.resolve());
    const [only] = await imagesOf(admin, productS.id);
    await button(rows(page).nth(NONE), RE_DEL_BTN).click();
    const status = await postVia(page, page.getByRole('dialog').getByRole('button', { name: RE_DEL_BTN }));
    expect(status).toBe(CONFLICT);
    await expect(page.locator('[role="alert"]').filter({ hasText: MSG_LAST }).first()).toBeVisible();
    await expect(rows(page)).toHaveCount(ONE);
    expect((await imagesOf(admin, productS.id)).map((i) => i.id)).toEqual([only.id]);
    expect(await urlStatus(only.url)).toBe(OK);
    await expectNoA11yViolations(page);
    // Despublicado, ya se puede quedar sin imágenes.
    expect((await api(admin, 'POST', `/catalog/admin/products/${productS.id}/unpublish`)).status).toBe(OK);
    await openEdit(page, productS.id);
    await button(rows(page).nth(NONE), RE_DEL_BTN).click();
    expect(await postVia(page, page.getByRole('dialog').getByRole('button', { name: RE_DEL_BTN }))).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(NONE, { timeout: NAV_TIMEOUT });
    expect(await urlStatus(only.url)).not.toBe(OK);
  });

  test('regresión de T-147: guardar el formulario principal no toca las imágenes y la ficha de «crear» sigue pidiendo guardar primero', async ({ page }) => {
    await openEdit(page, productA.id);
    const before = (await imagesOf(admin, productA.id)).map((i) => i.id);
    const name = `Reloj QA T148 editado ${unique()}`;
    await page.locator('form#product-form [name="name"]').fill(name);
    const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: NAV_TIMEOUT }), page.getByRole('button', { name: 'Guardar cambios', exact: true }).click()]);
    expect(res.status()).toBe(SEE_OTHER);
    expect((await getProduct(admin, productA.id)).name).toBe(name);
    expect((await imagesOf(admin, productA.id)).map((i) => i.id)).toEqual(before);
    await page.goto(`${BASE}/admin/productos/nuevo`);
    await expect(page.getByText('Guarda el producto para añadir imágenes')).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(NONE);
  });
});

// ===================================================================================================================================
test.describe('T-148 · sin JavaScript: los botones y los formularios funcionan con POST', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ javaScriptEnabled: false });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'escribe imágenes: se ejecuta una vez (escritorio)');
    test.setTimeout(TEST_TIMEOUT);
  });
  let product: ApiProduct;
  let initial: ApiImage[];

  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    product = await createProduct(admin, categoryId, PREFIX);
    initial = await uploadMany(admin, product.id, THREE, 'QA sin JS');
  });

  test('«Bajar» y «Subir» reordenan con un POST y la página recargada muestra el nuevo orden', async ({ page }) => {
    await openEdit(page, product.id);
    await expect(rows(page)).toHaveCount(THREE);
    expect(await postVia(page, button(rows(page).nth(NONE), RE_DOWN_BTN))).toBe(SEE_OTHER);
    expect((await imagesOf(admin, product.id)).map((i) => i.id)).toEqual([initial[ONE].id, initial[NONE].id, initial[TWO].id]);
    await expect(rows(page).nth(NONE).getByRole('textbox', { name: RE_ALT_LABEL })).toHaveValue(initial[ONE].alt);
    await expect(rows(page).nth(NONE).getByText('Principal', { exact: true })).toBeVisible();
    expect(await postVia(page, button(rows(page).nth(ONE), RE_UP_BTN))).toBe(SEE_OTHER);
    expect((await imagesOf(admin, product.id)).map((i) => i.id)).toEqual(initial.map((i) => i.id));
  });

  test('sin JavaScript no hay asas ni filas arrastrables, y la subida y el alt funcionan', async ({ page }) => {
    await openEdit(page, product.id);
    await expect(page.locator('[draggable="true"]')).toHaveCount(NONE);
    expect(await uploadFile(page, file('nojs.png', 'image/png', pngBytes()), 'QA subida sin JS')).toBe(SEE_OTHER);
    await expect(rows(page)).toHaveCount(FOUR);
    const field = rows(page).nth(ONE).getByRole('textbox', { name: RE_ALT_LABEL });
    await field.fill('Alt editado sin JS');
    expect(await postVia(page, rows(page).nth(ONE).getByRole('button', { name: RE_SAVE_BTN }))).toBe(SEE_OTHER);
    expect((await imagesOf(admin, product.id))[ONE].alt).toBe('Alt editado sin JS');
  });

  test('sin JavaScript también se puede borrar: el diálogo se abre con el atributo `command` del navegador', async ({ page }) => {
    await openEdit(page, product.id);
    const before = await imagesOf(admin, product.id);
    await button(rows(page).last(), RE_DEL_BTN).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await postVia(page, dialog.getByRole('button', { name: RE_DEL_BTN }))).toBe(SEE_OTHER);
    expect((await imagesOf(admin, product.id)).length).toBe(before.length - ONE);
  });
});

// ===================================================================================================================================
test.describe('T-148 · seguridad de las acciones de imagen (HTTP real)', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'se ejecuta una vez (escritorio)');
    test.setTimeout(TEST_TIMEOUT);
  });
  let product: ApiProduct;
  let images: ApiImage[];
  const url = (): string => `/admin/productos/${product.id}`;
  const deleteBody = (id: string): Record<string, string> => ({ _action: 'image-delete', image_id: id });

  test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    product = await createProduct(admin, categoryId, PREFIX);
    images = await uploadMany(admin, product.id, THREE, 'QA seguridad');
  });

  test('un POST de otro sitio (Origin ajeno) o sin Origin → 403 y la imagen sigue', async ({ request }) => {
    const bodies = [deleteBody(images[NONE].id), { _action: 'image-move', image_id: images[ONE].id, direction: 'up' }];
    await bodies.reduce<Promise<void>>(async (prev, body) => {
      await prev;
      const foreign = await postForm(request, url(), body, { cookie: admin.cookie, origin: EVIL });
      expect(foreign.status(), `${body._action} ajeno`).toBe(FORBIDDEN);
      const missing = await postForm(request, url(), body, { cookie: admin.cookie });
      expect(missing.status(), `${body._action} sin Origin`).toBe(FORBIDDEN);
    }, Promise.resolve());
    expect((await imagesOf(admin, product.id)).map((i) => i.id)).toEqual(images.map((i) => i.id));
  });

  test('una subida multipart con Origin ajeno → 403 sin subir nada', async ({ request }) => {
    const res = await request.post(`${BASE}${url()}`, {
      headers: { cookie: admin.cookie, origin: EVIL },
      multipart: { _action: 'image-upload', alt: 'ataque', file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from(pngBytes()) } },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(FORBIDDEN);
    expect((await imagesOf(admin, product.id)).length).toBe(images.length);
  });

  test('un cuerpo que no es formulario (JSON, texto) → 415 con no-store', async ({ request }) => {
    const kinds: [string, string][] = [['application/json', '{"_action":"image-delete"}'], ['text/plain', '_action=image-delete']];
    await kinds.reduce<Promise<void>>(async (prev, [type, data]) => {
      await prev;
      const res = await request.post(`${BASE}${url()}`, { headers: asAdmin({ 'content-type': type }), data, maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), type).toBe(UNSUPPORTED);
      expect(res.headers()['cache-control']).toBe(NO_STORE);
    }, Promise.resolve());
    expect((await imagesOf(admin, product.id)).length).toBe(images.length);
  });

  test('un cuerpo de más de 6 MiB se rechaza con 413 antes de procesarlo', async ({ request }) => {
    const res = await request.post(`${BASE}${url()}`, {
      headers: asAdmin({ 'content-type': 'application/octet-stream' }),
      data: Buffer.alloc(SIX_MIB + ONE),
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(TOO_LARGE);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
  });

  test('un id de producto o de imagen que no es UUID → 404 o 4xx, nunca 500', async ({ request }) => {
    const badProduct = await postForm(request, '/admin/productos/no-es-uuid', deleteBody(images[NONE].id), asAdmin());
    expect(badProduct.status()).toBe(NOT_FOUND);
    const badImage = await postForm(request, url(), deleteBody('../order'), asAdmin());
    expect(badImage.status()).toBeGreaterThanOrEqual(BAD_REQUEST);
    expect(badImage.status()).toBeLessThan(SERVER_ERROR);
    expect((await imagesOf(admin, product.id)).length).toBe(images.length);
  });

  test('una imagen de OTRO producto no se puede borrar ni describir por la URL de este (404) y la otra sigue intacta', async ({ request }) => {
    const del = await postForm(request, url(), deleteBody(imageOfB.id), asAdmin());
    expect(del.status()).toBe(NOT_FOUND);
    const alt = await postForm(request, url(), { _action: 'image-alt', image_id: imageOfB.id, alt: 'robada' }, asAdmin());
    expect(alt.status()).toBe(NOT_FOUND);
    const foreign = await imagesOf(admin, productB.id);
    expect(foreign.map((i) => i.id)).toEqual([imageOfB.id]);
    expect(foreign[NONE].alt).toBe('QA ajena 1');
    expect(await urlStatus(imageOfB.url)).toBe(OK);
  });

  test('el orden con ids de otro producto o incompletos no se aplica (4xx) y el orden queda igual', async ({ request }) => {
    const before = (await imagesOf(admin, product.id)).map((i) => i.id);
    const sets = [[...before.slice(NONE, TWO), imageOfB.id], before.slice(NONE, TWO), [...before, imageOfB.id], [before[NONE], before[NONE], before[ONE]]];
    await sets.reduce<Promise<void>>(async (prev, ids) => {
      await prev;
      const res = await postForm(request, url(), { _action: 'image-order', ids: ids.join(',') }, asAdmin());
      expect(res.status(), ids.join(',')).toBeGreaterThanOrEqual(BAD_REQUEST);
      expect(res.status(), ids.join(',')).toBeLessThan(SERVER_ERROR);
    }, Promise.resolve());
    expect((await imagesOf(admin, product.id)).map((i) => i.id)).toEqual(before);
  });

  test('sin sesión → 302 al ingreso; un cliente (customer) → 403; ninguno cambia nada', async ({ request }) => {
    const anon = await postForm(request, url(), deleteBody(images[NONE].id), { origin: BASE });
    expect(anon.status()).toBe(FOUND);
    expect(anon.headers().location ?? '').toContain('/ingresar');
    const anonGet = await get(request, url());
    expect(anonGet.status()).toBe(FOUND);
    const cust = await postForm(request, url(), deleteBody(images[NONE].id), { cookie: customer.cookie, origin: BASE });
    expect(cust.status()).toBe(FORBIDDEN);
    const custGet = await get(request, url(), customer.cookie);
    expect(custGet.status()).toBe(FORBIDDEN);
    expect(await custGet.text()).not.toContain(images[NONE].url);
    expect((await imagesOf(admin, product.id)).length).toBe(images.length);
  });

  test('una acción que no existe (image-hack) o ninguna → 400; el 303 de las que sí existen lleva no-store y apunta a la misma página', async ({ request }) => {
    const unknown = await postForm(request, url(), { _action: 'image-hack', image_id: images[NONE].id }, asAdmin());
    expect(unknown.status()).toBe(BAD_REQUEST);
    const none = await postForm(request, url(), { image_id: images[NONE].id }, asAdmin());
    expect(none.status()).toBe(BAD_REQUEST);
    const ok = await postForm(request, url(), { _action: 'image-alt', image_id: images[TWO].id, alt: 'QA 303 no-store' }, asAdmin());
    expect(ok.status()).toBe(SEE_OTHER);
    expect(ok.headers()['cache-control']).toBe(NO_STORE);
    expect(new URL(ok.headers().location ?? '', BASE).pathname).toBe(url());
    expect(new URL(ok.headers().location ?? '', BASE).origin).toBe(BASE);
  });

  test('el cuerpo recibido no se refleja: nada del formulario hostil sale en la respuesta', async ({ request }) => {
    const res = await postForm(request, url(), { _action: 'image-alt', image_id: 'x', alt: '<script>window.__pwned=1</script>', secreto: 'valor-QX' }, asAdmin());
    const body = await res.text();
    expect(body).not.toContain('<script>window.__pwned');
    expect(body).not.toContain('valor-QX');
  });
});

// ===================================================================================================================================
// Fuera de las secuencias en serie: un fallo aquí no debe ocultar el resto de las comprobaciones de T-148.
test.describe('T-148 · anuncio de errores (RT-B10)', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop', 'se ejecuta una vez (escritorio)');
    test.setTimeout(TEST_TIMEOUT);
  });

  test('el error de la subida se anuncia: un resumen role="alert" y el foco en el aviso o en el campo con error (RT-B10)', async ({ page }) => {
    await openEdit(page, productB.id);
    await uploadFile(page, file('animacion.gif', 'image/gif', gifBytes()), 'QA aviso');
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    const focusOk = await page.evaluate(() => {
      const a = document.activeElement;
      return !!a && (a.closest('[role="alert"]') !== null || a.getAttribute('aria-invalid') === 'true');
    });
    expect(focusOk).toBe(true);
  });

  test('tras un error del archivo el texto alternativo tecleado sigue en su campo (criterio «no pierde lo escrito»)', async ({ page }) => {
    await openEdit(page, productB.id);
    await uploadFile(page, file('animacion.gif', 'image/gif', gifBytes()), 'QA conservar lo escrito');
    await expect(uploadForm(page).getByRole('textbox')).toHaveValue('QA conservar lo escrito');
  });

  test('el resumen de error enlaza al campo con error y el enlace lleva el foco a él', async ({ page }) => {
    await openEdit(page, productB.id);
    await uploadFile(page, file('animacion.gif', 'image/gif', gifBytes()), 'QA enlace');
    const link = page.locator('#imagenes-errores a').first();
    await expect(link).toBeVisible();
    const target = (await link.getAttribute('href')) ?? '';
    await expect(page.locator(target)).toHaveAttribute('aria-invalid', 'true');
    await link.click();
    await expect(page.locator(target)).toBeFocused();
  });
});
