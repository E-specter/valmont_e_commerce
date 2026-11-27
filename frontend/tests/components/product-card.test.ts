import { describe, expect, test } from 'vitest';
import ProductCard from '../../src/components/catalog/ProductCard.astro';
import ProductGrid from '../../src/components/catalog/ProductGrid.astro';
import type { ProductSummary } from '../../src/lib/api/catalog';
import { formatMoney as rawFormatMoney, type Money } from '../../src/lib/format';
import { markers, root, text, ui } from '../helpers/ui';

// T-123 · ProductCard (4 variantes) y ProductGrid (STATUS "T-123 › Criterios de aceptación y firmas") con la Container API.
// Datos: `ProductSummary` de lib/api/catalog.ts. RN-09: la tarjeta no calcula importes; todo importe pasa por `Price`.
const NONE = 0;
const PRECISION = 2;
const DIAMETER_MM = 40;
const WATER_M = 100;
const LEAD_DAYS = 45;
const LONG_LABEL_COUNT = 6;
const ONE = 1;
const THREE = 3;
const HEADING_2 = 2;
const FIVE = 5;
const VARIANTS = ['store', 'related', 'wishlist', 'compact'] as const;
type Variant = (typeof VARIANTS)[number];
// Relación de aspecto propuesta (BRIEF §12.5): 4:5 en store y wishlist, 1:1 en related y compact.
const FOUR = FIVE - ONE;
const RATIO: Record<Variant, number> = { store: FOUR / FIVE, wishlist: FOUR / FIVE, related: ONE, compact: ONE };

/** El texto del DOM se compara con espacios normales: formatMoney usa U+00A0 entre "S/" y la cifra. */
const formatMoney = (m: Money): string => rawFormatMoney(m).replaceAll('\u00a0', ' ');
const pen = (amount: number): { amount: number; currency: 'PEN' } => ({ amount, currency: 'PEN' });
const PRICE = 8450000;
const ORIGINAL = 9900000;
const DISCOUNT_SERVER = 7770000; // deliberadamente NO es ORIGINAL - PRICE: la tarjeta solo muestra lo que llega
const STOCK_LEAK = 37;

const watch = (over: Partial<ProductSummary> = {}): ProductSummary => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'tourbillon-aurora',
  sku: 'TA-0001',
  name: 'Tourbillon Aurora',
  category: { slug: 'clasica', name: 'Clásica' },
  price: pen(PRICE),
  original_price: null,
  discount_amount: null,
  movement: { code: 'automatic', label: 'Automático' },
  case_material: { code: 'gold', label: 'Oro Amarillo 18K' },
  case_diameter_mm: DIAMETER_MM,
  water_resistance_m: WATER_M,
  main_image: { id: 'img-1', url: 'https://img.example.test/a.jpg', alt: 'Tourbillon Aurora, vista frontal' },
  availability: { status: 'in_stock', lead_time_days: null },
  ...over,
});
const PROMO = watch({ original_price: pen(ORIGINAL), discount_amount: pen(DISCOUNT_SERVER) });

const card = (product: ProductSummary, props: Record<string, unknown> = {}, slots: Record<string, string> = {}): Promise<HTMLElement> =>
  ui(ProductCard, { product, ...props }, slots);

describe('ProductCard · un único enlace extendido', () => {
  test.each(VARIANTS)('%s: exactamente un <a> a /relojes/{slug} cuyo nombre accesible es el nombre del producto', async (variant) => {
    const body = await card(watch(), { variant });
    const links = body.querySelectorAll('a');
    expect(links).toHaveLength(ONE);
    expect(links[NONE].getAttribute('href')).toBe('/relojes/tourbillon-aurora');
    expect(text(links[NONE])).toBe('Tourbillon Aurora');
  });

  test.each(VARIANTS)('%s: sin enlaces anidados ni botones dentro del enlace; la raíz es un <article>', async (variant) => {
    const body = await card(watch(), { variant });
    expect(body.querySelector('a a')).toBeNull();
    expect(body.querySelector('a button, a [role="button"], a input')).toBeNull();
    expect(root(body).tagName.toLowerCase()).toBe('article');
  });

  test('el slug se codifica: no puede salir de /relojes/ ni inyectar atributos', async () => {
    const body = await card(watch({ slug: 'a/../b?x="><y' }));
    const href = body.querySelector('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/relojes/')).toBe(true);
    expect(href.slice('/relojes/'.length)).not.toContain('/');
    expect(href).not.toContain('"');
    expect(body.querySelector('y')).toBeNull();
  });

  test('el enlace está dentro del encabezado, con nivel 3 por defecto y configurable (2 y 4)', async () => {
    const def = await card(watch());
    expect(def.querySelector('h3 a')).not.toBeNull();
    const two = await card(watch(), { headingLevel: HEADING_2 });
    expect(two.querySelector('h2 a')).not.toBeNull();
    expect(two.querySelector('h3')).toBeNull();
    const four = await card(watch(), { headingLevel: FOUR });
    expect(four.querySelector('h4 a')).not.toBeNull();
  });

  test('las cuatro variantes se distinguen en el marcado', async () => {
    const marks = await Promise.all(VARIANTS.map(async (variant) => markers(root(await card(watch(), { variant })))));
    expect(new Set(marks).size).toBe(VARIANTS.length);
  });

  test('sin variante equivale a store', async () => {
    const [def, store] = await Promise.all([card(watch()), card(watch(), { variant: 'store' })]);
    expect(markers(root(def))).toBe(markers(root(store)));
  });
});

describe('ProductCard · slot action', () => {
  test('sin contenido en el slot no se pinta nada de acción', async () => {
    const body = await card(watch());
    expect(body.querySelector('button')).toBeNull();
    expect(body.querySelector('[class*="action"]')).toBeNull();
  });

  test('con contenido, se proyecta en la tarjeta y no entra dentro del enlace', async () => {
    const body = await card(watch(), {}, { action: '<button type="button" id="fav">Guardar</button>' });
    const button = body.querySelector('button#fav');
    expect(button).not.toBeNull();
    expect(button?.closest('a')).toBeNull();
    expect(body.querySelectorAll('a')).toHaveLength(ONE);
    expect(root(body).contains(button)).toBe(true);
  });
});

describe('ProductCard · imagen', () => {
  test.each(VARIANTS)('%s: img con src y alt del contrato, width/height y decoding async; lazy por defecto', async (variant) => {
    const body = await card(watch(), { variant });
    const img = body.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://img.example.test/a.jpg');
    expect(img.getAttribute('alt')).toBe('Tourbillon Aurora, vista frontal');
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    expect(width).toBeGreaterThan(NONE);
    expect(height).toBeGreaterThan(NONE);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('fetchpriority')).not.toBe('high');
    expect(body.querySelectorAll('img')).toHaveLength(ONE);
  });

  test.each(VARIANTS)('%s: la relación de aspecto de width/height es la propuesta de BRIEF §12.5', async (variant) => {
    const img = (await card(watch(), { variant })).querySelector('img') as HTMLImageElement;
    const ratio = Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
    expect(ratio).toBeCloseTo(RATIO[variant], PRECISION);
  });

  test('priority: loading="eager" y fetchpriority="high"', async () => {
    const img = (await card(watch(), { priority: true })).querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('width')).not.toBeNull();
    expect(img.getAttribute('height')).not.toBeNull();
  });

  test('el alt llega tal cual del contrato (se escapa: comillas y HTML no rompen el atributo)', async () => {
    const alt = 'Reloj "Luna" <b>oro</b> & acero';
    const body = await card(watch({ main_image: { id: 'i', url: 'https://img.example.test/b.jpg', alt } }));
    const img = body.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe(alt);
    expect(body.querySelector('b')).toBeNull();
    expect(img.hasAttribute('onerror')).toBe(false);
  });

  test.each(VARIANTS)('%s: sin imagen (url vacía) no hay <img> y se pinta un bloque con role="img" y nombre', async (variant) => {
    const body = await card(watch({ main_image: { id: 'i', url: '', alt: 'Sin foto' } }), { variant });
    expect(body.querySelector('img')).toBeNull();
    const block = body.querySelector('[role="img"]');
    expect(block).not.toBeNull();
    expect((block?.getAttribute('aria-label') ?? '').trim()).not.toBe('');
    expect(body.querySelectorAll('a')).toHaveLength(ONE);
  });

  test('con imagen no hay bloque role="img" de reemplazo', async () => {
    expect((await card(watch())).querySelector('[role="img"]')).toBeNull();
  });
});

describe('ProductCard · precio, disponibilidad y ficha', () => {
  test.each(VARIANTS)('%s: sin promoción muestra el precio con formatMoney y ni <del> ni "Ahorras"', async (variant) => {
    const body = await card(watch(), { variant });
    expect(text(body)).toContain(formatMoney(pen(PRICE)));
    expect(body.querySelector('del')).toBeNull();
    expect(text(body)).not.toContain('Ahorras');
  });

  test.each(VARIANTS)('%s: con promoción muestra el precio, el original tachado y el ahorro tal como llegan', async (variant) => {
    const body = await card(PROMO, { variant });
    const t = text(body);
    expect(t).toContain(formatMoney(pen(PRICE)));
    expect(text(body.querySelector('del'))).toContain(formatMoney(pen(ORIGINAL)));
    expect(t).toContain(`Ahorras ${formatMoney(pen(DISCOUNT_SERVER))}`);
  });

  test('RN-09: no calcula importes (ni la diferencia, ni descuentos, ni totales)', async () => {
    const body = await card(PROMO);
    const t = text(body);
    expect(t).not.toContain(formatMoney(pen(ORIGINAL - PRICE)));
    expect(t).not.toContain(formatMoney(pen(PRICE + DISCOUNT_SERVER)));
    expect(t).not.toContain('%');
    expect(t.split('S/').length - ONE).toBe(THREE); // precio, original y ahorro: solo los tres del servidor
  });

  test('un importe de 0 o fracción se presenta con formatMoney sin redondeos propios', async () => {
    const fraction = 1062550;
    expect(text(await card(watch({ price: pen(fraction) })))).toContain(formatMoney(pen(fraction)));
  });

  test.each(['store', 'related', 'wishlist'] as const)('%s: muestra la disponibilidad (Availability) con su texto', async (variant) => {
    const cases: [ProductSummary['availability'], string][] = [
      [{ status: 'in_stock', lead_time_days: null }, 'En stock'],
      [{ status: 'low_stock', lead_time_days: null }, 'Quedan pocas unidades'],
      [{ status: 'out_of_stock', lead_time_days: null }, 'Agotado'],
      [{ status: 'on_request', lead_time_days: null }, 'Bajo pedido'],
    ];
    const texts = await Promise.all(cases.map(async ([availability]) => text(await card(watch({ availability }), { variant }))));
    texts.forEach((t, i) => expect(t).toContain(cases[i][ONE]));
  });

  test('bajo pedido con plazo muestra los días del contrato', async () => {
    const days = LEAD_DAYS;
    const t = text(await card(watch({ availability: { status: 'on_request', lead_time_days: days } })));
    expect(t).toContain(`${days} días`);
  });

  test('compact no muestra la disponibilidad', async () => {
    const texts = await Promise.all(
      (['in_stock', 'low_stock', 'out_of_stock', 'on_request'] as const).map(async (status) =>
        text(await card(watch({ availability: { status, lead_time_days: null } }), { variant: 'compact' })),
      ),
    );
    texts.forEach((t) => {
      expect(t).not.toContain('En stock');
      expect(t).not.toContain('Quedan pocas');
      expect(t).not.toContain('Agotado');
      expect(t).not.toContain('Bajo pedido');
    });
    expect(texts[NONE]).toContain(formatMoney(pen(PRICE)));
  });

  test('nunca expone cantidades de stock aunque el objeto traiga campos de más', async () => {
    const extra = { ...watch(), stock: STOCK_LEAK, available_quantity: STOCK_LEAK } as unknown as ProductSummary;
    const all = await Promise.all(VARIANTS.map(async (variant) => (await card(extra, { variant })).innerHTML));
    all.forEach((html) => expect(html).not.toContain(String(STOCK_LEAK)));
  });

  test('la ficha corta aparece con los tres datos y omite los nulos sin separadores huérfanos', async () => {
    expect(text(await card(watch()))).toContain('40mm · Automático · Oro Amarillo 18K');
    expect(text(await card(watch({ case_material: null })))).toContain('40mm · Automático');
    const partial = text(await card(watch({ movement: null, case_diameter_mm: null })));
    expect(partial).toContain('Oro Amarillo 18K');
    expect(partial).not.toContain('·');
  });

  test('con los tres datos nulos no se pinta la línea de ficha (ni separadores)', async () => {
    const t = text(await card(watch({ movement: null, case_material: null, case_diameter_mm: null })));
    expect(t).not.toContain('·');
    expect(t).not.toContain('mm');
  });

  test('sin badges inventados: no hay "Nuevo" ni "Edición limitada" (D-041 P-2)', async () => {
    const all = await Promise.all(VARIANTS.map(async (variant) => text(await card(watch(), { variant }))));
    all.forEach((t) => {
      expect(t.toLowerCase().includes('nuevo') || t.toLowerCase().includes('edición limitada')).toBe(false);
    });
  });
});

describe('ProductCard · seguridad (texto como texto)', () => {
  const HOSTILE = '<img src=x onerror=alert(1)><script>window.__pwn=1</script>';

  test.each(VARIANTS)('%s: nombre, categoría, movimiento y material se escapan', async (variant) => {
    const body = await card(
      watch({
        name: HOSTILE,
        category: { slug: 'c', name: HOSTILE },
        movement: { code: 'm', label: HOSTILE },
        case_material: { code: 'x', label: HOSTILE },
      }),
      { variant },
    );
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelectorAll('img[src="x"]')).toHaveLength(NONE);
    expect([...body.querySelectorAll('[onerror]')]).toHaveLength(NONE);
    expect(body.textContent).toContain('<script>window.__pwn=1</script>');
  });
});

describe('ProductGrid', () => {
  const MANY = Array.from({ length: LONG_LABEL_COUNT }, (_, i) =>
    watch({ id: `id-${i}`, slug: `reloj-${i}`, name: `Reloj ${i}`, main_image: { id: `m${i}`, url: `https://img.example.test/${i}.jpg`, alt: `Reloj ${i}` } }),
  );
  const grid = (props: Record<string, unknown> = {}, products: ProductSummary[] = MANY): Promise<HTMLElement> =>
    ui(ProductGrid, { products, label: 'Relojes de ejemplo', ...props });

  test('es una lista ul con aria-label y un li por producto, cada li con una sola tarjeta y un solo enlace', async () => {
    const body = await grid();
    const uls = body.querySelectorAll('ul');
    expect(uls).toHaveLength(ONE);
    expect(uls[NONE].getAttribute('aria-label')).toBe('Relojes de ejemplo');
    const items = [...body.querySelectorAll('ul > li')];
    expect(items).toHaveLength(MANY.length);
    items.forEach((li, i) => {
      expect(li.querySelectorAll('article')).toHaveLength(ONE);
      expect(li.querySelectorAll('a')).toHaveLength(ONE);
      expect(li.querySelector('a')?.getAttribute('href')).toBe(`/relojes/reloj-${i}`);
    });
  });

  test('conserva el orden de los productos', async () => {
    const body = await grid();
    expect([...body.querySelectorAll('h3')].map(text)).toEqual(MANY.map((p) => p.name));
  });

  test('en store, las tres primeras imágenes son prioritarias (eager + fetchpriority) y las demás lazy', async () => {
    const imgs = [...(await grid()).querySelectorAll('img')];
    expect(imgs).toHaveLength(MANY.length);
    imgs.forEach((img, i) => {
      expect(img.getAttribute('loading')).toBe(i < THREE ? 'eager' : 'lazy');
      expect(img.getAttribute('fetchpriority') === 'high').toBe(i < THREE);
    });
  });

  test.each(['related', 'wishlist', 'compact'] as const)('%s: ninguna imagen es prioritaria', async (variant) => {
    const imgs = [...(await grid({ variant })).querySelectorAll('img')];
    expect(imgs).toHaveLength(MANY.length);
    imgs.forEach((img) => {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('fetchpriority')).not.toBe('high');
    });
  });

  test.each(VARIANTS)('%s: pasa la variante a cada tarjeta', async (variant) => {
    const body = await grid({ variant });
    const expected = markers(root(await card(watch(), { variant })));
    const cards = [...body.querySelectorAll('article')];
    expect(cards).toHaveLength(MANY.length);
    cards.forEach((c) => expect(markers(c)).toBe(expected));
  });

  test('headingLevel se propaga a las tarjetas', async () => {
    const body = await grid({ headingLevel: HEADING_2 });
    expect(body.querySelectorAll('h2 a')).toHaveLength(MANY.length);
    expect(body.querySelector('h3')).toBeNull();
  });

  test('el label se escapa', async () => {
    const body = await grid({ label: '"><script id="x">1</script>' });
    expect(body.querySelector('script#x')).toBeNull();
    expect(body.querySelector('ul')?.getAttribute('aria-label')).toBe('"><script id="x">1</script>');
  });

  test('con un solo producto sigue siendo una lista de un elemento', async () => {
    const body = await grid({}, [MANY[NONE]]);
    expect(body.querySelectorAll('ul > li')).toHaveLength(ONE);
    expect(body.querySelector('img')?.getAttribute('loading')).toBe('eager');
  });
});
