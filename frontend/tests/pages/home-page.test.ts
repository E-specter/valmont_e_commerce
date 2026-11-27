import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Home from '../../src/pages/index.astro';
import { FRONTEND } from '../helpers/css';
import { parseHtml } from '../helpers/render';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-121 · la portada `/` (STATUS "T-121 > Criterios de aceptación"), renderizada con la Container API y un `fetch` falso
// por ruta (el contrato de catálogo; sin red). Se prueba lo que ve el visitante: DOM accesible, enlaces, cabeceras.
const NONE = 0;
const ONE = 1;
const THREE = 3;
const FOUR = 4;
const OK = 200;
const SERVER_ERROR = 500;
const PRICE = 290000;
// Cada expresión regular lleva su ejemplo (regla del repositorio de estilo).
// Marca: "Valmont · Alta relojería" casa; "Rolex" no.
// Probar: https://regex101.com/?flavor=javascript&regex=Valmont&flags=i
const BRAND = /Valmont/i;
// Título del hero: "Donde la tradición relojera" casa; "Bienvenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=tradici%5Bo%C3%B3%5Dn&flags=i
const HERO_TITLE = /tradici[oó]n/i;
// Enlace de boutiques o tiendas (P-1): "/tiendas" casa; "/relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=boutique%7Ctienda&flags=i
const STORES_HREF = /boutique|tienda/i;
// Importe es-PE: "S/ 2,900" casa; "S/ 29,000" no.
// Probar: https://regex101.com/?flavor=javascript&regex=S%5C%2F%5Cs%3F2%2C900(%3F!%5Cd)&flags=
const AMOUNT_2900 = /S\/\s?2,900(?!\d)/;
// "S/ 800" casa; "S/ 8,000" no.
// Probar: https://regex101.com/?flavor=javascript&regex=S%5C%2F%5Cs%3F800(%3F!%5Cd)&flags=
const AMOUNT_800 = /S\/\s?800(?!\d)/;
// Detalle técnico filtrado al HTML: "TypeError: fetch failed" casa; "Ver todos los relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=fetch%20failed%7CTypeError%7CECONNREFUSED%7Cstack&flags=i
const LEAK = /fetch failed|TypeError|ECONNREFUSED|stack/i;
// Cabecera Vary por cookie: "Cookie" casa; "Accept-Encoding" no.
// Probar: https://regex101.com/?flavor=javascript&regex=cookie&flags=i
const VARY_COOKIE = /cookie/i;
// Portada dinámica: "export const prerender = false;" casa; "prerender = true" no.
// Probar: https://regex101.com/?flavor=javascript&regex=export%20const%20prerender%20%3D%20false&flags=
const SSR = /export const prerender = false/;
// HTML del servidor sin escapar: "set:html" casa; "set:text" no.
// Probar: https://regex101.com/?flavor=javascript&regex=set%3Ahtml&flags=
const SET_HTML = /set:html/;
// Color hexadecimal suelto: "#a1b2c3" casa; "#contenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%23%5B0-9A-Fa-f%5D%7B3%2C8%7D%5Cb&flags=
const HEX = /#[0-9A-Fa-f]{3,8}\b/;
// Caché pública y corta: "'Cache-Control', 'public, max-age=60'" casa; "'private'" no.
// Probar: https://regex101.com/?flavor=javascript&regex=Cache-Control%5B'%22%5D%2C%5Cs*%5B'%22%5Dpublic%2C%20max-age%3D60%5B'%22%5D&flags=
const PUBLIC_CACHE = /Cache-Control['"],\s*['"]public, max-age=60['"]/;
// Caché privada: "no-store" casa; "public" no.
// Probar: https://regex101.com/?flavor=javascript&regex=no-store%7Cprivate&flags=
const PRIVATE_CACHE = /no-store|private/;
// Acceso a la sesión: "Astro.locals" casa; "Astro.props" no.
// Probar: https://regex101.com/?flavor=javascript&regex=Astro%5C.locals%7CAstro%5C.cookies%7CaccessToken%7Csession&flags=i
const SESSION_USE = /Astro\.locals|Astro\.cookies|accessToken|session/i;
const SALE = 80000;
const LIST = 100000;
const SAVING = 20000;
const IMG = 'https://img.example.test/p.jpg';
const XSS = '<script>window.__pwned=1</script><b>x</b>';
const COOKIE_VALUE = 'sesion-ajena-123';
const FAKE_BEARER = 'abc.def.ghi';

const cat = (slug: string, name: string) => ({ slug, name, description: null });
const FOUR_CATS = [cat('demo-vestir', 'Vestir (demo)'), cat('demo-deportivos', 'Deportivos (demo)'), cat('demo-buceo', 'Buceo (demo)'), cat('demo-aviador', 'Aviador (demo)')];
const product = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'demo-lira-37',
  sku: 'DEMO-012',
  name: 'Demo Lira 37',
  category: { slug: 'demo-aviador', name: 'Aviador (demo)' },
  price: { amount: PRICE, currency: 'PEN' },
  original_price: null,
  discount_amount: null,
  movement: null,
  case_material: null,
  case_diameter_mm: null,
  water_resistance_m: null,
  main_image: { id: '00000000-0000-4000-8000-000000000002', url: IMG, alt: 'Imagen de marcador (demo)' },
  availability: { status: 'in_stock', lead_time_days: null },
  ...over,
});
const pageOf = (items: unknown[]) => ({ items, total: items.length, page: 1, page_size: 1 });
const json = (body: unknown, status = OK) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Behaviour = { categories: () => Response | Promise<Response>; products: () => Response | Promise<Response> };
let fetchMock: ReturnType<typeof vi.fn>;

function stubApi(b: Partial<Behaviour> = {}): void {
  const full: Behaviour = {
    categories: () => json(FOUR_CATS),
    products: () => json(pageOf([product()])),
    ...b,
  };
  fetchMock = vi.fn(async (url: string) => (String(url).includes('/catalog/categories') ? full.categories() : full.products()));
  vi.stubGlobal('fetch', fetchMock);
}
beforeEach(() => stubApi());
afterEach(() => vi.unstubAllGlobals());

type Rendered = { res: Response; doc: Document; html: string };
async function render(init: RequestInit = {}): Promise<Rendered> {
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Home, { request: new Request('http://localhost:4321/', init) });
  const html = await res.text();
  return { res, doc: parseHtml(html), html };
}

const main = (d: Document): Element => d.querySelector('main') as Element;
const tiles = (d: Document): Element[] => [...main(d).querySelectorAll('ul a[href^="/relojes?category="]')].filter((a) => a.closest('nav') === null);
const collectionNav = (d: Document): Element | null => main(d).querySelector('nav[aria-label]');
const featured = (d: Document): Element | null => main(d).querySelector('[aria-labelledby="featured-title"]');
const fallbackLink = (d: Document): Element | undefined => [...main(d).querySelectorAll('a')].find((a) => text(a) === 'Ver todos los relojes');

describe('estructura y accesibilidad (datos completos)', () => {
  test('responde 200 con un único h1 y los landmarks de StoreLayout', async () => {
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(doc.querySelectorAll('main#contenido')).toHaveLength(ONE);
    expect(doc.querySelectorAll('header')).toHaveLength(ONE);
    expect(doc.querySelectorAll('footer')).toHaveLength(ONE);
    expect(doc.querySelector('h1')?.closest('main')).not.toBeNull();
    expect(doc.title).toMatch(BRAND);
  });

  test('el h1 es el del hero (el nombre del producto es h2) y los encabezados no saltan de nivel', async () => {
    const { doc } = await render();
    expect(text(doc.querySelector('h1'))).toMatch(HERO_TITLE);
    expect(text(featured(doc)?.querySelector('h2'))).toBe('Demo Lira 37');
    const levels = [...main(doc).querySelectorAll('h1,h2,h3,h4')].map((h) => Number(h.tagName.slice(ONE)));
    expect(levels[0]).toBe(ONE);
    levels.slice(ONE).forEach((l, i) => expect(l - levels[i]).toBeLessThanOrEqual(ONE));
  });

  test('todos los enlaces y botones tienen nombre accesible', async () => {
    const { doc } = await render();
    [...doc.querySelectorAll('a[href]')].forEach((a) => expect(text(a) || a.getAttribute('aria-label'), a.outerHTML).toBeTruthy());
  });

  test('no hay ChatWidget ni pantalla de boutiques/tiendas (P-1) ni avisos de error', async () => {
    const { doc } = await render();
    expect(doc.querySelector('[data-chat-widget], [aria-label*="asistente" i], [aria-label*="chat" i]')).toBeNull();
    const hrefs = [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((h) => STORES_HREF.test(h))).toEqual([]);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('la invitación a contactar enlaza a /nosotros#contacto y el manifiesto a /nosotros', async () => {
    const { doc } = await render();
    const hrefs = [...main(doc).querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/nosotros#contacto');
    expect(hrefs).toContain('/nosotros');
    expect(hrefs).toContain('/relojes');
  });
});

describe('mosaicos y enlaces de colección (categorías reales)', () => {
  test('con 4 categorías: 3 mosaicos con las 3 primeras y 4 enlaces tipográficos, con href /relojes?category=<slug>', async () => {
    const { doc } = await render();
    expect(tiles(doc).map((a) => a.getAttribute('href'))).toEqual([
      '/relojes?category=demo-vestir',
      '/relojes?category=demo-deportivos',
      '/relojes?category=demo-buceo',
    ]);
    const links = [...(collectionNav(doc)?.querySelectorAll('a') ?? [])];
    expect(links.map((a) => [text(a), a.getAttribute('href')])).toEqual([
      ['Vestir (demo)', '/relojes?category=demo-vestir'],
      ['Deportivos (demo)', '/relojes?category=demo-deportivos'],
      ['Buceo (demo)', '/relojes?category=demo-buceo'],
      ['Aviador (demo)', '/relojes?category=demo-aviador'],
    ]);
    expect(links).toHaveLength(FOUR);
  });

  test('cada mosaico muestra el nombre de su categoría', async () => {
    const { doc } = await render();
    expect(tiles(doc).map((a) => text(a))).toEqual(
      expect.arrayContaining([expect.stringContaining('Vestir (demo)'), expect.stringContaining('Deportivos (demo)'), expect.stringContaining('Buceo (demo)')]),
    );
    expect(tiles(doc)).toHaveLength(THREE);
  });

  test('con 2 categorías: 2 mosaicos y 2 enlaces, sin botón de respaldo', async () => {
    stubApi({ categories: () => json(FOUR_CATS.slice(NONE, ONE + ONE)) });
    const { doc } = await render();
    expect(tiles(doc)).toHaveLength(ONE + ONE);
    expect(collectionNav(doc)?.querySelectorAll('a')).toHaveLength(ONE + ONE);
    expect(fallbackLink(doc)).toBeUndefined();
  });

  test('no se inventan colecciones: ningún mosaico apunta a un slug que la API no devolvió', async () => {
    const { doc } = await render();
    const slugs = new Set(FOUR_CATS.map((c) => c.slug));
    tiles(doc).forEach((a) => expect(slugs.has(new URL(a.getAttribute('href') ?? '', 'http://x').searchParams.get('category') ?? '')).toBe(true));
  });

  test('el nombre de la categoría se escapa y el slug se codifica en el href (sin inyectar HTML ni parámetros)', async () => {
    stubApi({ categories: () => json([cat('a&b=c d', XSS)]) });
    const { doc, html } = await render();
    expect(html).not.toContain('<script>window.__pwned');
    expect(main(doc).querySelector('script')).toBeNull();
    const href = tiles(doc)[NONE].getAttribute('href') ?? '';
    expect(href).toBe('/relojes?category=a%26b%3Dc%20d');
    expect(new URL(href, 'http://x').searchParams.get('category')).toBe('a&b=c d');
  });
});

describe('bloque "Novedad" (producto más reciente)', () => {
  test('con producto: aparece con insignia, nombre, categoría, precio del servidor y enlace a su ficha', async () => {
    const { doc } = await render();
    const f = featured(doc);
    expect(f).not.toBeNull();
    expect(text(f)).toContain('Novedad');
    expect(text(f)).toContain('Demo Lira 37');
    expect(text(f)).toContain('Aviador (demo)');
    expect(text(f)).toMatch(AMOUNT_2900);
    const link = [...(f?.querySelectorAll('a') ?? [])].find((a) => a.getAttribute('href')?.startsWith('/relojes/'));
    expect(link?.getAttribute('href')).toBe('/relojes/demo-lira-37');
  });

  test('sin producto (lista vacía): no hay bloque "Novedad" y la página sigue', async () => {
    stubApi({ products: () => json(pageOf([])) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    expect(featured(doc)).toBeNull();
    expect(text(main(doc))).not.toContain('Novedad');
    expect(tiles(doc)).toHaveLength(THREE);
  });

  test('con precio rebajado, muestra el original del servidor (sin recalcular)', async () => {
    stubApi({
      products: () =>
        json(pageOf([product({ price: { amount: SALE, currency: 'PEN' }, original_price: { amount: LIST, currency: 'PEN' }, discount_amount: { amount: SAVING, currency: 'PEN' } })])),
    });
    const { doc } = await render();
    expect(featured(doc)?.querySelector('del')).not.toBeNull();
    expect(text(featured(doc))).toMatch(AMOUNT_800);
  });

  test('el nombre del producto del servidor se escapa', async () => {
    stubApi({ products: () => json(pageOf([product({ name: XSS })])) });
    const { doc, html } = await render();
    expect(html).not.toContain('<script>window.__pwned');
    expect(featured(doc)?.querySelector('h2 b')).toBeNull();
  });
});

describe('degradación: la portada nunca da 500', () => {
  const fallbackShown = (d: Document): void => {
    expect(fallbackLink(d)?.getAttribute('href')).toBe('/relojes');
    expect(tiles(d)).toHaveLength(NONE);
    expect(collectionNav(d)).toBeNull();
    expect(featured(d)).toBeNull();
    expect(d.querySelectorAll('h1')).toHaveLength(ONE);
    expect(d.querySelector('[role="alert"], [role="status"]')).toBeNull();
  };

  test('categorías vacías y sin productos: 200 con un único botón a /relojes', async () => {
    stubApi({ categories: () => json([]), products: () => json(pageOf([])) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    fallbackShown(doc);
    expect([...main(doc).querySelectorAll('a')].filter((a) => text(a) === 'Ver todos los relojes')).toHaveLength(ONE);
  });

  test('la API caída (red rechazada): 200 con el botón de respaldo y sin avisos de error', async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { res, doc, html } = await render();
    expect(res.status).toBe(OK);
    fallbackShown(doc);
    expect(html).not.toMatch(LEAK);
  });

  test('la API responde 500 en ambas rutas: 200 con respaldo', async () => {
    stubApi({ categories: () => json({ error: { code: 'internal', message: 'x', details: null } }, SERVER_ERROR), products: () => new Response('boom', { status: SERVER_ERROR }) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    fallbackShown(doc);
  });

  test('cuerpo no JSON: 200 con respaldo', async () => {
    stubApi({ categories: () => new Response('<html>nope</html>', { status: OK, headers: { 'content-type': 'text/html' } }), products: () => new Response('???', { status: OK }) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    fallbackShown(doc);
  });

  test('solo fallan las categorías: se conserva "Novedad" y aparece el botón de respaldo', async () => {
    stubApi({ categories: () => new Response('boom', { status: SERVER_ERROR }) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    expect(featured(doc)).not.toBeNull();
    expect(fallbackLink(doc)?.getAttribute('href')).toBe('/relojes');
    expect(tiles(doc)).toHaveLength(NONE);
  });

  test('solo falla el producto: se conservan los mosaicos y no hay "Novedad"', async () => {
    stubApi({ products: () => new Response('boom', { status: SERVER_ERROR }) });
    const { res, doc } = await render();
    expect(res.status).toBe(OK);
    expect(featured(doc)).toBeNull();
    expect(tiles(doc)).toHaveLength(THREE);
  });

  test('un fallo en ambas llamadas se ejerce de verdad (la prueba no es vacía): se hicieron las dos peticiones', async () => {
    stubApi({ categories: () => new Response('boom', { status: SERVER_ERROR }), products: () => new Response('boom', { status: SERVER_ERROR }) });
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(ONE + ONE);
  });
});

describe('peticiones al backend y caché pública', () => {
  test('pide categorías y el producto más reciente (sort=newest, page_size=1) al API_BASE_URL del servidor', async () => {
    await render();
    const urls = fetchMock.mock.calls.map((c) => String(c[NONE]));
    expect(urls).toContain('http://api.test:8000/api/v1/catalog/categories');
    expect(urls).toContain('http://api.test:8000/api/v1/catalog/products?page_size=1&sort=newest');
    expect(urls).toHaveLength(ONE + ONE);
  });

  test('responde con Cache-Control: public, max-age=60 (también degradada)', async () => {
    const ok = await render();
    expect(ok.res.headers.get('cache-control')).toBe('public, max-age=60');
    stubApi({ categories: () => new Response('boom', { status: SERVER_ERROR }), products: () => new Response('boom', { status: SERVER_ERROR }) });
    const bad = await render();
    expect(bad.res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  test('sin datos por usuario: no reenvía Cookie ni Authorization a la API, no fija cookies y no refleja la cookie en el HTML', async () => {
    const { res, html } = await render({ headers: { cookie: `sb=${COOKIE_VALUE}`, authorization: `Bearer ${FAKE_BEARER}` } });
    fetchMock.mock.calls.forEach((c) => {
      const headers = Object.fromEntries(Object.entries((c[ONE] as { headers?: Record<string, string> })?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).not.toContain(COOKIE_VALUE);
    expect(html).not.toContain(FAKE_BEARER);
    expect(res.headers.get('vary') ?? '').not.toMatch(VARY_COOKIE);
  });

  test('la misma respuesta para dos visitantes distintos (nada depende de la sesión)', async () => {
    const a = await render({ headers: { cookie: 'sb=uno' } });
    const b = await render({ headers: { cookie: 'sb=dos' } });
    expect(a.html).toBe(b.html);
  });
});

describe('imágenes (RT-6, LCP)', () => {
  test('el hero es eager con fetchpriority high; las demás son lazy con width y height; ninguna sin alt', async () => {
    const { doc } = await render();
    const imgs = [...main(doc).querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThanOrEqual(ONE + ONE);
    const [hero, ...rest] = imgs;
    expect(hero.closest('section')?.querySelector('h1')).not.toBeNull();
    expect(hero.getAttribute('loading')).toBe('eager');
    expect(hero.getAttribute('fetchpriority')).toBe('high');
    expect(hero.getAttribute('alt')?.length).toBeGreaterThan(NONE);
    rest.forEach((img) => {
      expect(img.getAttribute('loading'), img.outerHTML).toBe('lazy');
      expect(img.getAttribute('fetchpriority')).not.toBe('high');
    });
    imgs.forEach((img) => {
      expect(Number(img.getAttribute('width')), img.outerHTML).toBeGreaterThan(NONE);
      expect(Number(img.getAttribute('height')), img.outerHTML).toBeGreaterThan(NONE);
      expect(img.hasAttribute('alt')).toBe(true);
    });
  });

  test('la imagen de "Novedad" es la del contrato (URL y alt)', async () => {
    const { doc } = await render();
    const img = featured(doc)?.querySelector('img');
    expect(img?.getAttribute('src')).toBe(IMG);
    expect(img?.getAttribute('alt')).toBe('Imagen de marcador (demo)');
  });
});

describe('código fuente de la página (RT-1, RT-5, D-024)', () => {
  const src = readFileSync(join(FRONTEND, 'src', 'pages', 'index.astro'), 'utf8');

  test('SSR (prerender = false) y sin set:html ni valores sueltos de color', () => {
    expect(src).toMatch(SSR);
    expect(src).not.toMatch(SET_HTML);
    expect(src).not.toMatch(HEX);
  });

  test('la caché es pública y corta; nunca private/no-store en la portada', () => {
    expect(src).toMatch(PUBLIC_CACHE);
    expect(src).not.toMatch(PRIVATE_CACHE);
  });

  test('no lee la sesión ni cookies (la caché pública no puede contener datos de usuario)', () => {
    expect(src).not.toMatch(SESSION_USE);
  });
});
