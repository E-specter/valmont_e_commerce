import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { openPage, sequence } from './helpers/ui-a';

// T-121 · E2E de la portada `/` con el backend real (:8000, solo lectura: GET públicos del catálogo sembrado).
// Los datos son SSR: el navegador no debe hablar con el backend ni con terceros salvo para las fotos de Storage del contrato.
const PATH = '/';
const API = 'http://127.0.0.1:8000/api/v1';
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 800;
const MAX_CLS = 0.1; // umbral "bueno" de Core Web Vitals
const SCROLL_STEP = 600;
const SETTLE_MS = 400;
const OK = 200;
const NAV_MS = 15_000;
// Origen de las fotos de producto (Storage local del contrato).
const STORAGE_ORIGIN = 'http://127.0.0.1:54321';
// Etiquetas de texto admitidas como LCP: "H1" (titular) y "A" (wordmark) casan; "IMG" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E(H1%7CA)%24&flags=
const LCP_TEXT_TAG = /^(H1|A)$/;
// Ruta del API en una URL: "http://x/api/v1/catalog" casa; "http://x/relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%2Fapi%2Fv1%2F&flags=
const API_PATH = /\/api\/v1\//;
// Parámetro de categoría en la URL: "/relojes?category=demo-vestir" casa; "/relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%5C%2Frelojes%5C%3Fcategory%3D&flags=
const CATEGORY_URL = /\/relojes\?category=/;
// Enlace a boutiques o tiendas (P-1): "Nuestras tiendas" casa; "Explorar" no.
// Probar: https://regex101.com/?flavor=javascript&regex=boutiques%7Ctiendas&flags=i
const STORES = /boutiques|tiendas/i;
// URL absoluta: "http://x" casa; "data:image/png" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Ehttps%3F%3A&flags=
const HTTP_URL = /^https?:/;
// Título del hero: "Donde la tradición relojera" casa; "Bienvenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=tradici%5Bo%C3%B3%5Dn&flags=i
const HERO_TITLE = /tradici[oó]n/i;

type Category = { slug: string; name: string };

const getJson = async <T>(page: Page, path: string): Promise<T> => {
  const res = await page.request.get(`${API}${path}`);
  expect(res.status(), `${path} del backend real`).toBe(OK);
  return (await res.json()) as T;
};

async function openAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, PATH);
}

/** Recorre la página hacia abajo para que carguen las imágenes `lazy`. */
async function scrollThrough(page: Page): Promise<void> {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const stops = Array.from({ length: Math.ceil(total / SCROLL_STEP) + ONE }, (_, i) => i * SCROLL_STEP);
  await sequence(stops, async (y) => {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(SETTLE_MS / THREE);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe('portada / con el backend real', () => {
  test.describe.configure({ timeout: SLOW });

  test('responde 200 con Cache-Control público de 60 s y sin Set-Cookie', async ({ page }) => {
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(OK);
    expect(res?.headers()['cache-control']).toBe('public, max-age=60');
    expect(res?.headers()['set-cookie']).toBeUndefined();
  });

  test('un único h1 (el del hero), landmarks de la tienda y "lang=es"', async ({ page }) => {
    await openPage(page, PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HERO_TITLE);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.getByRole('banner')).toHaveCount(ONE);
    await expect(page.getByRole('main')).toHaveCount(ONE);
    await expect(page.getByRole('contentinfo')).toHaveCount(ONE);
    await expect(page.locator('main#contenido h1')).toHaveCount(ONE);
  });

  test('3 mosaicos con las 3 primeras categorías del backend y enlaces con href /relojes?category=<slug>', async ({ page }) => {
    const cats = await getJson<Category[]>(page, '/catalog/categories');
    expect(cats.length).toBeGreaterThanOrEqual(THREE);
    await openPage(page, PATH);
    const tiles = page.locator('main > ul > li > a[href^="/relojes?category="]');
    await expect(tiles).toHaveCount(THREE);
    const hrefs = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual(cats.slice(NONE, THREE).map((c) => `/relojes?category=${encodeURIComponent(c.slug)}`));
    const names = await tiles.allInnerTexts();
    cats.slice(NONE, THREE).forEach((c, i) => expect(names[i]).toContain(c.name));
    const nav = page.getByRole('navigation', { name: 'Colecciones' });
    await expect(nav.getByRole('link')).toHaveCount(Math.min(cats.length, THREE + ONE));
    await expect(page.getByRole('link', { name: 'Ver todos los relojes' })).toHaveCount(NONE);
  });

  test('"Novedad" muestra el producto más reciente del backend con su precio y enlaza a su ficha', async ({ page }) => {
    const { items } = await getJson<{ items: { slug: string; name: string; price: { amount: number } }[] }>(
      page,
      '/catalog/products?sort=newest&page_size=1',
    );
    expect(items.length).toBeGreaterThan(NONE);
    await openPage(page, PATH);
    const section = page.locator('[aria-labelledby="featured-title"]');
    await expect(section).toHaveCount(ONE);
    await expect(section.getByRole('heading', { level: 2 })).toHaveText(items[NONE].name);
    await expect(section).toContainText('Novedad');
    await expect(section.getByRole('link').first()).toHaveAttribute('href', `/relojes/${encodeURIComponent(items[NONE].slug)}`);
    await expect(section).toContainText('S/');
  });

  test('clic en un mosaico lleva a /relojes?category=<slug>', async ({ page }) => {
    await openPage(page, PATH);
    const first = page.locator('main > ul > li > a[href^="/relojes?category="]').first();
    const href = await first.getAttribute('href');
    await first.click();
    await page.waitForURL(CATEGORY_URL, { timeout: NAV_MS });
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(href);
  });

  test('clic en "Explorar" lleva a /relojes', async ({ page }) => {
    await openPage(page, PATH);
    await page.getByRole('main').getByRole('link', { name: 'Explorar', exact: true }).click();
    await page.waitForURL('**/relojes');
    expect(new URL(page.url()).pathname).toBe('/relojes');
  });

  test('sin ChatWidget ni enlaces a boutiques/tiendas', async ({ page }) => {
    await openPage(page, PATH);
    await expect(page.getByRole('main').getByRole('link', { name: STORES })).toHaveCount(NONE);
    await expect(page.locator('[role="alert"]')).toHaveCount(NONE);
  });

  WIDTHS.forEach((width) => {
    test(`a ${String(width)} px: axe sin violaciones (WCAG 2.2 AA) y sin desbordamiento horizontal`, async ({ page }) => {
      await openAt(page, width);
      await scrollThrough(page);
      await expectNoA11yViolations(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'exceso de ancho (px)').toBeLessThanOrEqual(NONE);
      const wide = await page.evaluate(() =>
        [...document.querySelectorAll('main *')]
          .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .map((e) => `${e.tagName.toLowerCase()}.${e.className.toString()}`),
      );
      expect(wide, 'elementos que se salen por la derecha').toEqual([]);
    });
  });

  test('a 360 px los mosaicos se apilan en una columna y a 1280 px van en fila', async ({ page }) => {
    const tops = async (): Promise<{ lefts: number[]; tops: number[] }> =>
      page.locator('main > ul > li > a[href^="/relojes?category="]').evaluateAll((els) => ({
        lefts: els.map((e) => Math.round(e.getBoundingClientRect().left)),
        tops: els.map((e) => Math.round(e.getBoundingClientRect().top + window.scrollY)),
      }));
    await openAt(page, WIDTH_SMALL);
    const narrow = await tops();
    expect(new Set(narrow.lefts).size).toBe(ONE);
    expect(new Set(narrow.tops).size).toBe(THREE);
    await openAt(page, WIDTH_DESKTOP);
    const wide = await tops();
    expect(new Set(wide.tops).size).toBe(ONE);
    expect(new Set(wide.lefts).size).toBe(THREE);
  });

  test('imágenes (T-137): el hero no lleva foto (solo el símbolo decorativo, sin fetchpriority); el resto lazy con width, height y alt', async ({ page }) => {
    await openPage(page, PATH);
    const imgs = await page.locator('main img').evaluateAll((els) =>
      els.map((e) => ({
        loading: e.getAttribute('loading'),
        priority: e.getAttribute('fetchpriority'),
        width: e.getAttribute('width'),
        height: e.getAttribute('height'),
        alt: e.getAttribute('alt'),
        inHero: e.closest('section')?.querySelector('h1') !== null,
      })),
    );
    expect(imgs.length).toBeGreaterThanOrEqual(TWO);
    const hero = imgs.filter((i) => i.inHero);
    // T-137 (D-044): bloque de marca; solo el símbolo, decorativo (alt vacío) y sin prioridad alta.
    expect(hero).toHaveLength(ONE);
    expect(hero[NONE]).toMatchObject({ alt: '', priority: null });
    expect(imgs.filter((i) => i.priority === 'high')).toEqual([]);
    imgs.filter((i) => !i.inHero).forEach((i) => expect(i, JSON.stringify(i)).toMatchObject({ loading: 'lazy' }));
    imgs.forEach((i) => {
      expect(Number(i.width), JSON.stringify(i)).toBeGreaterThan(NONE);
      expect(Number(i.height), JSON.stringify(i)).toBeGreaterThan(NONE);
    });
    imgs.filter((i) => !i.inHero).forEach((i) => expect(i.alt?.length ?? NONE, JSON.stringify(i)).toBeGreaterThan(NONE));
  });

  [WIDTH_PHONE, WIDTH_DESKTOP].forEach((width) => {
    test(`a ${String(width)} px el LCP es el titular (T-137), no una imagen`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.addInitScript(() => {
        (window as unknown as { __lcp: { tag: string; priority: string | null; loading: string | null }[] }).__lcp = [];
        new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            const el = (entry as PerformanceEntry & { element?: Element | null }).element;
            (window as unknown as { __lcp: unknown[] }).__lcp.push({
              tag: el?.tagName ?? 'none',
              priority: el?.getAttribute('fetchpriority') ?? null,
              loading: el?.getAttribute('loading') ?? null,
            });
          });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await openPage(page, PATH);
      await page.waitForLoadState('load');
      await page.waitForTimeout(SETTLE_MS);
      const entries = await page.evaluate(() => (window as unknown as { __lcp: { tag: string; priority: string | null; loading: string | null }[] }).__lcp);
      expect(entries.length, 'se registró un LCP').toBeGreaterThan(NONE);
      // T-133 (D-02): el wordmark de la cabecera (enlace de texto, mayor desde 800 px) puede ser el LCP; lo que no puede ser es una imagen.
      expect(entries.at(-ONE)).toMatchObject({ tag: expect.stringMatching(LCP_TEXT_TAG), priority: null, loading: null });
    });
  });

  [WIDTH_SMALL, WIDTH_DESKTOP].forEach((width) => {
    test(`a ${String(width)} px no hay CLS apreciable (< ${String(MAX_CLS)}) tras recorrer la página`, async ({ page }) => {
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
      await openPage(page, PATH);
      await scrollThrough(page);
      await page.waitForTimeout(SETTLE_MS);
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      expect(cls).toBeLessThan(MAX_CLS);
    });
  });

  test('consola limpia: sin errores ni avisos al cargar y recorrer la página', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await openPage(page, PATH);
    await scrollThrough(page);
    expect(problems).toEqual([]);
  });

  test('el navegador no pide datos al backend ni a terceros: solo el sitio y las fotos de Storage del contrato', async ({ page }) => {
    const requests: { url: string; type: string }[] = [];
    page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
    await openPage(page, PATH);
    await scrollThrough(page);
    const own = new URL(page.url()).origin;
    // Solo se admite la hoja de símbolos de marca del propio sitio (/brand/*.svg, estática); ningún fetch/xhr/websocket más.
    const dynamic = requests.filter((r) => ['fetch', 'xhr', 'websocket', 'eventsource'].includes(r.type));
    expect(dynamic.filter((r) => !r.url.startsWith(`${own}/brand/`))).toEqual([]);
    expect(requests.filter((r) => API_PATH.test(r.url) || r.url.includes(':8000'))).toEqual([]);
    const foreign = requests.filter((r) => HTTP_URL.test(r.url) && new URL(r.url).origin !== own);
    expect(foreign.filter((r) => !(r.url.startsWith(`${STORAGE_ORIGIN}/storage/`) && r.type === 'image'))).toEqual([]);
  });

  test('al recargar dentro de la caché la página sigue respondiendo 200 (SSR estable)', async ({ page }) => {
    const first = await page.goto(PATH);
    const second = await page.reload();
    expect([first?.status(), second?.status()]).toEqual([OK, OK]);
  });
});
