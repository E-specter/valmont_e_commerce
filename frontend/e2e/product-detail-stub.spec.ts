import { expect, test as base, type Page, type Response } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors } from './helpers/page';
import { formatMoney } from '../src/lib/format';
import { product, rawGet, startStub, startSite, pen, type Detail, type Site, type Stub } from './helpers/product-stub';
import { sequence } from './helpers/ui-a';

// T-125 · ficha /relojes/[slug] contra una API simulada (e2e/helpers/product-stub.ts) con su propio servidor de producción (`dist/`: ejecutar `npm run build` antes; Astro 7 solo permite un `astro dev` por proyecto):
// lo que la semilla real no ofrece (varias imágenes, textos hostiles, 5xx, lentitud, API apagada, contar llamadas).
// La semilla real (`demo-…`) se prueba en product-detail.spec.ts. Un servidor por trabajador (no se reutiliza el de :4321).
const STARTUP_TIMEOUT = 240_000;
const TEST_TIMEOUT = 90_000;
const MAIN_W = 712;
const MAIN_H = 593;
const PANORAMA = { w: 2000, h: 300 };
const WIDE = { w: 3000, h: 200 };
const SERVER_ERROR = 500;
const UNAVAILABLE = 503;
const ONE_SECOND = 1000;
const META_SLACK = 10;
const LEAD_DAYS = 45;
const BIG_PRICE = 12_345_600;
const BIG_ORIGINAL = 14_000_000;
const BIG_SAVING = 1_654_400;
const NAME_WORD_REPEATS = 3;
const SKU_PAD = 20;
const SPACES_CHUNK = 30;
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FIVE = 5;
const OK = 200;
const NOT_FOUND = 404;
const BAD_GATEWAY = 502;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 900;
const TOUCH_TARGET = 44;
const FOCUS_RING_MIN = 2;
const META_MAX = 155;
const CLS_LIMIT = 0.001;
const API_TIMEOUT_MS = 8000;
const HANG_MS = 9500;
const IMAGE_DELAY_MS = 1200;
const CACHE_OK = 'public, max-age=30, stale-while-revalidate=60';
const MAIN_RATIO = MAIN_W / MAIN_H;
const RATIO_TOLERANCE = 0.03;
const BOX_TOLERANCE = 1;
const HERO_INFO_WIDTH = 460;
const FRAME_BORDER = 4; // borde de 1 px a cada lado más margen

const NOINDEX = 'noindex, nofollow';
const CATALOG_LINK = 'Ver el catálogo';
const ADVISOR_LINK = 'Consultar con un asesor';
/** Reduce rachas de espacios y saltos de línea a un espacio: "a  b\n" → "a b". */
const norm = (s: string): string => s.replaceAll('\n', ' ').split(' ').filter(Boolean).join(' ');

type Env = { stub: Stub; site: Site };
const test = base.extend<object, { env: Env }>({
  env: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const stub = await startStub();
      const site = await startSite(stub.origin);
      await use({ stub, site });
      site.stop();
      await stub.stop();
    },
    { scope: 'worker', timeout: STARTUP_TIMEOUT },
  ],
});
// Un solo trabajador por proyecto y fichero: así se levanta un único `astro dev` (si un test falla, el trabajador se reinicia).
test.describe.configure({ mode: 'default' });
test.beforeEach(() => test.setTimeout(TEST_TIMEOUT));

const mainImg = (page: Page) => page.locator('main img[fetchpriority="high"]');
/** Miniaturas: enlaces con imagen dentro de `main` que no son tarjetas de producto. */
const thumbs = (page: Page) => page.locator('main a:has(img):not(article a)');
const open = async (page: Page, env: Env, slug: string): Promise<Response> => {
  const res = await page.goto(`${env.site.origin}/relojes/${slug}`);
  if (!res) throw new Error('sin respuesta');
  await page.evaluate(() => document.fonts.ready);
  return res;
};
const publish = (env: Env, slug: string, over: Partial<Detail> = {}, imageCount = ONE): Detail => {
  const p = product(env.stub, slug, over, imageCount);
  env.stub.reply(slug, { status: OK, body: p });
  return p;
};
const imageLoaded = (page: Page): Promise<unknown> =>
  page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('main img[fetchpriority="high"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
const overflowOf = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('galería con varias imágenes', () => {
  test('la principal es la primera y es la de LCP; las miniaturas son enlaces y aria-current marca la activa', async ({ page, env }) => {
    const slug = 'galeria-cinco';
    const p = publish(env, slug, {}, FIVE);
    await open(page, env, slug);
    await expect(mainImg(page)).toHaveCount(ONE);
    await expect(mainImg(page)).toHaveAttribute('src', p.images[NONE].url);
    expect(await mainImg(page).getAttribute('loading')).not.toBe('lazy');
    expect(await mainImg(page).getAttribute('width')).toBe(String(MAIN_W));
    expect(await mainImg(page).getAttribute('height')).toBe(String(MAIN_H));
    await expect(thumbs(page)).toHaveCount(FIVE);
    const hrefs = await thumbs(page).evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(p.images.map((i) => i.url));
    const current = await thumbs(page).evaluateAll((els) => els.map((a) => a.hasAttribute('aria-current')));
    expect(current).toEqual([true, false, false, false, false]);
    const alts = await thumbs(page).locator('img').evaluateAll((els) => els.map((i) => (i.getAttribute('alt') ?? '').trim()));
    expect(alts.every((a) => a !== '')).toBe(true);
    expect(new Set(alts).size).toBe(FIVE);
  });

  test('al pulsar una miniatura cambia la principal (src y alt) y aria-current; la página no navega', async ({ page, env }) => {
    const slug = 'galeria-clic';
    const p = publish(env, slug, {}, FIVE);
    await open(page, env, slug);
    await imageLoaded(page);
    const before = page.url();
    await thumbs(page).nth(THREE - ONE).click();
    await expect(mainImg(page)).toHaveAttribute('src', p.images[THREE - ONE].url);
    await expect(mainImg(page)).toHaveAttribute('alt', p.images[THREE - ONE].alt);
    const current = await thumbs(page).evaluateAll((els) => els.map((a) => a.hasAttribute('aria-current')));
    expect(current).toEqual([false, false, true, false, false]);
    expect(page.url()).toBe(before);
    await expect(mainImg(page)).toHaveCount(ONE);
    // Sigue siendo la imagen de LCP, aunque cambie.
    await expect(mainImg(page)).toHaveAttribute('fetchpriority', 'high');
    // Volver a la primera.
    await thumbs(page).first().click();
    await expect(mainImg(page)).toHaveAttribute('src', p.images[NONE].url);
    expect(await thumbs(page).evaluateAll((els) => els.filter((a) => a.hasAttribute('aria-current')).length)).toBe(ONE);
  });

  test('con teclado: Tab llega a las miniaturas y Enter cambia la principal', async ({ page, env }) => {
    const slug = 'galeria-teclado';
    const p = publish(env, slug, {}, FIVE);
    await open(page, env, slug);
    await thumbs(page).nth(TWO).focus();
    await expect(thumbs(page).nth(TWO)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(mainImg(page)).toHaveAttribute('src', p.images[TWO].url);
    expect(await thumbs(page).nth(TWO).getAttribute('aria-current')).not.toBeNull();
  });

  test('sin JavaScript las miniaturas son enlaces que abren la imagen', async ({ browser, env }) => {
    const slug = 'galeria-sin-js';
    const p = publish(env, slug, {}, THREE);
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await open(page, env, slug);
    await expect(mainImg(page)).toHaveAttribute('src', p.images[NONE].url);
    await expect(thumbs(page)).toHaveCount(THREE);
    const second = thumbs(page).nth(ONE);
    await expect(second).toHaveAttribute('href', p.images[ONE].url);
    const [nav] = await Promise.all([page.waitForResponse(p.images[ONE].url), second.click()]);
    expect(nav.status()).toBe(OK);
    expect((await nav.allHeaders())['content-type']).toContain('image/svg+xml');
    expect(page.url()).toBe(p.images[ONE].url);
    await ctx.close();
  });

  test('sin imágenes (images: []) se usa main_image como principal', async ({ page, env }) => {
    const slug = 'galeria-vacia';
    const p = publish(env, slug, { images: [] });
    await open(page, env, slug);
    await expect(mainImg(page)).toHaveCount(ONE);
    await expect(mainImg(page)).toHaveAttribute('src', p.main_image.url);
    expect(((await mainImg(page).getAttribute('alt')) ?? '').trim()).not.toBe('');
    expect(await thumbs(page).count()).toBeLessThanOrEqual(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
  });

  test('sin el campo images (respuesta antigua) la ficha sigue sirviéndose con main_image', async ({ page, env }) => {
    const slug = 'galeria-sin-campo';
    const p = product(env.stub, slug);
    const { images: _omit, ...withoutImages } = p;
    env.stub.reply(slug, { status: OK, body: withoutImages });
    const res = await open(page, env, slug);
    expect(res.status()).toBe(OK);
    await expect(mainImg(page)).toHaveAttribute('src', p.main_image.url);
  });

  test('og:image es la imagen principal', async ({ page, env }) => {
    const slug = 'galeria-og';
    const p = publish(env, slug, {}, THREE);
    await open(page, env, slug);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', p.images[NONE].url);
    const vacio = publish(env, 'galeria-og-vacia', { images: [] });
    await open(page, env, 'galeria-og-vacia');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', vacio.main_image.url);
  });

  test('las miniaturas miden >= 44 px, tienen foco visible (>= 2 px) y caben a 360 px', async ({ page, env }) => {
    const slug = 'galeria-tactil';
    publish(env, slug, {}, FIVE);
    await page.setViewportSize({ width: WIDTH_SMALL, height: VIEWPORT_HEIGHT });
    await open(page, env, slug);
    const sizes = await thumbs(page).evaluateAll((els) => els.map((a) => ({ w: a.getBoundingClientRect().width, h: a.getBoundingClientRect().height, r: a.getBoundingClientRect().right })));
    sizes.forEach((s) => {
      expect(s.w).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(s.h).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(s.r).toBeLessThanOrEqual(WIDTH_SMALL);
    });
    await page.keyboard.press('Tab');
    await thumbs(page).nth(ONE).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await thumbs(page).nth(ONE).evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle === 'none' ? 0 : parseFloat(cs.outlineWidth);
    });
    expect(ring).toBeGreaterThanOrEqual(FOCUS_RING_MIN);
  });
});

test.describe('estabilidad visual de la imagen principal', () => {
  test('el hueco de la principal está reservado: su caja no cambia al llegar la imagen (CLS ~ 0)', async ({ page, env }) => {
    const slug = 'cls-principal';
    const p = product(env.stub, slug, {}, THREE);
    const slow = p.images.map((i, n) => ({ ...i, url: env.stub.imageUrl(n + ONE, { w: PANORAMA.w, h: PANORAMA.h, delayMs: IMAGE_DELAY_MS }) }));
    env.stub.reply(slug, { status: OK, body: { ...p, images: slow, main_image: slow[NONE] } });
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: { value: number; hasMain: boolean }[] };
      w.__cls = [];
      new PerformanceObserver((list) => {
        list.getEntries().forEach((e) => {
          const s = e as unknown as { value: number; hadRecentInput: boolean; sources?: { node?: Node }[] };
          if (s.hadRecentInput) return;
          const hasMain = (s.sources ?? []).some((x) => x.node instanceof Element && (x.node.matches('img[fetchpriority="high"]') || x.node.querySelector('img[fetchpriority="high"]') !== null));
          w.__cls.push({ value: s.value, hasMain });
        });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await page.goto(`${env.site.origin}/relojes/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    // Se mide el marco de la principal (el padre de la imagen) y lo que hay debajo: ninguno puede moverse al llegar la imagen.
    const box = (): Promise<{ w: number; h: number; top: number; below: number }> =>
      mainImg(page).evaluate((el) => {
        const r = (el.parentElement as HTMLElement).getBoundingClientRect();
        const below = (document.querySelector('main section[aria-labelledby="specs-title"]') as HTMLElement).getBoundingClientRect().top;
        return { w: r.width, h: r.height, top: r.top, below };
      });
    const before = await box();
    expect(await page.evaluate(() => document.querySelector<HTMLImageElement>('main img[fetchpriority="high"]')?.complete)).toBe(false);
    await imageLoaded(page);
    const after = await box();
    expect(Math.abs(after.w - before.w)).toBeLessThanOrEqual(BOX_TOLERANCE);
    expect(Math.abs(after.h - before.h)).toBeLessThanOrEqual(BOX_TOLERANCE);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(BOX_TOLERANCE);
    expect(Math.abs(after.below - before.below)).toBeLessThanOrEqual(BOX_TOLERANCE);
    expect(Math.abs(after.w / after.h - MAIN_RATIO)).toBeLessThan(RATIO_TOLERANCE);
    const shifts = await page.evaluate(() => (window as unknown as { __cls: { value: number; hasMain: boolean }[] }).__cls);
    expect(shifts.filter((s) => s.hasMain).reduce((sum, s) => sum + s.value, NONE), JSON.stringify(shifts)).toBeLessThan(CLS_LIMIT);
  });

  test('imágenes de proporciones muy distintas (panorámica y vertical) no deforman ni desbordan la principal', async ({ page, env }) => {
    const slug = 'cls-proporciones';
    const p = product(env.stub, slug, {}, TWO);
    const odd = [
      { ...p.images[NONE], url: env.stub.imageUrl(1, { w: WIDE.w, h: WIDE.h }) },
      { ...p.images[ONE], url: env.stub.imageUrl(2, { w: WIDE.h, h: WIDE.w }) },
    ];
    env.stub.reply(slug, { status: OK, body: { ...p, images: odd, main_image: odd[NONE] } });
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page, env, slug);
    await imageLoaded(page);
    const frame = (): Promise<number> => mainImg(page).evaluate((el) => (el.parentElement as HTMLElement).getBoundingClientRect().height);
    const first = await frame();
    await thumbs(page).nth(ONE).click();
    await page.waitForFunction(() => (document.querySelector('main img[fetchpriority="high"]') as HTMLImageElement | null)?.src.includes('/img/2.svg') === true);
    await imageLoaded(page);
    const second = await frame();
    expect(Math.abs(second - first)).toBeLessThanOrEqual(BOX_TOLERANCE);
    expect(await overflowOf(page)).toBeLessThanOrEqual(NONE);
  });
});

test.describe('404: inexistente, despublicado y rutas peligrosas', () => {
  test('inexistente y borrador dan el mismo 404 con la misma página (sin revelar el estado)', async ({ page, env }) => {
    env.stub.reply('borrador-secreto', {
      status: NOT_FOUND,
      body: { error: { code: 'product_unpublished', message: 'Producto en borrador PRIVADO-123', details: null } },
    });
    const gone = await open(page, env, 'no-existe-nunca');
    const goneText = norm(await page.locator('body').innerText());
    const goneHtml = await gone.text();
    const draft = await open(page, env, 'borrador-secreto');
    const draftText = norm(await page.locator('body').innerText());
    expect(gone.status()).toBe(NOT_FOUND);
    expect(draft.status()).toBe(NOT_FOUND);
    expect(draftText).toBe(goneText);
    expect(draftText).not.toContain('PRIVADO-123');
    expect(goneHtml).not.toContain('PRIVADO-123');
    expect(goneHtml).not.toContain('product_unpublished');
  });

  test('la página 404: un h1 sr-only "Error 404", "Esta página no existe" y enlace al catálogo; noindex', async ({ page, env }) => {
    const res = await open(page, env, 'otro-que-no-existe');
    expect(res.status()).toBe(NOT_FOUND);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Error 404');
    const sr = await page.getByRole('heading', { level: 1 }).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    expect(sr.w).toBeLessThanOrEqual(ONE);
    expect(sr.h).toBeLessThanOrEqual(ONE);
    await expect(page.getByText('Esta página no existe')).toBeVisible();
    const link = page.getByRole('main').getByRole('link', { name: CATALOG_LINK });
    await expect(link).toHaveAttribute('href', '/relojes');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', NOINDEX);
    await expect(page.locator('main#contenido')).toHaveCount(ONE);
  });

  test('N-2: "." y "%2E" dan 404 sin llamar a la API; ".." y "%2E%2E" tampoco la llaman ni dan 500; "a%2Fb" y "%00" dan 404', async ({ env }) => {
    env.stub.apiHits.splice(NONE);
    const strict = await sequence(['/relojes/.', '/relojes/%2E', '/relojes/%2e'], (path) => rawGet(env.site.origin, path));
    // WHATWG URL quita los segmentos "." y "%2E" antes de enrutar: la página no llega a verlos (su guarda se prueba en
    // tests/components/product-page.test.ts). Hoy no existe /relojes/ y da 404; con el listado (T-124) el resultado será el listado:
    // lo que importa es que NUNCA sea una ficha de producto ni un 5xx.
    strict.forEach((r) => expect(r.status === NOT_FOUND || (r.status === OK && !r.body.includes('IGV incluido'))).toBe(true));
    const dots = await sequence(['/relojes/..', '/relojes/%2E%2E', '/relojes/%2e%2e'], (path) => rawGet(env.site.origin, path));
    dots.forEach((r) => expect(r.status).toBeLessThan(SERVER_ERROR));
    expect(env.stub.apiHits.filter((h) => h.startsWith('/api/v1/catalog/products')), 'la API recibió una petición de producto').toEqual([]);
    // Otros slugs raros sí llegan a la API (codificados, sin poder salir de su ruta) y su 404 se muestra igual.
    const odd = await sequence(['/relojes/a%2Fb', '/relojes/%00', '/relojes/%3Cscript%3E'], (path) => rawGet(env.site.origin, path));
    expect(odd.map((r) => r.status)).toEqual(odd.map(() => NOT_FOUND));
    env.stub.apiHits.forEach((h) => expect(h.slice('/api/v1/catalog/products/'.length).includes('/')).toBe(false));
  });

  test('un slug normal sí llama a la API exactamente una vez, con el slug codificado', async ({ env }) => {
    publish(env, 'una-llamada');
    env.stub.apiHits.splice(NONE);
    const r = await rawGet(env.site.origin, '/relojes/una-llamada');
    expect(r.status).toBe(OK);
    expect(env.stub.apiHits).toEqual(['/api/v1/catalog/products/una-llamada']);
  });

  test('un slug con marcado no se refleja sin escapar en la 404', async ({ env }) => {
    const r = await rawGet(env.site.origin, '/relojes/%3Cscript%3Ewindow.__x%3D1%3C%2Fscript%3E');
    expect(r.status).toBe(NOT_FOUND);
    expect(r.body).not.toContain('<script>window.__x=1</script>');
  });
});

test.describe('API caída o con errores: 502, nunca 500', () => {
  test('5xx del servidor: 502, no-store, Notice con "Reintentar" a la misma URL, un h1 y sin filtrar el cuerpo del error', async ({ page, env }) => {
    env.stub.reply('error-500', { status: SERVER_ERROR, body: { error: { code: 'internal', message: 'boom TRAZA-SECRETA at /srv/app.py', details: null } } });
    const res = await open(page, env, 'error-500');
    expect(res.status()).toBe(BAD_GATEWAY);
    expect(res.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    const notice = page.getByRole('alert').filter({ hasText: 'No pudimos cargar este reloj' });
    await expect(notice).toBeVisible();
    const retry = notice.getByRole('link', { name: 'Reintentar' });
    await expect(retry).toHaveAttribute('href', '/relojes/error-500');
    const body = await page.content();
    expect(body).not.toContain('TRAZA-SECRETA');
    expect(body).not.toContain('app.py');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', NOINDEX);
  });

  test('503, cuerpo no JSON con 200 y cuerpo no JSON con 500: siempre 502 con no-store (nunca 500)', async ({ page, env }) => {
    env.stub.reply('err-503', { status: UNAVAILABLE, body: { error: { code: 'unavailable', message: 'x', details: null } } });
    env.stub.reply('err-html-200', { status: OK, body: null, raw: '<html>no soy json' });
    env.stub.reply('err-html-500', { status: SERVER_ERROR, body: null, raw: 'Internal Server Error' });
    const results = await sequence(['err-503', 'err-html-200', 'err-html-500'], async (slug) => {
      const res = await open(page, env, slug);
      return [slug, res.status(), res.headers()['cache-control'] ?? ''] as const;
    });
    expect(results).toEqual([
      ['err-503', BAD_GATEWAY, 'no-store'],
      ['err-html-200', BAD_GATEWAY, 'no-store'],
      ['err-html-500', BAD_GATEWAY, 'no-store'],
    ]);
  });

  test('"Reintentar" funciona cuando la API vuelve', async ({ page, env }) => {
    const slug = 'reintento';
    publish(env, slug);
    await env.stub.stop();
    try {
      const down = await open(page, env, slug);
      expect(down.status()).toBe(BAD_GATEWAY);
      expect(down.headers()['cache-control']).toBe('no-store');
      await expect(page.getByRole('alert').filter({ hasText: 'No pudimos cargar este reloj' })).toBeVisible();
    } finally {
      await env.stub.start();
    }
    await page.getByRole('link', { name: 'Reintentar' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Reloj de Prueba Aurora' })).toBeVisible();
    expect(page.url()).toBe(`${env.site.origin}/relojes/${slug}`);
  });

  test('API que no responde: 502 al agotarse el tiempo (8 s) y no 500', async ({ page, env }) => {
    test.setTimeout(SLOW);
    env.stub.reply('lento', { status: OK, body: product(env.stub, 'lento'), delayMs: HANG_MS });
    const started = Date.now();
    const res = await open(page, env, 'lento');
    expect(res.status()).toBe(BAD_GATEWAY);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(Date.now() - started).toBeGreaterThanOrEqual(API_TIMEOUT_MS - ONE_SECOND);
    await expect(page.getByRole('link', { name: 'Reintentar' })).toBeVisible();
  });
});

test.describe('contenido del servidor como texto (RT-5)', () => {
  test('nombre, categoría, descripción y especificaciones hostiles se muestran literales y no ejecutan nada', async ({ page, env }) => {
    const slug = 'xss-total';
    const evilName = '<i>Aurora</i> "Q" <img src=x onerror=window.__xss=1>';
    const evilDesc = '<script>window.__xss=1</script><b>negrita</b>\nSegunda línea con <u>subrayado</u>';
    publish(env, slug, {
      name: evilName,
      description: evilDesc,
      category: { slug: 'a b&c"d', name: '<b>Cat</b>' },
      specs: [{ label: '<s>Etiqueta</s>', value: '<a href="javascript:alert(1)">valor</a>' }],
    });
    const errors = collectConsoleErrors(page);
    const res = await open(page, env, slug);
    expect(res.status()).toBe(OK);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('main b, main i, main u, main s, main a[href^="javascript"]').count()).toBe(NONE);
    expect(await page.locator('main [onerror]').count()).toBe(NONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(evilName);
    await expect(page).toHaveTitle(`${evilName} — Valmont`);
    expect(await page.locator('meta[name="description"]').count()).toBe(ONE);
    await expect(page.getByText('<b>negrita</b>', { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('la descripción conserva los saltos de línea (white-space: pre-line) y no usa <br>', async ({ page, env }) => {
    publish(env, 'saltos', { description: 'Línea uno.\nLínea dos.\nLínea tres.' });
    await open(page, env, 'saltos');
    const holder = page.locator('main p', { hasText: 'Línea uno.' }).first();
    expect(await holder.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-line');
    expect(await holder.evaluate((el) => (el as HTMLElement).innerText)).toContain('Línea uno.\nLínea dos.');
    expect(await holder.evaluate((el) => el.querySelectorAll('br').length)).toBe(NONE);
    const lineHeight = await holder.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(await holder.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(lineHeight * TWO);
  });
});

test.describe('metadatos y SEO', () => {
  test('title con el nombre y meta description de 155 caracteres como máximo (primeros 155 de la descripción)', async ({ page, env }) => {
    const long = `${'Palabra  larga\ncon espacios. '.repeat(SPACES_CHUNK)}FIN`;
    publish(env, 'meta-larga', { name: 'Modelo Meta', description: long });
    await open(page, env, 'meta-larga');
    await expect(page).toHaveTitle('Modelo Meta — Valmont');
    const content = (await page.locator('meta[name="description"]').getAttribute('content')) ?? '';
    expect(content.length).toBeLessThanOrEqual(META_MAX);
    expect(content.length).toBeGreaterThan(META_MAX - META_SLACK);
    expect(content.trim()).toBe(norm(long).slice(NONE, META_MAX).trim());
    expect(content).not.toContain('FIN');
    expect(await page.locator('meta[name="description"]').count()).toBe(ONE);
  });

  test('description corta: completa y sin relleno; vacía: a lo sumo una meta description válida', async ({ page, env }) => {
    publish(env, 'meta-corta', { description: 'Breve.' });
    await open(page, env, 'meta-corta');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Breve.');
    publish(env, 'meta-vacia', { description: '' });
    const res = await open(page, env, 'meta-vacia');
    expect(res.status()).toBe(OK);
    const metas = await page.locator('meta[name="description"]').evaluateAll((els) => els.map((e) => e.getAttribute('content') ?? ''));
    expect(metas.length).toBeLessThanOrEqual(ONE);
    metas.forEach((m) => expect(m.length).toBeLessThanOrEqual(META_MAX));
  });

  test('cabecera de caché pública del paquete en un 200', async ({ env }) => {
    publish(env, 'cache-ok');
    const r = await rawGet(env.site.origin, '/relojes/cache-ok');
    expect(r.status).toBe(OK);
    expect(r.headers['cache-control']).toBe(CACHE_OK);
  });

  test('un 404 y un 502 no llevan la caché pública del 200', async ({ env }) => {
    const gone = await rawGet(env.site.origin, '/relojes/sin-caches');
    expect(gone.status).toBe(NOT_FOUND);
    expect(String(gone.headers['cache-control'] ?? '')).not.toContain('max-age=30');
    env.stub.reply('sin-cache-502', { status: SERVER_ERROR, body: { error: { code: 'x', message: 'x', details: null } } });
    const bad = await rawGet(env.site.origin, '/relojes/sin-cache-502');
    expect(bad.status).toBe(BAD_GATEWAY);
    expect(bad.headers['cache-control']).toBe('no-store');
  });
});

test.describe('estructura de la ficha', () => {
  test('migas Inicio > Relojes > categoría (codificada) > nombre; un solo h1 con el nombre', async ({ page, env }) => {
    publish(env, 'migas', { category: { slug: 'cat con espacio&x', name: 'Clásica (stub)' }, name: 'Modelo Migas' });
    await open(page, env, 'migas');
    const nav = page.getByRole('navigation', { name: 'Migas de pan' });
    await expect(nav).toHaveCount(ONE);
    const items = await nav.locator('li').evaluateAll((els) =>
      els.map((li) => ({ text: (li.textContent ?? '').trim(), href: li.querySelector('a')?.getAttribute('href') ?? null, current: li.querySelector('[aria-current="page"]') !== null })),
    );
    expect(items).toEqual([
      { text: 'Inicio', href: '/', current: false },
      { text: 'Relojes', href: '/relojes', current: false },
      { text: 'Clásica (stub)', href: `/relojes?category=${encodeURIComponent('cat con espacio&x')}`, current: false },
      { text: 'Modelo Migas', href: null, current: true },
    ]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Modelo Migas');
  });

  test('sin relacionados no se pinta la sección; con relacionados, una rejilla etiquetada con enlaces a sus fichas', async ({ page, env }) => {
    publish(env, 'sin-rel', { related: [] });
    await open(page, env, 'sin-rel');
    await expect(page.getByText('También te pueden interesar')).toHaveCount(NONE);
    expect(await page.locator('main article').count()).toBe(NONE);
    publish(env, 'con-rel');
    await open(page, env, 'con-rel');
    await expect(page.getByRole('heading', { level: 2, name: 'También te pueden interesar' })).toBeVisible();
    await expect(page.locator('main article')).toHaveCount(TWO);
    await expect(page.getByRole('list', { name: 'Relojes relacionados' })).toHaveCount(ONE);
    await expect(page.getByRole('link', { name: 'Relacionado Uno' })).toHaveAttribute('href', '/relojes/stub-rel-a');
  });

  test('especificaciones: solo las filas no nulas, en orden, sin etiquetas repetidas', async ({ page, env }) => {
    publish(env, 'specs-pocas', {
      sku: 'SK-9',
      movement: null,
      case_material: null,
      case_diameter_mm: null,
      water_resistance_m: null,
      specs: [{ label: 'Calibre', value: 'C-1' }],
    });
    await open(page, env, 'specs-pocas');
    const terms = await page.locator('main dl dt').allInnerTexts();
    expect(terms.map((t) => t.trim().toLowerCase())).toEqual(['referencia', 'calibre']);
    publish(env, 'specs-dup', { specs: [{ label: 'Movimiento', value: 'otro' }, { label: 'Cristal', value: 'Zafiro' }] });
    await open(page, env, 'specs-dup');
    const dup = (await page.locator('main dl dt').allInnerTexts()).map((t) => t.trim().toLowerCase());
    expect(new Set(dup).size).toBe(dup.length);
    expect(dup[NONE]).toBe('referencia');
    expect(dup).toContain('cristal');
  });

  test('sin specs extra solo salen las estructuradas', async ({ page, env }) => {
    publish(env, 'specs-cero', { specs: [] });
    await open(page, env, 'specs-cero');
    expect((await page.locator('main dl dt').allInnerTexts()).map((t) => t.trim().toLowerCase())).toEqual([
      'referencia',
      'movimiento',
      'diámetro de caja',
      'material de caja',
      'resistencia al agua',
    ]);
  });

  test('BuyBox sin botones de compra ni deseos (el slot `actions` llega con T-060) y con el asesor', async ({ page, env }) => {
    publish(env, 'sin-botones');
    await open(page, env, 'sin-botones');
    expect(await page.locator('main button').count()).toBe(NONE);
    await expect(page.getByRole('link', { name: ADVISOR_LINK })).toHaveAttribute('href', '/nosotros#contacto');
    await expect(page.getByText('IGV incluido')).toBeVisible();
  });

  test('disponibilidad y precio de los cuatro estados del servidor, sin cantidades', async ({ page, env }) => {
    const cases = [
      ['disp-in', { status: 'in_stock', lead_time_days: null }, 'En stock'],
      ['disp-low', { status: 'low_stock', lead_time_days: null }, 'Quedan pocas unidades'],
      ['disp-out', { status: 'out_of_stock', lead_time_days: null }, 'Agotado'],
      ['disp-req', { status: 'on_request', lead_time_days: LEAD_DAYS }, `entrega estimada en ${LEAD_DAYS} días`],
    ] as const;
    await sequence(cases, async ([slug, availability, label]) => {
      publish(env, slug, { availability: { ...availability }, price: pen(BIG_PRICE), original_price: pen(BIG_ORIGINAL), discount_amount: pen(BIG_SAVING) });
      await open(page, env, slug);
      await expect(page.getByRole('main').getByText(label).first()).toBeVisible();
      // formatMoney (lib/format.ts) pinta "S/ 123,456" con un espacio de no separación; el DOM se compara con espacios normales.
      const shown = (cents: number): string => formatMoney(pen(cents)).replaceAll(' ', ' ');
      await expect(page.getByRole('main')).toContainText(shown(BIG_PRICE));
      await expect(page.locator('main del')).toContainText(shown(BIG_ORIGINAL));
      await expect(page.getByRole('main')).toContainText(`Ahorras ${shown(BIG_SAVING)}`);
    });
  });
});

test.describe('accesibilidad y diseño adaptable (stub, 5 imágenes)', () => {
  WIDTHS.forEach((width) => {
    test(`axe (WCAG 2.2 AA): 0 violaciones a ${width} px en la ficha con galería`, async ({ page, env }) => {
      publish(env, 'axe-galeria', {}, FIVE);
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, env, 'axe-galeria');
      await imageLoaded(page);
      await expectNoA11yViolations(page);
    });
  });

  test('sin desbordamiento a 360, 375, 800 y 1280 con un nombre de 290 caracteres (varias palabras); galería y BuyBox apilados por debajo de 1280 y en dos columnas desde 1280', async ({ page, env }) => {
    test.setTimeout(SLOW);
    const longName = 'Tourbillon Aurora Grande Complication Calendario Perpetuo Fase Lunar Edición Limitada Numerada '.repeat(NAME_WORD_REPEATS);
    publish(env, 'layout-largo', { name: longName, sku: 'SKU-' + 'X'.repeat(SKU_PAD) }, FIVE);
    const reports = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, env, 'layout-largo');
      return page.evaluate((w) => {
        const main = document.querySelector('main img[fetchpriority="high"]') as HTMLElement;
        const h1 = document.querySelector('main h1') as HTMLElement;
        const g = main.getBoundingClientRect();
        const b = h1.getBoundingClientRect();
        return {
          width: w,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          stacked: b.top >= g.bottom - 1,
          sideBySide: b.left >= g.right - 1,
          infoWidth: Math.round(document.querySelector('main section[aria-label="Compra"]')?.getBoundingClientRect().width ?? 0),
          h1Right: b.right,
        };
      }, width);
    });
    expect(reports.filter((r) => r.overflow > NONE || r.h1Right > r.width)).toEqual([]);
    expect(reports.filter((r) => r.width < WIDTH_DESKTOP).map((r) => r.stacked)).toEqual([true, true, true]);
    const desktop = reports.find((r) => r.width === WIDTH_DESKTOP);
    expect(desktop?.sideBySide).toBe(true);
    expect(desktop?.infoWidth).toBeLessThanOrEqual(HERO_INFO_WIDTH + BOX_TOLERANCE);
  });

  test('una URL de 221 caracteres sin espacios en la descripción no provoca scroll horizontal a 360 px', async ({ page, env }) => {
    publish(env, 'url-larga', { description: `https://example.test/${'a'.repeat(200)}` });
    await page.setViewportSize({ width: WIDTH_SMALL, height: VIEWPORT_HEIGHT });
    await open(page, env, 'url-larga');
    expect(await overflowOf(page)).toBeLessThanOrEqual(NONE);
  });

  test('la imagen principal a 1280 tiene proporción 712:593', async ({ page, env }) => {
    publish(env, 'ratio', {}, TWO);
    await page.setViewportSize({ width: WIDTH_DESKTOP, height: VIEWPORT_HEIGHT });
    await open(page, env, 'ratio');
    await imageLoaded(page);
    const { frame, img } = await mainImg(page).evaluate((el) => {
      const f = (el.parentElement as HTMLElement).getBoundingClientRect();
      const i = el.getBoundingClientRect();
      return { frame: { w: f.width, h: f.height }, img: { w: i.width, h: i.height } };
    });
    expect(Math.abs(frame.w / frame.h - MAIN_RATIO)).toBeLessThan(RATIO_TOLERANCE);
    // La imagen rellena su marco (object-fit: cover), sea cual sea su proporción: la del stub es 800 x 600.
    expect(frame.h - img.h, 'la imagen no rellena el marco de 712:593').toBeLessThanOrEqual(FRAME_BORDER);
    expect(frame.w - img.w).toBeLessThanOrEqual(FRAME_BORDER);
  });

  test('objetivos táctiles >= 44 px en migas, "Consultar con un asesor" y relacionados a 375 px', async ({ page, env }) => {
    publish(env, 'tactil', {}, THREE);
    await page.setViewportSize({ width: WIDTH_PHONE, height: VIEWPORT_HEIGHT });
    await open(page, env, 'tactil');
    const small = await page.evaluate((min) => {
      const sel = ['main nav[aria-label="Migas de pan"] a', 'main a[href="/nosotros#contacto"]', 'main article'];
      return sel.flatMap((s) =>
        [...document.querySelectorAll(s)]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width < min - 1 || r.height < min - 1;
          })
          .map((e) => `${s}: ${(e.textContent ?? '').trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
      );
    }, TOUCH_TARGET);
    expect(small).toEqual([]);
  });

  [WIDTH_SMALL, WIDTH_DESKTOP].forEach((width) => {
    test(`axe: la 404 y el error 502 no tienen violaciones a ${width} px`, async ({ page, env }) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page, env, 'axe-no-existe');
      await expectNoA11yViolations(page);
      env.stub.reply('axe-502', { status: SERVER_ERROR, body: { error: { code: 'x', message: 'x', details: null } } });
      const res = await open(page, env, 'axe-502');
      expect(res.status()).toBe(BAD_GATEWAY);
      await expectNoA11yViolations(page);
    });
  });

  test('ninguna petición del navegador a la API; consola limpia', async ({ page, env }) => {
    publish(env, 'red-limpia', {}, THREE);
    const errors = collectConsoleErrors(page);
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await open(page, env, 'red-limpia');
    await imageLoaded(page);
    await thumbs(page).nth(ONE).click();
    expect(seen.filter((u) => u.includes('/api/v1')), 'peticiones a la API desde el navegador').toEqual([]);
    expect(seen.filter((u) => u.includes(`:${env.stub.port}`) && !u.includes('/img/'))).toEqual([]);
    expect(errors).toEqual([]);
  });
});
