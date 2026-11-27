import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { TOUCH_TARGET, openPage, sequence } from './helpers/ui-a';

// T-133 · fix visual A: cabecera y pie (REVIEW-2026-11-27 D-01, D-02, D-09, D-14; D-044; accesos de D-041 P-1).
// Página real con StoreLayout (/nosotros, estática). Se localiza por rol, nombre y atributos nativos.
const PAGE = '/nosotros';
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const TOLERANCE = 1; // px
const VIEWPORT_HEIGHT = 800;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const MOBILE_WIDTHS = [WIDTH_SMALL, WIDTH_PHONE];
const CELL = 24; // --space-24: celda del damero
const BOARD_ROWS = 2;
// Ancho mínimo del enlace del wordmark de la cabecera (caja del enlace; medido el 2026-11-27 en astro dev: 135, 148, 236 y 477 px).
// Los umbrales dejan ~7 % de margen por la fuente y son claramente mayores que el wordmark anterior (caja de ≈ 106, 109, 129 y 129 px).
const MIN_AT_SMALL = 125;
const MIN_AT_PHONE = 138;
const MIN_AT_TABLET = 215;
const MIN_AT_DESKTOP = 440;
const MIN_WORDMARK: Record<number, number> = {
  [WIDTH_SMALL]: MIN_AT_SMALL,
  [WIDTH_PHONE]: MIN_AT_PHONE,
  [WIDTH_TABLET]: MIN_AT_TABLET,
  [WIDTH_DESKTOP]: MIN_AT_DESKTOP,
};
const HALF = 2; // centro de una caja
const MAX_FOOTER_MARK = 0.65; // el wordmark del pie en móvil, como máximo el 65 % del ancho (medido 51 %)
const MIN_FOOTER_MARK = 0.35;
const ACCESS_NAMES = ['Lista de deseos', 'Carrito', 'Mi cuenta'];
// Nombre del wordmark: "Valmont, inicio" casa; "Relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=valmont&flags=i
const VALMONT_NAME = /valmont/i;
// Enlace de salto: "Saltar al contenido" casa; "Ir al contenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=saltar%20al%20contenido&flags=i
const SKIP_LINK = /saltar al contenido/i;
// Familia Geist: "Geist-3430acb700b72188" casa; "Jaro-731b4c00b2ff5201" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Egeist&flags=i
const GEIST = /^"?geist/i;
// Familia Jaro: "Jaro-731b4c00b2ff5201" casa; "Geist-3430acb700b72188" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%22%3Fjaro&flags=i
const JARO = /^"?jaro/i;

type Box = { x: number; y: number; width: number; height: number };

const header = (page: Page): Locator => page.locator('header').first();
const footer = (page: Page): Locator => page.locator('footer').first();
const menu = (page: Page): Locator => header(page).locator('[popover]');
const opener = (page: Page): Locator => header(page).locator('button[popovertarget]:visible').first();
const wordmark = (page: Page): Locator => header(page).getByRole('link', { name: VALMONT_NAME }).first();
const access = (page: Page, name: string): Locator => header(page).getByRole('link', { name, exact: true });

async function openAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, PAGE);
}

const overflowX = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const box = async (loc: Locator): Promise<Box> => {
  const b = await loc.boundingBox();
  if (!b) throw new Error('El elemento no tiene caja (¿oculto?)');
  return b;
};

/** Los rectángulos se pisan (con 1 px de tolerancia). */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width - TOLERANCE &&
  b.x < a.x + a.width - TOLERANCE &&
  a.y < b.y + b.height - TOLERANCE &&
  b.y < a.y + a.height - TOLERANCE;

test.describe('T-133 · cabecera y pie (corrección visual A)', () => {
  test.describe.configure({ timeout: SLOW });

  test('sin desplazamiento horizontal a 360, 375, 800 y 1280 px (RNF04)', async ({ page }) => {
    const overflows = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      return { width, overflow: await overflowX(page) };
    });
    expect(overflows.filter((o) => o.overflow > NONE)).toEqual([]);
  });

  test('D-02 · el wordmark de la cabecera es claramente mayor que antes en 360, 375, 800 y 1280 px', async ({ page }) => {
    const widths = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      return { width, wordmark: (await box(wordmark(page))).width, min: MIN_WORDMARK[width] };
    });
    expect(widths.filter((w) => w.wordmark < w.min)).toEqual([]);
  });

  test('D-02 · los accesos de P-1 miden 44 px, no se solapan entre sí ni con el wordmark ni con la búsqueda, y caben en la ventana', async ({ page }) => {
    const failures = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      const mobile = width < WIDTH_TABLET;
      const buttons = [...ACCESS_NAMES.map((n) => access(page, n)), ...(mobile ? [opener(page)] : [])];
      expect(buttons.length).toBe(mobile ? FOUR : THREE);
      const boxes = await sequence(buttons, async (b) => box(b));
      const wm = await box(wordmark(page));
      const others = mobile ? [] : [await box(header(page).getByRole('search'))];
      const problems = [
        ...boxes.flatMap((b, i) => [
          ...(b.width < TOUCH_TARGET - TOLERANCE || b.height < TOUCH_TARGET - TOLERANCE ? [`${width}: botón ${i} mide ${b.width}x${b.height}`] : []),
          ...(b.x < NONE || b.x + b.width > width + TOLERANCE ? [`${width}: botón ${i} fuera de la ventana`] : []),
          ...(overlaps(b, wm) ? [`${width}: botón ${i} pisa el wordmark`] : []),
          ...others.filter((o) => overlaps(b, o)).map(() => `${width}: botón ${i} pisa la búsqueda`),
          ...boxes.slice(i + ONE).filter((c) => overlaps(b, c)).map(() => `${width}: botón ${i} se solapa con otro botón`),
        ]),
        ...others.filter((o) => overlaps(wm, o)).map(() => `${width}: el wordmark pisa la búsqueda`),
        ...(wm.x + wm.width > width + TOLERANCE ? [`${width}: el wordmark se sale de la ventana`] : []),
      ];
      return problems;
    });
    expect(failures.flat()).toEqual([]);
  });

  test('D-02 · el símbolo sigue en el marcado, decorativo (alt vacío)', async ({ page }) => {
    await openAt(page, WIDTH_DESKTOP);
    const img = header(page).locator('img[src="/brand/symbol.svg"]');
    await expect(img).toHaveCount(ONE);
    await expect(img).toHaveAttribute('alt', '');
    await expect(img).toBeVisible();
  });

  test('D-01 · el damero mide dos filas (48 px) en la cabecera y en el pie, a todos los anchos', async ({ page }) => {
    const heights = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      const h = await header(page).locator('[data-palette]').evaluate((e) => e.getBoundingClientRect().height);
      const f = await footer(page).locator('[data-palette]').evaluate((e) => e.getBoundingClientRect().height);
      return { width, h, f };
    });
    expect(heights.filter((x) => x.h !== CELL * BOARD_ROWS || x.f !== CELL * BOARD_ROWS)).toEqual([]);
  });

  test('el enlace de salto es el primer enfocable y queda dentro de la ventana, a 360, 375, 800 y 1280 px', async ({ page }) => {
    const states = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: SKIP_LINK });
      await expect(skip).toBeFocused();
      const b = await box(skip);
      return { width, inside: b.y >= -TOLERANCE && b.x >= -TOLERANCE && b.x + b.width <= width + TOLERANCE };
    });
    expect(states.filter((s) => !s.inside)).toEqual([]);
  });

  test('dato · altura de la cabecera por ancho; no tapa el contenido (no es fija ni pegajosa y el h1 queda libre)', async ({ page }) => {
    const data = await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      return page.evaluate(([w, half]) => {
        const h = document.querySelector('header') as HTMLElement;
        const h1 = document.querySelector('main h1') as HTMLElement;
        const r = h1.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / half, Math.min(r.top + r.height / half, window.innerHeight - 1));
        return {
          width: w,
          height: Math.round(h.getBoundingClientRect().height),
          position: getComputedStyle(h).position,
          mainTop: Math.round((document.querySelector('main') as HTMLElement).getBoundingClientRect().top),
          h1Visible: r.top < window.innerHeight ? !!hit && (hit === h1 || h1.contains(hit) || hit.closest('main') !== null) : true,
        };
      }, [width, HALF] as const);
    });
    test.info().annotations.push({ type: 'altura de cabecera (px)', description: data.map((d) => `${d.width}: ${d.height}`).join(' · ') });
    console.log(`T-133 altura de cabecera → ${data.map((d) => `${d.width}px: ${d.height}px`).join(' · ')}`);
    expect(data.filter((d) => d.position === 'fixed' || d.position === 'sticky')).toEqual([]);
    expect(data.filter((d) => d.mainTop < d.height - TOLERANCE)).toEqual([]);
    expect(data.filter((d) => !d.h1Visible)).toEqual([]);
  });

  MOBILE_WIDTHS.forEach((width) => {
    test(`menú móvil a ${width} px: el botón abre, el botón de cerrar cierra y Escape devuelve el foco al botón`, async ({ page }) => {
      await openAt(page, width);
      await page.evaluate(() =>
        document.addEventListener('click', (e) => {
          if ((e.target as Element).closest('a[href]')) e.preventDefault();
        }),
      );
      await expect(menu(page)).toBeHidden();
      await opener(page).click();
      await expect(menu(page)).toBeVisible();
      await expect(header(page).getByRole('search')).toBeVisible();
      await expect(header(page).getByRole('navigation', { name: 'Principal' })).toBeVisible();
      await header(page).getByRole('button', { name: 'Cerrar menú' }).click();
      await expect(menu(page)).toBeHidden();
      const btn = opener(page);
      await btn.focus();
      await page.keyboard.press('Enter');
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu(page)).toBeHidden();
      await expect(btn).toBeFocused();
      expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
    });
  });

  test('D-14 · el contacto del pie se calcula en Geist, sin mayúsculas; solo el wordmark decorativo usa Jaro (a 375 y 1280 px)', async ({ page }) => {
    const styles = await sequence([WIDTH_PHONE, WIDTH_DESKTOP], async (width) => {
      await openAt(page, width);
      const contact = await footer(page).locator('address').locator('a').evaluateAll((as) =>
        as.map((a) => ({ text: a.textContent, family: getComputedStyle(a).fontFamily, transform: getComputedStyle(a).textTransform, upper: (a as HTMLElement).innerText })),
      );
      const mark = await footer(page).locator('.site-footer__mark').evaluate((e) => getComputedStyle(e).fontFamily);
      return { width, contact, mark };
    });
    styles.forEach(({ width, contact, mark }) => {
      expect(contact.length, `${width}: faltan los 3 contactos`).toBe(THREE);
      contact.forEach((c) => {
        expect(c.family, `${width} ${c.text}`).toMatch(GEIST);
        expect(c.family, `${width} ${c.text}`).not.toMatch(JARO);
        expect(c.transform, `${width} ${c.text}`).toBe('none');
      });
      const shown = contact.map((c) => c.upper).join(' ');
      expect(shown, `${width}: el contacto se ve en minúsculas`).not.toBe(shown.toUpperCase());
      expect(mark, `${width}: el wordmark del pie conserva Jaro`).toMatch(JARO);
    });
  });

  MOBILE_WIDTHS.forEach((width) => {
    test(`D-09 · pie a ${width} px: enlaces en rejilla de 2 columnas (sin enlace suelto a media fila) y wordmark que no ocupa todo el ancho`, async ({ page }) => {
      await openAt(page, width);
      const links = await footer(page).getByRole('navigation', { name: 'Pie de página' }).getByRole('link').evaluateAll((as) =>
        as.map((a) => ({ name: a.textContent?.trim(), x: Math.round(a.getBoundingClientRect().x), y: Math.round(a.getBoundingClientRect().y) })),
      );
      expect(links.map((l) => l.name)).toEqual(['Relojes', 'Nosotros', 'Contacto', 'Privacidad', 'Términos']);
      const columns = [...new Set(links.map((l) => l.x))];
      expect(columns, 'los enlaces deben alinearse en 2 columnas').toHaveLength(TWO);
      const rows = [...new Set(links.map((l) => l.y))];
      expect(rows, '5 enlaces en 2 columnas = 3 filas').toHaveLength(THREE);
      // Las filas completas llevan sus dos enlaces; solo el último (impar) queda solo, en la primera columna.
      const byRow = rows.map((y) => links.filter((l) => l.y === y));
      expect(byRow.map((r) => r.length)).toEqual([TWO, TWO, ONE]);
      expect(byRow[TWO][NONE].x).toBe(Math.min(...columns));
      const mark = await footer(page).locator('.site-footer__mark').evaluate((e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return { text: r.getBoundingClientRect().width, footer: (e.closest('footer') as HTMLElement).clientWidth };
      });
      expect(mark.text / mark.footer).toBeLessThanOrEqual(MAX_FOOTER_MARK);
      expect(mark.text / mark.footer).toBeGreaterThanOrEqual(MIN_FOOTER_MARK);
      expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
    });
  });

  test('axe (WCAG 2.2 AA): 0 violaciones a 360, 375, 800 y 1280 px', async ({ page }) => {
    await sequence(WIDTHS, async (width) => {
      await openAt(page, width);
      await expectNoA11yViolations(page);
    });
  });
});
