import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { MIN_TEXT_CONTRAST, openPage, sequence, textContrast } from './helpers/ui-a';

// T-122 · E2E de /nosotros, /privacidad y /terminos (STATUS "T-122 › Pruebas obligatorias"): estáticas, sin API, accesibles
// a 360, 375, 800 y 1280, sin desbordamiento y con consola limpia. Se localiza por rol y nombre, no por clases.
const SLOW = 180_000;
const NAV_MS = 15_000;
const NONE = 0;
const ONE = 1;
const OK = 200;
const MIN_CONTRAST_ITEMS = 9; // 3 dt + 3 dd + 3 enlaces
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 800;
const TOLERANCE = 1; // px
const MIN_BLOCK_HEIGHT = 240; // px, RT-1 del paquete: bloques de color con altura mínima
const DEMO = 'Contenido de demostración';
const CONTACT_PATH = '/nosotros';
const CONTACT_HASH = '#contacto';
const ROUTES = [
  { path: '/nosotros', h1: 'Valmont', legal: false },
  { path: '/privacidad', h1: 'Política de privacidad', legal: true },
  { path: '/terminos', h1: 'Términos y condiciones', legal: true },
];
// Petición a la API o a Supabase: "/api/v1/catalog/products" y ":54321" casan; "/_astro/x.css" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5C%2Fapi%5C%2F%7C%3A8000%7C%3A54321&flags=
const API_CALL = /\/api\/|:8000|:54321/;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const overflowX = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const openAt = async (page: Page, path: string, width: number): Promise<void> => {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, path);
};
/** Enlace "Contacto" de la cabecera; en pantallas estrechas vive en el menú desplegable. */
async function headerContact(page: Page): Promise<Locator> {
  const header = page.locator('header').first();
  const link = header.getByRole('link', { name: 'Contacto', exact: true }).first();
  if (!(await link.isVisible())) await header.locator('button[popovertarget]:visible').first().click();
  return link;
}

ROUTES.forEach(({ path, h1, legal }) => {
  test.describe(`${path} (estática)`, () => {
    test.describe.configure({ timeout: SLOW });

    test('responde 200 con un solo h1, main#contenido y consola limpia, sin peticiones a la API ni a terceros', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const external = collectExternalRequests(page);
      const api: string[] = [];
      page.on('request', (r) => API_CALL.test(r.url()) && api.push(r.url()));
      const res = await page.goto(path);
      expect(res?.status()).toBe(OK);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
      await expect(page.locator('main h1')).toContainText(h1, { ignoreCase: true });
      await expect(page.locator('main#contenido')).toHaveCount(ONE);
      expect(errors).toEqual([]);
      expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
      expect(api, `peticiones a la API: ${api.join(', ')}`).toEqual([]);
    });

    test('es estática: no emite Set-Cookie', async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.headers()['set-cookie']).toBeUndefined();
    });

    test('cada bloque de demostración muestra visible la etiqueta "Contenido de demostración"', async ({ page }) => {
      await openPage(page, path);
      const blocks = page.locator('[data-demo-content]');
      const n = await blocks.count();
      expect(n).toBeGreaterThanOrEqual(ONE);
      await sequence(range(n), async (i) => {
        await expect(blocks.nth(i).getByText(DEMO, { exact: true }).first()).toBeVisible();
      });
    });

    WIDTHS.forEach((width) => {
      test(`a ${width}px: axe sin violaciones (WCAG 2.2 AA) y sin desbordamiento horizontal`, async ({ page }) => {
        await openAt(page, path, width);
        await expectNoA11yViolations(page);
        expect(await overflowX(page)).toBeLessThanOrEqual(TOLERANCE);
      });
    });

    if (legal) {
      test('muestra el aviso de texto no definitivo y la fecha de última actualización', async ({ page }) => {
        await openPage(page, path);
        await expect(page.getByRole('status').filter({ hasText: 'definitivo' })).toBeVisible();
        await expect(page.getByText('Última actualización')).toBeVisible();
      });
    }
  });
});

test.describe('/nosotros · contacto', () => {
  test.describe.configure({ timeout: SLOW });

  test('el bloque #contacto muestra teléfono, correo y red con enlaces tel:, mailto: y externo, y el mismo teléfono que el pie (H-22)', async ({ page }) => {
    await openPage(page, CONTACT_PATH);
    const block = page.locator('main #contacto');
    await expect(block).toHaveCount(ONE);
    const tel = block.locator('a[href^="tel:"]');
    await expect(tel).toHaveCount(ONE);
    await expect(block.locator('a[href^="mailto:"]')).toHaveCount(ONE);
    const external = block.locator('a[target="_blank"]');
    await expect(external).toHaveCount(ONE);
    expect(await external.getAttribute('rel')).toContain('noopener');
    const footerTel = page.locator('footer a[href^="tel:"]');
    expect(await tel.textContent()).toBe(await footerTel.textContent());
    expect(await tel.getAttribute('href')).toBe(await footerTel.getAttribute('href'));
  });

  test('el dl del contacto sobre forest cumple el contraste de texto (>= 4,5:1) en dt, dd y enlaces', async ({ page }) => {
    await openPage(page, CONTACT_PATH);
    const items = page.locator('main #contacto dl').locator('dt, dd, a');
    const n = await items.count();
    expect(n).toBeGreaterThanOrEqual(MIN_CONTRAST_ITEMS);
    const ratios = await sequence(range(n), async (i) => (await textContrast(items.nth(i))).ratio);
    expect(ratios.filter((r) => r < MIN_TEXT_CONTRAST)).toEqual([]);
  });

  test('el bloque de imagen del contacto conserva su altura mínima a 375', async ({ page }) => {
    await openAt(page, CONTACT_PATH, WIDTH_PHONE);
    const height = await page.locator('main #contacto').evaluate((el) => el.firstElementChild!.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(MIN_BLOCK_HEIGHT - TOLERANCE);
  });

  WIDTHS.forEach((width) => {
    test(`a ${width}px el enlace "Contacto" de la cabecera lleva a /nosotros#contacto y deja el bloque a la vista`, async ({ page }) => {
      await openAt(page, '/privacidad', width);
      await (await headerContact(page)).click();
      await expect(page).toHaveURL((u) => u.pathname === CONTACT_PATH && u.hash === CONTACT_HASH, { timeout: NAV_MS });
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('#contacto')).toBeInViewport();
      await expect(page.locator('#contacto h2')).toBeVisible();
    });
  });

  test('el enlace "Contacto" del pie también apunta al bloque', async ({ page }) => {
    await openPage(page, '/terminos');
    await page.locator('footer').getByRole('link', { name: 'Contacto', exact: true }).click();
    await expect(page).toHaveURL((u) => u.pathname === CONTACT_PATH && u.hash === CONTACT_HASH, { timeout: NAV_MS });
    await expect(page.locator('#contacto')).toBeInViewport();
  });
});

test.describe('pie · enlaces legales', () => {
  test.describe.configure({ timeout: SLOW });

  [
    { name: 'Privacidad', url: '/privacidad' },
    { name: 'Términos', url: '/terminos' },
  ].forEach(({ name, url }) => {
    test(`el enlace "${name}" del pie lleva a ${url} (no un 404)`, async ({ page }) => {
      await openPage(page, CONTACT_PATH);
      await page.locator('footer').getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL((u) => u.pathname === url, { timeout: NAV_MS });
      expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
      await expect(page.locator('main h1')).not.toContainText('404');
    });
  });

  test('el contenido de /privacidad cubre Ley 29733, fecha de nacimiento, 4 últimos dígitos, httpOnly, ARCO y la versión', async ({ page }) => {
    await openPage(page, '/privacidad');
    const main = page.locator('main');
    await expect(main).toContainText('29733');
    await expect(main).toContainText('fecha de nacimiento', { ignoreCase: true });
    await expect(main).toContainText('4 dígitos');
    await expect(main).toContainText('httpOnly');
    await expect(main).toContainText('ARCO');
    await expect(main).toContainText('Versión 2026-10');
    expect(await main.locator('script').count()).toBe(NONE);
  });
});
