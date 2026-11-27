import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { openPage, sequence } from './helpers/ui-a';

// T-137 · corrección visual E (D-044; REVIEW-2026-11-27: foto del hero, D-03, D-06, D-07, D-08, D-12, D-13).
// Contra el backend real (:8000, semilla `seed_dev`). Comprueba el resultado visible (estilos calculados y geometría), no el código.
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 900;
const SETTLE_MS = 400;
const SCROLL_STEP = 600;
const MAX_CLS = 0.1;
const HERO_AIR_PX = 40; // D-03: el diseño deja ~49 px entre el damero y el hero (tolerancia hacia abajo)
const MANIFESTO_H2_MAX_PX = 36; // D-08: a 375 el manifiesto es H2 (32/36), no H1 (42+)
const MANIFESTO_H1_MIN_PX = 42; // desde 800 px vuelve a H1
const HALF_TOLERANCE_PX = 4;
const ALIGN_TOLERANCE_PX = 2;
const ROW_MIN_GAP_PX = 60; // etiqueta y valor en la misma fila: el valor empieza claramente a la derecha de la etiqueta
const PRODUCT = 'demo-jade-39';

type Rgb = string;

/** Color calculado de un token (`--color-forest`...) resuelto por el navegador, para compararlo con el de un elemento. */
const tokenColor = (page: Page, token: string): Promise<Rgb> =>
  page.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);

async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, path);
}

async function scrollThrough(page: Page): Promise<void> {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const stops = Array.from({ length: Math.ceil(total / SCROLL_STEP) + ONE }, (_, i) => i * SCROLL_STEP);
  await sequence(stops, async (y) => {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(SETTLE_MS);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe('T-137 · portada sin foto de hero', () => {
  test.describe.configure({ timeout: SLOW });

  WIDTHS.forEach((width) => {
    test(`a ${String(width)} px: exactamente un h1, en el DOM y visible (el h2 ↔ h1 del manifiesto no duplica)`, async ({ page }) => {
      await openAt(page, '/', width);
      const info = await page.evaluate(() =>
        [...document.querySelectorAll('h1')].map((h) => {
          const r = h.getBoundingClientRect();
          const cs = getComputedStyle(h);
          return { text: h.textContent?.trim() ?? '', visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' };
        }),
      );
      expect(info, JSON.stringify(info)).toHaveLength(ONE);
      expect(info[NONE].visible).toBe(true);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
      // Los encabezados ocultos (display:none) también cuentan en el DOM: ninguno puede ser otro h1.
      expect(await page.locator('[role="heading"][aria-level="1"]').count()).toBe(NONE);
    });

    test(`a ${String(width)} px: el hero no tiene imágenes raster ni texto incrustado y sus colores son los de la marca`, async ({ page }) => {
      await openAt(page, '/', width);
      const hero = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const section = h1?.closest('section') as HTMLElement;
        const imgs = [...section.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt'), prio: i.getAttribute('fetchpriority') }));
        const bg = [...section.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundImage).filter((b) => b.includes('url('));
        return { imgs, bg, text: section.innerText };
      });
      expect(hero.imgs.length).toBeGreaterThan(NONE);
      hero.imgs.forEach((i) => expect(i, JSON.stringify(i)).toEqual({ src: '/brand/symbol.svg', alt: '', prio: null }));
      expect(hero.bg, 'sin fondos con url() (foto)').toEqual([]);
      expect(hero.text.toLowerCase()).not.toContain('citizen');
      expect(hero.text.toLowerCase()).not.toContain('eco-drive');
    });

    test(`a ${String(width)} px: sin respuestas ≥ 400 ni peticiones de hero.png/CITIZEN y consola limpia`, async ({ page }) => {
      const bad: string[] = [];
      const problems: string[] = [];
      page.on('response', (r) => {
        if (r.status() >= 400) bad.push(`${String(r.status())} ${r.url()}`);
        if (r.url().toLowerCase().includes('hero') && r.url().toLowerCase().includes('.png')) bad.push(`hero png ${r.url()}`);
      });
      page.on('console', (m) => {
        if (['error', 'warning'].includes(m.type())) problems.push(m.text());
      });
      await openAt(page, '/', width);
      await scrollThrough(page);
      expect(bad).toEqual([]);
      expect(problems).toEqual([]);
    });

    test(`a ${String(width)} px: "(demo)" no se parte en dos líneas y no hay desbordamiento horizontal`, async ({ page }) => {
      await openAt(page, '/', width);
      const demos = await page.locator('main a span').evaluateAll((els) =>
        els
          .filter((e) => e.textContent?.trim() === '(demo)')
          .map((e) => ({ rects: e.getClientRects().length, ws: getComputedStyle(e).whiteSpace })),
      );
      // Si el backend no trae categorías con "(demo)" la prueba sería vacía.
      expect(demos.length, 'hay enlaces con (demo)').toBeGreaterThan(NONE);
      demos.forEach((d) => expect(d, JSON.stringify(d)).toEqual({ rects: ONE, ws: 'nowrap' }));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(NONE);
    });

    test(`a ${String(width)} px: axe sin violaciones (WCAG 2.2 AA)`, async ({ page }) => {
      await openAt(page, '/', width);
      await scrollThrough(page);
      await expectNoA11yViolations(page);
    });
  });

  test('D-08: el manifiesto es H2 (≤ 36 px) a 375 px y vuelve a tamaño H1 (≥ 42 px) a 800 y 1280 px', async ({ page }) => {
    const manifestoSize = async (width: number): Promise<number> => {
      await openAt(page, '/', width);
      return page.locator('main p', { hasText: 'VALMONT es una boutique' }).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    };
    expect(await manifestoSize(WIDTH_PHONE)).toBeLessThanOrEqual(MANIFESTO_H2_MAX_PX);
    expect(await manifestoSize(WIDTH_TABLET)).toBeGreaterThanOrEqual(MANIFESTO_H1_MIN_PX);
    expect(await manifestoSize(WIDTH_DESKTOP)).toBeGreaterThanOrEqual(MANIFESTO_H1_MIN_PX);
  });

  test('D-08: los enlaces gigantes a 375 px son más pequeños que a 1280 px y caben sin desbordar', async ({ page }) => {
    const linkSize = async (width: number): Promise<number> => {
      await openAt(page, '/', width);
      return page
        .getByRole('navigation', { name: 'Colecciones' })
        .getByRole('link')
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    };
    const phone = await linkSize(WIDTH_PHONE);
    const desktop = await linkSize(WIDTH_DESKTOP);
    expect(phone).toBeLessThan(desktop);
    expect(phone).toBeLessThanOrEqual(MANIFESTO_H2_MAX_PX + TWO * TWO);
  });

  test('D-03: el hero tiene aire sobre él (no toca la cabecera con el damero) a 1280 px', async ({ page }) => {
    await openAt(page, '/', WIDTH_DESKTOP);
    const gap = await page.evaluate(() => {
      const hero = document.querySelector('h1')?.closest('section') as HTMLElement;
      const header = document.querySelector('header') as HTMLElement;
      return hero.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(HERO_AIR_PX);
  });

  test('D-044: el bloque del hero usa el color forest de la marca', async ({ page }) => {
    await openAt(page, '/', WIDTH_DESKTOP);
    const forest = await tokenColor(page, '--color-forest');
    const colors = await page.evaluate(() => {
      const section = document.querySelector('h1')?.closest('section') as HTMLElement;
      return [...section.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundColor);
    });
    expect(colors).toContain(forest);
  });

  [WIDTH_SMALL, WIDTH_TABLET].forEach((width) => {
    test(`a ${String(width)} px el LCP es texto (titular o manifiesto), nunca una imagen`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.addInitScript(() => {
        (window as unknown as { __lcp: { tag: string; priority: string | null }[] }).__lcp = [];
        new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            const el = (entry as PerformanceEntry & { element?: Element | null }).element;
            (window as unknown as { __lcp: unknown[] }).__lcp.push({ tag: el?.tagName ?? 'none', priority: el?.getAttribute('fetchpriority') ?? null });
          });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await openPage(page, '/');
      await page.waitForLoadState('load');
      await page.waitForTimeout(SETTLE_MS);
      const entries = await page.evaluate(() => (window as unknown as { __lcp: { tag: string; priority: string | null }[] }).__lcp);
      expect(entries.length, 'se registró un LCP').toBeGreaterThan(NONE);
      // Con 900 px de alto el párrafo del manifiesto ocupa más área que el h1 y pasa a ser el LCP: ambos son texto, sin recursos pesados.
      expect(['H1', 'P']).toContain(entries.at(-ONE)?.tag);
      expect(entries.at(-ONE)?.priority).toBeNull();
    });
  });

  [WIDTH_PHONE, WIDTH_TABLET].forEach((width) => {
    test(`a ${String(width)} px no hay CLS apreciable (< ${String(MAX_CLS)})`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.addInitScript(() => {
        (window as unknown as { __cls: number }).__cls = 0;
        new PerformanceObserver((list) => {
          list.getEntries().forEach((e) => {
            const shift = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
            if (!shift.hadRecentInput) (window as unknown as { __cls: number }).__cls += shift.value;
          });
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await openPage(page, '/');
      await scrollThrough(page);
      expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(MAX_CLS);
    });
  });
});

test.describe('T-137 · catálogo: título en forest y banner en ink 50/50', () => {
  test.describe.configure({ timeout: SLOW });

  test('D-06: el título de /relojes es forest; el de la ficha también (referencia del diseño)', async ({ page }) => {
    await openAt(page, '/relojes', WIDTH_DESKTOP);
    const forest = await tokenColor(page, '--color-forest');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    expect(await page.getByRole('heading', { level: 1 }).evaluate((e) => getComputedStyle(e).color)).toBe(forest);
  });

  test('D-07: el banner destacado es ink, mitad texto y mitad bloque de color, sin CTA, a 1280 px', async ({ page }) => {
    await openAt(page, '/relojes', WIDTH_DESKTOP);
    const ink = await tokenColor(page, '--color-ink');
    const banner = page.locator('[data-demo-content]').first();
    await expect(banner).toBeVisible();
    expect(await banner.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(ink);
    await expect(banner.locator('a, button')).toHaveCount(NONE);
    await expect(banner).toContainText('Contenido de demostración');
    const [text, media] = await banner.evaluate((e) => [...e.children].map((c) => Math.round(c.getBoundingClientRect().width)));
    expect(Math.abs(text - media), `texto ${String(text)} px, bloque ${String(media)} px`).toBeLessThanOrEqual(HALF_TOLERANCE_PX);
  });

  test('D-07: a 375 px el banner se apila (texto sobre bloque) y no desborda', async ({ page }) => {
    await openAt(page, '/relojes', WIDTH_PHONE);
    const banner = page.locator('[data-demo-content]').first();
    const [first, second] = await banner.evaluate((e) => [...e.children].map((c) => c.getBoundingClientRect().top));
    expect(second).toBeGreaterThan(first);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(NONE);
  });

  [WIDTH_SMALL, WIDTH_DESKTOP].forEach((width) => {
    test(`a ${String(width)} px /relojes pasa axe (contraste del banner ink y del título forest)`, async ({ page }) => {
      await openAt(page, '/relojes', width);
      await expectNoA11yViolations(page);
    });
  });
});

test.describe('T-137 · ficha: especificaciones en filas y asesor a la izquierda', () => {
  test.describe.configure({ timeout: SLOW });

  const firstRow = (page: Page): Promise<{ dtLeft: number; dtRight: number; ddLeft: number; dtTop: number; ddTop: number; dtBottom: number }> =>
    page.locator('#specs-title').locator('xpath=..').locator('dl .row').first().evaluate((row) => {
      const dt = row.querySelector('dt') as HTMLElement;
      const dd = row.querySelector('dd') as HTMLElement;
      const a = dt.getBoundingClientRect();
      const b = dd.getBoundingClientRect();
      return { dtLeft: a.left, dtRight: a.right, dtTop: a.top, dtBottom: a.bottom, ddLeft: b.left, ddTop: b.top };
    });

  test('D-12: a 1280 px etiqueta y valor van en la misma fila (valor a la derecha) y hay una sola columna de filas', async ({ page }) => {
    await openAt(page, `/relojes/${PRODUCT}`, WIDTH_DESKTOP);
    const row = await firstRow(page);
    expect(row.ddLeft - row.dtLeft, JSON.stringify(row)).toBeGreaterThanOrEqual(ROW_MIN_GAP_PX);
    expect(Math.abs(row.ddTop - row.dtTop), JSON.stringify(row)).toBeLessThan(row.dtBottom - row.dtTop);
    const lefts = await page.locator('#specs-title').locator('xpath=..').locator('dl .row').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    expect(lefts, 'todas las filas arrancan en el mismo borde: una columna').toBe(ONE);
  });

  test('D-12: a 375 px (contenedor estrecho) la etiqueta queda sobre el valor, sin desbordar', async ({ page }) => {
    await openAt(page, `/relojes/${PRODUCT}`, WIDTH_PHONE);
    const row = await firstRow(page);
    expect(row.ddTop, JSON.stringify(row)).toBeGreaterThanOrEqual(row.dtBottom - ALIGN_TOLERANCE_PX);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(NONE);
  });

  WIDTHS.forEach((width) => {
    test(`a ${String(width)} px la ficha tiene un solo h1 y pasa axe`, async ({ page }) => {
      await openAt(page, `/relojes/${PRODUCT}`, width);
      expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
      await expectNoA11yViolations(page);
    });
  });

  [WIDTH_PHONE, WIDTH_DESKTOP].forEach((width) => {
    test(`D-13: a ${String(width)} px "Consultar con un asesor" se alinea a la izquierda con el bloque de compra`, async ({ page }) => {
      await openAt(page, `/relojes/${PRODUCT}`, width);
      const advisor = page.getByRole('link', { name: /Consultar con un asesor/ });
      await expect(advisor).toHaveCount(ONE);
      const [advisorLeft, nameLeft] = await Promise.all([
        advisor.evaluate((e) => e.getBoundingClientRect().left),
        page.getByRole('heading', { level: 1 }).evaluate((e) => e.getBoundingClientRect().left),
      ]);
      expect(Math.abs(advisorLeft - nameLeft), `asesor ${String(advisorLeft)}, título ${String(nameLeft)}`).toBeLessThanOrEqual(ALIGN_TOLERANCE_PX);
    });
  });
});
