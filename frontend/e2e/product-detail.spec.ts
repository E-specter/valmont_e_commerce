import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors } from './helpers/page';
import { rawGet, type Detail } from './helpers/product-stub';
import { sequence } from './helpers/ui-a';
import { formatMoney } from '../src/lib/format';

// T-125 · ficha /relojes/[slug] y 404 contra el backend real (:8000) con la semilla `seed_dev` (productos `demo-…`).
// Los valores esperados se leen de la propia API, no se escriben a mano. `E2E_PORT=4328 SUPABASE_ANON_KEY=x npm run test:e2e`.
// La API caída, las varias imágenes, los textos hostiles y el recuento de llamadas están en product-detail-stub.spec.ts.
const BACKEND = process.env.E2E_BACKEND ?? 'http://127.0.0.1:8000';
const OWN_PORT = process.env.E2E_PORT ?? '4321';
const NONE = 0;
const ONE = 1;
const OK = 200;
const NOT_FOUND = 404;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 900;
const META_MAX = 155;
const CACHE_OK = 'public, max-age=30, stale-while-revalidate=60';
const SLOW = 180_000;
const CLS_LIMIT = 0.001;
const HERO_INFO_WIDTH = 460;
const PIXEL = 1;
const NOINDEX = 'noindex, nofollow';
const CATALOG_LINK = 'Ver el catálogo';
const SCROLL_WAIT_MS = 500;
const IMAGE_DELAY_MS = 1500;

const SEED = {
  promoOnRequest: 'demo-isla-40', // promoción + bajo pedido (90 días)
  soldOut: 'demo-lira-37', // agotado
  onRequest: 'demo-kilo-42', // bajo pedido (14 días)
  inStock: 'demo-jade-39',
  lowStock: 'demo-halcon-43',
};

/** Reduce rachas de espacios y saltos de línea a un espacio: "a  b\n" → "a b". */
const norm = (s: string): string => s.replaceAll('\n', ' ').split(' ').filter(Boolean).join(' ');
const api = async (request: APIRequestContext, slug: string): Promise<Detail> => {
  const res = await request.get(`${BACKEND}/api/v1/catalog/products/${slug}`);
  expect(res.status(), `la semilla no tiene ${slug}; ¿corrió seed_dev?`).toBe(OK);
  return (await res.json()) as Detail;
};
/** El importe como lo pinta la ficha (lib/format.ts, RT-7): "S/ 10,625". El DOM lleva espacios normales, no U+00A0. */
const digits = (m: { amount: number; currency: 'PEN' }): string => formatMoney(m).replaceAll(' ', ' ');
/** En el primer acceso, el servidor de desarrollo puede recargar la página (optimización de dependencias de Vite): se reintenta una vez. */
const fontsReady = (page: Page, retries = ONE): Promise<unknown> =>
  page.evaluate(() => document.fonts.ready).catch(async (e: unknown) => {
    if (retries === NONE) throw e;
    await page.waitForLoadState('load');
    return fontsReady(page, retries - ONE);
  });
const open = async (page: Page, slug: string): Promise<void> => {
  const res = await page.goto(`/relojes/${slug}`);
  expect(res?.status()).toBe(OK);
  await fontsReady(page);
};
const main = (page: Page) => page.locator('main#contenido');
const mainImg = (page: Page) => page.locator('main img[fetchpriority="high"]');

test.describe('ficha con la semilla real', () => {
  test('200, un solo h1 con el nombre, migas, Cache-Control, title y meta description <= 155', async ({ page, request }) => {
    const data = await api(request, SEED.promoOnRequest);
    const res = await page.goto(`/relojes/${SEED.promoOnRequest}`);
    expect(res?.status()).toBe(OK);
    expect(res?.headers()['cache-control']).toBe(CACHE_OK);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(data.name);
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
    await expect(page).toHaveTitle(`${data.name} — Valmont`);
    const meta = (await page.locator('meta[name="description"]').getAttribute('content')) ?? '';
    expect(meta.length).toBeGreaterThan(NONE);
    expect(meta.length).toBeLessThanOrEqual(META_MAX);
    expect(norm(data.description).startsWith(meta.trim())).toBe(true);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', data.images[NONE]?.url ?? data.main_image.url);

    const crumbs = await page.getByRole('navigation', { name: 'Migas de pan' }).locator('li').evaluateAll((els) =>
      els.map((li) => ({ text: (li.textContent ?? '').trim(), href: li.querySelector('a')?.getAttribute('href') ?? null, current: li.querySelector('[aria-current="page"]') !== null })),
    );
    expect(crumbs).toEqual([
      { text: 'Inicio', href: '/', current: false },
      { text: 'Relojes', href: '/relojes', current: false },
      { text: data.category.name, href: `/relojes?category=${encodeURIComponent(data.category.slug)}`, current: false },
      { text: data.name, href: null, current: true },
    ]);
  });

  test('BuyBox: colección, Ref., precio con promoción del servidor, IGV incluido, bajo pedido con plazo y asesor; sin botones ni stock', async ({ page, request }) => {
    const data = await api(request, SEED.promoOnRequest);
    await open(page, SEED.promoOnRequest);
    const box = main(page);
    await expect(box).toContainText(`Colección ${data.category.name}`, { ignoreCase: true });
    await expect(box).toContainText(`Ref. ${data.sku}`);
    await expect(box).toContainText(digits(data.price));
    await expect(page.locator('main del')).toContainText(digits(data.original_price as Detail['price']));
    await expect(box).toContainText(`Ahorras`);
    await expect(box).toContainText(digits(data.discount_amount as Detail['price']));
    await expect(box).toContainText('IGV incluido');
    await expect(box).toContainText(`entrega estimada en ${data.availability.lead_time_days} días`);
    await expect(page.getByRole('link', { name: 'Consultar con un asesor' })).toHaveAttribute('href', '/nosotros#contacto');
    expect(await page.locator('main button').count()).toBe(NONE);
    expect(await page.content()).not.toContain('stock_quantity');
  });

  test('agotado: precio visible y aviso "Agotado", sin botón', async ({ page, request }) => {
    const data = await api(request, SEED.soldOut);
    expect(data.availability.status).toBe('out_of_stock');
    await open(page, SEED.soldOut);
    await expect(main(page)).toContainText('Agotado');
    await expect(main(page)).toContainText(digits(data.price));
    expect(await page.locator('main button').count()).toBe(NONE);
  });

  test('bajo pedido con plazo, en stock y pocas unidades: etiquetas de D-023 sin cantidades', async ({ page, request }) => {
    const onRequest = await api(request, SEED.onRequest);
    await open(page, SEED.onRequest);
    await expect(main(page)).toContainText(`entrega estimada en ${onRequest.availability.lead_time_days} días`);
    await open(page, SEED.inStock);
    await expect(main(page).getByText('En stock', { exact: true })).toBeVisible();
    await open(page, SEED.lowStock);
    await expect(main(page).getByText('Quedan pocas unidades')).toBeVisible();
    await expect(main(page)).not.toContainText('Quedan 1 ');
  });

  test('especificaciones del servidor y relacionados con enlace a su ficha', async ({ page, request }) => {
    const data = await api(request, SEED.promoOnRequest);
    await open(page, SEED.promoOnRequest);
    const terms = (await page.locator('main dl dt').evaluateAll((els) => els.map((e) => e.textContent ?? ''))).map((t) => t.trim());
    expect(terms[NONE]).toBe('Referencia');
    data.specs.forEach((s) => expect(terms).toContain(s.label));
    expect(new Set(terms.map((t) => t.toLowerCase())).size).toBe(terms.length);
    await expect(page.getByRole('heading', { level: 2, name: 'También te pueden interesar' })).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(data.related.length);
    await expect(page.getByRole('link', { name: data.related[NONE].name, exact: true })).toHaveAttribute('href', `/relojes/${data.related[NONE].slug}`);
  });

  test('la imagen principal es la de LCP: sin lazy, fetchpriority high, 712 x 593, con alt del contrato', async ({ page, request }) => {
    const data = await api(request, SEED.inStock);
    await open(page, SEED.inStock);
    await expect(mainImg(page)).toHaveCount(ONE);
    await expect(mainImg(page)).toHaveAttribute('src', data.images[NONE]?.url ?? data.main_image.url);
    await expect(mainImg(page)).toHaveAttribute('alt', data.images[NONE]?.alt ?? data.main_image.alt);
    await expect(mainImg(page)).toHaveAttribute('width', '712');
    await expect(mainImg(page)).toHaveAttribute('height', '593');
    expect(await mainImg(page).getAttribute('loading')).not.toBe('lazy');
    expect(await page.locator('main img[loading="lazy"][fetchpriority="high"]').count()).toBe(NONE);
  });

  test('consola limpia y ninguna petición del navegador al backend ni a /api/v1', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await open(page, SEED.promoOnRequest);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
    expect(seen.filter((u) => u.includes('/api/v1') || u.includes(':8000')), 'peticiones al backend desde el navegador').toEqual([]);
    expect(seen.filter((u) => u.includes('/bff/'))).toEqual([]);
    // Solo el propio sitio y el almacenamiento de imágenes de la semilla; nada de terceros.
    const foreign = seen.filter((u) => u.startsWith('http') && new URL(u).origin !== `http://localhost:${OWN_PORT}` && !u.includes('/storage/v1/object/public/'));
    expect(foreign).toEqual([]);
  });

  test('el HTML no contiene la URL interna del backend ni claves', async ({ page }) => {
    await open(page, SEED.promoOnRequest);
    const html = await page.content();
    ['127.0.0.1:8000', 'API_BASE_URL', 'SUPABASE_ANON_KEY', '/api/v1'].forEach((bad) => expect(html.includes(bad), bad).toBe(false));
  });
});

test.describe('404 real', () => {
  test('slug inexistente: estado HTTP 404 con la página 404 (h1 sr-only "Error 404"), mismo marco que el sitio', async ({ page }) => {
    const res = await page.goto('/relojes/este-reloj-no-existe-xyz');
    expect(res?.status()).toBe(NOT_FOUND);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Error 404');
    await expect(page.getByText('Esta página no existe')).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: CATALOG_LINK })).toHaveAttribute('href', '/relojes');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', NOINDEX);
    await expect(page.getByRole('banner')).toHaveCount(ONE);
    await expect(page.getByRole('contentinfo')).toHaveCount(ONE);
    await expect(main(page)).toHaveCount(ONE);
  });

  test('el enlace de la 404 lleva al catálogo', async ({ page }) => {
    await page.goto('/relojes/no-existe-abc');
    await page.getByRole('main').getByRole('link', { name: CATALOG_LINK }).click();
    await expect(page).toHaveURL((u) => u.pathname === '/relojes');
  });

  test('N-2 (curl --path-as-is): /relojes/. y /relojes/%2E no son una ficha ni un 5xx; slugs raros dan 404', async () => {
    const origin = `http://localhost:${OWN_PORT}`;
    // WHATWG URL quita los segmentos "." y "%2E" antes de enrutar (la guarda de la página se prueba en tests/components/product-page.test.ts).
    // Hoy no existe /relojes/ y da 404; con el listado (T-124) será el listado: nunca una ficha de producto ni un 5xx.
    const dots = await sequence(['/relojes/.', '/relojes/%2E'], (path) => rawGet(origin, path));
    dots.forEach((r) => expect(r.status === NOT_FOUND || (r.status === OK && !r.body.includes('IGV incluido'))).toBe(true));
    const odd = await sequence(['/relojes/a%2Fb', '/relojes/%3Cscript%3E'], (path) => rawGet(origin, path));
    expect(odd.map((r) => r.status)).toEqual(odd.map(() => NOT_FOUND));
    odd.forEach((r) => {
      expect(r.body).toContain('Error 404');
      expect(r.body).not.toContain('<script>alert');
    });
  });

  test('un 404 y un 200 tienen cabeceras distintas: la 404 no se sirve con la caché del producto', async () => {
    const origin = `http://localhost:${OWN_PORT}`;
    const gone = await rawGet(origin, '/relojes/no-existe-cabecera');
    const ok = await rawGet(origin, `/relojes/${SEED.inStock}`);
    expect(ok.headers['cache-control']).toBe(CACHE_OK);
    expect(gone.status).toBe(NOT_FOUND);
    expect(String(gone.headers['cache-control'] ?? '')).not.toBe(CACHE_OK);
  });
});

test.describe('accesibilidad y diseño adaptable (semilla real)', () => {
  const slugs = [SEED.promoOnRequest, SEED.soldOut];
  slugs.forEach((slug) => {
    WIDTHS.forEach((width) => {
      test(`axe (WCAG 2.2 AA): 0 violaciones en ${slug} a ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await open(page, slug);
        await expectNoA11yViolations(page);
      });
    });
  });

  WIDTHS.forEach((width) => {
    test(`axe: la 404 a ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.goto('/relojes/no-existe-axe');
      await expectNoA11yViolations(page);
    });
  });

  test('sin desbordamiento horizontal a 360, 375, 800 y 1280; apilado hasta 800 y en dos columnas (info de 460 px) a 1280', async ({ page }) => {
    test.setTimeout(SLOW);
    const reports = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, SEED.promoOnRequest);
      return page.evaluate((w) => {
        const img = document.querySelector('main img[fetchpriority="high"]') as HTMLElement;
        const h1 = document.querySelector('main h1') as HTMLElement;
        const info = document.querySelector('main section[aria-label="Compra"]') as HTMLElement;
        const g = img.getBoundingClientRect();
        const b = h1.getBoundingClientRect();
        const outside = [...document.querySelectorAll('main article, main nav, main dl, main section')].filter((e) => e.getBoundingClientRect().right > w + 1).length;
        return {
          width: w,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          outside,
          stacked: b.top >= g.bottom - 1,
          sideBySide: b.left >= g.right - 1,
          info: Math.round(info.getBoundingClientRect().width),
        };
      }, width);
    });
    expect(reports.filter((r) => r.overflow > NONE || r.outside > NONE)).toEqual([]);
    expect(reports.filter((r) => r.width < WIDTH_DESKTOP).map((r) => r.stacked)).toEqual([true, true, true]);
    const desktop = reports[reports.length - ONE];
    expect(desktop.sideBySide).toBe(true);
    expect(Math.abs(desktop.info - HERO_INFO_WIDTH)).toBeLessThanOrEqual(PIXEL);
  });

  test('sin desplazamiento de diseño al cargar (CLS vertical ~ 0 tras la carga de fuentes)', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shifts: { value: number; at: number }[] };
      w.__shifts = [];
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          const s = e as unknown as { value: number; hadRecentInput: boolean; startTime: number };
          if (!s.hadRecentInput) w.__shifts.push({ value: s.value, at: s.startTime });
        });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.setViewportSize({ width: WIDTH_PHONE, height: VIEWPORT_HEIGHT });
    await open(page, SEED.promoOnRequest);
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('main img[fetchpriority="high"]')?.complete === true);
    const settledAt = await page.evaluate(() => performance.now());
    await page.evaluate(async (wait) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, wait));
      window.scrollTo(0, 0);
      await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
    }, SCROLL_WAIT_MS);
    const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; at: number }[] }).__shifts);
    expect(shifts.filter((s) => s.at > settledAt).reduce((sum, s) => sum + s.value, NONE), JSON.stringify(shifts)).toBeLessThan(CLS_LIMIT);
  });

  test('la imagen principal no desplaza el contenido: su caja con la imagen retrasada es la misma que cuando llega', async ({ page }) => {
    // Se retrasa la imagen del almacenamiento 1,5 s; la caja reservada (712:593) no puede cambiar al llegar.
    await page.route('**/storage/v1/object/public/**', async (route) => {
      await new Promise((r) => setTimeout(r, IMAGE_DELAY_MS));
      await route.continue();
    });
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await page.goto(`/relojes/${SEED.inStock}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    const box = (): Promise<{ w: number; h: number; top: number }> =>
      mainImg(page).evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top };
      });
    const before = await box();
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('main img[fetchpriority="high"]')?.complete === true);
    const after = await box();
    expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(PIXEL);
    expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(PIXEL);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(PIXEL);
  });
});
