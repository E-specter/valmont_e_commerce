import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { TOUCH_TARGET, openPage, sequence } from './helpers/ui-a';

// T-136 · D-044 (REVIEW-2026-11-27 D-04; BRIEF §3): Jaro solo en el wordmark VALMONT (dibuja la V como U).
// Botones y llamadas en Phudu, navegación y badges de producto en Geist. Se mide la fuente calculada y la geometría
// real, sin conocer el CSS. Contra el backend real (:8000, semilla `seed_dev`) para `/`, `/relojes` y la ficha.
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TOLERANCE = 1; // px
const VIEWPORT_HEIGHT = 900;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const GIANT_PX = 36; // desde este tamaño el texto es un titular: no puede salirse de su caja
const PAGES = ['/', '/relojes', '/relojes/demo-jade-39', '/nosotros', '/dev/ui-a'];
const SHOWCASE = '/dev/ui-a'; // el muestrario enseña el Wordmark dentro de main

// Primera familia: "Jaro-731b4c00b2ff5201, ..." casa; "Phudu-1a2b3c4d5e6f7a8b" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%22%3Fjaro&flags=i
const JARO = /^"?jaro/i;
// Primera familia: "Phudu-1a2b3c4d5e6f7a8b" casa; "Geist-3430acb700b72188" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%22%3Fphudu&flags=i
const PHUDU = /^"?phudu/i;
// Primera familia: "Geist-3430acb700b72188" casa; "Jaro-731b4c00b2ff5201" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%22%3Fgeist&flags=i
const GEIST = /^"?geist/i;
// Nombre del enlace: "Ver reloj: Isla 40" casa; "Ver detalles" no.
// Probar: https://regex101.com/?flavor=javascript&regex=ver%20reloj&flags=i
const VER_RELOJ = /ver reloj/i;
// Nombre del enlace: "Ver el catálogo" casa; "Ver reloj" no.
// Probar: https://regex101.com/?flavor=javascript&regex=ver%20el%20cat%C3%A1logo&flags=i
const VER_CATALOGO = /ver el catálogo/i;
// Primera familia: "Staatliches-9f8e7d6c5b4a3921" o "Phudu-1a2b3c4d5e6f7a8b" casan; "Jaro-731b4c00b2ff5201" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%22%3F(phudu%7Cstaatliches)&flags=i
const PHUDU_OR_STAATLICHES = /^"?(phudu|staatliches)/i;
const SNIPPET = 30; // caracteres de texto en los mensajes
const BODY_PX = 16; // BRIEF §3: Body/UI 16 px en escritorio
const TWO = 2;
const THREE = 3;

type TextRun = { text: string; family: string; tag: string; inBrandSlot: boolean; right: number; left: number; clipped: boolean; empty: boolean };
type Giant = { text: string; client: number; scroll: number; right: number };

async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, path);
}

const first = (family: string): string => family.split(',')[0].trim();

/** Cada nodo de texto visible de la página con su familia calculada y su caja real (Range). */
function textRuns(page: Page): Promise<TextRun[]> {
  return page.evaluate(() => {
    const clippedUp = (p: HTMLElement | null): boolean =>
      !!p && (['clip', 'hidden'].includes(getComputedStyle(p).overflowX) || clippedUp(p.parentElement));
    return [...document.body.querySelectorAll<HTMLElement>('*')]
      .filter((el) => !el.closest('astro-dev-toolbar, script, style, noscript, template') && el.checkVisibility({ visibilityProperty: true }))
      .flatMap((el) =>
        [...el.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
          .map((n) => {
            const range = document.createRange();
            range.selectNodeContents(n);
            const box = range.getBoundingClientRect();
            return {
              text: (n.textContent ?? '').trim(),
              family: getComputedStyle(el).fontFamily,
              tag: el.tagName.toLowerCase(),
              inBrandSlot: !!el.closest('header, footer'),
              right: box.right,
              left: box.left,
              clipped: clippedUp(el),
              empty: box.width === 0 || box.height === 0,
            };
          }),
      )
      .filter((r) => !r.empty);
  });
}

/** Titulares (>= 36 px): el texto cabe en su propia caja y en la ventana. */
function giants(page: Page): Promise<Giant[]> {
  return page.evaluate((min) =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter(
        (el) =>
          !el.closest('astro-dev-toolbar') &&
          el.checkVisibility() &&
          [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && (c.textContent ?? '').trim() !== '') &&
          parseFloat(getComputedStyle(el).fontSize) >= min,
      )
      .map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { text: (el.textContent ?? '').trim(), client: el.clientWidth, scroll: el.scrollWidth, right: range.getBoundingClientRect().right };
      }),
  GIANT_PX);
}

test.describe('T-136 · Jaro solo en el wordmark VALMONT', () => {
  PAGES.forEach((path) => {
    test(`${path} · ningún texto visible usa Jaro salvo el wordmark VALMONT de cabecera y pie`, async ({ page }) => {
      test.setTimeout(SLOW);
      await openAt(page, path, WIDTH_DESKTOP);
      const runs = await textRuns(page);
      expect(runs.length).toBeGreaterThan(NONE);
      const allowed = (r: TextRun): boolean =>
        r.text.toLowerCase() === 'valmont' && (r.inBrandSlot || path === SHOWCASE);
      const offenders = runs.filter((r) => JARO.test(first(r.family)) && !allowed(r)).map((r) => `<${r.tag}> "${r.text.slice(NONE, SNIPPET)}" ${r.family}`);
      expect(offenders).toEqual([]);
    });

    test(`${path} · el wordmark de la cabecera y el del pie siguen en Jaro`, async ({ page }) => {
      test.setTimeout(SLOW);
      await openAt(page, path, WIDTH_DESKTOP);
      const runs = await textRuns(page);
      const marks = runs.filter((r) => r.text.toLowerCase() === 'valmont' && (r.inBrandSlot || path === SHOWCASE));
      if (path !== SHOWCASE) expect(marks.length, 'cabecera y pie').toBeGreaterThanOrEqual(2);
      expect(marks.length).toBeGreaterThan(NONE);
      marks.forEach((m) => expect(first(m.family)).toMatch(JARO));
    });
  });

  test('"VER RELOJ" (portada) y el resto de botones se renderizan en Phudu, no en Jaro', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, '/', WIDTH_DESKTOP);
    const link = page.locator('main').getByRole('link', { name: VER_RELOJ }).first();
    await expect(link).toBeVisible();
    const s = await link.evaluate((e) => {
      const c = getComputedStyle(e);
      return { family: c.fontFamily, weight: c.fontWeight, size: c.fontSize, transform: c.textTransform };
    });
    expect(first(s.family)).toMatch(PHUDU);
    expect(s.weight).toBe('600');
    expect(s.size).toBe('16px');
    expect(s.transform).toBe('uppercase');
  });

  test('"VER EL CATÁLOGO" (404) se renderiza en Phudu', async ({ page }) => {
    test.setTimeout(SLOW);
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await page.goto('/ruta-que-no-existe-t136');
    await page.evaluate(() => document.fonts.ready);
    const link = page.getByRole('link', { name: VER_CATALOGO }).first();
    await expect(link).toBeVisible();
    expect(first(await link.evaluate((e) => getComputedStyle(e).fontFamily))).toMatch(PHUDU);
  });

  test('/dev/ui-a · todos los botones visibles usan Phudu 600', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, SHOWCASE, WIDTH_DESKTOP);
    const btns = await page.locator('main .btn:visible').evaluateAll((els) =>
      els.map((e) => ({ text: (e.textContent ?? '').trim(), family: getComputedStyle(e).fontFamily, weight: getComputedStyle(e).fontWeight })),
    );
    expect(btns.length).toBeGreaterThan(ONE);
    btns.forEach((b) => {
      expect(first(b.family), b.text).toMatch(PHUDU);
      expect(b.weight, b.text).toBe('600');
    });
  });

  test('/relojes · "Ver detalles" no usa Jaro (familia de apoyo de la tarjeta) y los botones de las tarjetas siguen el kit', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, '/relojes', WIDTH_DESKTOP);
    const more = await page.locator('main .product-card .more:visible').evaluateAll((els) => els.map((e) => getComputedStyle(e).fontFamily));
    expect(more.length).toBeGreaterThan(NONE);
    // La spec de T-136 no cambia `.more` (Staatliches, BRIEF §3 metadatos); D-044 solo exige que no sea Jaro. Phudu también sería válido.
    more.forEach((f) => expect(first(f)).toMatch(PHUDU_OR_STAATLICHES));
  });

  test('/dev/products · "Descubrir" (.cta de la tarjeta) usa Phudu 600, 16 px, mayúsculas', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, '/dev/products', WIDTH_DESKTOP);
    const ctas = await page.locator('.product-card .cta:visible').evaluateAll((els) =>
      els.map((e) => {
        const c = getComputedStyle(e);
        return { text: (e.textContent ?? '').trim(), family: c.fontFamily, weight: c.fontWeight, size: c.fontSize, transform: c.textTransform };
      }),
    );
    expect(ctas.length).toBeGreaterThan(NONE);
    ctas.forEach((c) => {
      expect(first(c.family), c.text).toMatch(PHUDU);
      expect(c.weight).toBe('600');
      expect(c.size).toBe('16px');
      expect(c.transform).toBe('uppercase');
    });
  });

  test('portada · enlaces de colección y destacado en Phudu 700; /nosotros · bloque de premios en Phudu 700', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, '/', WIDTH_DESKTOP);
    const big = await page.evaluate((min) =>
      [...document.querySelectorAll<HTMLElement>('nav[aria-label="Colecciones"] a, #featured-title')]
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) >= min && e.checkVisibility())
        .map((e) => ({ text: (e.textContent ?? '').trim(), family: getComputedStyle(e).fontFamily, weight: getComputedStyle(e).fontWeight })),
    GIANT_PX);
    expect(big.length, 'enlaces gigantes y h2 del destacado').toBeGreaterThan(ONE);
    big.forEach((b) => {
      expect(first(b.family), b.text).toMatch(PHUDU);
      expect(b.weight, b.text).toBe('700');
    });
    await openAt(page, '/nosotros', WIDTH_DESKTOP);
    const block = await page.locator('.awards__block').evaluate((e) => ({ family: getComputedStyle(e).fontFamily, weight: getComputedStyle(e).fontWeight }));
    expect(first(block.family)).toMatch(PHUDU);
    expect(block.weight).toBe('700');
  });

  test('badges de producto (Novedad) en Geist 700', async ({ page }) => {
    test.setTimeout(SLOW);
    await openAt(page, '/', WIDTH_DESKTOP);
    const badges = await page.locator('main [data-kind="product"]:visible').evaluateAll((els) =>
      els.map((e) => ({ text: (e.textContent ?? '').trim(), family: getComputedStyle(e).fontFamily, weight: getComputedStyle(e).fontWeight })),
    );
    expect(badges.length).toBeGreaterThan(NONE);
    badges.forEach((b) => {
      expect(first(b.family), b.text).toMatch(GEIST);
      expect(b.weight).toBe('700');
    });
    await openAt(page, SHOWCASE, WIDTH_DESKTOP);
    const demo = await page.locator('main [data-kind="product"]:visible').evaluateAll((els) => els.map((e) => getComputedStyle(e).fontFamily));
    demo.forEach((f) => expect(first(f)).toMatch(GEIST));
  });

  WIDTHS.forEach((width) => {
    test(`navegación de la cabecera a ${width} px: Geist 600, mayúsculas y objetivo de ${TOUCH_TARGET} px`, async ({ page }) => {
      test.setTimeout(SLOW);
      await openAt(page, '/nosotros', width);
      const opener = page.locator('header button[popovertarget]:visible').first();
      if (await opener.count()) await opener.click();
      const links = await page.locator('header nav a:visible').evaluateAll((els) =>
        els.map((e) => {
          const c = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return { text: (e.textContent ?? '').trim(), family: c.fontFamily, weight: c.fontWeight, size: c.fontSize, transform: c.textTransform, height: r.height };
        }),
      );
      expect(links.length).toBeGreaterThan(ONE);
      links.forEach((l) => {
        expect(first(l.family), l.text).toMatch(GEIST);
        expect(first(l.family), l.text).not.toMatch(JARO);
        expect(l.weight, l.text).toBe('600');
        expect(l.transform, l.text).toBe('uppercase');
        expect(l.height, `${l.text}: objetivo táctil`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
      });
    });
  });
});

test.describe('T-136 · sin desbordamiento horizontal (Phudu 700 es más ancha que Jaro)', () => {
  PAGES.forEach((path) => {
    WIDTHS.forEach((width) => {
      test(`${path} a ${width} px: sin scroll horizontal; los titulares caben en su caja y en la ventana`, async ({ page }) => {
        test.setTimeout(SLOW);
        await openAt(page, path, width);
        const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
        expect(doc.scroll, 'documentElement').toBeLessThanOrEqual(doc.client + TOLERANCE);
        expect(doc.body, 'body').toBeLessThanOrEqual(doc.client + TOLERANCE);
        const big = await giants(page);
        big
          .filter((g) => g.scroll > g.client + TOLERANCE)
          .forEach((g) => expect.soft(g.scroll, `"${g.text.slice(NONE, SNIPPET)}" desborda su caja (${g.scroll} > ${g.client})`).toBeLessThanOrEqual(g.client + TOLERANCE));
        big.forEach((g) => expect.soft(g.right, `"${g.text.slice(NONE, SNIPPET)}" se sale de la ventana`).toBeLessThanOrEqual(width + TOLERANCE));
        const runs = await textRuns(page);
        // El wordmark decorativo del pie recorta a propósito (overflow: clip); el resto del texto debe estar a la vista.
        const out = runs.filter((r) => !r.clipped && (r.right > width + TOLERANCE || r.left < -TOLERANCE));
        expect(out.map((r) => `"${r.text.slice(NONE, SNIPPET)}" ${Math.round(r.left)}..${Math.round(r.right)}`)).toEqual([]);
      });

      test(`${path} a ${width} px: sin violaciones de accesibilidad (axe WCAG 2.2 AA)`, async ({ page }) => {
        test.setTimeout(SLOW);
        await openAt(page, path, width);
        await expectNoA11yViolations(page);
      });

      test(`${path} a ${width} px: botones con objetivo de ${TOUCH_TARGET} px aunque el texto sea de 16 px`, async ({ page }) => {
        test.setTimeout(SLOW);
        await openAt(page, path, width);
        const boxes = await page.locator('main .btn:visible').evaluateAll((els) =>
          els.map((e) => ({ text: (e.textContent ?? '').trim(), h: e.getBoundingClientRect().height, size: getComputedStyle(e).fontSize })),
        );
        await sequence(boxes, async (b) => {
          expect(b.h, `${b.text}: alto`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
          expect(parseFloat(b.size), `${b.text}: tamaño`).toBeLessThanOrEqual(BODY_PX + TOLERANCE);
        });
      });
    });
  });
});

test.describe('T-136 · pie en rejilla de 2 columnas, sin huérfanos', () => {
  [WIDTH_TABLET, WIDTH_DESKTOP].forEach((width) => {
    test(`pie a ${width} px: los enlaces siguen en rejilla de 2 columnas (no en fila flex) y "Términos" no queda suelto`, async ({ page }) => {
      test.setTimeout(SLOW);
      await openAt(page, '/nosotros', width);
      const nav = page.locator('footer').first().getByRole('navigation', { name: 'Pie de página' });
      const links = await nav.getByRole('link').evaluateAll((as) =>
        as.map((a) => ({ name: (a.textContent ?? '').trim(), x: Math.round(a.getBoundingClientRect().x), y: Math.round(a.getBoundingClientRect().y) })),
      );
      expect(links.map((l) => l.name)).toEqual(['Relojes', 'Nosotros', 'Contacto', 'Privacidad', 'Términos']);
      const columns = [...new Set(links.map((l) => l.x))];
      expect(columns, 'dos columnas').toHaveLength(TWO);
      const rows = [...new Set(links.map((l) => l.y))];
      expect(rows, '5 enlaces en 2 columnas = 3 filas').toHaveLength(THREE);
      const byRow = rows.map((y) => links.filter((l) => l.y === y).length);
      expect(byRow).toEqual([TWO, TWO, ONE]);
      const list = await nav.locator('ul').first().evaluate((e) => getComputedStyle(e).display);
      expect(list).toBe('grid');
    });
  });
});
