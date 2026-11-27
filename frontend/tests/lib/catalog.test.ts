import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAttributes, getProduct, listCategories, listProducts, type ProductFilters } from '../../src/lib/api/catalog';
import { ApiError, type Transport } from '../../src/lib/api/http';
import { serverTransport } from '../../src/lib/api/server';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-120 · catalog.ts: ruta y parámetros exactos del OpenAPI (catalog SPEC §7), vistos desde la
// petición HTTP final (serverTransport con un `fetch` falso).
const BASE = 'http://api.test:8000/api/v1';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
const calledUrl = () => (fetchMock.mock.calls.at(-1) as [string, RequestInit])[0];
const calledInit = () => (fetchMock.mock.calls.at(-1) as [string, RequestInit])[1];
const t = () => serverTransport();

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('listProducts', () => {
  test('sin filtros → GET /catalog/products sin query', async () => {
    await listProducts(t());
    expect(calledUrl()).toBe(`${BASE}/catalog/products`);
    expect(calledInit().method).toBe('GET');
    expect(calledInit().body).toBeUndefined();
    await listProducts(t(), {});
    expect(calledUrl()).toBe(`${BASE}/catalog/products`);
  });

  test('cada filtro del OpenAPI viaja con su nombre exacto, ordenado alfabéticamente', async () => {
    const f: Required<ProductFilters> = {
      q: 'tourbillon',
      category: 'alta-relojeria',
      movement: 'automatic',
      case_material: 'steel',
      case_diameter_mm_min: 36,
      case_diameter_mm_max: 42.5,
      water_resistance_m_min: 100,
      price_min: 100000,
      price_max: 900000,
      available: true,
      sort: 'price_desc',
      page: 3,
      page_size: 12,
    };
    await listProducts(t(), f);
    expect(calledUrl()).toBe(
      `${BASE}/catalog/products?available=true&case_diameter_mm_max=42.5&case_diameter_mm_min=36&case_material=steel` +
        '&category=alta-relojeria&movement=automatic&page=3&page_size=12&price_max=900000&price_min=100000' +
        '&q=tourbillon&sort=price_desc&water_resistance_m_min=100',
    );
  });

  test.each(['newest', 'price_asc', 'price_desc', 'relevance'] as const)('sort=%s se envía tal cual', async (sort) => {
    await listProducts(t(), { sort });
    expect(calledUrl()).toBe(`${BASE}/catalog/products?sort=${sort}`);
  });

  test('available solo se envía con true; false y ausente no se envían', async () => {
    await listProducts(t(), { available: true });
    expect(calledUrl()).toBe(`${BASE}/catalog/products?available=true`);
    await listProducts(t(), { available: false });
    expect(calledUrl()).toBe(`${BASE}/catalog/products`);
    await listProducts(t(), { available: undefined, page: 2 });
    expect(calledUrl()).toBe(`${BASE}/catalog/products?page=2`);
  });

  test('los valores se escapan (q con espacios, &, = y tildes)', async () => {
    await listProducts(t(), { q: 'reloj & más=ñ' });
    expect(calledUrl()).toBe(`${BASE}/catalog/products?q=reloj%20%26%20m%C3%A1s%3D%C3%B1`);
  });

  test('q vacío y filtros undefined se omiten', async () => {
    await listProducts(t(), { q: '', category: undefined, page: 1 });
    expect(calledUrl()).toBe(`${BASE}/catalog/products?page=1`);
  });

  test('devuelve la página del servidor tal cual (nada se recalcula)', async () => {
    const page = {
      items: [{ id: 'x', price: { amount: 123456, currency: 'PEN' }, original_price: null, discount_amount: null }],
      total: 1,
      page: 1,
      page_size: 20,
    };
    fetchMock.mockResolvedValueOnce(json(page));
    expect(await listProducts(t())).toEqual(page);
  });

  test('422 → ApiError con status 422, code y details del servidor', async () => {
    const details = [{ loc: ['query', 'page'], msg: 'debe ser >= 1' }];
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_error', message: 'Datos no válidos.', details } }, 422));
    const err = await listProducts(t(), { page: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation_error', details });
  });

  test('un transporte falso recibe GET + /catalog/products + los filtros en query, sin body', async () => {
    const spy = vi.fn(async () => ({ items: [], total: 0, page: 1, page_size: 20 }));
    await listProducts(spy as unknown as Transport, { category: 'c', available: true });
    const req = spy.mock.calls[0] as unknown as [{ method: string; path: string; body?: unknown; query: Record<string, unknown> }];
    expect(req[0].method).toBe('GET');
    expect(req[0].path).toBe('/catalog/products');
    expect(req[0].body).toBeUndefined();
    expect(req[0].query).toMatchObject({ category: 'c', available: true });
  });
});

describe('getProduct', () => {
  test('GET /catalog/products/{slug}', async () => {
    await getProduct(t(), 'demo-clasico-01');
    expect(calledUrl()).toBe(`${BASE}/catalog/products/demo-clasico-01`);
    expect(calledInit().method).toBe('GET');
  });

  test.each([
    ['a/b', 'a%2Fb'],
    ['ñandú', '%C3%B1and%C3%BA'],
    ['../x', '..%2Fx'],
    ['..\\x', '..%5Cx'],
    ['x?y=1#z', 'x%3Fy%3D1%23z'],
    ['a b', 'a%20b'],
    ['%2e%2e%2f', '%252e%252e%252f'],
  ])('codifica el slug %j como un único segmento (%s)', async (slug, encoded) => {
    await getProduct(t(), slug);
    expect(calledUrl()).toBe(`${BASE}/catalog/products/${encoded}`);
    // El slug no puede introducir segmentos, query ni fragmento nuevos.
    const u = new URL(calledUrl());
    expect(u.pathname.split('/').length).toBe('/api/v1/catalog/products/x'.split('/').length);
    expect(u.search).toBe('');
    expect(u.hash).toBe('');
  });

  test('404 → ApiError con status 404 y code not_found', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'No existe.', details: null } }, 404));
    const err = await getProduct(t(), 'no-existe').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
  });

  test('devuelve el detalle del servidor tal cual', async () => {
    const detail = { id: 'x', slug: 's', related: [], price: { amount: 1, currency: 'PEN' }, movement: null };
    fetchMock.mockResolvedValueOnce(json(detail));
    expect(await getProduct(t(), 's')).toEqual(detail);
  });
});

describe('listCategories y getAttributes', () => {
  test('GET /catalog/categories sin parámetros', async () => {
    fetchMock.mockResolvedValueOnce(json([{ slug: 'a', name: 'A', description: null }]));
    expect(await listCategories(t())).toEqual([{ slug: 'a', name: 'A', description: null }]);
    expect(calledUrl()).toBe(`${BASE}/catalog/categories`);
    expect(calledInit().method).toBe('GET');
  });

  test('GET /catalog/attributes sin parámetros', async () => {
    const body = { movements: [{ code: 'auto', label: 'Automático' }], case_materials: [] };
    fetchMock.mockResolvedValueOnce(json(body));
    expect(await getAttributes(t())).toEqual(body);
    expect(calledUrl()).toBe(`${BASE}/catalog/attributes`);
  });

  test('un fallo de la API se propaga como ApiError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    expect(await listCategories(t()).catch((e) => e)).toMatchObject({ status: 502, code: 'invalid_response' });
  });
});

describe('catálogo público: no envía credenciales ni identidad', () => {
  test('con un transporte sin token, ninguna función añade Authorization ni cuerpo', async () => {
    await listProducts(t(), { q: 'x' });
    await getProduct(t(), 's');
    await listCategories(t());
    await getAttributes(t());
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      const keys = Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase());
      expect(keys).not.toContain('authorization');
      expect(init.body).toBeUndefined();
    }
  });
});
