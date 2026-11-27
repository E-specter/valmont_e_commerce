import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, openFilters } from './helpers/page';
import { LEAK, startSite, startStub, type Site, type Stub } from './helpers/stub-site';

// T-124 · estados que el backend real no produce con 12 productos: paginación (60 relojes simulados), 422, 5xx, JSON roto,
// API caída y el no-envío de parámetros. Se prueba el servidor de PRODUCCIÓN de Astro (`dist/`, requiere `npm run build`)
// contra una API simulada y sin base de datos. Los puertos dependen del proyecto (desktop/mobile) para no chocar.
test.describe.configure({ mode: 'default' });

const PATH = '/relojes';
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_GATEWAY = 502;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const PAGE_SIZE = 24;
const TOTAL = 60;
const CAT_A_TOTAL = 30;
const CAT_B_TOTAL = 5;
const PRICE_MIN_SOLES = 100; // S/ 100 = 10000 céntimos: no recorta la semilla simulada
const LONG_Q = 150;
const MAX_Q = 100;
const BASE_PORT = 4331;
const PORT_SPAN = 2;
const WIDE = 1280;
const PHONE = 375;
const HEIGHT = 800;
const CACHE_OK = 'public, max-age=30, stale-while-revalidate=60';
const DIST_CLIENT = resolve(import.meta.dirname, '../dist/client');
// Hay una instancia por proyecto (desktop = 0, mobile = 1): dos puertos cada una (con API y con la API caída).
const PORT_OFFSET: Record<string, number> = { desktop: NONE, mobile: PORT_SPAN };
// Puerto cerrado: nadie escucha (conexión rechazada), para "API caída".
const DEAD_API = 'http://127.0.0.1:9';

let stub: Stub;
let site: Site;
let dead: Site;

test.beforeAll(async ({}, info) => {
  const base = BASE_PORT + (PORT_OFFSET[info.project.name] ?? NONE);
  stub = await startStub();
  site = await startSite(base, stub.url);
  dead = await startSite(base + ONE, DEAD_API);
});

test.afterAll(async () => {
  site?.stop();
  dead?.stop();
  await stub?.close();
});

test.beforeEach(() => {
  stub.setMode('ok');
  stub.hits.length = NONE;
});

const cards = (page: Page) => page.locator('main article');
const notice = (page: Page) => page.getByRole('alert');
const countOf = async (page: Page): Promise<number> => {
  const text = await page.locator('main [role="status"]').filter({ hasText: 'modelo' }).textContent();
  return Number.parseInt(text ?? '', 10);
};
const names = (page: Page): Promise<string[]> => page.locator('main article h2 a').allTextContents();
const pager = (page: Page) => page.getByRole('navigation', { name: 'Paginación' });
const lastQuery = (): URLSearchParams => stub.productHits().at(-ONE)?.query ?? new URLSearchParams();

test.describe('paginación (60 relojes simulados, 24 por página)', () => {
  test('página 1: 24 tarjetas, total 60, 3 páginas, y el servidor pidió page=1 y page_size=24', async ({ page }) => {
    const res = await page.goto(`${site.url}${PATH}`);
    expect(res?.status()).toBe(HTTP_OK);
    expect(res?.headers()['cache-control']).toBe(CACHE_OK);
    expect(await cards(page).count()).toBe(PAGE_SIZE);
    expect(await countOf(page)).toBe(TOTAL);
    await expect(pager(page)).toHaveCount(ONE);
    expect(lastQuery().get('page')).toBe('1');
    expect(lastQuery().get('page_size')).toBe(String(PAGE_SIZE));
    // Una sola petición de listado y una de categorías y atributos por vista.
    expect(stub.productHits()).toHaveLength(ONE);
    expect(stub.hits.filter((h) => h.path.endsWith('/catalog/categories'))).toHaveLength(ONE);
    expect(stub.hits.filter((h) => h.path.endsWith('/catalog/attributes'))).toHaveLength(ONE);
  });

  test('las páginas 2 y 3 traen su tramo (24 y 12 tarjetas) sin repetir productos', async ({ page }) => {
    await page.goto(`${site.url}${PATH}`);
    const first = await names(page);
    await page.goto(`${site.url}${PATH}?page=2`);
    const second = await names(page);
    await page.goto(`${site.url}${PATH}?page=3`);
    const third = await names(page);
    expect([first.length, second.length, third.length]).toEqual([PAGE_SIZE, PAGE_SIZE, TOTAL - PAGE_SIZE * TWO]);
    expect(new Set([...first, ...second, ...third]).size).toBe(TOTAL);
  });

  test('los enlaces de paginación conservan TODOS los filtros y ordenar', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?category=cat-a&sort=price_desc&price_min=${PRICE_MIN_SOLES}`);
    expect(await countOf(page)).toBeLessThan(TOTAL);
    const links = await pager(page).getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
    expect(links.length).toBeGreaterThan(NONE);
    links.forEach((href) => {
      const sp = new URL(href, 'http://x').searchParams;
      expect(sp.get('category'), href).toBe('cat-a');
      expect(sp.get('sort'), href).toBe('price_desc');
      expect(sp.get('price_min'), href).toBe(String(PRICE_MIN_SOLES));
    });
  });

  test('ir a la página 2 con el enlace conserva los filtros y pide ese tramo a la API', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?category=cat-a&sort=price_asc`);
    expect(await countOf(page)).toBe(CAT_A_TOTAL);
    await Promise.all([page.waitForURL((u) => u.searchParams.get('page') === '2'), pager(page).getByRole('link', { name: 'Siguiente' }).click()]);
    const sp = new URL(page.url()).searchParams;
    expect(sp.get('category')).toBe('cat-a');
    expect(sp.get('sort')).toBe('price_asc');
    expect(await cards(page).count()).toBe(CAT_A_TOTAL - PAGE_SIZE);
    expect(lastQuery().get('category')).toBe('cat-a');
    expect(lastQuery().get('page')).toBe('2');
    expect(lastQuery().get('sort')).toBe('price_asc');
    expect(await names(page)).toEqual(['Reloj 24', 'Reloj 25', 'Reloj 26', 'Reloj 27', 'Reloj 28', 'Reloj 29']);
  });

  test('la página 1 de la paginación no lleva page= en la URL', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?category=cat-a&page=2`);
    const first = pager(page).getByRole('link', { name: 'Página 1', exact: true });
    expect(new URL((await first.getAttribute('href')) ?? '', 'http://x').searchParams.has('page')).toBe(false);
  });

  test('cambiar un filtro desde el formulario reinicia page a 1', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?page=2`);
    await openFilters(page);
    await page.getByLabel('Colección', { exact: true }).selectOption('cat-b');
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'cat-b'), page.getByRole('button', { name: 'Aplicar' }).click()]);
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
    expect(await countOf(page)).toBe(CAT_B_TOTAL);
  });

  test('"Quitar" un chip desde la página 2 reinicia page', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?category=cat-a&page=2`);
    await page.getByRole('link', { name: 'Quitar filtro Colección Alfa' }).click();
    await page.waitForURL((u) => !u.searchParams.has('category'));
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  });

  test('page fuera de rango redirige 302 a la última página con los filtros', async ({ request }) => {
    const res = await request.get(`${site.url}${PATH}?category=cat-a&page=99`, { maxRedirects: 0 });
    expect(res.status()).toBe(HTTP_FOUND);
    const target = new URL(res.headers().location ?? '', 'http://x');
    expect(target.searchParams.get('category')).toBe('cat-a');
    expect(target.searchParams.get('page')).toBe('2');
    const sinFiltro = await request.get(`${site.url}${PATH}?page=99`, { maxRedirects: 0 });
    expect(sinFiltro.status()).toBe(HTTP_FOUND);
    expect(new URL(sinFiltro.headers().location ?? '', 'http://x').searchParams.get('page')).toBe('3');
  });

  test('la última página existente NO redirige', async ({ request }) => {
    expect((await request.get(`${site.url}${PATH}?page=3`, { maxRedirects: 0 })).status()).toBe(HTTP_OK);
  });

  test('sin resultados con page>1 (total 0) no entra en bucle de redirección: 200 y estado vacío', async ({ page }) => {
    const res = await page.goto(`${site.url}${PATH}?category=vacia&page=4`);
    expect(res?.status()).toBe(HTTP_OK);
    await expect(page.getByRole('heading', { name: 'Ningún reloj coincide con tu búsqueda' })).toBeVisible();
  });
});

test.describe('lo que se envía a la API (frontera de confianza)', () => {
  test('soles → céntimos y nombres de la API; sin parámetros ajenos ni page_size del visitante', async ({ request }) => {
    await request.get(
      `${site.url}${PATH}?category=cat-a&movement=automatic&case_material=steel&price_min=1500&price_max=9000&available=1&sort=price_asc&foo=bar&admin=1&page_size=1000&is_published=false`,
    );
    const q = lastQuery();
    expect(q.get('price_min')).toBe('150000');
    expect(q.get('price_max')).toBe('900000');
    expect(q.get('available')).toBe('true');
    expect(q.get('page_size')).toBe(String(PAGE_SIZE));
    const allowed = ['q', 'category', 'movement', 'case_material', 'price_min', 'price_max', 'available', 'sort', 'page', 'page_size'];
    expect([...q.keys()].filter((k) => !allowed.includes(k))).toEqual([]);
  });

  test('slugs y valores hostiles nunca llegan a la API', async ({ request }) => {
    await request.get(`${site.url}${PATH}?category=${encodeURIComponent("x'; DROP TABLE products;--")}&movement=../admin&sort=hacked&price_min=-1&price_max=1e3&page=-2`);
    const q = lastQuery();
    expect(q.has('category')).toBe(false);
    expect(q.has('movement')).toBe(false);
    expect(q.has('sort')).toBe(false);
    expect(q.has('price_min')).toBe(false);
    expect(q.has('price_max')).toBe(false);
    expect(q.get('page')).toBe('1');
  });

  test('q se recorta a 100 caracteres antes de pedirlo', async ({ request }) => {
    await request.get(`${site.url}${PATH}?q=${'a'.repeat(LONG_Q)}`);
    expect(lastQuery().get('q')).toBe('a'.repeat(MAX_Q));
  });

  test('q con caracteres de control no llega con ellos a la API', async ({ request }) => {
    await request.get(`${site.url}${PATH}?q=${encodeURIComponent('reloj\u0000\u0007x')}`);
    const q = lastQuery().get('q') ?? '';
    expect([...q].some((c) => c.charCodeAt(NONE) < ' '.charCodeAt(NONE))).toBe(false);
  });

  test('relevance sin q no se pide (CATALOG-R8)', async ({ request }) => {
    await request.get(`${site.url}${PATH}?sort=relevance`);
    expect(lastQuery().has('sort')).toBe(false);
  });

  test('rango invertido (price_min > price_max): NINGUNA petición a la API, Notice y no-store', async ({ page }) => {
    const res = await page.goto(`${site.url}${PATH}?price_min=9000&price_max=100`);
    expect(res?.status()).toBe(HTTP_OK);
    expect(res?.headers()['cache-control']).toBe('no-store');
    expect(stub.hits).toEqual([]);
    await expect(notice(page)).toContainText('Revisa los filtros');
    await expect(notice(page).getByRole('link', { name: 'Limpiar filtros' })).toHaveAttribute('href', PATH);
    expect(await cards(page).count()).toBe(NONE);
  });

  test('rango igual (min = max) sí es válido y se pide', async ({ request }) => {
    const res = await request.get(`${site.url}${PATH}?price_min=1000&price_max=1000`);
    expect(res.status()).toBe(HTTP_OK);
    expect(stub.productHits()).toHaveLength(ONE);
  });

  test('el navegador nunca habla con la API: ninguna petición del cliente va al origen de la API', async ({ page }) => {
    const origin = new URL(stub.url).origin;
    const toApi: string[] = [];
    page.on('request', (r) => {
      if (r.url().startsWith(origin)) toApi.push(r.url());
    });
    await page.goto(`${site.url}${PATH}?category=cat-a`);
    await page.getByRole('link', { name: 'Siguiente' }).click();
    await page.waitForLoadState('load');
    expect(toApi).toEqual([]);
  });
});

test.describe('estados de error', () => {
  test('422 de la API: 200 con Notice "Revisa los filtros", sin caché y sin filtrar detalles', async ({ page }) => {
    stub.setMode('validation');
    const res = await page.goto(`${site.url}${PATH}?q=algo`);
    expect(res?.status()).toBe(HTTP_OK);
    expect(res?.headers()['cache-control']).toBe('no-store');
    await expect(notice(page)).toContainText('Revisa los filtros');
    await expect(notice(page).getByRole('link', { name: 'Limpiar filtros' })).toHaveAttribute('href', PATH);
    expect(await page.content()).not.toContain(LEAK);
    expect(await cards(page).count()).toBe(NONE);
  });

  test('5xx de la API: 502, no-store, "Reintentar" a la misma URL y sin trazas del servidor', async ({ page }) => {
    stub.setMode('server-error');
    const url = `${PATH}?category=cat-a&sort=price_asc&page=2`;
    const res = await page.goto(`${site.url}${url}`);
    expect(res?.status()).toBe(HTTP_BAD_GATEWAY);
    expect(res?.headers()['cache-control']).toBe('no-store');
    await expect(notice(page)).toContainText('No pudimos cargar los relojes');
    await expect(notice(page).getByRole('link', { name: 'Reintentar' })).toHaveAttribute('href', url);
    const html = await page.content();
    expect(html).not.toContain(LEAK);
    expect(html).not.toContain('Traceback');
    expect(await cards(page).count()).toBe(NONE);
    await expect(page.getByRole('heading', { name: 'Ningún reloj coincide con tu búsqueda' })).toHaveCount(NONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
  });

  test('"Reintentar" funciona cuando la API se recupera', async ({ page }) => {
    stub.setMode('server-error');
    await page.goto(`${site.url}${PATH}?category=cat-b`);
    stub.setMode('ok');
    await page.getByRole('link', { name: 'Reintentar' }).click();
    await page.waitForLoadState('load');
    expect(await cards(page).count()).toBe(CAT_B_TOTAL);
    await expect(notice(page)).toHaveCount(NONE);
  });

  test('JSON roto en una respuesta 200: 502 (nunca 500) y sin filtrar el cuerpo', async ({ page }) => {
    stub.setMode('bad-json');
    const res = await page.goto(`${site.url}${PATH}`);
    expect(res?.status()).toBe(HTTP_BAD_GATEWAY);
    expect(res?.headers()['cache-control']).toBe('no-store');
    expect(await page.content()).not.toContain(LEAK);
  });

  test('si falla solo la lista de categorías también hay 502 y no-store (una de las tres peticiones)', async ({ page }) => {
    stub.setMode('categories-down');
    const res = await page.goto(`${site.url}${PATH}`);
    expect(res?.status()).toBe(HTTP_BAD_GATEWAY);
    expect(res?.headers()['cache-control']).toBe('no-store');
    await expect(notice(page).getByRole('link', { name: 'Reintentar' })).toBeVisible();
    expect(await page.content()).not.toContain(LEAK);
  });

  test('API caída (conexión rechazada): 502, no-store, "Reintentar" y el resto de la página sigue', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const res = await page.goto(`${dead.url}${PATH}?category=demo-buceo`);
    expect(res?.status()).toBe(HTTP_BAD_GATEWAY);
    expect(res?.headers()['cache-control']).toBe('no-store');
    await expect(notice(page)).toContainText('No pudimos cargar los relojes');
    await expect(notice(page).getByRole('link', { name: 'Reintentar' })).toHaveAttribute('href', `${PATH}?category=demo-buceo`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nuestros relojes');
    await expect(page.getByRole('link', { name: 'Reintentar' })).toHaveCount(ONE);
    await expectNoA11yViolations(page);
    expect(errors.filter((e) => !e.includes('502'))).toEqual([]);
  });

  test('API caída: la respuesta no menciona la dirección interna del API', async ({ page }) => {
    await page.goto(`${dead.url}${PATH}`);
    const html = await page.content();
    ['127.0.0.1:9', 'API_BASE_URL', 'ECONNREFUSED', 'fetch failed'].forEach((s) => expect(html).not.toContain(s));
  });

  test('axe en los estados 422 y 5xx a 375 y 1280 px', async ({ page }) => {
    await page.setViewportSize({ width: WIDE, height: HEIGHT });
    stub.setMode('validation');
    await page.goto(`${site.url}${PATH}`);
    await expectNoA11yViolations(page);
    stub.setMode('server-error');
    await page.goto(`${site.url}${PATH}`);
    await expectNoA11yViolations(page);
    await page.setViewportSize({ width: PHONE, height: HEIGHT });
    await page.goto(`${site.url}${PATH}`);
    await expectNoA11yViolations(page);
  });
});

test.describe('paginación y vacío: accesibilidad', () => {
  test('axe en la página 2 con filtros (paginación) a 375 y 1280 px, sin desbordamiento', async ({ page }) => {
    await Promise.all(
      [PHONE, WIDE].map(async (width) => {
        const ctx = await page.context().newPage();
        await ctx.setViewportSize({ width, height: HEIGHT });
        await ctx.goto(`${site.url}${PATH}?category=cat-a&page=2&sort=price_desc`);
        await expectNoA11yViolations(ctx);
        expect(await ctx.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(NONE);
        await ctx.close();
      }),
    );
  });

  test('estado vacío con filtros: EmptyState, 0 modelos, chip y "Limpiar filtros"', async ({ page }) => {
    await page.goto(`${site.url}${PATH}?category=vacia`);
    await expect(page.getByRole('region', { name: 'Resultados' }).getByRole('heading', { name: 'Ningún reloj coincide con tu búsqueda' })).toBeVisible();
    expect(await countOf(page)).toBe(NONE);
    await expect(pager(page)).toHaveCount(NONE);
    await expectNoA11yViolations(page);
  });
});

// N-4: nada del origen ni de las rutas de la API puede acabar en el JavaScript o el HTML estático servido al navegador.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = resolve(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

test.describe('N-4: el build no filtra la API al cliente', () => {
  test('dist/client no contiene API_BASE_URL, 127.0.0.1:8000 ni api/v1', () => {
    const files = walk(DIST_CLIENT).filter((f) => ['.js', '.mjs', '.html', '.css', '.json', '.map'].some((ext) => f.endsWith(ext)));
    expect(files.length).toBeGreaterThan(NONE);
    const leaks = files.flatMap((f) => ['API_BASE_URL', '127.0.0.1:8000', 'localhost:8000', 'api/v1'].filter((n) => readFileSync(f, 'utf8').includes(n)).map((n) => `${f}: ${n}`));
    expect(leaks).toEqual([]);
  });

  test('la página renderizada por el servidor de producción tampoco expone el origen de la API', async ({ request }) => {
    const html = await (await request.get(`${site.url}${PATH}`)).text();
    expect(html).not.toContain(new URL(stub.url).host);
    expect(html).not.toContain('api/v1');
    expect(html).not.toContain('API_BASE_URL');
  });
});

test.describe('estados con tres cabeceras de caché', () => {
  test('éxito público 30 s / swr 60 s; vacío también es un éxito', async ({ request }) => {
    expect((await request.get(`${site.url}${PATH}`)).headers()['cache-control']).toBe(CACHE_OK);
    expect((await request.get(`${site.url}${PATH}?category=vacia`)).headers()['cache-control']).toBe(CACHE_OK);
  });

  test('ningún error, aviso ni redirección es cacheable públicamente', async ({ request }) => {
    const bad = await request.get(`${site.url}${PATH}?price_min=2&price_max=1`);
    expect(bad.headers()['cache-control']).toBe('no-store');
    stub.setMode('server-error');
    const res = await request.get(`${site.url}${PATH}`);
    expect(res.status()).toBe(HTTP_BAD_GATEWAY);
    expect(res.headers()['cache-control']).toBe('no-store');
  });
});
