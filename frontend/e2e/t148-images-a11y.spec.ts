import { expect, test, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { gifBytes } from '../tests/helpers/t148-files';
import { RE_DEL_BTN, RE_DOWN_BTN, RE_FOCUS_YELLOW, RE_UP_BTN } from '../tests/helpers/t148-re';
import { browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { activeCategories, api, cleanup, createProduct, newRunPrefix, seenUrls, uploadMany, type ApiImage, type ApiProduct } from './helpers/t148';

// T-148 · accesibilidad (axe, WCAG 2.2 AA), teclado, tamaños táctiles, responsive y movimiento reducido de la sección de imágenes, con un administrador real.
// Corre en escritorio (1280 y 1440) y en móvil (375). Crea SOLO un producto `QA-T148-*` con tres imágenes generadas por la suite y lo borra al terminar.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 240_000;
const TEST_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 60_000;
const OK = 200;
const UNSUPPORTED = 415;
const NONE = 0;
const ONE = 1;
const THREE = 3;
const W_DESKTOP = 1280;
const W_WIDE = 1440;
const W_MOBILE = 375;
const W_SMALL = 360;
const HEIGHT = 900;
const FOCUS_WIDTH = 2;
const BUTTON_MIN = 40;
const CONTROL_MIN = 44;
const TOLERANCE = 0.5;
const THUMB = 56;
const MAX_TABS = 40;
const DIALOG_TABS = 10;
const MS_PER_S = 1000;
const ALT_MAX = 150;
const REDUCED_MAX_S = 0.001;
const PREFIX = newRunPrefix();

let env: LiveEnv;
let admin: QaUser;
let product: ApiProduct;
let images: ApiImage[];

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't148x', 'admin');
  product = await createProduct(admin, (await activeCategories(admin))[NONE].id, PREFIX);
  images = await uploadMany(admin, product.id, THREE, 'QA accesibilidad');
});

test.afterAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const left = admin ? await cleanup(admin, PREFIX) : NONE;
  await deleteQaUser(env, admin);
  console.warn(`T-148 a11y limpieza: ${left} producto(s) ${PREFIX}* sin borrar (${seenUrls.size} imágenes vistas)`);
});

const widthsFor = (project: string): number[] => (project === 'mobile' ? [W_SMALL, W_MOBILE] : [W_DESKTOP, W_WIDE]);
const region = (page: Page): Locator => page.getByRole('region', { name: 'Imágenes' });
const rows = (page: Page): Locator => region(page).locator('ol > li');
const uploadForm = (page: Page): Locator => region(page).locator('form:has(input[type="file"])');
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const isPost = (r: { request: () => { method: () => string } }): boolean => r.request().method() === 'POST';

async function openEdit(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.context().addCookies(browserCookies(admin.cookies));
  const res = await page.goto(`${BASE}/admin/productos/${product.id}`);
  expect(res?.status()).toBe(OK);
  await expect(region(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(images.length);
}

const sizes = async (loc: Locator): Promise<{ w: number; h: number }[]> =>
  loc.evaluateAll((els) => els.map((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));

/** Cada cuadro de los controles cae dentro del ancho de la pantalla. */
async function insideViewport(page: Page, loc: Locator): Promise<boolean> {
  const width = page.viewportSize()?.width ?? W_DESKTOP;
  return loc.evaluateAll((els, w) => els.every((e) => e.getBoundingClientRect().left >= -1 && e.getBoundingClientRect().right <= w + 1), width);
}

test.describe('T-148 · accesibilidad y responsive de las imágenes', () => {
  test.beforeEach(() => {
    test.setTimeout(TEST_TIMEOUT);
  });

  test('axe: la edición con imágenes no tiene violaciones WCAG 2.2 AA y no desborda en ningún ancho', async ({ page }, info) => {
    await widthsFor(info.project.name).reduce<Promise<void>>(async (prev, width) => {
      await prev;
      await openEdit(page, width);
      await expectNoA11yViolations(page);
      expect(await overflow(page), `desborde a ${width}`).toBeLessThanOrEqual(ONE);
    }, Promise.resolve());
  });

  test('axe: con el error de una subida (415) y su aviso', async ({ page }, info) => {
    await widthsFor(info.project.name).reduce<Promise<void>>(async (prev, width) => {
      await prev;
      await openEdit(page, width);
      const form = uploadForm(page);
      await form.locator('input[type="file"]').setInputFiles({ name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from(gifBytes()) });
      await form.getByRole('textbox').fill('QA accesibilidad error');
      const [res] = await Promise.all([page.waitForResponse(isPost, { timeout: UPLOAD_TIMEOUT }), form.getByRole('button', { name: RE_UP_BTN }).click()]);
      expect(res.status()).toBe(UNSUPPORTED);
      await expectNoA11yViolations(page);
      expect(await overflow(page)).toBeLessThanOrEqual(ONE);
    }, Promise.resolve());
  });

  test('axe: con el diálogo de confirmar el borrado abierto', async ({ page }, info) => {
    await widthsFor(info.project.name).reduce<Promise<void>>(async (prev, width) => {
      await prev;
      await openEdit(page, width);
      await rows(page).first().getByRole('button', { name: RE_DEL_BTN }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoA11yViolations(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
    }, Promise.resolve());
  });

  test('los botones de cada fila y la subida caben en la pantalla, no se solapan y tienen tamaño táctil (≥ 40 px los botones, ≥ 44 px los campos)', async ({ page }, info) => {
    await widthsFor(info.project.name).reduce<Promise<void>>(async (prev, width) => {
      await prev;
      await openEdit(page, width);
      const buttons = region(page).getByRole('button');
      expect(await insideViewport(page, buttons), `botones dentro de ${width} px`).toBe(true);
      expect(await insideViewport(page, region(page).locator('input')), `campos dentro de ${width} px`).toBe(true);
      (await sizes(buttons)).forEach((s) => {
        expect(s.h).toBeGreaterThanOrEqual(BUTTON_MIN - TOLERANCE);
        expect(s.w).toBeGreaterThanOrEqual(BUTTON_MIN - TOLERANCE);
      });
      (await sizes(region(page).locator('input[type="text"]'))).forEach((s) => expect(s.h).toBeGreaterThanOrEqual(CONTROL_MIN - TOLERANCE));
      // Los tres botones de una fila no se tapan entre sí.
      const boxes = await rows(page).first().getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      boxes.forEach((a, i) =>
        boxes.slice(i + ONE).forEach((b) => {
          const apart = a.right <= b.left + ONE || b.right <= a.left + ONE || a.bottom <= b.top + ONE || b.bottom <= a.top + ONE;
          expect(apart, `solape entre botones a ${width} px`).toBe(true);
        }),
      );
    }, Promise.resolve());
  });

  test('las miniaturas miden 56 px (VIEWS §12.2) y cargan', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'la miniatura se mide en escritorio');
    await openEdit(page, W_DESKTOP);
    const thumbs = rows(page).locator('img');
    (await sizes(thumbs)).forEach((s) => {
      expect(Math.round(s.w)).toBe(THUMB);
      expect(Math.round(s.h)).toBe(THUMB);
    });
    expect(await thumbs.evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0))).toBe(true);
  });

  test('teclado: Tab recorre texto alternativo, «Subir», «Bajar», «Eliminar» y la subida con foco amarillo de 2 px', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'el foco se mide en escritorio');
    await openEdit(page, W_DESKTOP);
    await rows(page).first().getByRole('textbox').focus();
    const seen: { label: string; color: string; width: number; style: string }[] = [];
    await Array.from({ length: MAX_TABS }).reduce<Promise<void>>(async (prev) => {
      await prev;
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          const s = getComputedStyle(el);
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('type') ?? el.tagName).trim().toLowerCase();
          return { label, color: s.outlineColor, width: parseFloat(s.outlineWidth), style: s.outlineStyle };
        }),
      );
      await page.keyboard.press('Tab');
    }, Promise.resolve());
    const words = ['subir', 'bajar', 'eliminar'];
    words.forEach((w) => expect(seen.some((s) => s.label.startsWith(w)), `Tab no llega a «${w}»`).toBe(true));
    seen
      .filter((s) => words.some((w) => s.label.startsWith(w)))
      .forEach((s) => {
        expect(s.style, s.label).not.toBe('none');
        expect(s.width, s.label).toBeGreaterThanOrEqual(FOCUS_WIDTH);
        expect(RE_FOCUS_YELLOW.test(s.color), `${s.label}: ${s.color}`).toBe(true);
      });
  });

  test('el campo de archivo y el texto alternativo de la subida también muestran el foco amarillo', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'el foco se mide en escritorio');
    await openEdit(page, W_DESKTOP);
    const targets = [uploadForm(page).locator('input[type="file"]'), uploadForm(page).getByRole('textbox')];
    await targets.reduce<Promise<void>>(async (prev, loc) => {
      await prev;
      await page.keyboard.press('Tab'); // el último gesto es de teclado: :focus-visible aplica
      await loc.focus();
      const s = await loc.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.outlineColor, width: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
      });
      expect(s.style).not.toBe('none');
      expect(s.width).toBeGreaterThanOrEqual(FOCUS_WIDTH);
      expect(RE_FOCUS_YELLOW.test(s.color), s.color).toBe(true);
    }, Promise.resolve());
  });

  test('prefers-reduced-motion: ningún elemento de la sección anima ni hace transiciones', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openEdit(page, widthsFor(info.project.name)[NONE]);
    const longest = await region(page).evaluate((root, msPerS) => {
      const secs = (v: string): number => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / msPerS : parseFloat(x))), 0);
      return [...root.querySelectorAll('*'), root].map((e) => {
        const s = getComputedStyle(e);
        return Math.max(secs(s.transitionDuration), secs(s.animationDuration));
      });
    }, MS_PER_S);
    longest.forEach((d) => expect(d).toBeLessThanOrEqual(REDUCED_MAX_S));
  });

  test('un texto alternativo de 150 caracteres sin espacios no desborda la pantalla', async ({ page }, info) => {
    const long = 'a'.repeat(ALT_MAX);
    expect((await api(admin, 'PATCH', `/catalog/admin/products/${product.id}/images/${images[NONE].id}`, { alt: long })).status).toBe(OK);
    await widthsFor(info.project.name).reduce<Promise<void>>(async (prev, width) => {
      await prev;
      await openEdit(page, width);
      expect(await overflow(page), `desborde a ${width}`).toBeLessThanOrEqual(ONE);
      expect(await insideViewport(page, region(page).locator('input')), `campos dentro de ${width} px`).toBe(true);
    }, Promise.resolve());
    expect((await api(admin, 'PATCH', `/catalog/admin/products/${product.id}/images/${images[NONE].id}`, { alt: images[NONE].alt })).status).toBe(OK);
  });

  test('el foco del diálogo queda dentro de él y Esc devuelve el foco al botón que lo abrió', async ({ page }, info) => {
    await openEdit(page, widthsFor(info.project.name)[NONE]);
    const trigger = rows(page).nth(ONE).getByRole('button', { name: RE_DEL_BTN });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
    // Tras el último control el foco sale a la interfaz del navegador (activeElement = body), pero nunca llega a un elemento del fondo.
    await Array.from({ length: DIALOG_TABS }).reduce<Promise<void>>(async (prev) => {
      await prev;
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.closest('dialog') !== null)).toBe(true);
    }, Promise.resolve());
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(RE_DOWN_BTN.test('Bajar imagen 1')).toBe(true);
  });
});
