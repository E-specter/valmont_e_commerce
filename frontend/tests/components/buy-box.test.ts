import { describe, expect, test } from 'vitest';
import BuyBox from '../../src/components/catalog/BuyBox.astro';
import type { ProductDetail } from '../../src/lib/api/catalog';
import { formatMoney as rawFormatMoney, type Money } from '../../src/lib/format';
import { detail, pen, promo } from '../helpers/product-detail';
import { text, ui } from '../helpers/ui';

// T-125 · BuyBox (STATUS "T-125 › Resultado esperado y criterios") con la Container API. Props `{ product: ProductDetail }`; slot `actions`.
// RN-09 / D-023: precio y disponibilidad son los del servidor; nunca se calcula ni se muestran cantidades de stock.
const NONE = 0;
const ONE = 1;
const LEAD_DAYS = 14;
const STOCK_LEAK = 37;
const PRICE = 8450000;
const ORIGINAL = 9900000;
const SAVING = 1234500;

/** El texto del DOM se compara con espacios normales: formatMoney usa U+00A0 entre "S/" y la cifra. */
const formatMoney = (m: Money): string => rawFormatMoney(m).replaceAll(' ', ' ');
const render = (product: ProductDetail, slots: Record<string, string> = {}): Promise<HTMLElement> => ui(BuyBox, { product }, slots);
const withStatus = (status: ProductDetail['availability']['status'], lead: number | null = null): ProductDetail =>
  detail({ availability: { status, lead_time_days: lead } });

describe('BuyBox · cabecera del producto', () => {
  test('un único h1 con el nombre del producto', async () => {
    const body = await render(detail({ name: 'Tourbillon Aurora' }));
    const h1 = body.querySelectorAll('h1');
    expect(h1).toHaveLength(ONE);
    expect(text(h1[NONE])).toBe('Tourbillon Aurora');
  });

  test('muestra la colección (categoría) y "Ref. {sku}"', async () => {
    const t = text(await render(detail({ sku: 'TA-0001', category: { slug: 'clasica', name: 'Clásica' } })));
    expect(t.toLowerCase()).toContain('colección clásica');
    expect(t).toContain('Ref. TA-0001');
  });

  test('ofrece "Consultar con un asesor" como enlace a /nosotros#contacto', async () => {
    const body = await render(detail());
    const link = [...body.querySelectorAll('a')].find((a) => text(a).includes('Consultar con un asesor'));
    expect(link?.getAttribute('href')).toBe('/nosotros#contacto');
  });
});

describe('BuyBox · precio (RN-09: solo lo que llega del servidor)', () => {
  test('sin promoción: el precio formateado y ningún precio tachado ni ahorro', async () => {
    const body = await render(detail());
    expect(text(body)).toContain(formatMoney(pen(PRICE)));
    expect(body.querySelector('del, s')).toBeNull();
    expect(text(body)).not.toContain('Ahorras');
  });

  test('con promoción: precio vigente, original tachado y ahorro tal como llegan (no se recalculan)', async () => {
    // El ahorro del servidor (1.450.000) no es ORIGINAL - PRICE a propósito: la ficha muestra solo lo que recibe.
    const product = promo({ price: pen(PRICE), original_price: pen(ORIGINAL), discount_amount: pen(SAVING) });
    const body = await render(product);
    const t = text(body);
    expect(t).toContain(formatMoney(pen(PRICE)));
    expect(text(body.querySelector('del'))).toContain(formatMoney(pen(ORIGINAL)));
    expect(t).toContain(`Ahorras ${formatMoney(pen(SAVING))}`);
    expect(t).not.toContain(formatMoney(pen(ORIGINAL - PRICE)));
  });

  test('"IGV incluido" fijo (H-13), con y sin promoción', async () => {
    expect(text(await render(detail()))).toContain('IGV incluido');
    expect(text(await render(promo()))).toContain('IGV incluido');
  });
});

describe('BuyBox · disponibilidad (D-023)', () => {
  test.each([
    ['in_stock', null, 'En stock'],
    ['low_stock', null, 'Quedan pocas unidades'],
    ['out_of_stock', null, 'Agotado'],
    ['on_request', null, 'Bajo pedido'],
    ['on_request', LEAD_DAYS, `entrega estimada en ${LEAD_DAYS} días`],
    ['on_request', ONE, 'entrega estimada en 1 día'],
  ] as const)('%s (plazo %s): muestra "%s"', async (status, lead, label) => {
    expect(text(await render(withStatus(status, lead)))).toContain(label);
  });

  test('agotado: se mantiene el precio y no hay ningún botón de compra', async () => {
    const body = await render(withStatus('out_of_stock'));
    expect(text(body)).toContain('Agotado');
    expect(text(body)).toContain(formatMoney(pen(PRICE)));
    expect(body.querySelectorAll('button')).toHaveLength(NONE);
  });

  test('bajo pedido con plazo: no confunde con "En stock" ni muestra "Agotado"', async () => {
    const t = text(await render(withStatus('on_request', LEAD_DAYS)));
    expect(t).not.toContain('En stock');
    expect(t).not.toContain('Agotado');
  });

  test('nunca muestra cantidades de stock aunque el objeto traiga campos extra', async () => {
    const leaky = { ...withStatus('low_stock'), stock: STOCK_LEAK, stock_quantity: STOCK_LEAK } as ProductDetail;
    const html = text(await render(leaky));
    expect(html).not.toContain(String(STOCK_LEAK));
    expect(html).toContain('Quedan pocas unidades');
  });
});

describe('BuyBox · descripción como texto (RT-5)', () => {
  test('el marcado de la descripción se muestra literal: ni elementos, ni scripts, ni manejadores', async () => {
    const evil = '<script>window.__xss=1</script><b>negrita</b><img src=x onerror=alert(1)>';
    const body = await render(detail({ description: evil }));
    expect(body.querySelector('script')?.textContent ?? '').not.toContain('__xss');
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelectorAll('[onerror]')).toHaveLength(NONE);
    expect(text(body)).toContain('<b>negrita</b>');
  });

  test('los saltos de línea se conservan en el texto (los presenta white-space: pre-line, sin <br>)', async () => {
    const body = await render(detail({ description: 'Primera línea.\nSegunda línea.' }));
    const holder = [...body.querySelectorAll('p, div')].find((e) => (e.textContent ?? '').includes('Primera línea.') && e.children.length === NONE);
    expect(holder?.textContent).toContain('Primera línea.\nSegunda línea.');
    expect(body.querySelector('br')).toBeNull();
  });

  test('nombre y SKU también son texto: un nombre con marcado no crea elementos', async () => {
    const body = await render(detail({ name: '<em>Aurora</em>', sku: '"><i>x</i>' }));
    expect(body.querySelector('em, i')).toBeNull();
    expect(text(body.querySelector('h1'))).toBe('<em>Aurora</em>');
  });

  test('sin descripción: no pinta un párrafo vacío', async () => {
    const body = await render(detail({ description: '' }));
    expect([...body.querySelectorAll('p')].filter((p) => text(p) === '')).toEqual([]);
  });
});

describe('BuyBox · slot `actions` (T-060)', () => {
  test('sin contenido en el slot no pinta botones ni contenedores vacíos', async () => {
    const body = await render(detail());
    expect(body.querySelectorAll('button, [role="button"]')).toHaveLength(NONE);
    expect([...body.querySelectorAll('div')].filter((d) => d.children.length === NONE && text(d) === '')).toEqual([]);
  });

  test('con contenido en el slot: se pinta una sola vez', async () => {
    const body = await render(detail(), { actions: '<button type="button">Añadir al carrito</button>' });
    const buttons = [...body.querySelectorAll('button')].filter((b) => text(b) === 'Añadir al carrito');
    expect(buttons).toHaveLength(ONE);
  });
});
