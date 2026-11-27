import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { FOCUS_RING_MIN, MIN_TEXT_CONTRAST, TOUCH_TARGET, indices, openPage, sequence, textContrast } from './helpers/ui-a';

// T-119 · E2E de cabecera, pie y título (STATUS "T-119"): /dev/layout (muestrario, solo existe con `astro dev`) y /dev/tokens
// (una página real con StoreLayout). Se localiza por rol, nombre y atributos nativos (popover), no por clases.
const SHOWCASE = '/dev/layout';
const REAL_PAGE = '/dev/tokens';
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const FOUR = 4;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const JUST_BELOW_TABLET = 799;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 800;
const TAB_LIMIT = 40;
const MAX_Q = 100;
const EXTRA = 20; // caracteres de más sobre el máximo de la búsqueda
const LONG_QUERY = 'x'.repeat(MAX_Q + EXTRA);
const TOLERANCE = 1; // px
const MIN_TARGET_AA = 24; // WCAG 2.2 SC 2.5.8
const ACCESS_NAMES = ['Lista de deseos', 'Carrito', 'Mi cuenta'];
const SNIP = 30; // recorte de texto en los mensajes
// Nombre del wordmark: "Valmont, inicio" casa; "Relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=valmont&flags=i
const VALMONT_NAME = /valmont/i;
// Enlace de salto: "Saltar al contenido" casa; "Ir al contenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=saltar%20al%20contenido&flags=i
const SKIP_LINK = /saltar al contenido/i;
// Algún dígito: "Carrito 3" casa; "Carrito" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cd&flags=
const DIGIT = /\d/;
// Enlace legal: "Términos y condiciones" casa; "Privacidad" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5ET%C3%A9rminos&flags=
const TERMS = /^Términos/;
const MENU_ID_ATTR = 'popovertarget';

const header = (page: Page): Locator => page.locator('header').first();
const footer = (page: Page): Locator => page.locator('footer').first();
const menu = (page: Page): Locator => header(page).locator('[popover]');
/** Botón que abre el menú: el único `popovertarget` visible con el menú cerrado (el de cerrar vive dentro). */
const opener = (page: Page): Locator => header(page).locator(`button[${MENU_ID_ATTR}]:visible`).first();
const mainNav = (page: Page): Locator => header(page).getByRole('navigation', { name: 'Principal' });
const search = (page: Page): Locator => header(page).getByRole('search');
const access = (page: Page, name: string): Locator => header(page).getByRole('link', { name, exact: true });
const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));

async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, path);
}

/** Exceso de ancho del documento sobre la ventana (RNF04). */
const overflowX = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Impide que un clic en un enlace navegue (las páginas /nosotros y /relojes aún no existen); el resto del clic sigue su curso. */
const blockNavigation = (page: Page): Promise<void> =>
  page.evaluate(() =>
    document.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a[href]')) e.preventDefault();
    }),
  );

const box = async (loc: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await loc.boundingBox();
  if (!b) throw new Error('El elemento no tiene caja (¿oculto?)');
  return b;
};

[SHOWCASE, REAL_PAGE].forEach((path) => {
  test.describe(`cabecera y pie en ${path}`, () => {
    test.describe.configure({ timeout: SLOW });

    test('carga sin errores de consola ni peticiones a terceros, con un h1 y un solo main#contenido', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const external = collectExternalRequests(page);
      await openPage(page, path);
      expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
      await expect(page.locator('main#contenido')).toHaveCount(ONE);
      await expect(header(page)).toBeVisible();
      await expect(footer(page)).toBeVisible();
    });

    test('landmarks: banner, nav "Principal", main y contentinfo; el main no contiene cabecera ni pie', async ({ page }) => {
      await openAt(page, path, WIDTH_DESKTOP);
      await expect(page.getByRole('banner').first()).toBeVisible();
      await expect(mainNav(page)).toHaveCount(ONE);
      await expect(page.getByRole('main')).toHaveCount(ONE);
      await expect(page.getByRole('contentinfo')).toHaveCount(ONE);
      // Las cabeceras y pies de la tienda cuelgan del layout, nunca del main (el muestrario añade una cabecera de muestra y los PageTitle usan <header>).
      await expect(page.locator('main footer')).toHaveCount(NONE);
      expect(await page.evaluate(() => !!document.querySelector('header')?.closest('main'))).toBe(false);
    });

    test('axe (WCAG 2.2 AA): 0 violaciones a 360, 375, 800 y 1280 px', async ({ page }) => {
      await sequence(WIDTHS, async (width) => {
        await openAt(page, path, width);
        await expectNoA11yViolations(page);
      });
    });

    test('sin desplazamiento horizontal a 360, 375, 800 y 1280 px (RNF04)', async ({ page }) => {
      const overflows = await sequence(WIDTHS, async (width) => {
        await openAt(page, path, width);
        return { width, overflow: await overflowX(page) };
      });
      expect(overflows.filter((o) => o.overflow > NONE)).toEqual([]);
    });

    test('el enlace para saltar al contenido es el primer enfocable y le sigue el wordmark de la cabecera', async ({ page }) => {
      await openAt(page, path, WIDTH_DESKTOP);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: SKIP_LINK })).toBeFocused();
      await page.keyboard.press('Tab');
      const second = await page.evaluate(() => ({ inHeader: !!document.activeElement?.closest('header'), href: document.activeElement?.getAttribute('href') }));
      expect(second).toEqual({ inHeader: true, href: '/' });
    });
  });
});

test.describe('cabecera full · escritorio y tablet (nav en línea desde 800 px)', () => {
  test.describe.configure({ timeout: SLOW });

  test.beforeEach(async ({ page }) => {
    await openAt(page, SHOWCASE, WIDTH_DESKTOP);
  });

  test('a 1280 el nav está en línea (sin abrir nada), con Relojes, Nosotros y Contacto, y el botón de menú no se ve', async ({ page }) => {
    await expect(mainNav(page)).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Relojes', exact: true })).toHaveAttribute('href', '/relojes');
    await expect(mainNav(page).getByRole('link', { name: 'Nosotros', exact: true })).toHaveAttribute('href', '/nosotros');
    await expect(mainNav(page).getByRole('link', { name: 'Contacto', exact: true })).toHaveAttribute('href', '/nosotros#contacto');
    await expect(search(page)).toBeVisible();
    await expect(opener(page)).toHaveCount(NONE);
  });

  test('a 800 (desde el punto de corte) el nav está en línea, sin abrir nada, dentro de la cabecera y sin desbordar', async ({ page }) => {
    await openAt(page, SHOWCASE, WIDTH_TABLET);
    await expect(mainNav(page)).toBeVisible();
    await expect(search(page)).toBeVisible();
    await expect(opener(page)).toHaveCount(NONE);
    const h = await box(header(page));
    const nav = await box(mainNav(page));
    expect(nav.x).toBeGreaterThanOrEqual(h.x - TOLERANCE);
    expect(nav.x + nav.width).toBeLessThanOrEqual(h.x + h.width + TOLERANCE);
    expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
  });

  test('a 799 (justo antes del corte) el nav se pliega en el menú: hay botón y los enlaces no se ven', async ({ page }) => {
    await openAt(page, SHOWCASE, JUST_BELOW_TABLET);
    await expect(opener(page)).toBeVisible();
    await expect(mainNav(page)).toHaveCount(NONE);
    await expect(search(page)).toHaveCount(NONE);
  });

  test('la búsqueda envía GET a /relojes con q (sin POST ni otros campos) y limita a 100 caracteres', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/relojes**', (route) => {
      requests.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>x</title><main id="contenido">ok</main>' });
    });
    const input = search(page).getByRole('searchbox');
    await input.pressSequentially(LONG_QUERY);
    expect((await input.inputValue()).length).toBe(MAX_Q);
    await input.fill('reloj dorado');
    await input.press('Enter');
    await page.waitForURL('**/relojes?**');
    const url = new URL(page.url());
    expect(url.pathname).toBe('/relojes');
    expect([...url.searchParams.keys()]).toEqual(['q']);
    expect(url.searchParams.get('q')).toBe('reloj dorado');
    expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
  });

  test('accesos: nombre accesible, href y objetivo táctil >= 44 x 44', async ({ page }) => {
    const hrefs: Record<string, string> = { 'Lista de deseos': '/cuenta/lista-de-deseos', Carrito: '/carrito', 'Mi cuenta': '/cuenta' };
    await sequence(ACCESS_NAMES, async (name) => {
      const link = access(page, name);
      await expect(link, name).toBeVisible();
      await expect(link, name).toHaveAttribute('href', hrefs[name]);
      const b = await box(link);
      expect(b.width, name).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
      expect(b.height, name).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
    });
  });

  test('sin contadores en los accesos (nada de números en la cabecera)', async ({ page }) => {
    await sequence(ACCESS_NAMES, async (name) => {
      const text = (await access(page, name).innerText()).trim();
      expect(text, name).not.toMatch(DIGIT);
    });
  });

  test('foco visible en cada control de la cabecera (contorno >= 2 px con separación >= 2 px)', async ({ page }) => {
    const rings = await sequence(indices(TAB_LIMIT), async () => {
      await page.keyboard.press('Tab');
      return page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        // El campo de búsqueda muestra el anillo en su contenedor (:focus-within): vale el del propio elemento o el de un ancestro.
        const ringOwner = [el, ...(function* () { for (let n = el.parentElement; n; n = n.parentElement) yield n; })()].find((n) => getComputedStyle(n).outlineStyle !== 'none') ?? el;
        const s = getComputedStyle(ringOwner);
        return {
          who: (el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.textContent ?? el.tagName).trim(),
          inHeader: !!el.closest('header'),
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth),
          offset: parseFloat(s.outlineOffset),
        };
      });
    });
    const inHeader = rings.filter((r) => r.inHeader);
    expect(inHeader.length).toBeGreaterThanOrEqual(FOUR);
    expect(inHeader.filter((r) => r.style === 'none' || r.width < FOCUS_RING_MIN || r.offset < FOCUS_RING_MIN)).toEqual([]);
  });

  test('contraste >= 4,5:1 en los enlaces del nav y del pie, el descriptor y los derechos', async ({ page }) => {
    const targets = [
      ...(await all(mainNav(page).getByRole('link'))),
      ...(await all(footer(page).getByRole('link'))),
      footer(page).getByText('Todos los derechos reservados'),
    ];
    const results = await sequence(targets, async (loc) => ({ text: (await loc.innerText()).slice(NONE, SNIP), ratio: (await textContrast(loc)).ratio }));
    expect(results.length).toBeGreaterThan(FOUR);
    expect(results.filter((r) => r.ratio < MIN_TEXT_CONTRAST)).toEqual([]);
  });

  test('objetivo mínimo de 24 x 24 en cada enlace de texto del nav y del pie (WCAG 2.5.8)', async ({ page }) => {
    const targets = [...(await all(mainNav(page).getByRole('link'))), ...(await all(footer(page).getByRole('link')))];
    const small = await sequence(targets, async (loc) => {
      const b = await box(loc);
      return { text: (await loc.innerText()).slice(NONE, SNIP), w: b.width, h: b.height };
    });
    expect(small.filter((s) => s.h < MIN_TARGET_AA - TOLERANCE || s.w < MIN_TARGET_AA - TOLERANCE)).toEqual([]);
  });

  test('el damero de la cabecera ocupa el 100 % del contenedor y no sobresale (overflow: clip)', async ({ page }) => {
    const info = await header(page).evaluate((h) => {
      const hb = h.getBoundingClientRect();
      const boards = [...h.querySelectorAll('[data-palette="storefront"]')].map((b) => b.getBoundingClientRect());
      return { header: hb.width, boards: boards.map((b) => ({ w: b.width, x: b.x })) };
    });
    expect(info.boards.length).toBe(ONE);
    expect(Math.abs(info.boards[NONE].w - info.header)).toBeLessThanOrEqual(TOLERANCE);
    expect(info.boards[NONE].x).toBeLessThanOrEqual(TOLERANCE);
  });

  test('pie: teléfono (tel:), correo (mailto:) y Instagram con rel seguro, enlaces legales y derechos', async ({ page }) => {
    const f = footer(page);
    await expect(f.locator('a[href^="tel:"]')).toHaveCount(ONE);
    await expect(f.locator('a[href^="mailto:"]')).toHaveCount(ONE);
    await expect(f.getByRole('link', { name: 'Privacidad' })).toHaveAttribute('href', '/privacidad');
    await expect(f.getByRole('link', { name: TERMS })).toHaveAttribute('href', '/terminos');
    await expect(f.getByText('© 2026 Valmont. Todos los derechos reservados.')).toBeVisible();
    const external = await f.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel') ?? '' })));
    expect(external.length).toBeGreaterThanOrEqual(ONE);
    external.forEach((e) => {
      expect(e.rel.split(' ')).toContain('noopener');
      expect(e.rel.split(' ')).toContain('noreferrer');
    });
  });

  test('el wordmark gigante del pie es decorativo: no aparece en el árbol de accesibilidad y no se puede enfocar', async ({ page }) => {
    const decorative = await footer(page).evaluate((f) =>
      [...f.querySelectorAll('[aria-hidden="true"]')].map((e) => ({ focusable: e.matches('a, button') || !!e.querySelector('a, button'), text: (e.textContent ?? '').trim() })),
    );
    expect(decorative.length).toBeGreaterThanOrEqual(ONE);
    expect(decorative.filter((d) => d.focusable)).toEqual([]);
  });

  test('cabecera compacta del muestrario: wordmark, Nosotros (actual) y Contacto, sin accesos ni búsqueda', async ({ page }) => {
    const compact = page.locator('main header').filter({ has: page.getByRole('link', { name: 'Nosotros', exact: true }) });
    await expect(compact).toBeVisible();
    await expect(compact.getByRole('link', { name: 'Nosotros', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(compact.getByRole('link', { name: 'Contacto', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(compact.getByRole('link', { name: 'Carrito' })).toHaveCount(NONE);
    await expect(compact.getByRole('search')).toHaveCount(NONE);
  });

  test('el título de nivel 1 y el de nivel 2 del muestrario: un h1 y un h2 de PageTitle', async ({ page }) => {
    await expect(page.locator('main h1')).toHaveCount(ONE);
    expect(await page.locator('main h2').count()).toBeGreaterThanOrEqual(ONE);
  });
});

test.describe('cabecera full · móvil con menú desplegable (360 y 375 px)', () => {
  test.describe.configure({ timeout: SLOW });

  [WIDTH_SMALL, WIDTH_PHONE].forEach((width) => {
    test.describe(`a ${width} px`, () => {
      test.beforeEach(async ({ page }) => {
        await openAt(page, SHOWCASE, width);
        await blockNavigation(page);
      });

      test('cerrado: se ven wordmark y los 4 botones de 44 px dentro de la ventana, sin solaparse; el nav no se ve', async ({ page }) => {
        const wordmark = header(page).getByRole('link', { name: VALMONT_NAME }).first();
        const buttons = [...ACCESS_NAMES.map((n) => access(page, n)), opener(page)];
        expect(buttons.length).toBe(FOUR);
        const boxes = await sequence([wordmark, ...buttons], async (loc) => box(loc));
        boxes.forEach((b, i) => {
          expect(b.x, `caja ${i}`).toBeGreaterThanOrEqual(-TOLERANCE);
          expect(b.x + b.width, `caja ${i}`).toBeLessThanOrEqual(width + TOLERANCE);
          if (i > NONE) {
            expect(b.width, `botón ${i}`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
            expect(b.height, `botón ${i}`).toBeGreaterThanOrEqual(TOUCH_TARGET - TOLERANCE);
          }
        });
        boxes.slice(ONE).forEach((b, i, arr) => {
          const prev = i === NONE ? boxes[NONE] : arr[i - ONE];
          expect(b.x, `solape ${i}`).toBeGreaterThanOrEqual(prev.x + prev.width - TOLERANCE);
        });
        expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
        await expect(mainNav(page)).toHaveCount(NONE);
        await expect(menu(page)).toBeHidden();
      });

      test('con el menú cerrado, Tab solo recorre wordmark, accesos y el botón (nada oculto recibe foco)', async ({ page }) => {
        await page.keyboard.press('Tab'); // salto al contenido
        const names = await sequence(indices(FOUR + ONE), async () => {
          await page.keyboard.press('Tab');
          return page.evaluate(() => ({
            inHeader: !!document.activeElement?.closest('header'),
            name: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '',
          }));
        });
        const inHeader = names.filter((n) => n.inHeader).map((n) => n.name);
        expect(inHeader).toHaveLength(FOUR + ONE);
        expect(inHeader).toEqual(expect.arrayContaining(ACCESS_NAMES));
        expect(inHeader.filter((n) => ['Relojes', 'Nosotros', 'Contacto', 'Buscar'].includes(n))).toEqual([]);
      });

      test('el botón abre el menú: nav y búsqueda visibles y el foco entra en el menú', async ({ page }) => {
        await opener(page).click();
        await expect(menu(page)).toBeVisible();
        await expect(mainNav(page)).toBeVisible();
        await expect(search(page)).toBeVisible();
        expect(await page.evaluate(() => !!document.activeElement?.closest('[popover]'))).toBe(true);
        await expect(menu(page)).toHaveAttribute('popover');
        expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
      });

      test('Escape cierra el menú y devuelve el foco al botón que lo abrió', async ({ page }) => {
        const btn = opener(page);
        await btn.focus();
        await page.keyboard.press('Enter');
        await expect(menu(page)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu(page)).toBeHidden();
        await expect(btn).toBeFocused();
      });

      test('se abre y cierra solo con teclado (Enter y Espacio en el botón; Escape para salir)', async ({ page }) => {
        const btn = opener(page);
        await btn.focus();
        await page.keyboard.press('Space');
        await expect(menu(page)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu(page)).toBeHidden();
        await expect(btn).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(menu(page)).toBeVisible();
      });

      test('con el menú abierto, Tab recorre sus controles y el foco no sale de la página', async ({ page }) => {
        await opener(page).click();
        const stops = await sequence(indices(TWO + FOUR), async () => {
          await page.keyboard.press('Tab');
          return page.evaluate(() => ({ tag: document.activeElement?.tagName ?? '', inMenu: !!document.activeElement?.closest('[popover]') }));
        });
        expect(stops.every((s) => s.tag !== 'BODY')).toBe(true);
        expect(stops.filter((s) => s.inMenu).length).toBeGreaterThanOrEqual(ONE);
      });

      test('elegir un enlace cierra el menú', async ({ page }) => {
        await opener(page).click();
        await expect(menu(page)).toBeVisible();
        await mainNav(page).getByRole('link', { name: 'Contacto', exact: true }).click();
        await expect(menu(page)).toBeHidden();
      });

      test('cada enlace del nav cierra el menú al elegirlo (Relojes, Nosotros, Contacto)', async ({ page }) => {
        await sequence(['Relojes', 'Nosotros', 'Contacto'], async (name) => {
          await opener(page).click();
          await expect(menu(page)).toBeVisible();
          await mainNav(page).getByRole('link', { name, exact: true }).click();
          await expect(menu(page), name).toBeHidden();
        });
      });

      test('un clic fuera del menú lo cierra', async ({ page }) => {
        await opener(page).click();
        await expect(menu(page)).toBeVisible();
        await page.mouse.click(TWO, VIEWPORT_HEIGHT - TWO);
        await expect(menu(page)).toBeHidden();
      });

      test('el menú abierto tiene 0 violaciones de axe y no desborda', async ({ page }) => {
        await opener(page).click();
        await expect(menu(page)).toBeVisible();
        await expectNoA11yViolations(page);
        expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
      });

      test('en el menú abierto los controles táctiles miden >= 44 de alto y el campo de búsqueda también', async ({ page }) => {
        await opener(page).click();
        const targets = [
          search(page).getByRole('searchbox'),
          search(page).getByRole('button'),
          ...(await all(mainNav(page).getByRole('link'))),
        ];
        const sizes = await sequence(targets, async (loc) => ({ h: (await box(loc)).height, html: (await loc.innerText().catch(() => '')).slice(NONE, SNIP) }));
        expect(sizes.filter((s) => s.h < TOUCH_TARGET - TOLERANCE)).toEqual([]);
      });

      test('cerrado y abierto el foco del botón es visible (contorno >= 2 px)', async ({ page }) => {
        await opener(page).focus();
        const ring = await opener(page).evaluate((el) => {
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset) };
        });
        expect(ring.style).not.toBe('none');
        expect(ring.width).toBeGreaterThanOrEqual(FOCUS_RING_MIN);
        expect(ring.offset).toBeGreaterThanOrEqual(FOCUS_RING_MIN);
      });
    });
  });
});

test.describe('pie y título a 360 px', () => {
  test.describe.configure({ timeout: SLOW });

  test('el pie cabe sin desbordar y sus enlaces y contacto se ven', async ({ page }) => {
    await openAt(page, SHOWCASE, WIDTH_SMALL);
    expect(await overflowX(page)).toBeLessThanOrEqual(NONE);
    await expect(footer(page).locator('a[href^="tel:"]')).toBeVisible();
    await expect(footer(page).locator('a[href^="mailto:"]')).toBeVisible();
    const b = await box(footer(page));
    expect(b.x + b.width).toBeLessThanOrEqual(WIDTH_SMALL + TOLERANCE);
  });

  test('el damero del pie ocupa el ancho del pie', async ({ page }) => {
    await openAt(page, SHOWCASE, WIDTH_SMALL);
    const info = await footer(page).evaluate((f) => ({
      footer: f.getBoundingClientRect().width,
      boards: [...f.querySelectorAll('[data-palette]')].map((b) => b.getBoundingClientRect().width),
    }));
    expect(info.boards.length).toBe(ONE);
    expect(Math.abs(info.boards[NONE] - info.footer)).toBeLessThanOrEqual(TOLERANCE);
  });
});

test.describe('prefers-reduced-motion y página real', () => {
  test.describe.configure({ timeout: SLOW });

  test('con movimiento reducido el menú sigue funcionando', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAt(page, SHOWCASE, WIDTH_SMALL);
    await opener(page).click();
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
  });

  test('en una página real (/dev/tokens) sin sesión la cabecera es idéntica entre recargas (nada por usuario)', async ({ page }) => {
    const snapshot = (): Promise<string> =>
      header(page).evaluate((h) => [...h.querySelectorAll('a, button, input')].map((e) => `${e.tagName}|${e.getAttribute('href')}|${e.getAttribute('aria-label') ?? e.textContent?.trim()}`).join(';'));
    await openAt(page, REAL_PAGE, WIDTH_DESKTOP);
    const first = await snapshot();
    await page.reload();
    expect(await snapshot()).toBe(first);
  });
});
