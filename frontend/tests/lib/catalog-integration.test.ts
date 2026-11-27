import { describe, expect, test, vi } from 'vitest';
import { getAttributes, getProduct, listCategories, listProducts } from '../../src/lib/api/catalog';
import { ApiError } from '../../src/lib/api/http';
import { serverTransport } from '../../src/lib/api/server';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://127.0.0.1:8000' }));

// T-120 · integración real contra el backend local del stack de revisión (scripts/review-up.sh).
// Solo lectura: GET públicos del catálogo del seed (`demo-…`). Si el backend no está levantado
// se omite, y el resultado lo declara (no es una verificación sustituible por el `fetch` falso).
const alive = await fetch('http://127.0.0.1:8000/api/v1/catalog/categories', { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!alive)('catálogo real (127.0.0.1:8000)', () => {
  const t = serverTransport();

  test('listProducts devuelve una página con la forma del contrato y productos demo-', async () => {
    const page = await listProducts(t, { page_size: 5, sort: 'newest' });
    expect(page).toMatchObject({ page: 1, page_size: 5 });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);
    for (const p of page.items) {
      expect(p.slug).toMatch(/^demo-/);
      expect(Number.isInteger(p.price.amount)).toBe(true);
      expect(p.price.currency).toBe('PEN');
      expect(p).toHaveProperty('original_price');
      expect(p).toHaveProperty('discount_amount');
      expect(['in_stock', 'low_stock', 'out_of_stock', 'on_request']).toContain(p.availability.status);
    }
  });

  test('getProduct de un producto del listado devuelve su ficha (slug codificado sin alterarlo)', async () => {
    const { items } = await listProducts(t, { page_size: 1 });
    const detail = await getProduct(t, items[0].slug);
    expect(detail.slug).toBe(items[0].slug);
    expect(detail.price).toEqual(items[0].price);
    expect(Array.isArray(detail.specs)).toBe(true);
    expect(Array.isArray(detail.images)).toBe(true);
    expect(Array.isArray(detail.related)).toBe(true);
  });

  test('getProduct de un slug inexistente o con caracteres raros → ApiError 404 not_found', async () => {
    for (const slug of ['demo-no-existe-xyz', 'a/b', '../x', 'ñandú']) {
      const err = await getProduct(t, slug).catch((e) => e);
      expect(err, slug).toBeInstanceOf(ApiError);
      expect(err, slug).toMatchObject({ status: 404, code: 'not_found' });
    }
  });

  test('listProducts con un parámetro inválido → ApiError 422 con details', async () => {
    const err = await listProducts(t, { page: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation_error' });
    expect(err.details).not.toBeNull();
  });

  test('available=true solo devuelve relojes con stock; sort=price_asc ordena por precio', async () => {
    const avail = await listProducts(t, { available: true, page_size: 48 });
    for (const p of avail.items) expect(p.availability.status).not.toBe('out_of_stock');
    const asc = await listProducts(t, { sort: 'price_asc', page_size: 48 });
    const prices = asc.items.map((p) => p.price.amount);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  test('listCategories y getAttributes', async () => {
    const cats = await listCategories(t);
    expect(cats.length).toBeGreaterThan(0);
    expect(cats[0]).toHaveProperty('slug');
    const attrs = await getAttributes(t);
    expect(Array.isArray(attrs.movements)).toBe(true);
    expect(Array.isArray(attrs.case_materials)).toBe(true);
  });

  test('el filtro por categoría devuelve solo esa categoría', async () => {
    const [first] = await listCategories(t);
    const page = await listProducts(t, { category: first.slug, page_size: 48 });
    for (const p of page.items) expect(p.category.slug).toBe(first.slug);
  });
});
