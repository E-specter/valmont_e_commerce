import { describe, expect, test } from 'vitest';
import ProductsTable from '../../src/components/admin/ProductsTable.astro';
import { productPill } from '../../src/lib/admin/status';
import type { AdminProduct, ProductStatus } from '../../src/lib/api/admin-catalog';
import { formatMoney } from '../../src/lib/format';
import { text, ui } from '../helpers/ui';
import { AT_LIMA, AT_UTC, HOSTILE, NIGHT_LIMA, NIGHT_UTC, manyProducts, product } from '../helpers/t149';

// T-149 · Container API de ProductsTable (firma de STATUS ui §10.7 T-149: Props { items: readonly AdminProduct[] }). Sin red.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const MIN_COLUMNS = 6;
const WHOLE = 8_450_000;
const WITH_CENTS = 1_062_550;
const FIVE_CENTS = 5;
const COST = 987_654;
const ON_HAND = 424_242;
const MAX_PAGE_SIZE = 48;
const STATUSES: ProductStatus[] = ['draft', 'published'];
const IMAGE = { id: '8a8a8a8a-0000-4000-8000-000000000001', url: 'https://cdn.example.test/media/qa-reloj-1.jpg', alt: 'Reloj de acero con esfera azul' };
const FOCUSABLE = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const render = (items: readonly AdminProduct[] = [product()]) => ui(ProductsTable, { items });
const rows = (b: ParentNode): Element[] => [...b.querySelectorAll('tbody tr')];
const cells = (row: Element): string[] => [...row.querySelectorAll('td')].map((c) => text(c));

describe('ProductsTable · estructura y accesibilidad', () => {
  test('una tabla con caption, encabezados de columna (th scope=col) no vacíos y una fila por producto', async () => {
    const b = await render(manyProducts(THREE));
    expect(b.querySelectorAll('table')).toHaveLength(ONE);
    expect(text(b.querySelector('caption'))).not.toBe('');
    const heads = [...b.querySelectorAll('thead th')];
    expect(heads.length).toBeGreaterThanOrEqual(MIN_COLUMNS);
    heads.forEach((th) => {
      expect(th.getAttribute('scope')).toBe('col');
      expect(text(th)).not.toBe('');
    });
    expect(rows(b)).toHaveLength(THREE);
  });

  test('las columnas del paquete existen: producto (nombre y SKU), categoría, precio, estado y actualizado', async () => {
    const b = await render();
    const heads = [...b.querySelectorAll('thead th')].map((th) => text(th).toLowerCase()).join('|');
    ['producto', 'categor', 'precio', 'estado', 'actualizado'].forEach((h) => expect(heads, h).toContain(h));
  });

  test('el nombre y el SKU salen de la fila y llevan al formulario /admin/productos/{id}', async () => {
    const item = product({ name: 'Heritage 38', sku: 'QA-T149-0001' });
    const row = rows(await render([item]))[NONE];
    expect(text(row)).toContain('Heritage 38');
    expect(text(row)).toContain('QA-T149-0001');
    const hrefs = [...row.querySelectorAll('a')].map((a) => new URL(a.getAttribute('href') ?? '', 'http://x.test').pathname);
    expect(hrefs.length).toBeGreaterThanOrEqual(ONE);
    hrefs.forEach((h) => expect(h).toBe(`/admin/productos/${item.id}`));
  });

  test('el enlace al producto lleva el nombre del producto como texto accesible', async () => {
    const row = rows(await render([product({ name: 'Heritage 38' })]))[NONE];
    expect([...row.querySelectorAll('a')].some((a) => text(a).includes('Heritage 38'))).toBe(true);
  });

  test('todo lo enfocable de la fila apunta al mismo formulario (sin otras trampas de teclado)', async () => {
    const item = product();
    const row = rows(await render([item]))[NONE];
    const focusable = [...row.querySelectorAll(FOCUSABLE)];
    expect(focusable.length).toBeGreaterThanOrEqual(ONE);
    focusable.forEach((el) => {
      expect(el.tagName).toBe('A');
      expect(new URL(el.getAttribute('href') ?? '', 'http://x.test').pathname).toBe(`/admin/productos/${item.id}`);
    });
  });

  test('un id con caracteres de ruta o de consulta se codifica: el enlace no se sale de /admin/productos/', async () => {
    const row = rows(await render([product({ id: 'a/b?c#d' })]))[NONE];
    const href = row.querySelector('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/admin/productos/')).toBe(true);
    expect(['/', '?', '#'].filter((c) => href.slice('/admin/productos/'.length).includes(c))).toEqual([]);
    expect(new URL(href, 'http://x.test').pathname).toBe('/admin/productos/a%2Fb%3Fc%23d');
  });

  test('la categoría sale del contrato (category.name)', async () => {
    const row = rows(await render([product({ category: { slug: 'deportivos', name: 'Deportivos' } })]))[NONE];
    expect(cells(row)).toContain('Deportivos');
  });
});

describe('ProductsTable · estado (productPill)', () => {
  test('borrador y publicado se pintan con StatusPill: texto y tono del contrato (productPill)', async () => {
    const b = await render(STATUSES.map((status, i) => product({ id: `00000000-0000-4000-8000-00000000000${i + ONE}`, status })));
    const pills = [...b.querySelectorAll('tbody .pill')];
    expect(pills.map((p) => text(p))).toEqual(STATUSES.map((s) => productPill(s).label));
    STATUSES.forEach((s, i) => expect(pills[i].getAttribute('data-tone'), s).toBe(productPill(s).tone));
    expect(pills.map((p) => text(p))).toEqual(['Borrador', 'Publicado']);
  });

  test('cada fila tiene exactamente una pill y nunca es solo color: lleva su texto', async () => {
    const b = await render(manyProducts(THREE));
    rows(b).forEach((r) => {
      const pills = r.querySelectorAll('.pill');
      expect(pills).toHaveLength(ONE);
      expect(text(pills[NONE]).length).toBeGreaterThan(NONE);
    });
  });

  test('borrador y publicado se distinguen por el tono además del texto', async () => {
    const b = await render(STATUSES.map((status, i) => product({ id: `00000000-0000-4000-8000-00000000000${i + ONE}`, status })));
    const tones = [...b.querySelectorAll('tbody .pill')].map((p) => p.getAttribute('data-tone'));
    expect(new Set(tones).size).toBe(TWO);
  });
});

describe('ProductsTable · precio y fecha', () => {
  test.each([
    [WHOLE, 'S/ 84,500'],
    [WITH_CENTS, 'S/ 10,625.50'],
    [FIVE_CENTS, 'S/ 0.05'],
  ])('el precio %i céntimos se pinta con formatMoney (%s) en su propia celda', async (amount, shown) => {
    const price = { amount, currency: 'PEN' as const };
    const row = rows(await render([product({ price })]))[NONE];
    expect(formatMoney(price).replaceAll(' ', ' ')).toBe(shown); // Intl separa «S/» con un espacio de no ruptura
    expect(cells(row)).toContain(shown);
  });

  test('importe entero: sin ".00" fijo (D-B6 B)', async () => {
    const row = rows(await render([product({ price: { amount: WHOLE, currency: 'PEN' } })]))[NONE];
    expect(text(row)).not.toContain('.00');
  });

  test('«actualizado» sale como dd/mm/aaaa hh:mm en hora de Lima (UTC-5)', async () => {
    const row = rows(await render([product({ updated_at: AT_UTC })]))[NONE];
    expect(text(row)).toContain(AT_LIMA);
  });

  test('a las 03:30 UTC todavía es el día anterior en Lima', async () => {
    const row = rows(await render([product({ updated_at: NIGHT_UTC })]))[NONE];
    expect(text(row)).toContain(NIGHT_LIMA);
  });

  test('la fecha de creación no sustituye a la de actualización', async () => {
    const row = rows(await render([product({ created_at: NIGHT_UTC, updated_at: AT_UTC })]))[NONE];
    expect(text(row)).toContain(AT_LIMA);
    expect(text(row)).not.toContain(NIGHT_LIMA);
  });
});

describe('ProductsTable · miniatura', () => {
  test('con main_image: img con la URL y el alt del contrato', async () => {
    const row = rows(await render([product({ main_image: IMAGE })]))[NONE];
    const img = row.querySelector('img');
    expect(img?.getAttribute('src') ?? '').toContain(IMAGE.url);
    expect(img?.getAttribute('alt')).toBe(IMAGE.alt);
  });

  test('sin imagen (main_image null): no se rompe, no hay img sin src y la fila conserva nombre y enlace', async () => {
    const row = rows(await render([product({ main_image: null, name: 'Sin foto' })]))[NONE];
    expect(text(row)).toContain('Sin foto');
    row.querySelectorAll('img').forEach((img) => expect(img.getAttribute('src') ?? '').not.toBe(''));
    expect(row.querySelector('a')).not.toBeNull();
  });

  test('el marcador de «sin imagen» se anuncia con aria-label (no es una imagen rota ni texto vacío)', async () => {
    const row = rows(await render([product({ main_image: null, name: 'Sin foto' })]))[NONE];
    const marker = row.querySelector('[role="img"]');
    expect(marker?.getAttribute('aria-label') ?? '').not.toBe('');
  });

  test('una mezcla con y sin imagen renderiza todas las filas', async () => {
    const items = manyProducts(THREE).map((p, i) => (i === ONE ? p : { ...p, main_image: IMAGE }));
    expect(rows(await render(items))).toHaveLength(THREE);
  });

  test('un alt hostil se escapa en el atributo: no inyecta elementos ni manejadores', async () => {
    const b = await render([product({ main_image: { ...IMAGE, alt: `" onerror="window.__pwn=1" x="${HOSTILE}` } })]);
    expect(b.querySelector('tbody script')).toBeNull();
    b.querySelectorAll('tbody img').forEach((img) => expect(img.hasAttribute('onerror')).toBe(false));
  });
});

describe('ProductsTable · texto del servidor (RT-B9) y sin campos inventados', () => {
  test('nombre, SKU y categoría hostiles se pintan como texto: sin elementos ni scripts inyectados', async () => {
    const b = await render([product({ name: HOSTILE, sku: HOSTILE, category: { slug: 'x', name: HOSTILE } })]);
    expect(b.querySelector('tbody img')).toBeNull();
    expect(b.querySelector('tbody script')).toBeNull();
    expect(text(rows(b)[NONE])).toContain(HOSTILE);
  });

  test('no pinta campos que el listado no necesita ni que el contrato no tiene', async () => {
    const extra = { ...product(), cost_price: COST, internal_note: 'NOTA-INTERNA-QX', stock_on_hand: ON_HAND } as unknown as AdminProduct;
    const html = (await render([extra])).innerHTML;
    ['NOTA-INTERNA-QX', '987654', '424242', 'cost_price'].forEach((w) => expect(html, w).not.toContain(w));
  });

  test('no pinta la descripción larga ni las especificaciones (no son columnas del listado)', async () => {
    const html = (await render([product({ description: 'DESCRIPCION-LARGA-QX', specs: [{ label: 'Calibre', value: 'VALOR-SPEC-QX' }] })])).innerHTML;
    expect(html).not.toContain('DESCRIPCION-LARGA-QX');
    expect(html).not.toContain('VALOR-SPEC-QX');
  });

  test('el estado se lee del producto, no del texto del nombre: un nombre «Publicado» sigue siendo borrador', async () => {
    const row = rows(await render([product({ name: 'Publicado', status: 'draft' })]))[NONE];
    expect(text(row.querySelector('.pill'))).toBe('Borrador');
  });
});

describe('ProductsTable · volumen', () => {
  test('MAX_PAGE_SIZE productos (el máximo del contrato) producen 48 filas con ids distintos en sus enlaces', async () => {
    const items = manyProducts(MAX_PAGE_SIZE);
    const b = await render(items);
    expect(rows(b)).toHaveLength(items.length);
    const hrefs = rows(b).map((r) => r.querySelector('a')?.getAttribute('href'));
    expect(new Set(hrefs).size).toBe(items.length);
  });
});
