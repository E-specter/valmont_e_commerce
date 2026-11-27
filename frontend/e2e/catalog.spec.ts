import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors } from './helpers/page';
import { sequence } from './helpers/ui-a';

// T-124 · E2E de /relojes CONTRA EL BACKEND REAL (:8000, semilla `demo-…` con 12 productos). Los totales esperados no se
// escriben a mano: se piden a la API real con los mismos filtros, convertidos a céntimos de forma independiente.
const API = 'http://127.0.0.1:8000/api/v1/catalog/products';
const SLOW = 180_000;
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const PAGE_SIZE = 24;
const CENTS = 100;
const TABS = 45;
const SEED_TOTAL = 12;
const LONG_Q = 150;
const TOLERANCE = 1;
const CLS_LIMIT = 0.001;
const SETTLE_MS = 500;
const VIEWPORT_HEIGHT = 800;
const W_SMALL = 360;
const W_PHONE = 375;
const W_TABLET = 800;
const W_DESKTOP = 1280;
const WIDTHS = [W_SMALL, W_PHONE, W_TABLET, W_DESKTOP];
const CHIPS_SIX = 6;
const HUNDRED = 100;
const TOUCH = 44;
const SCROLL_MS = 500;
const CACHE_OK = 'public, max-age=30, stale-while-revalidate=60';

type Item = { slug: string; name: string; price: { amount: number } };
type Listing = { items: Item[]; total: number };
const PATH = '/relojes';
const TITLE = 'Nuestros relojes';
const EMPTY_TITLE = 'Ningún reloj coincide con tu búsqueda';

/** Pide el listado a la API real con los parámetros de la API (céntimos), no los de la URL. */
async function apiList(request: APIRequestContext, params: Record<string, string> = {}): Promise<Listing> {
  const res = await request.get(`${API}?${new URLSearchParams({ page_size: String(PAGE_SIZE), ...params })}`);
  expect(res.status(), 'el backend real debe estar en :8000').toBe(HTTP_OK);
  return (await res.json()) as Listing;
}

const results = (page: Page) => page.getByRole('region', { name: 'Resultados' });
const cards = (page: Page) => page.locator('main article');
const slugsOf = (page: Page): Promise<string[]> =>
  page.locator('main article h2 a').evaluateAll((links) => links.map((a) => (a.getAttribute('href') ?? '').split('/').pop() ?? ''));
const countText = (page: Page): Promise<string> => page.locator('main [role="status"]').filter({ hasText: 'modelo' }).textContent().then((t) => (t ?? '').trim());
const countOf = async (page: Page): Promise<number> => Number.parseInt(await countText(page), 10);
const notice = (page: Page) => page.getByRole('alert');

async function open(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(HTTP_OK);
  await page.evaluate(() => document.fonts.ready);
}

/** Abre `path` y comprueba que el listado y el total coinciden con la API real para `apiParams`. */
async function expectMatchesApi(page: Page, request: APIRequestContext, path: string, apiParams: Record<string, string>): Promise<Listing> {
  const expected = await apiList(request, apiParams);
  await open(page, path);
  expect(await countOf(page), `total de ${path}`).toBe(expected.total);
  expect(await slugsOf(page), `productos de ${path}`).toEqual(expected.items.map((i) => i.slug));
  return expected;
}

test.describe('estructura de la página', () => {
  test('200, un solo h1, total con role=status igual al de la API, cabecera de caché y título', async ({ page, request }) => {
    const errors = collectConsoleErrors(page);
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(HTTP_OK);
    expect(res?.headers()['cache-control']).toBe(CACHE_OK);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE);
    const expected = await apiList(request);
    expect(await countText(page)).toBe(`${expected.total} modelos`);
    await expect(page.locator('main [role="status"]').filter({ hasText: 'modelos' })).toHaveCount(ONE);
    expect(await cards(page).count()).toBe(Math.min(expected.total, PAGE_SIZE));
    expect(await page.title()).toContain('Relojes');
    await expect(page.locator('main#contenido')).toHaveCount(ONE);
    expect(await page.locator('html').getAttribute('lang')).toBe('es');
    expect(errors).toEqual([]);
  });

  test('cada tarjeta lleva su h2 (jerarquía h1 → h2) y las migas Inicio › Relojes', async ({ page }) => {
    await open(page, PATH);
    expect(await page.locator('main article h2').count()).toBe(await cards(page).count());
    expect(await page.locator('main h3').count()).toBe(NONE);
    const crumbs = page.getByRole('navigation', { name: 'Migas de pan' });
    await expect(crumbs.getByRole('link', { name: 'Inicio' })).toHaveAttribute('href', '/');
    await expect(crumbs).toContainText('Relojes');
  });

  test('con categoría las migas añaden el nombre real de la colección', async ({ page }) => {
    await open(page, `${PATH}?category=demo-buceo`);
    await expect(page.getByRole('navigation', { name: 'Migas de pan' })).toContainText('Buceo (demo)');
  });

  test('el total en singular: 1 modelo', async ({ page, request }) => {
    const one = await apiList(request, { price_min: '1062500', price_max: '1062500' });
    expect(one.total).toBe(ONE);
    await open(page, `${PATH}?price_min=10625&price_max=10625`);
    expect(await countText(page)).toBe('1 modelo');
  });

  test('el navegador no hace ninguna petición al backend ni a /api/v1 (todo es SSR)', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(':8000') || r.url().includes('/api/v1')) calls.push(r.url());
    });
    await open(page, `${PATH}?category=demo-buceo&sort=price_asc`);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.waitForLoadState('load');
    expect(calls).toEqual([]);
  });

  test('las 3 primeras imágenes son de LCP (sin lazy) y el resto carga diferida', async ({ page }) => {
    await open(page, PATH);
    const modes = await page.locator('main article img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('loading')));
    expect(modes.slice(NONE, THREE)).toEqual(['eager', 'eager', 'eager']);
    expect(modes.slice(THREE).every((m) => m === 'lazy')).toBe(true);
  });
});

test.describe('filtros contra la API real', () => {
  test('categoría reduce el listado y coincide con la API', async ({ page, request }) => {
    const e = await expectMatchesApi(page, request, `${PATH}?category=demo-buceo`, { category: 'demo-buceo' });
    expect(e.total).toBeGreaterThan(NONE);
    expect(e.total).toBeLessThan(SEED_TOTAL);
  });

  test('movimiento', async ({ page, request }) => {
    const e = await expectMatchesApi(page, request, `${PATH}?movement=manual`, { movement: 'manual' });
    expect(e.total).toBeGreaterThan(NONE);
    expect(e.total).toBeLessThan(SEED_TOTAL);
  });

  test('material de caja', async ({ page, request }) => {
    const e = await expectMatchesApi(page, request, `${PATH}?case_material=gold-18k`, { case_material: 'gold-18k' });
    expect(e.total).toBeGreaterThan(NONE);
    expect(e.total).toBeLessThan(SEED_TOTAL);
  });

  test('precio mínimo y máximo van en soles en la URL y en céntimos hacia la API', async ({ page, request }) => {
    const min = 4000;
    const max = 6000;
    const e = await expectMatchesApi(page, request, `${PATH}?price_min=${min}&price_max=${max}`, {
      price_min: String(min * CENTS),
      price_max: String(max * CENTS),
    });
    expect(e.total).toBeGreaterThan(NONE);
    expect(e.total).toBeLessThan(SEED_TOTAL);
    expect(e.items.every((i) => i.price.amount >= min * CENTS && i.price.amount <= max * CENTS)).toBe(true);
  });

  test('solo precio mínimo y solo precio máximo', async ({ page, request }) => {
    const soles = 5000;
    await expectMatchesApi(page, request, `${PATH}?price_min=${soles}`, { price_min: String(soles * CENTS) });
    await expectMatchesApi(page, request, `${PATH}?price_max=${soles}`, { price_max: String(soles * CENTS) });
  });

  test('solo disponibles excluye los agotados', async ({ page, request }) => {
    const e = await expectMatchesApi(page, request, `${PATH}?available=1`, { available: 'true' });
    expect(e.total).toBeLessThan(SEED_TOTAL);
    expect(e.total).toBeGreaterThan(NONE);
  });

  test('ordenar por precio ascendente y descendente reproduce el orden de la API', async ({ page, request }) => {
    const asc = await expectMatchesApi(page, request, `${PATH}?sort=price_asc`, { sort: 'price_asc' });
    const desc = await expectMatchesApi(page, request, `${PATH}?sort=price_desc`, { sort: 'price_desc' });
    expect(asc.items.map((i) => i.slug)).not.toEqual(desc.items.map((i) => i.slug));
    const prices = asc.items.map((i) => i.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  test('filtros combinados (colección + movimiento + disponibles + rango + orden)', async ({ page, request }) => {
    const e = await expectMatchesApi(
      page,
      request,
      `${PATH}?category=demo-deportivos&movement=automatic&available=1&price_min=1000&price_max=8000&sort=price_desc`,
      { category: 'demo-deportivos', movement: 'automatic', available: 'true', price_min: '100000', price_max: '800000', sort: 'price_desc' },
    );
    expect(e.total).toBeLessThan(SEED_TOTAL);
  });

  test('búsqueda de texto q', async ({ page, request }) => {
    await expectMatchesApi(page, request, `${PATH}?q=halcon`, { q: 'halcon' });
  });

  test('un parámetro desconocido no altera el resultado (no se reenvía)', async ({ page, request }) => {
    await expectMatchesApi(page, request, `${PATH}?category=demo-buceo&is_published=false&status=draft&page_size=1`, { category: 'demo-buceo' });
  });

  test('la URL es la fuente de verdad: recargar reproduce el mismo listado y el formulario conserva los valores', async ({ page, request }) => {
    const url = `${PATH}?category=demo-buceo&movement=automatic&available=1&sort=price_asc&price_min=1000`;
    const e = await expectMatchesApi(page, request, url, {
      category: 'demo-buceo',
      movement: 'automatic',
      available: 'true',
      sort: 'price_asc',
      price_min: '100000',
    });
    await page.reload();
    expect(await slugsOf(page)).toEqual(e.items.map((i) => i.slug));
    await expect(page.getByLabel('Colección', { exact: true })).toHaveValue('demo-buceo');
    await expect(page.getByLabel('Movimiento', { exact: true })).toHaveValue('automatic');
    await expect(page.getByLabel('Ordenar por', { exact: true })).toHaveValue('price_asc');
    await expect(page.getByLabel('Precio desde (S/)', { exact: true })).toHaveValue('1000');
    await expect(page.getByLabel('Solo disponibles', { exact: true })).toBeChecked();
  });
});

test.describe('formulario de filtros', () => {
  test('etiquetas accesibles, fieldset con legend y botón Aplicar', async ({ page }) => {
    await open(page, PATH);
    await expect(page.getByRole('group', { name: 'Filtrar y ordenar' })).toHaveCount(ONE);
    const labels = ['Colección', 'Movimiento', 'Material de caja', 'Precio desde (S/)', 'Precio hasta (S/)', 'Ordenar por', 'Solo disponibles'];
    await Promise.all(labels.map((l) => expect(page.getByLabel(l, { exact: true }), l).toHaveCount(ONE)));
    await expect(page.getByRole('button', { name: 'Aplicar' })).toHaveAttribute('type', 'submit');
  });

  test('elegir un valor NO envía el formulario (WCAG 3.2.2): solo "Aplicar" navega', async ({ page }) => {
    await open(page, PATH);
    await page.getByLabel('Colección', { exact: true }).selectOption('demo-buceo');
    await page.getByLabel('Solo disponibles', { exact: true }).check();
    await page.waitForTimeout(SETTLE_MS);
    expect(new URL(page.url()).search).toBe('');
  });

  test('aplicar con el formulario refleja los filtros en la URL y coincide con la API', async ({ page, request }) => {
    await open(page, PATH);
    await page.getByLabel('Colección', { exact: true }).selectOption('demo-buceo');
    await page.getByLabel('Movimiento', { exact: true }).selectOption('automatic');
    await page.getByLabel('Precio desde (S/)', { exact: true }).fill('1000');
    await page.getByLabel('Solo disponibles', { exact: true }).check();
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'demo-buceo'), page.getByRole('button', { name: 'Aplicar' }).click()]);
    const sp = new URL(page.url()).searchParams;
    expect(sp.get('movement')).toBe('automatic');
    expect(sp.get('price_min')).toBe('1000');
    expect(sp.get('available')).toBe('1');
    const expected = await apiList(request, { category: 'demo-buceo', movement: 'automatic', price_min: '100000', available: 'true' });
    expect(await slugsOf(page)).toEqual(expected.items.map((i) => i.slug));
    await expect(notice(page), 'los campos vacíos del formulario no son una URL inválida').toHaveCount(NONE);
  });

  test('enviar el formulario sin tocar nada vuelve al listado completo, sin avisos', async ({ page, request }) => {
    await open(page, PATH);
    await Promise.all([page.waitForURL((u) => u.pathname === PATH && u.search !== ''), page.getByRole('button', { name: 'Aplicar' }).click()]);
    await expect(notice(page)).toHaveCount(NONE);
    expect(await countOf(page)).toBe((await apiList(request)).total);
  });

  test('Enter dentro de un campo de precio envía el formulario', async ({ page }) => {
    await open(page, PATH);
    await page.getByLabel('Precio hasta (S/)', { exact: true }).fill('4000');
    await Promise.all([page.waitForURL((u) => u.searchParams.get('price_max') === '4000'), page.getByLabel('Precio hasta (S/)', { exact: true }).press('Enter')]);
  });

  test('"Limpiar filtros" del formulario lleva a /relojes', async ({ page }) => {
    await open(page, `${PATH}?category=demo-buceo`);
    await page.locator('form').getByRole('link', { name: 'Limpiar filtros' }).click();
    await page.waitForURL((u) => u.pathname === PATH && u.search === '');
    expect(await countOf(page)).toBe(SEED_TOTAL);
  });

  test('con una búsqueda activa, aplicar un filtro conserva q', async ({ page, request }) => {
    await open(page, `${PATH}?q=demo`);
    await expect(page.getByLabel('Ordenar por', { exact: true })).toHaveValue('relevance');
    await page.getByLabel('Colección', { exact: true }).selectOption('demo-buceo');
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'demo-buceo'), page.getByRole('button', { name: 'Aplicar' }).click()]);
    expect(new URL(page.url()).searchParams.get('q')).toBe('demo');
    const expected = await apiList(request, { q: 'demo', category: 'demo-buceo' });
    expect(await countOf(page)).toBe(expected.total);
  });

  test('el formulario funciona con el teclado: Tab llega a todos los controles sin pasar por los estáticos', async ({ page }) => {
    await open(page, PATH);
    const visited = await sequence(Array.from({ length: TABS }), async () => {
      await page.keyboard.press('Tab');
      return page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { tag: el?.tagName ?? '', inDemo: Boolean(el?.closest('[data-demo-content]')), name: el?.getAttribute('name') ?? '' };
      });
    });
    expect(visited.filter((v) => v.inDemo)).toEqual([]);
    const names = visited.map((v) => v.name);
    ['category', 'movement', 'case_material', 'price_min', 'price_max', 'sort', 'available'].forEach((n) => expect(names).toContain(n));
  });
});

test.describe('formulario sin JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('aplica filtros con un GET completo y la URL queda compartible', async ({ page, request }) => {
    await open(page, PATH);
    await page.getByLabel('Colección', { exact: true }).selectOption('demo-buceo');
    await page.getByLabel('Solo disponibles', { exact: true }).check();
    await page.getByLabel('Precio hasta (S/)', { exact: true }).fill('8000');
    await Promise.all([page.waitForURL((u) => u.searchParams.get('category') === 'demo-buceo'), page.getByRole('button', { name: 'Aplicar' }).click()]);
    const sp = new URL(page.url()).searchParams;
    expect(sp.get('available')).toBe('1');
    expect(sp.get('price_max')).toBe('8000');
    const expected = await apiList(request, { category: 'demo-buceo', available: 'true', price_max: '800000' });
    expect(await slugsOf(page)).toEqual(expected.items.map((i) => i.slug));
    await expect(page.getByLabel('Colección', { exact: true })).toHaveValue('demo-buceo');
  });

  test('los chips "Quitar" y "Limpiar todo" son enlaces normales', async ({ page }) => {
    await open(page, `${PATH}?category=demo-buceo&available=1`);
    await page.getByRole('link', { name: 'Quitar filtro Buceo (demo)' }).click();
    await page.waitForURL((u) => !u.searchParams.has('category'));
    expect(new URL(page.url()).searchParams.get('available')).toBe('1');
    await page.getByRole('link', { name: 'Limpiar todo' }).click();
    await page.waitForURL((u) => u.search === '');
  });
});

test.describe('filtros activos (chips)', () => {
  test('un chip por filtro activo, con el nombre real del atributo', async ({ page }) => {
    await open(page, `${PATH}?category=demo-buceo&movement=automatic&case_material=steel&available=1&price_min=1000&price_max=9000`);
    const chips = page.getByRole('list', { name: 'Filtros activos:' }).getByRole('listitem');
    await expect(chips).toHaveCount(CHIPS_SIX);
    const t = await chips.allTextContents();
    expect(t.join('|')).toContain('Buceo (demo)');
    expect(t.join('|')).toContain('Automático');
    expect(t.join('|')).toContain('Acero');
    expect(t.join('|')).toContain('Solo disponibles');
  });

  test('"Quitar" regenera la URL sin ese filtro, conserva los demás y vuelve a filtrar', async ({ page, request }) => {
    await open(page, `${PATH}?category=demo-buceo&movement=automatic&available=1&sort=price_asc`);
    await page.getByRole('link', { name: 'Quitar filtro Buceo (demo)' }).click();
    await page.waitForURL((u) => !u.searchParams.has('category'));
    const sp = new URL(page.url()).searchParams;
    expect(sp.get('movement')).toBe('automatic');
    expect(sp.get('available')).toBe('1');
    expect(sp.get('sort')).toBe('price_asc');
    expect(sp.has('page')).toBe(false);
    const expected = await apiList(request, { movement: 'automatic', available: 'true', sort: 'price_asc' });
    expect(await slugsOf(page)).toEqual(expected.items.map((i) => i.slug));
  });

  test('"Limpiar todo" vuelve a /relojes sin parámetros', async ({ page }) => {
    await open(page, `${PATH}?category=demo-buceo&movement=automatic`);
    await page.getByRole('link', { name: 'Limpiar todo' }).click();
    await page.waitForURL((u) => u.pathname === PATH && u.search === '');
    await expect(page.getByRole('link', { name: 'Limpiar todo' })).toHaveCount(NONE);
  });

  test('sin filtros activos no hay chips', async ({ page }) => {
    await open(page, PATH);
    await expect(page.getByText('Filtros activos:')).toHaveCount(NONE);
  });
});

test.describe('vacío, rango inválido y URL inválida', () => {
  test('sin resultados: EmptyState con "Limpiar filtros" que lleva a /relojes', async ({ page }) => {
    await open(page, `${PATH}?price_max=1`);
    await expect(results(page).getByRole('heading', { name: EMPTY_TITLE })).toBeVisible();
    expect(await cards(page).count()).toBe(NONE);
    expect(await countText(page)).toBe('0 modelos');
    await results(page).getByRole('link', { name: 'Limpiar filtros' }).click();
    await page.waitForURL((u) => u.pathname === PATH && u.search === '');
    expect(await countOf(page)).toBe(SEED_TOTAL);
  });

  test('categoría desconocida pero con formato válido: 200 y estado vacío', async ({ page }) => {
    await open(page, `${PATH}?category=no-existe`);
    await expect(results(page).getByRole('heading', { name: EMPTY_TITLE })).toBeVisible();
  });

  test('rango invertido: Notice de error con "Limpiar filtros", sin listado ni vacío, sin caché', async ({ page }) => {
    const res = await page.goto(`${PATH}?price_min=9000&price_max=100`);
    expect(res?.status()).toBe(HTTP_OK);
    expect(res?.headers()['cache-control']).toBe('no-store');
    await expect(notice(page)).toHaveCount(ONE);
    await expect(notice(page)).toContainText('Revisa los filtros');
    await expect(notice(page).getByRole('link', { name: 'Limpiar filtros' })).toHaveAttribute('href', PATH);
    expect(await cards(page).count()).toBe(NONE);
    await expect(page.getByRole('heading', { name: EMPTY_TITLE })).toHaveCount(NONE);
  });

  test('valores inválidos se ignoran con un aviso y se muestra el listado completo', async ({ page, request }) => {
    const res = await page.goto(`${PATH}?sort=hacked&page=abc&price_min=-5&price_max=1.5&category=Bad%20Slug&movement=../x`);
    expect(res?.status()).toBe(HTTP_OK);
    await expect(notice(page)).toContainText('Revisa los filtros');
    await expect(notice(page).getByRole('link', { name: 'Limpiar filtros' })).toHaveAttribute('href', PATH);
    expect(await countOf(page)).toBe((await apiList(request)).total);
    await expect(page.getByLabel('Colección', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Ordenar por', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Precio desde (S/)', { exact: true })).toHaveValue('');
  });

  test('un valor inválido no impide aplicar los válidos', async ({ page, request }) => {
    await open(page, `${PATH}?category=Bad%20Slug&movement=automatic`);
    const expected = await apiList(request, { movement: 'automatic' });
    expect(await slugsOf(page)).toEqual(expected.items.map((i) => i.slug));
  });

  test('relevance sin q se descarta sin romper la página (el servidor daría 422)', async ({ page }) => {
    await open(page, `${PATH}?sort=relevance`);
    expect(await cards(page).count()).toBe(SEED_TOTAL);
  });

  test('page fuera de rango: 302 a la última página (aquí /relojes) y luego 200', async ({ page, request }) => {
    const res = await request.get(`${PATH}?page=99`, { maxRedirects: 0 });
    expect(res.status()).toBe(HTTP_FOUND);
    expect(new URL(res.headers().location ?? '', 'http://x').pathname + new URL(res.headers().location ?? '', 'http://x').search).toBe(PATH);
    await open(page, `${PATH}?page=99`);
    expect(await countOf(page)).toBe(SEED_TOTAL);
    expect(new URL(page.url()).search).toBe('');
  });

  test('page fuera de rango conserva los filtros en la redirección', async ({ request }) => {
    const res = await request.get(`${PATH}?category=demo-buceo&sort=price_asc&page=7`, { maxRedirects: 0 });
    expect(res.status()).toBe(HTTP_FOUND);
    const target = new URL(res.headers().location ?? '', 'http://x').searchParams;
    expect(target.get('category')).toBe('demo-buceo');
    expect(target.get('sort')).toBe('price_asc');
    expect(target.has('page')).toBe(false);
  });

  test('q con caracteres de control o de más de 100 caracteres nunca produce un error 5xx (RT: sin 500)', async ({ request }) => {
    const bad = ['%00', 'a%00b', '%07', '%1b', `${'z'.repeat(LONG_Q)}`];
    const statuses = await Promise.all(bad.map(async (q) => (await request.get(`${PATH}?q=${q}`, { maxRedirects: 0 })).status()));
    expect(statuses).toEqual(bad.map(() => HTTP_OK));
  });

  test('q con caracteres de control no muestra el aviso de error (se sanea antes de la API)', async ({ page }) => {
    await open(page, `${PATH}?q=reloj%00%07x`);
    await expect(notice(page)).toHaveCount(NONE);
  });

  test('q de 150 caracteres se recorta: sin aviso de error 422', async ({ page }) => {
    await open(page, `${PATH}?q=${'a'.repeat(LONG_Q)}`);
    await expect(notice(page)).toHaveCount(NONE);
  });
});

test.describe('seguridad de la entrada', () => {
  test('q con HTML/JS se pinta como texto: no ejecuta nada ni crea elementos', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    const hostile = '"><script>window.__xss=1</script><img src=x onerror="window.__xss=2">';
    await open(page, `${PATH}?q=${encodeURIComponent(hostile)}&category=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(await page.locator('main script').count()).toBe(NONE);
    expect(await page.locator('main img[src="x"]').count()).toBe(NONE);
    // La búsqueda se conserva como valor del campo y como texto del chip, sin interpretarse.
    expect(await page.locator('form fieldset input[name="q"]').inputValue()).toBe(hostile.slice(NONE, HUNDRED));
  });

  test('la respuesta no incluye parámetros ajenos ni cabeceras de servidor internas', async ({ page }) => {
    const res = await page.goto(`${PATH}?admin=1&is_published=false`);
    const headers = res?.headers() ?? {};
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['set-cookie']).toBeUndefined();
  });
});

test.describe('contenido de demostración (D-041 P-2)', () => {
  test('"Complicación" y el conmutador: visibles, fuera del formulario, inertes y sin efecto', async ({ page }) => {
    await open(page, PATH);
    const fake = page.locator('[data-demo-content]').getByText('Complicación');
    await expect(fake).toBeVisible();
    expect(await fake.evaluate((el) => el.closest('form') === null)).toBe(true);
    expect(await fake.evaluate((el) => el.closest('[aria-disabled="true"]') !== null)).toBe(true);
    const before = page.url();
    await fake.click({ force: true });
    await page.waitForTimeout(SETTLE_MS);
    expect(page.url()).toBe(before);
    expect(await page.locator('form [name]').evaluateAll((els) => els.map((e) => e.getAttribute('name')).join(','))).not.toContain('complic');
  });

  test('"Destacado del mes": marcado como demostración, sin botón ni enlace', async ({ page }) => {
    await open(page, PATH);
    const banner = page.locator('[data-demo-content]').filter({ hasText: 'Destacado del mes' });
    await expect(banner).toHaveCount(ONE);
    await expect(banner).toContainText('Contenido de demostración');
    expect(await banner.locator('a, button, input, select').count()).toBe(NONE);
    await expect(banner).toContainText('S/');
  });
});

test.describe('accesibilidad y responsive', () => {
  const STATES = [
    ['listado', PATH],
    ['con filtros y chips', `${PATH}?category=demo-buceo&movement=automatic&available=1&price_min=1000&sort=price_asc`],
    ['vacío', `${PATH}?price_max=1`],
    ['rango invertido', `${PATH}?price_min=9000&price_max=100`],
    ['URL inválida', `${PATH}?sort=hacked&category=Bad%20Slug`],
  ] as const;

  STATES.forEach(([name, path]) => {
    test(`axe: 0 violaciones, sin desbordamiento y consola limpia a 360, 375, 800 y 1280 — ${name}`, async ({ page }) => {
      test.setTimeout(SLOW);
      const errors = collectConsoleErrors(page);
      await sequence(WIDTHS, async (width) => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
        await open(page, path);
        await expectNoA11yViolations(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `desbordamiento horizontal a ${width}px`).toBeLessThanOrEqual(NONE);
        const wide = await page.evaluate(() =>
          [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((e) => e.tagName),
        );
        expect(wide, `elementos fuera de la pantalla a ${width}px`).toEqual([]);
      });
      expect(errors).toEqual([]);
    });
  });

  test('los controles del formulario miden al menos 44 px de alto a 375 px', async ({ page }) => {
    await page.setViewportSize({ width: W_PHONE, height: VIEWPORT_HEIGHT });
    await open(page, PATH);
    const heights = await page.locator('main fieldset select, main fieldset input[type="number"], main fieldset button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThanOrEqual(THREE);
    heights.forEach((h) => expect(h).toBeGreaterThanOrEqual(TOUCH - TOLERANCE));
  });

  test('sin desplazamiento de diseño (CLS) al cargar y recorrer el listado a 375 px', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shifts: { value: number; at: number }[] };
      w.__shifts = [];
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          const s = e as unknown as { value: number; hadRecentInput: boolean };
          if (!s.hadRecentInput) w.__shifts.push({ value: s.value, at: e.startTime });
        });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.setViewportSize({ width: W_PHONE, height: VIEWPORT_HEIGHT });
    await open(page, PATH);
    const settledAt = await page.evaluate(() => performance.now());
    await page.evaluate(async (ms) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, ms));
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, ms));
    }, SCROLL_MS);
    const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; at: number }[] }).__shifts);
    const after = shifts.filter((s) => s.at > settledAt).reduce((sum, s) => sum + s.value, NONE);
    expect(after, JSON.stringify(shifts)).toBeLessThan(CLS_LIMIT);
  });

  test('a 1280 px la rejilla muestra varias columnas y a 360 px una sola o dos sin solaparse', async ({ page }) => {
    await page.setViewportSize({ width: W_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page, PATH);
    const columns = (): Promise<number> => page.locator('main ul').filter({ has: page.locator('article') }).first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(await columns()).toBeGreaterThanOrEqual(THREE);
    await page.setViewportSize({ width: W_SMALL, height: VIEWPORT_HEIGHT });
    expect(await columns()).toBeLessThanOrEqual(TWO);
  });
});
