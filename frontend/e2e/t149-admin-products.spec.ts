import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { formatMoney } from '../src/lib/format';
import { API, browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { MARK, PRICE_CENTS, RUN_PREFIX, activeCategories, allProducts, cleanup, createDraft, type ApiProduct } from './helpers/t149';

// T-149 · listado /admin/productos con administrador REAL (Supabase local + backend en :8000 + `astro dev`), D-050.
// Crea SOLO productos `QA-T149-*` (borradores, por la API) y los borra al terminar; los 12 relojes de la semilla (`DEMO-*`) no se tocan:
// la suite compara su estado antes y después. Requiere `npm run db:start`, el backend y Docker (rol admin con `docker exec … psql`).
// Una sola pasada en escritorio (cambia el ancho dentro de las pruebas: 1280, 1440 y 375).
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const PATH = '/admin/productos';
const NEW = '/admin/productos/nuevo';
const HOOK_TIMEOUT = 240_000;
const NAV_TIMEOUT = 20_000;
const OK = 200;
const FOUND = 302;
const FORBIDDEN = 403;
const NO_STORE = 'private, no-store';
const SEEDED = 12;
const DESKTOP = 1440;
const MOBILE = 375;
const LAPTOP = 1280;
const WIDTHS = [LAPTOP, DESKTOP, MOBILE];
const HEIGHT = 900;
const FAR_PAGE = 999;
const FOCUS_YELLOW = 'rgb(255, 217, 0)';
const RING = 2;
const MAX_TABS = 40;
// «dd/mm/aaaa hh:mm» en cualquier parte del texto de una celda.
// Acepta "27/11/2026 15:04"; rechaza "2026-11-27T20:04:00Z".
// https://regex101.com/?regex=%5Cd%7B2%7D%2F%5Cd%7B2%7D%2F%5Cd%7B4%7D%20%5Cd%7B2%7D%3A%5Cd%7B2%7D&testString=27%2F11%2F2026%2015%3A04
const DATE_TIME = /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/;
// Ruta del formulario de un producto: /admin/productos/<uuid>.
// Acepta "/admin/productos/3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza "/admin/productos/nuevo".
// https://regex101.com/?regex=%5E%5C%2Fadmin%5C%2Fproductos%5C%2F%5B0-9a-f-%5D%7B36%7D%24&testString=%2Fadmin%2Fproductos%2F3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const PRODUCT_PATH = /^\/admin\/productos\/[0-9a-f-]{36}$/;
const TAG_OWN = 'PROPIO';
const TAG_HOSTILE = 'HOSTIL';
const HOSTILE_TAIL = '<img src=x onerror=window.__pwn=1>';
const PRICE_TEXT = formatMoney({ amount: PRICE_CENTS, currency: 'PEN' }).replaceAll(' ', ' ');
const LABEL = { draft: 'Borrador', published: 'Publicado' } as const;

// Un solo worker: comparten usuarios y productos (sin saltarse el resto si una prueba falla).
test.describe.configure({ mode: 'default' });

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;
let own: ApiProduct;
let hostile: ApiProduct;
let seedBefore: Map<string, string>;
let leftoverAtEnd = 0;

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'escribe usuarios y productos y mide el escritorio y el móvil: una sola pasada (escritorio)');
});
test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't149a', 'admin');
  customer = await createQaUser(env, 't149c', 'customer');
  const category = (await activeCategories(admin))[0];
  own = await createDraft(admin, category.id, TAG_OWN);
  hostile = await createDraft(admin, category.id, TAG_HOSTILE, { name: `Reloj ${MARK} hostil ${HOSTILE_TAIL}` });
  seedBefore = new Map((await allProducts(admin)).filter((p) => p.sku.startsWith('DEMO-')).map((p) => [p.id, `${p.updated_at}|${p.status}|${p.name}`]));
});
test.afterAll(async () => {
  test.setTimeout(HOOK_TIMEOUT);
  if (!admin) return;
  const seedAfter = new Map((await allProducts(admin)).filter((p) => p.sku.startsWith('DEMO-')).map((p) => [p.id, `${p.updated_at}|${p.status}|${p.name}`]));
  leftoverAtEnd = await cleanup(admin);
  await Promise.all([deleteQaUser(env, admin), deleteQaUser(env, customer)]);
  // Anotación para el traspaso: 0 = todo borrado; otro número = quedaron como borradores QA-T149-*.
  console.warn(`T-149 limpieza: ${leftoverAtEnd} producto(s) ${RUN_PREFIX}* sin borrar`);
  expect([...seedAfter.entries()]).toEqual([...(seedBefore ?? seedAfter).entries()]);
});

// --- ayudantes --------------------------------------------------------------------------------------------------
const asUser = (page: Page, user: QaUser): Promise<void> => page.context().addCookies(browserCookies(user.cookies));
const get = (request: APIRequestContext, path: string, cookie?: string) =>
  request.get(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, maxRedirects: 0, failOnStatusCode: false });
const mine = (extra = ''): string => `${PATH}?q=${encodeURIComponent(MARK)}${extra}`;
const rows = (page: Page): Locator => page.locator('tbody tr');
const rowOf = (page: Page, product: ApiProduct): Locator => rows(page).filter({ hasText: product.sku });
const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const chip = (page: Page, label: string): Locator => page.getByRole('navigation', { name: 'Filtrar por estado' }).getByRole('link', { name: label });
const searchBox = (page: Page): Locator => page.getByLabel('Nombre o SKU', { exact: true });
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);

async function open(page: Page, path: string, width = DESKTOP, user: QaUser = admin): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT });
  await asUser(page, user);
  const res = await page.goto(`${BASE}${path}`);
  expect(res?.status()).toBe(OK);
  await expect(page.getByRole('heading', { level: 1, name: 'Productos' })).toBeVisible();
}

// --- sin datos --------------------------------------------------------------------------------------------------
test.describe('acceso · sin sesión', () => {
  [PATH, `${PATH}?status=draft`, `${PATH}?q=zzz&page=2`, `${PATH}/`, '/Admin/productos', '/%61dmin/productos'].forEach((path) =>
    test(`${path} sin sesión → 302 al ingreso con next, no-store y sin cuerpo`, async ({ request }) => {
      const res = await get(request, path);
      expect(res.status()).toBe(FOUND);
      expect(res.headers().location?.startsWith('/ingresar?next=')).toBe(true);
      expect(res.headers()['cache-control']).toBe(NO_STORE);
      expect(await res.text()).toBe('');
    }));

  test('el destino de vuelta conserva la consulta', async ({ request }) => {
    const res = await get(request, `${PATH}?status=draft&q=Ana`);
    expect(res.headers().location).toBe(`/ingresar?next=${encodeURIComponent(`${PATH}?status=draft&q=Ana`)}`);
  });

  test('una cookie de sesión basura no da acceso: 302', async ({ request }) => {
    const res = await get(request, PATH, 'sb-127-auth-token=base64-QUJDREVGRw; sb-127-auth-token.1=garbage');
    expect(res.status()).toBe(FOUND);
  });
});

test.describe('acceso · cliente', () => {
  ['', '?status=draft', `?q=${encodeURIComponent('DEMO-')}`, '?page=2'].forEach((query) =>
    test(`cliente en ${PATH}${query}: 403 «Sin permiso», no-store y ningún dato de productos`, async ({ request }) => {
      const res = await get(request, `${PATH}${query}`, customer.cookie);
      expect(res.status()).toBe(FORBIDDEN);
      expect(res.headers()['cache-control'] ?? '').toContain('no-store');
      const html = await res.text();
      expect(html).toContain('No tienes permiso');
      expect(html).not.toContain('<table');
      expect(html).not.toContain('DEMO-');
      expect(html).not.toContain(own.sku);
      expect(html).not.toContain(own.id);
    }));

  test('un cliente no consigue datos del listado con parámetros de rol ni de usuario', async ({ request }) => {
    const res = await get(request, `${PATH}?role=admin&user_id=${admin.id}&status=draft`, customer.cookie);
    expect(res.status()).toBe(FORBIDDEN);
    expect(await res.text()).not.toContain(own.sku);
  });
});

// --- con administrador --------------------------------------------------------------------------------------------
test.describe('listado de productos · administrador real', () => {
  test.describe.configure({ mode: 'default' });

  test('administrador: 200, private no-store, noindex, un h1 y «Productos» activo en el menú', async ({ page, request }) => {
    const res = await get(request, PATH, admin.cookie);
    expect(res.status()).toBe(OK);
    expect(res.headers()['cache-control']).toBe(NO_STORE);
    expect(await res.text()).toContain('noindex');
    await open(page, PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Administración' }).getByRole('link', { name: 'Productos' })).toHaveAttribute('aria-current', 'page');
  });

  test('los 12 relojes de la semilla aparecen, con el estado y el precio que dice la API', async ({ page }) => {
    const demo = (await allProducts(admin)).filter((p) => p.sku.startsWith('DEMO-'));
    expect(demo).toHaveLength(SEEDED);
    await open(page, `${PATH}?q=DEMO-`);
    await expect(rows(page)).toHaveCount(SEEDED);
    await Promise.all(
      demo.map(async (p) => {
        const row = rowOf(page, p);
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(p.name);
        await expect(row).toContainText(LABEL[p.status]);
        await expect(row).toContainText(formatMoney({ amount: p.price.amount, currency: 'PEN' }).replaceAll(' ', ' '));
      }),
    );
  });

  test('un borrador de la suite aparece con su estado «Borrador», nombre, SKU, precio y enlace a su formulario', async ({ page }) => {
    await open(page, mine());
    const row = rowOf(page, own);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(own.name);
    await expect(row.locator('.pill')).toHaveText(LABEL.draft);
    await expect(row).toContainText(PRICE_TEXT);
    await expect(row).toContainText(DATE_TIME);
    await row.getByRole('link', { name: own.name }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe(`${PATH}/${own.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('filtrar por «Publicado» quita el borrador; «Borrador» lo devuelve; los chips conservan q', async ({ page }) => {
    await open(page, mine());
    await expect(rowOf(page, own)).toHaveCount(1);
    await chip(page, 'Publicado').click();
    await expect.poll(() => param(page, 'status')).toBe('published');
    expect(param(page, 'q')).toBe(MARK);
    await expect(rowOf(page, own)).toHaveCount(0);
    await expect(page.getByText('No hay productos con estos filtros')).toBeVisible();
    await expect(chip(page, 'Publicado')).toHaveAttribute('aria-current', 'true');
    await chip(page, 'Borrador').click();
    await expect.poll(() => param(page, 'status')).toBe('draft');
    await expect(rowOf(page, own)).toHaveCount(1);
    await chip(page, 'Todos').click();
    await expect.poll(() => param(page, 'status')).toBeNull();
    expect(param(page, 'q')).toBe(MARK);
    await expect(rowOf(page, own)).toHaveCount(1);
  });

  test('la búsqueda por SKU y por nombre filtra; recargar conserva la URL y el resultado; «Limpiar filtros» vuelve a la lista completa', async ({ page }) => {
    await open(page, PATH);
    await searchBox(page).fill(own.sku);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => param(page, 'q')).toBe(own.sku);
    await expect(rows(page)).toHaveCount(1);
    await page.reload();
    expect(param(page, 'q')).toBe(own.sku);
    await expect(rows(page)).toHaveCount(1);
    await expect(searchBox(page)).toHaveValue(own.sku);
    await searchBox(page).fill(own.name);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(rowOf(page, own)).toHaveCount(1);
    await page.getByRole('link', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect(searchBox(page)).toHaveValue('');
    expect(await rows(page).count()).toBeGreaterThanOrEqual(SEEDED);
  });

  test('aplicar la búsqueda conserva el estado activo', async ({ page }) => {
    await open(page, `${PATH}?status=draft`);
    await searchBox(page).fill(MARK);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => param(page, 'q')).toBe(MARK);
    expect(param(page, 'status')).toBe('draft');
    await expect(rowOf(page, own)).toHaveCount(1);
  });

  test('parámetros ajenos o inválidos se ignoran sin error: 200 y la lista completa', async ({ page }) => {
    await open(page, `${PATH}?q=DEMO-&status=otro&category=clasicos&page_size=500&evil=1&page=abc&role=admin`);
    await expect(rows(page)).toHaveCount(SEEDED);
    await expect(chip(page, 'Todos')).toHaveAttribute('aria-current', 'true');
  });

  test('una página que no existe dice «Esta página no existe» y «Ir a la página 1» conserva los filtros', async ({ page }) => {
    await open(page, `${PATH}?q=DEMO-&status=published&page=${FAR_PAGE}`);
    await expect(page.getByText('Esta página no existe')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await page.getByRole('link', { name: 'Ir a la página 1' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
    expect(param(page, 'q')).toBe('DEMO-');
    expect(param(page, 'status')).toBe('published');
    await expect(rows(page).first()).toBeVisible();
  });

  test('vacío con filtros: «No hay productos con estos filtros» y «Limpiar filtros»', async ({ page }) => {
    await open(page, `${PATH}?q=${encodeURIComponent(`${MARK}noexistezzzz`)}`);
    await expect(page.getByText('No hay productos con estos filtros')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('link', { name: 'Limpiar filtros' }).last()).toBeVisible();
  });

  test('«Nuevo producto» lleva a /admin/productos/nuevo', async ({ page }) => {
    await open(page, PATH);
    await page.getByRole('link', { name: 'Nuevo producto' }).first().click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toBe(NEW);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('XSS: un nombre con HTML se muestra como texto y la búsqueda hostil no ejecuta nada', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await open(page, mine());
    const row = rowOf(page, hostile);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(HOSTILE_TAIL);
    await expect(page.locator('tbody img[src="x"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    const attack = '"><script>window.__pwn=1</script>';
    await page.goto(`${BASE}${PATH}?q=${encodeURIComponent(attack)}`);
    await expect(searchBox(page)).toHaveValue(attack);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    expect(errors.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  });

  test('contrato: los productos de la API tienen exactamente los campos de AdminProductOut del OpenAPI en vivo', async () => {
    const spec = (await (await fetch(`${API}/openapi.json`)).json()) as { components: { schemas: { AdminProductOut: { properties: Record<string, unknown> } } } };
    const listed = (await allProducts(admin, `&q=${encodeURIComponent(MARK)}`)).find((p) => p.id === own.id);
    expect(Object.keys(listed ?? {}).sort()).toEqual(Object.keys(spec.components.schemas.AdminProductOut.properties).sort());
  });

  test('sin JavaScript: el formulario GET filtra y los chips navegan', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE, viewport: { width: DESKTOP, height: HEIGHT } });
    await context.addCookies(browserCookies(admin.cookies));
    const page = await context.newPage();
    await page.goto(`${BASE}${PATH}`);
    await searchBox(page).fill(own.sku);
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => param(page, 'q')).toBe(own.sku);
    await expect(rows(page)).toHaveCount(1);
    await chip(page, 'Publicado').click();
    await expect.poll(() => param(page, 'status')).toBe('published');
    await expect(rows(page)).toHaveCount(0);
    await context.close();
  });

  test.describe('teclado y foco', () => {
    const FOCUS_TARGETS: [string, (page: Page) => Locator][] = [
      ['el campo de búsqueda', (page) => searchBox(page)],
      ['«Aplicar»', (page) => page.getByRole('button', { name: 'Aplicar' })],
      ['un chip de estado', (page) => chip(page, 'Borrador')],
      ['el enlace del producto', (page) => rows(page).first().getByRole('link').first()],
      ['«Nuevo producto»', (page) => page.getByRole('link', { name: 'Nuevo producto' }).first()],
    ];
    FOCUS_TARGETS.forEach(([label, target]) =>
      test(`foco visible en ${label}: anillo amarillo de 2 px (en el control o en su caja)`, async ({ page }) => {
        await open(page, mine());
        const el = target(page);
        await el.focus();
        const ring = await el.evaluate((node) => {
          const chain = [node, node.parentElement, node.parentElement?.parentElement].filter((n): n is HTMLElement => !!n);
          const found = chain.map((n) => getComputedStyle(n)).find((s) => s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0);
          return found ? { color: found.outlineColor, width: parseFloat(found.outlineWidth) } : null;
        });
        expect(ring, 'sin anillo de foco').not.toBeNull();
        expect(ring!.width).toBeGreaterThanOrEqual(RING);
        expect(ring!.color).toBe(FOCUS_YELLOW);
      }));

    test('con Tab se llega del campo de búsqueda al enlace del producto y Enter abre su formulario', async ({ page }) => {
      await open(page, mine(`&status=draft`));
      await searchBox(page).focus();
      const reached = await Array.from({ length: MAX_TABS }).reduce<Promise<boolean>>(async (acc) => {
        if (await acc) return true;
        await page.keyboard.press('Tab');
        return page.evaluate(() => (document.activeElement?.getAttribute('href') ?? '').startsWith('/admin/productos/'));
      }, Promise.resolve(false));
      expect(reached).toBe(true);
      await page.keyboard.press('Enter');
      await expect.poll(() => new URL(page.url()).pathname, { timeout: NAV_TIMEOUT }).toMatch(PRODUCT_PATH);
    });
  });

  test.describe('anchos y accesibilidad', () => {
    WIDTHS.forEach((width) =>
      test(`${width} px: sin desbordamiento de la página, un h1, tabla con encabezados y axe sin violaciones`, async ({ page }) => {
        const errors = collectConsoleErrors(page);
        const external = collectExternalRequests(page, BASE);
        await open(page, mine(), width);
        await expect(rowOf(page, own)).toHaveCount(1);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.locator('main#contenido')).toHaveCount(1);
        await expect(page.locator('thead th').first()).toBeVisible();
        await expectNoA11yViolations(page);
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
      }));

    WIDTHS.forEach((width) =>
      test(`${width} px: los 12 relojes de la semilla, el vacío y la página inexistente pasan axe`, async ({ page }) => {
        await open(page, `${PATH}?q=DEMO-`, width);
        await expect(rows(page)).toHaveCount(SEEDED);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expectNoA11yViolations(page);
        await page.goto(`${BASE}${PATH}?q=${encodeURIComponent(`${MARK}noexistezzzz`)}`);
        await expect(page.getByText('No hay productos con estos filtros')).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await expectNoA11yViolations(page);
        await page.goto(`${BASE}${PATH}?q=DEMO-&page=${FAR_PAGE}`);
        await expect(page.getByText('Esta página no existe')).toBeVisible();
        await expectNoA11yViolations(page);
      }));

    test('a 375 px la tabla se desplaza dentro de su región (enfocable), no la página', async ({ page }) => {
      await open(page, mine(), MOBILE);
      const region = page.locator('[role="region"][tabindex="0"]').first();
      await expect(region).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
});
