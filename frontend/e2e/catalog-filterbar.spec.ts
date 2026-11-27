import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { openFilters } from './helpers/page';
import { sequence } from './helpers/ui-a';
import { startSite, startStub, type Site, type Stub } from './helpers/stub-site';

// T-134 (D-05, D-11 de REVIEW-2026-11-27) · la barra de filtros de /relojes: plegable nativo (<details>, sin JavaScript,
// D-014) en < 800 px y barra desplegada y alineada en escritorio. Se prueba el servidor de PRODUCCIÓN de Astro (`dist/`,
// requiere `npm run build`) contra la API simulada de T-124: no hay base de datos ni backend real.
test.describe.configure({ mode: 'default' });

const PATH = '/relojes';
const NONE = 0;
const ONE = 1;
const BASE_PORT = 4341;
const PORT_OFFSET: Record<string, number> = { desktop: NONE, mobile: ONE };
const HEIGHT = 800;
const W_SMALL = 360;
const W_PHONE = 375;
const W_BREAKPOINT = 800;
const W_BELOW_BREAKPOINT = 799;
const W_DESKTOP = 1280;
const TOUCH = 44;
const ROW_TOLERANCE = 2;
const TAB_LIMIT = 80;
// Revisión visual: a 375 px el primer reloj aparecía tras ≈ 1400 px. El plegado lo deja a ≈ 790 px medidos (abierto: ≈ 1390); el umbral es
// un valor intermedio que no se alcanza sin plegar y deja margen a fuentes y cabecera.
const FIRST_CARD_MAX_TOP = 1000;
const MIN_SAVING = 300;

let stub: Stub;
let site: Site;

test.beforeAll(async ({}, info) => {
  stub = await startStub();
  site = await startSite(BASE_PORT + (PORT_OFFSET[info.project.name] ?? NONE), stub.url);
});
test.afterAll(async () => {
  site?.stop();
  await stub?.close();
});
test.beforeEach(() => {
  stub.setMode('ok');
  stub.hits.length = NONE;
});

const details = (page: Page) => page.locator('details:has(form)').first();
const summary = (page: Page) => details(page).locator('summary').first();
const isOpen = (page: Page): Promise<boolean> => details(page).evaluate((d) => (d as HTMLDetailsElement).open);
const category = (page: Page) => page.getByLabel('Colección', { exact: true });
const firstCardTop = (page: Page): Promise<number> =>
  page.locator('main article').first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
const visit = async (page: Page, width: number, path = PATH): Promise<void> => {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`${site.url}${path}`);
};
/** Lleva el foco con Tab hasta el resumen, como lo haría una persona con teclado. */
async function tabToSummary(page: Page, left = TAB_LIMIT): Promise<void> {
  if (left <= NONE) throw new Error('Tab no llegó al resumen de filtros');
  await page.keyboard.press('Tab');
  if (!(await page.evaluate(() => document.activeElement?.tagName === 'SUMMARY'))) await tabToSummary(page, left - ONE);
}

test.describe('375 px sin filtros activos: plegable cerrado', () => {
  test('el details nace cerrado y los controles no se ven; el resumen sí', async ({ page }) => {
    await visit(page, W_PHONE);
    expect(await isOpen(page)).toBe(false);
    await expect(summary(page)).toBeVisible();
    await expect(summary(page)).toContainText('Filtros');
    await expect(summary(page)).not.toContainText('activo');
    await expect(category(page)).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar' })).not.toBeVisible();
  });

  test('el primer reloj aparece mucho antes que los ≈ 1400 px de la revisión, y abrir el plegable lo empuja hacia abajo', async ({ page }) => {
    await visit(page, W_PHONE);
    const closed = await firstCardTop(page);
    expect(closed).toBeLessThan(FIRST_CARD_MAX_TOP);
    await summary(page).click();
    await expect(category(page)).toBeVisible();
    expect(await firstCardTop(page)).toBeGreaterThan(closed + MIN_SAVING);
  });

  test('el resumen mide al menos 44 px de alto y de ancho', async ({ page }) => {
    await visit(page, W_PHONE);
    const box = await summary(page).boundingBox();
    expect(box?.height ?? NONE).toBeGreaterThanOrEqual(TOUCH);
    expect(box?.width ?? NONE).toBeGreaterThanOrEqual(TOUCH);
  });

  test('con Tab el resumen recibe un foco visible (contorno real)', async ({ page }) => {
    await visit(page, W_PHONE);
    await tabToSummary(page);
    const ring = await summary(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThan(NONE);
  });

  ['Enter', 'Space'].forEach((key) => {
    test(`con el teclado (${key}) el resumen abre y cierra el plegable`, async ({ page }) => {
      await visit(page, W_PHONE);
      await tabToSummary(page);
      await page.keyboard.press(key);
      expect(await isOpen(page)).toBe(true);
      await expect(category(page)).toBeVisible();
      await page.keyboard.press(key);
      expect(await isOpen(page)).toBe(false);
      await expect(category(page)).not.toBeVisible();
    });
  });

  test('abierto, "Limpiar filtros" mide 44 px de alto y los precios van en dos columnas', async ({ page }) => {
    await visit(page, W_PHONE);
    await summary(page).click();
    const clear = await page.locator('form').getByRole('link', { name: 'Limpiar filtros' }).boundingBox();
    expect(clear?.height ?? NONE).toBeGreaterThanOrEqual(TOUCH);
    const min = await page.getByLabel('Precio desde (S/)', { exact: true }).boundingBox();
    const max = await page.getByLabel('Precio hasta (S/)', { exact: true }).boundingBox();
    expect(Math.abs((min?.y ?? NONE) - (max?.y ?? HEIGHT)), 'precios en la misma fila').toBeLessThanOrEqual(ROW_TOLERANCE);
    expect((max?.x ?? NONE) > (min?.x ?? HEIGHT)).toBe(true);
  });

  test('los controles abiertos no desbordan el ancho a 360 y 375 px', async ({ page }) => {
    await sequence([W_SMALL, W_PHONE], async (width) => {
      await visit(page, width);
      await summary(page).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px`).toBeLessThanOrEqual(NONE);
    });
  });
});

test.describe('sin JavaScript', () => {
  test.use({ javaScriptEnabled: false, viewport: { width: W_PHONE, height: HEIGHT } });

  test('abrir el details con el ratón y aplicar filtros funciona con un GET completo', async ({ page }) => {
    await page.goto(`${site.url}${PATH}`);
    expect(await isOpen(page)).toBe(false);
    await summary(page).click();
    expect(await isOpen(page)).toBe(true);
    await category(page).selectOption('cat-a');
    await page.getByLabel('Solo disponibles', { exact: true }).check();
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'cat-a'), page.getByRole('button', { name: 'Aplicar' }).click()]);
    expect(new URL(page.url()).searchParams.get('available')).toBe('1');
    // Con filtros activos el servidor lo entrega abierto: no hace falta JavaScript para verlo.
    expect(await isOpen(page)).toBe(true);
    await expect(category(page)).toHaveValue('cat-a');
  });

  test('con el teclado (Enter) también abre sin JavaScript', async ({ page }) => {
    await page.goto(`${site.url}${PATH}`);
    await tabToSummary(page);
    await page.keyboard.press('Enter');
    expect(await isOpen(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Aplicar' })).toBeVisible();
  });
});

// Casos en los que el servidor entrega el plegable abierto. `count` es el texto esperado del recuento (null: sin recuento).
const AUTO_OPEN: { name: string; path: string; mode?: 'validation'; count: string | null }[] = [
  { name: 'filtros activos (colección + disponibles)', path: '?category=cat-a&available=1', count: '2 activos' },
  { name: 'un solo filtro activo (singular)', path: '?movement=automatic', count: '1 activo' },
  { name: 'tres filtros activos (material + rango de precio)', path: '?case_material=steel&price_min=100&price_max=900', count: '3 activos' },
  { name: 'solo el orden cambiado (un control activo oculto no puede quedar plegado)', path: '?sort=price_desc', count: null },
  { name: 'rango de precio invertido', path: '?price_min=9000&price_max=100', count: '2 activos' },
  { name: 'valores inválidos y uno válido', path: '?category=cat-a&price_min=-1&sort=hacked', count: '1 activo' },
  { name: 'valores inválidos sin ningún filtro válido', path: '?category=Mal%20Slug&available=quizas', count: null },
  { name: 'página inválida', path: '?page=abc', count: null },
  { name: 'respuesta 422 de la API (con búsqueda)', path: '?q=algo', mode: 'validation', count: null },
  { name: 'respuesta 422 de la API y un filtro activo', path: '?q=algo&movement=automatic', mode: 'validation', count: '1 activo' },
];

test.describe('apertura automática a 375 px', () => {
  AUTO_OPEN.forEach((c) => {
    test(`abierto por el servidor: ${c.name}`, async ({ page }) => {
      if (c.mode) stub.setMode(c.mode);
      await visit(page, W_PHONE, `${PATH}${c.path}`);
      expect(await isOpen(page)).toBe(true);
      await expect(category(page)).toBeVisible();
      // Acepta "Filtros · 2 activos" (separador cualquiera) y rechaza "Filtros 3 activos" cuando se esperaba 2.
      // Prueba: https://regex101.com/?regex=%5E%5Cs*Filtros%5CW*2%20activos%5Cs*%24
      if (c.count) await expect(summary(page)).toHaveText(new RegExp(`^\\s*Filtros\\W*${c.count}\\s*$`));
      else if (!c.path.includes('sort=price_desc')) {
        await expect(summary(page)).toContainText('Filtros');
        await expect(summary(page)).not.toContainText('activo');
      }
    });
  });

  test('la búsqueda sola (q) o la paginación sola NO cuentan como filtros: sigue cerrado', async ({ page }) => {
    await visit(page, W_PHONE, `${PATH}?q=reloj`);
    expect(await isOpen(page)).toBe(false);
    await expect(summary(page)).not.toContainText('activo');
    await visit(page, W_PHONE, `${PATH}?page=2`);
    expect(await isOpen(page)).toBe(false);
  });

  test('un fallo 5xx de la API no abre el plegable (no hay filtros que corregir)', async ({ page }) => {
    stub.setMode('server-error');
    await visit(page, W_PHONE);
    expect(await isOpen(page)).toBe(false);
  });

  test('con filtros activos el formulario conserva sus valores y hay un chip por filtro', async ({ page }) => {
    await visit(page, W_PHONE, `${PATH}?category=cat-a&available=1`);
    await expect(category(page)).toHaveValue('cat-a');
    await expect(page.getByLabel('Solo disponibles', { exact: true })).toBeChecked();
    await expect(page.getByRole('link', { name: 'Quitar filtro Colección Alfa' })).toBeVisible();
  });
});

test.describe('1280 px: barra desplegada y alineada', () => {
  test('sin filtros activos la barra se ve completa y el resumen no se muestra', async ({ page }) => {
    await visit(page, W_DESKTOP);
    await expect(summary(page)).toBeHidden();
    const labels = ['Colección', 'Movimiento', 'Material de caja', 'Precio desde (S/)', 'Precio hasta (S/)', 'Ordenar por', 'Solo disponibles'];
    await Promise.all(labels.map((label) => expect(page.getByLabel(label, { exact: true }), label).toBeVisible()));
    await expect(page.getByRole('button', { name: 'Aplicar' })).toBeVisible();
    await expect(page.locator('form').getByRole('link', { name: 'Limpiar filtros' })).toBeVisible();
  });

  test('"Solo disponibles", "Aplicar" y "Limpiar filtros" van en la misma fila', async ({ page }) => {
    await visit(page, W_DESKTOP);
    const check = await page.locator('label', { hasText: 'Solo disponibles' }).boundingBox();
    const apply = await page.getByRole('button', { name: 'Aplicar' }).boundingBox();
    const clear = await page.locator('form').getByRole('link', { name: 'Limpiar filtros' }).boundingBox();
    const tops = [check, apply, clear].map((b) => b?.y ?? Number.NaN);
    tops.forEach((t) => expect(Math.abs(t - tops[NONE]), `tops ${tops.join(', ')}`).toBeLessThanOrEqual(ROW_TOLERANCE));
    // y en orden de lectura de izquierda a derecha, sin solaparse
    expect((check?.x ?? NONE) < (apply?.x ?? NONE) && (apply?.x ?? NONE) < (clear?.x ?? NONE)).toBe(true);
    expect(clear?.height ?? NONE).toBeGreaterThanOrEqual(TOUCH);
  });

  test('los selects de colección, movimiento y material comparten fila y alto; los controles miden 44 px', async ({ page }) => {
    await visit(page, W_DESKTOP);
    const boxes = await Promise.all(['Colección', 'Movimiento', 'Material de caja'].map((l) => page.getByLabel(l, { exact: true }).boundingBox()));
    boxes.forEach((b) => {
      expect(Math.abs((b?.y ?? Number.NaN) - (boxes[NONE]?.y ?? NONE)), 'mismo top').toBeLessThanOrEqual(ROW_TOLERANCE);
      expect(Math.abs((b?.height ?? Number.NaN) - (boxes[NONE]?.height ?? NONE)), 'mismo alto').toBeLessThanOrEqual(ROW_TOLERANCE);
    });
    const rest = await Promise.all(['Precio desde (S/)', 'Precio hasta (S/)', 'Ordenar por'].map((l) => page.getByLabel(l, { exact: true }).boundingBox()));
    rest.forEach((b) => expect(b?.height ?? NONE).toBeGreaterThanOrEqual(TOUCH - ROW_TOLERANCE));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(NONE);
  });

  test('con filtros activos tampoco se muestra el resumen y la fila de acciones se mantiene', async ({ page }) => {
    await visit(page, W_DESKTOP, `${PATH}?category=cat-a&available=1`);
    await expect(summary(page)).toBeHidden();
    await expect(category(page)).toBeVisible();
    const apply = await page.getByRole('button', { name: 'Aplicar' }).boundingBox();
    const clear = await page.locator('form').getByRole('link', { name: 'Limpiar filtros' }).boundingBox();
    expect(Math.abs((apply?.y ?? Number.NaN) - (clear?.y ?? NONE))).toBeLessThanOrEqual(ROW_TOLERANCE);
  });

  test('elegir y aplicar en escritorio funciona sin abrir nada', async ({ page }) => {
    await visit(page, W_DESKTOP);
    await category(page).selectOption('cat-b');
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'cat-b'), page.getByRole('button', { name: 'Aplicar' }).click()]);
  });
});

test.describe('punto de corte de 800 px', () => {
  test('a 799 px el resumen es el control; a 800 px desaparece y la barra queda desplegada', async ({ page }) => {
    await visit(page, W_BELOW_BREAKPOINT);
    await expect(summary(page)).toBeVisible();
    await expect(category(page)).not.toBeVisible();
    await visit(page, W_BREAKPOINT);
    await expect(summary(page)).toBeHidden();
    await expect(category(page)).toBeVisible();
  });
});

test.describe('accesibilidad (axe, WCAG 2.2 AA)', () => {
  [W_SMALL, W_PHONE, W_BREAKPOINT, W_DESKTOP].forEach((width) => {
    test(`${width} px: estado inicial, plegable abierto, con filtros activos y con 422`, async ({ page }) => {
      await visit(page, width);
      await expectNoA11yViolations(page);
      await openFilters(page);
      await expect(category(page)).toBeVisible();
      await expectNoA11yViolations(page);
      await visit(page, width, `${PATH}?category=cat-a&available=1`);
      await expect(category(page)).toBeVisible();
      await expectNoA11yViolations(page);
      stub.setMode('validation');
      await visit(page, width, `${PATH}?q=algo`);
      await expectNoA11yViolations(page);
    });
  });

  test('a 375 px "Limpiar filtros" del formulario es único y mide 44 px', async ({ page }) => {
    await visit(page, W_PHONE);
    await openFilters(page);
    const link = page.locator('form').getByRole('link', { name: 'Limpiar filtros' });
    await expect(link).toHaveCount(ONE);
    expect((await link.boundingBox())?.height ?? NONE).toBeGreaterThanOrEqual(TOUCH);
    await expect(page.getByRole('group', { name: 'Filtrar y ordenar' })).toHaveCount(ONE);
  });
});
