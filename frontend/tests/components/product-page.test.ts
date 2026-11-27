import { afterEach, describe, expect, test, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import NotFound from '../../src/pages/404.astro';
import ProductPage from '../../src/pages/relojes/[slug].astro';
import { parseHtml } from '../helpers/render';
import { detail, image } from '../helpers/product-detail';
import { text } from '../helpers/ui';

// T-125 · página /relojes/[slug] con la Container API y `fetch` simulado (sin servidor): estado HTTP, cabeceras y llamadas a la API.
// Lo que el servidor real no deja probar por HTTP: N-2 ("." y ".." se normalizan en la URL antes de llegar a la ruta; la guarda
// de la página es defensa en profundidad y solo se ejercita así), el recuento exacto de llamadas y los cuerpos de error.
const NONE = 0;
const ONE = 1;
const OK = 200;
const NOT_FOUND = 404;
const BAD_GATEWAY = 502;
const SERVER_ERROR = 500;
const UNAVAILABLE = 503;
const TWO = 2;
const THREE = 3;
const CACHE_OK = 'public, max-age=30, stale-while-revalidate=60';
const META_MAX = 155;
const LONG_REPEAT = 40;

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFoundBody = { error: { code: 'product_not_found', message: 'Producto no encontrado.', details: null } };

async function render(slug: string, reply: () => Promise<Response>): Promise<{ res: Response; doc: Document; html: string; calls: FetchMock }> {
  const calls: FetchMock = vi.fn(async () => reply());
  vi.stubGlobal('fetch', calls);
  const container = await AstroContainer.create();
  container.insertPageRoute('/404', NotFound);
  const res = await container.renderToResponse(ProductPage, {
    params: { slug },
    request: new Request(`http://localhost/relojes/${slug}`),
    routeType: 'page',
  });
  const html = await res.text();
  return { res, doc: parseHtml(html), html, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('página de la ficha · éxito', () => {
  test('200 con la cabecera de caché pública del paquete, un solo h1 con el nombre y una sola llamada a la API', async () => {
    const { res, doc, calls } = await render('tourbillon-aurora', async () => json(OK, detail()));
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(CACHE_OK);
    const h1 = doc.querySelectorAll('h1');
    expect(h1).toHaveLength(ONE);
    expect(text(h1[NONE])).toBe('Tourbillon Aurora');
    expect(calls).toHaveBeenCalledTimes(ONE);
    const url = String(calls.mock.calls[NONE][NONE]);
    expect(url.endsWith('/api/v1/catalog/products/tourbillon-aurora')).toBe(true);
  });

  test('title con el nombre, meta description de 155 como máximo (primeros 155 de la descripción) y og:image de la principal', async () => {
    const description = `${'Texto  largo\ncon espacios. '.repeat(LONG_REPEAT)}FIN`;
    const { doc } = await render('x', async () => json(OK, detail({ description, images: [image(TWO), image(THREE)] })));
    expect(doc.title).toContain('Tourbillon Aurora');
    const meta = doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
    expect(meta.length).toBeGreaterThan(NONE);
    expect(meta.length).toBeLessThanOrEqual(META_MAX);
    expect(meta).not.toContain('FIN');
    expect(doc.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(image(TWO).url);
  });

  test('sin imágenes usa main_image como principal y como og:image', async () => {
    const { doc } = await render('x', async () => json(OK, detail({ images: [] })));
    const main = doc.querySelector('img[fetchpriority="high"]');
    expect(main?.getAttribute('src')).toBe(detail().main_image.url);
    expect(doc.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe(detail().main_image.url);
  });

  test('sin relacionados no se pinta la sección; con relacionados sí', async () => {
    const without = await render('x', async () => json(OK, detail({ related: [] })));
    expect(without.doc.querySelectorAll('article')).toHaveLength(NONE);
    expect(text(without.doc.body)).not.toContain('También te pueden interesar');
    const rel = { ...detail(), id: 'r1', slug: 'otro', name: 'Otro Reloj' };
    const withRel = await render('x', async () => json(OK, detail({ related: [rel] })));
    expect(withRel.doc.querySelectorAll('article')).toHaveLength(ONE);
    expect(text(withRel.doc.body)).toContain('También te pueden interesar');
  });

  test('una descripción hostil no inyecta marcado en la página', async () => {
    const { doc } = await render('x', async () => json(OK, detail({ description: '<script>window.__x=1</script><b>b</b>' })));
    expect(doc.querySelector('main b')).toBeNull();
    expect([...doc.querySelectorAll('script')].filter((s) => (s.textContent ?? '').includes('__x'))).toEqual([]);
  });
});

describe('página de la ficha · 404 (inexistente o despublicado)', () => {
  test('el 404 de la API da estado 404 con la página 404 y no se cachea como éxito', async () => {
    const { res, doc } = await render('no-existe', async () => json(NOT_FOUND, notFoundBody));
    expect(res.status).toBe(NOT_FOUND);
    expect(text(doc.querySelector('h1'))).toBe('Error 404');
    expect(res.headers.get('cache-control') ?? '').not.toBe(CACHE_OK);
  });

  test('el mismo mensaje para inexistente y borrador: el cuerpo de la API no se refleja', async () => {
    const draft = { error: { code: 'product_unpublished', message: 'Producto en borrador PRIVADO-123', details: null } };
    const a = await render('no-existe', async () => json(NOT_FOUND, notFoundBody));
    const b = await render('borrador', async () => json(NOT_FOUND, draft));
    expect(b.res.status).toBe(NOT_FOUND);
    expect(text(b.doc.body)).toBe(text(a.doc.body));
    expect(b.html).not.toContain('PRIVADO-123');
  });

  test.each([['.'], ['..']])('N-2: el slug "%s" da 404 sin llamar a la API', async (slug) => {
    const { res, doc, calls } = await render(slug, async () => json(OK, detail()));
    expect(res.status).toBe(NOT_FOUND);
    expect(text(doc.querySelector('h1'))).toBe('Error 404');
    expect(calls).not.toHaveBeenCalled();
  });

  test('N-2: el slug vacío da 404 sin llamar a la API', async () => {
    const { res, calls } = await render('', async () => json(OK, detail()));
    expect(res.status).toBe(NOT_FOUND);
    expect(calls).not.toHaveBeenCalled();
  });

  test('un slug con "/" o marcado viaja codificado y no puede salir de la ruta de productos', async () => {
    const { calls } = await render('a/../b?x=<y>', async () => json(NOT_FOUND, notFoundBody));
    const url = String(calls.mock.calls[NONE][NONE]);
    const tail = url.slice(url.indexOf('/catalog/products/') + '/catalog/products/'.length);
    expect(tail).not.toContain('/');
    expect(tail).not.toContain('?');
    expect(tail).not.toContain('<');
  });
});

describe('página de la ficha · API caída o con errores (502, nunca 500)', () => {
  test.each([
    ['500 con JSON', async () => json(SERVER_ERROR, { error: { code: 'internal', message: 'boom TRAZA-SECRETA', details: null } })],
    ['503', async () => json(UNAVAILABLE, { error: { code: 'unavailable', message: 'x', details: null } })],
    ['200 con cuerpo que no es JSON', async () => new Response('<html>no soy json', { status: OK })],
    ['red caída (fetch rechaza)', async () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s: estado 502, no-store, aviso con "Reintentar" y sin filtrar el error', async (_name, reply) => {
    const { res, doc, html } = await render('reloj-x', reply);
    expect(res.status).toBe(BAD_GATEWAY);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(doc.body)).toContain('No pudimos cargar este reloj');
    const retry = [...doc.querySelectorAll('a')].find((a) => text(a) === 'Reintentar');
    expect(retry?.getAttribute('href')).toBe('/relojes/reloj-x');
    expect(html).not.toContain('TRAZA-SECRETA');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
  });
});
