import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { FOCUS_RING_MIN, TOUCH_TARGET, indices, openPage, sequence } from './helpers/ui-a';

// T-123 · E2E de /dev/products (muestrario de ProductCard, ProductGrid, Breadcrumb, Pagination y DefinitionList; solo existe con `astro dev`)
// en 1280 y 375 (proyectos desktop y mobile) y en 360, 375, 800 y 1280 con setViewportSize.
// No dependen del marcado interno: localizan por rol, atributos ARIA y estilos calculados. Las rejillas se identifican por
// `ul[aria-label]` con tarjetas, en el orden del paquete: store, related, wishlist, compact.
const PAGE = '/dev/products';
const SLOW = 180_000;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 800;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const TAB_LIMIT = 200;
const PIXEL_TOLERANCE = 1;
const CLS_LIMIT = 0.001;
const TALL_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="2000"><rect width="100" height="2000" fill="gray"/></svg>')}`;
const WIDE_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="100"><rect width="2000" height="100" fill="gray"/></svg>')}`;
const ASPECT_PORTRAIT = FOUR / (FOUR + ONE); // 4:5
const ASPECT_SQUARE = ONE;
const ASPECT_TOLERANCE = 0.02;

const IDX = { store: NONE, related: ONE, wishlist: TWO, compact: THREE } as const;
const open = (page: Page): Promise<void> => openPage(page, PAGE);
const main = (page: Page): Locator => page.locator('main#contenido');
const grids = (page: Page): Locator => page.locator('main ul[aria-label]').filter({ has: page.locator('article') });
const grid = (page: Page, variant: keyof typeof IDX): Locator => grids(page).nth(IDX[variant]);
const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));
const columns = (ul: Locator): Promise<number> =>
  ul.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);

test.describe('página de muestra', () => {
  test('carga sin errores de consola ni peticiones a terceros; un h1 y un solo main#contenido', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page);
    await open(page);
    expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
    await expect(main(page)).toHaveCount(ONE);
  });

  test('muestra las cuatro variantes, las migas, la lista de definiciones y los estados de paginación', async ({ page }) => {
    await open(page);
    await expect(grids(page)).toHaveCount(FOUR);
    await expect(page.getByRole('navigation', { name: 'Migas de pan' })).toHaveCount(ONE);
    expect(await page.locator('main dl dt').count()).toBeGreaterThan(NONE);
    // Varios estados de paginación (primera, intermedias, última): cada uno con una sola página actual; al menos dos con un extremo deshabilitado.
    const pagers = page.getByRole('navigation', { name: 'Paginación' });
    expect(await pagers.count()).toBeGreaterThanOrEqual(FOUR);
    expect(await page.locator('main nav [aria-disabled="true"]').count()).toBeGreaterThanOrEqual(TWO);
    const currents = await pagers.evaluateAll((navs) => navs.map((n) => n.querySelectorAll('[aria-current="page"]').length));
    expect(currents.filter((n) => n !== ONE)).toEqual([]);
    // Estados de producto del paquete: promoción, agotado, bajo pedido, sin imagen.
    await expect(page.locator('main del').first()).toBeVisible();
    await expect(main(page).getByText('Agotado').first()).toBeVisible();
    await expect(main(page).getByText('Bajo pedido').first()).toBeVisible();
    await expect(page.locator('main article [role="img"]').first()).toBeVisible();
  });

  test('un enlace por tarjeta con el nombre del producto; sin enlaces anidados', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('link', { name: 'Tourbillon Aurora', exact: true })).toHaveCount(FOUR);
    expect(await page.locator('main article a a').count()).toBe(NONE);
    const perCard = await page.locator('main article').evaluateAll((els) => els.map((e) => e.querySelectorAll('a').length));
    expect(perCard.length).toBeGreaterThan(NONE);
    expect(perCard.filter((n) => n !== ONE)).toEqual([]);
  });
});

test.describe('accesibilidad y diseño adaptable', () => {
  WIDTHS.forEach((width) => {
    test(`axe (WCAG 2.2 AA): 0 violaciones a ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page);
      await expectNoA11yViolations(page);
    });
  });

  test('sin desplazamiento horizontal ni tarjetas fuera del viewport a 360, 375, 800 y 1280', async ({ page }) => {
    test.setTimeout(SLOW);
    const reports = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page);
      return page.evaluate((w) => {
        const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const outside = [...document.querySelectorAll('main article, main nav, main dl')].filter((e) => e.getBoundingClientRect().right > w + 1).length;
        return { width: w, overflow, outside };
      }, width);
    });
    expect(reports.filter((r) => r.overflow > NONE || r.outside > NONE)).toEqual([]);
  });

  test('la rejilla de store pasa de 1 columna (360 y 375) a 2 (800) y 3 (1280); la compacta es siempre una columna', async ({ page }) => {
    test.setTimeout(SLOW);
    const expected = new Map([
      [WIDTH_SMALL, ONE],
      [WIDTH_PHONE, ONE],
      [WIDTH_TABLET, TWO],
      [WIDTH_DESKTOP, THREE],
    ]);
    const reports = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page);
      const [store, related, wishlist, compact] = await Promise.all((['store', 'related', 'wishlist', 'compact'] as const).map((v) => columns(grid(page, v))));
      return { width, store, related, wishlist, compact };
    });
    expect(reports.map((r) => [r.width, r.store, r.related, r.wishlist])).toEqual(
      WIDTHS.map((w) => [w, expected.get(w), expected.get(w), expected.get(w)]),
    );
    expect(reports.map((r) => r.compact)).toEqual(WIDTHS.map(() => ONE));
  });

  test('la rejilla responde al contenedor, no al viewport (container query)', async ({ page }) => {
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page);
    const wide = await columns(grid(page, 'store'));
    // Se estrecha el contenedor de la rejilla sin cambiar el viewport.
    await grid(page, 'store').evaluate((ul) => {
      const wrapper = ul.parentElement as HTMLElement;
      wrapper.style.width = '360px';
    });
    const narrow = await columns(grid(page, 'store'));
    expect(wide).toBe(THREE);
    expect(narrow).toBe(ONE);
  });

  test('las tarjetas con nombre largo no desbordan y los textos se ajustan a su tarjeta', async ({ page }) => {
    await page.setViewportSize({ width: WIDTH_SMALL, height: VIEWPORT_HEIGHT });
    await open(page);
    const cards = await all(page.locator('main article'));
    const overflowing = await sequence(cards, (c) =>
      c.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const bad = [...el.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().right > box.right + 1 && getComputedStyle(n).position !== 'absolute');
        return bad.length;
      }),
    );
    expect(overflowing.filter((n) => n > NONE)).toEqual([]);
  });
});

test.describe('tarjeta de producto', () => {
  test('la relación de aspecto de la imagen es fija por variante: 4:5 en store y wishlist, 1:1 en related y compact', async ({ page }) => {
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page);
    const ratios = await sequence(['store', 'wishlist', 'related', 'compact'] as const, async (variant) => {
      const box = await grid(page, variant).locator('article img').first().boundingBox();
      return [variant, (box?.width ?? NONE) / (box?.height ?? ONE)] as const;
    });
    const expected = { store: ASPECT_PORTRAIT, wishlist: ASPECT_PORTRAIT, related: ASPECT_SQUARE, compact: ASPECT_SQUARE };
    ratios.forEach(([variant, ratio]) => expect(Math.abs(ratio - expected[variant]), `${variant}: ${ratio}`).toBeLessThan(ASPECT_TOLERANCE));
  });

  test('cada imagen lleva width, height, alt, decoding async y loading lazy salvo las tres primeras de store', async ({ page }) => {
    await open(page);
    const imgs = await grid(page, 'store').locator('img').evaluateAll((els) =>
      els.map((e) => ({
        width: e.getAttribute('width'),
        height: e.getAttribute('height'),
        alt: e.getAttribute('alt'),
        decoding: e.getAttribute('decoding'),
        loading: e.getAttribute('loading'),
        priority: e.getAttribute('fetchpriority'),
      })),
    );
    expect(imgs.length).toBeGreaterThan(NONE);
    imgs.forEach((img, i) => {
      expect(Number(img.width)).toBeGreaterThan(NONE);
      expect(Number(img.height)).toBeGreaterThan(NONE);
      expect((img.alt ?? '').trim()).not.toBe('');
      expect(img.decoding).toBe('async');
      expect(img.loading).toBe(i < THREE ? 'eager' : 'lazy');
      expect(img.priority === 'high').toBe(i < THREE);
    });
    const others = await page.locator('main ul[aria-label]').nth(ONE).locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('loading')));
    expect(others.filter((l) => l !== 'lazy')).toEqual([]);
  });

  test('toda la tarjeta es clicable: cualquier punto interior resuelve al único enlace de la tarjeta', async ({ page }) => {
    test.setTimeout(SLOW);
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page);
    const cards = await all(page.locator('main article'));
    const misses = await sequence(cards, async (card) => {
      await card.scrollIntoViewIfNeeded();
      return card.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const link = el.querySelector('a');
        const points: [number, number][] = [
          [box.left + box.width / 2, box.top + box.height / 2],
          [box.left + 6, box.top + 6],
          [box.right - 6, box.top + 6],
          [box.left + 6, box.bottom - 6],
          [box.right - 6, box.bottom - 6],
        ];
        return points.filter(([x, y]) => document.elementFromPoint(x, y)?.closest('a') !== link).length;
      });
    });
    expect(misses.filter((n) => n > NONE)).toEqual([]);
  });

  test('un clic en la imagen navega a /relojes/{slug}', async ({ page }) => {
    await page.route('**/relojes/tourbillon-2026', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Ficha</h1>' }));
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page);
    // El enlace extendido cubre la imagen: se hace clic con el ratón en su centro, como lo haría una persona.
    const box = await grid(page, 'store').locator('article').first().locator('img').boundingBox();
    await page.mouse.click((box?.x ?? NONE) + (box?.width ?? NONE) / TWO, (box?.y ?? NONE) + (box?.height ?? NONE) / TWO);
    await page.waitForURL('**/relojes/tourbillon-2026');
    expect(new URL(page.url()).pathname).toBe('/relojes/tourbillon-2026');
  });

  test('el foco por teclado es visible (anillo >= 2 px), recorre solo enlaces reales y no cae en deshabilitados ni elipsis', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const stops = await sequence(indices(TAB_LIMIT), async () => {
      await page.keyboard.press('Tab');
      return page.evaluate((min) => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest('main')) return { inMain: false } as const;
        const ringOf = (n: Element): number => {
          const cs = getComputedStyle(n);
          return cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth);
        };
        const card = el.closest('article');
        return {
          inMain: true,
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30),
          ring: Math.max(ringOf(el), card ? ringOf(card) : 0),
          ok: ringOf(el) >= min || (card ? ringOf(card) >= min : false),
          bad: el.closest('[aria-disabled="true"], [aria-hidden="true"]') !== null,
        } as const;
      }, FOCUS_RING_MIN);
    });
    const inMain = stops.filter((s) => s.inMain);
    expect(inMain.length).toBeGreaterThan(THREE);
    expect(inMain.filter((s) => s.inMain && s.tag !== 'a').map((s) => s.inMain && s.tag)).toEqual([]);
    expect(inMain.filter((s) => s.inMain && !s.ok).map((s) => s.inMain && s.label)).toEqual([]);
    expect(inMain.filter((s) => s.inMain && s.bad)).toEqual([]);
  });

  test('objetivos táctiles >= 44 px: tarjetas, enlaces de migas y controles de paginación', async ({ page }) => {
    test.setTimeout(SLOW);
    const reports = await sequence([WIDTH_PHONE, WIDTH_DESKTOP], async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page);
      return page.evaluate((min) => {
        const small = (sel: string): string[] =>
          [...document.querySelectorAll(sel)]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width < min - 1 || r.height < min - 1;
            })
            .map((e) => `${sel}: ${(e.textContent ?? '').trim().slice(0, 20)}`);
        // RT-4: tarjetas, migas y paginación, 44 x 44.
        return {
          width: window.innerWidth,
          bad: [
            ...small('main article'),
            ...small('main nav[aria-label="Paginación"] a'),
            ...small('main nav[aria-label="Paginación"] [aria-disabled="true"]'),
            ...small('main nav[aria-label="Migas de pan"] a'),
            ...small('main nav[aria-label="Migas de pan"] [aria-current="page"]'),
          ],
        };
      }, TOUCH_TARGET);
    });
    expect(reports.filter((r) => r.bad.length > NONE)).toEqual([]);
  });

  test('el texto se muestra como texto: el nombre largo no recorta el precio ni la disponibilidad', async ({ page }) => {
    await page.setViewportSize({ width: WIDTH_SMALL, height: VIEWPORT_HEIGHT });
    await open(page);
    const long = page.locator('main article').filter({ hasText: 'nombre largo' }).first();
    await expect(long).toBeVisible();
    await expect(long.getByText('Agotado')).toBeVisible();
    await expect(long.getByText('32,000')).toBeVisible();
  });
});

test.describe('estabilidad visual (CLS)', () => {
  test('las imágenes no provocan desplazamiento de diseño al cargar y recorrer la página', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shifts: { value: number; at: number; nodes: string[] }[] };
      w.__shifts = [];
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          const shift = e as unknown as { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] };
          if (shift.hadRecentInput) return;
          const vertical = (shift.sources ?? []).some((s) => {
            const src = s as unknown as { previousRect: DOMRect; currentRect: DOMRect };
            return Math.abs(src.previousRect.y - src.currentRect.y) > 0.5 || Math.abs(src.previousRect.height - src.currentRect.height) > 0.5;
          });
          w.__shifts.push({ value: shift.value, at: e.startTime, nodes: vertical ? ['vertical'] : ['horizontal'] });
        });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.setViewportSize({ width: WIDTH_PHONE, height: VIEWPORT_HEIGHT });
    await open(page);
    // Las fuentes web (font-display) pueden recolocar el texto al cargar: ese cambio no es de las imágenes. Se mide desde que ya están listas.
    const settledAt = await page.evaluate(() => performance.now());
    await page.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 500));
      window.scrollTo(0, 0);
      await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
    });
    const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; at: number; nodes: string[] }[] }).__shifts);
    const cardShifts = shifts.filter((s) => s.at > settledAt && s.nodes.includes('vertical')).reduce((sum, s) => sum + s.value, NONE);
    expect(cardShifts, JSON.stringify(shifts)).toBeLessThan(CLS_LIMIT);
  });

  test('cambiar la imagen por otra de proporción muy distinta no altera ninguna caja de la tarjeta (el espacio está reservado)', async ({ page }) => {
    test.setTimeout(SLOW);
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page);
    const measure = (): Promise<number[][]> =>
      page.evaluate(() =>
        [...document.querySelectorAll('main article')].flatMap((a) => [a, ...a.querySelectorAll('img, [role="img"]')]).map((e) => {
          const r = e.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)];
        }),
      );
    const before = await measure();
    const swap = (src: string): Promise<void> =>
      page.evaluate(async (url) => {
        await Promise.all(
          [...document.querySelectorAll('main article img')].map(
            (img) => new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
              (img as HTMLImageElement).loading = 'eager';
              img.setAttribute('src', url);
            }),
          ),
        );
      }, src);
    await swap(TALL_SVG);
    const tall = await measure();
    await swap(WIDE_SVG);
    const wide = await measure();
    const drift = (a: number[][], b: number[][]): number => Math.max(...a.flatMap((box, i) => box.map((v, j) => Math.abs(v - b[i][j]))));
    expect(before.length).toBeGreaterThan(NONE);
    expect(drift(before, tall)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    expect(drift(before, wide)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  });
});
