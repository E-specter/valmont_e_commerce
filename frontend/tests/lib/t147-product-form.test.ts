import { describe, expect, test } from 'vitest';
import SpecsEditor from '../../src/components/admin/SpecsEditor.astro';
import { diffProduct, readProductForm, toProductValues, validateProductForm, type ProductFormValues } from '../../src/lib/admin/product-form';
import { parseSoles, solesInput } from '../../src/lib/admin/money';
import { parseHtml, renderAstro } from '../helpers/render';
import { CATEGORY_ID, OTHER_CATEGORY_ID, SOLES_CENTS, adminProduct, formValues, serialize, toFormData, type Entry } from '../helpers/t147';

// T-147 · `lib/admin/product-form.ts` (STATUS ui «T-147 › Firmas públicas»): readProductForm, toProductValues, validateProductForm y diffProduct.
// Funciones puras: sin red. El nombre de los controles de las especificaciones lo decide `SpecsEditor`; aquí se lee del marcado real.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THIRTEEN = 13;
const CENTS_1250 = 125000;
const CENTS_1250_5 = 125050;
const CENTS_1300_5 = 130050;
const LEAD = 42;
const WATER = 50;
const WATER_100 = 100;
const DIAMETER_38 = 38;
const CENTS_99 = 99;
const CENTS_5 = 5;
const CENTS_MAX = 999999999;
const LEAD_30 = 30;
const ALLOWED_INPUT_KEYS = [
  'sku', 'slug', 'name', 'description', 'category_id', 'price', 'order_policy', 'lead_time_days', 'movement_code', 'case_material_code',
  'case_diameter_mm', 'water_resistance_m', 'specs',
];
const VALUE_KEYS = ALLOWED_INPUT_KEYS;
const HOSTILE = '<script>window.__pwned=1</script>';
const EXTRA_FIELDS: Entry[] = [
  ['status', 'published'], ['id', 'x'], ['published_at', '2026-01-01T00:00:00Z'], ['images', '[]'], ['user_id', 'otro'], ['role', 'admin'],
  ['price_amount', '1'], ['currency', 'USD'], ['__proto__', 'x'], ['constructor', 'x'], ['_action', 'save'],
];

/** Entradas del formulario para unos valores: los escalares por nombre y las especificaciones tal como las pinta `SpecsEditor`. */
async function entriesFor(v: ProductFormValues): Promise<Entry[]> {
  const specs = serialize(parseHtml(await renderAstro(SpecsEditor, { props: { specs: v.specs } })).body);
  const scalars: Entry[] = Object.entries(v)
    .filter(([k]) => k !== 'specs')
    .map(([k, val]): Entry => [k, String(val)]);
  return [...scalars, ...specs];
}
const read = async (v: ProductFormValues, extra: Entry[] = []): Promise<ProductFormValues> => readProductForm(toFormData([...(await entriesFor(v)), ...extra]));
const ok = (v: ProductFormValues) => {
  const r = validateProductForm(v);
  if (!r.ok) throw new Error(`validateProductForm rechazó valores válidos: ${JSON.stringify(r.errors)}`);
  return r.input;
};
const fail = (v: ProductFormValues) => {
  const r = validateProductForm(v);
  if (r.ok) throw new Error('validateProductForm aceptó valores no válidos');
  return r.errors;
};

describe('readProductForm', () => {
  test('lee los 12 escalares como texto y las especificaciones, en orden, desde un formulario real', async () => {
    const v = formValues({ name: 'Otro reloj', description: 'Línea 1\nLínea 2', specs: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' }] });
    const got = await read(v);
    expect(got).toEqual(v);
  });

  test('devuelve exactamente las 13 claves de ProductFormValues; ignora status, id, published_at, images y cualquier campo extra', async () => {
    const got = await read(formValues(), EXTRA_FIELDS);
    expect(Object.keys(got).sort()).toEqual([...VALUE_KEYS].sort());
    expect(Object.keys(got)).toHaveLength(THIRTEEN);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('un campo ausente es cadena vacía; nunca undefined ni "null"', () => {
    const got = readProductForm(toFormData([['sku', 'QA-T147-X']]));
    expect(got.sku).toBe('QA-T147-X');
    (['slug', 'name', 'description', 'category_id', 'price', 'lead_time_days', 'movement_code', 'case_material_code', 'case_diameter_mm', 'water_resistance_m'] as const).forEach((k) =>
      expect(got[k], k).toBe(''),
    );
    expect(got.specs).toEqual([]);
  });

  test('un archivo subido en un campo de texto no es texto: se lee como cadena vacía', () => {
    const fd = new FormData();
    fd.append('name', new File(['x'], 'x.txt', { type: 'text/plain' }));
    fd.append('sku', 'QA-T147-F');
    const got = readProductForm(fd);
    expect(got.name).toBe('');
    expect(got.sku).toBe('QA-T147-F');
  });

  test('order_policy desconocida no pasa como política válida', async () => {
    const got = readProductForm(toFormData([['order_policy', 'regalo'], ['sku', 'A']]));
    expect(['stock', 'made_to_order', 'backorder']).toContain(got.order_policy);
  });

  test.each(['stock', 'made_to_order', 'backorder'] as const)('order_policy "%s" se conserva', (policy) => {
    expect(readProductForm(toFormData([['order_policy', policy]])).order_policy).toBe(policy);
  });

  test('los valores hostiles se leen tal cual (el escape es de la plantilla, no de la lectura)', async () => {
    const got = await read(formValues({ name: HOSTILE, specs: [{ label: HOSTILE, value: HOSTILE }] }));
    expect(got.name).toBe(HOSTILE);
    expect(got.specs).toEqual([{ label: HOSTILE, value: HOSTILE }]);
  });

  test('las filas vacías que pinta el editor sin JavaScript no llegan como especificaciones al validar (no se envían pares en blanco)', async () => {
    const entries = await entriesFor(formValues({ specs: [{ label: 'Calibre', value: 'VM-01' }] }));
    const blank = serialize(parseHtml(await renderAstro(SpecsEditor, { props: { specs: [{ label: 'Calibre', value: 'VM-01' }] } })).body);
    // El editor pinta las existentes y 2 vacías; el formulario las envía tal cual: el resultado no debe contener pares vacíos.
    expect(blank.length).toBeGreaterThan(TWO);
    const r = validateProductForm(readProductForm(toFormData(entries)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.specs).toEqual([{ label: 'Calibre', value: 'VM-01' }]);
  });
});

describe('toProductValues', () => {
  test('un producto completo: todo en texto; el precio con solesInput; los nulos como cadena vacía', () => {
    const v = toProductValues(adminProduct());
    expect(v).toMatchObject({
      sku: 'QA-T147-001', slug: 'qa-heritage-38', name: 'Heritage 38', category_id: CATEGORY_ID, price: '1250.50', order_policy: 'made_to_order',
      lead_time_days: '30', movement_code: 'automatic', case_material_code: 'steel', case_diameter_mm: '38.5', water_resistance_m: '50',
    });
    expect(v.description).toBe('Un clásico de líneas puras.\nCaja de acero.');
    expect(v.specs).toEqual([{ label: 'Calibre', value: 'VM-01' }, { label: 'Reserva de marcha', value: '42 h' }]);
    expect(Object.keys(v).sort()).toEqual([...VALUE_KEYS].sort());
  });

  test('opcionales nulos → cadena vacía (nunca "null" ni "undefined")', () => {
    const v = toProductValues(
      adminProduct({ lead_time_days: null, movement: null, movement_code: null, case_material: null, case_material_code: null, case_diameter_mm: null, water_resistance_m: null, order_policy: 'stock' }),
    );
    (['lead_time_days', 'movement_code', 'case_material_code', 'case_diameter_mm', 'water_resistance_m'] as const).forEach((k) => expect(v[k], k).toBe(''));
    expect(JSON.stringify(v)).not.toContain('null');
    expect(JSON.stringify(v)).not.toContain('undefined');
  });

  test('un diámetro entero (38) sale como "38" o "38.0", nunca con notación científica ni coma', () => {
    const v = toProductValues(adminProduct({ case_diameter_mm: DIAMETER_38 }));
    expect(['38', '38.0']).toContain(v.case_diameter_mm);
  });

  test('sin especificaciones → arreglo vacío; el resultado no comparte referencia con el producto', () => {
    const p = adminProduct({ specs: [{ label: 'A', value: 'B' }] });
    const v = toProductValues(p);
    v.specs[NONE].value = 'cambiado';
    expect(p.specs[NONE].value).toBe('B');
    expect(toProductValues(adminProduct({ specs: [] })).specs).toEqual([]);
  });

  test('el id, el estado, las imágenes y las fechas del producto no entran en los valores', () => {
    const v = toProductValues(adminProduct({ status: 'published', published_at: '2026-11-22T10:00:00Z' })) as Record<string, unknown>;
    ['id', 'status', 'images', 'published_at', 'created_at', 'updated_at', 'main_image', 'category', 'movement', 'case_material'].forEach((k) => expect(v, k).not.toHaveProperty(k));
  });

  test.each([[ONE], [CENTS_1250], [SOLES_CENTS], [CENTS_99], [CENTS_5], [CENTS_MAX]])('el precio %i céntimos va y vuelve igual por solesInput y parseSoles (D-B6)', (cents) => {
    const shown = toProductValues(adminProduct({ price: { amount: cents, currency: 'PEN' } })).price;
    expect(shown).toBe(solesInput(cents));
    expect(parseSoles(shown)).toEqual({ ok: true, cents });
  });

  test('1250.50 ↔ 125050', () => {
    expect(toProductValues(adminProduct({ price: { amount: CENTS_1250_5, currency: 'PEN' } })).price).toBe('1250.50');
    expect(solesInput(CENTS_1250_5)).toBe('1250.50');
    expect(parseSoles('1250.50')).toEqual({ ok: true, cents: CENTS_1250_5 });
  });
});

describe('validateProductForm · solo formato', () => {
  test('valores completos → { ok: true, input } con el precio como { amount, currency: "PEN" } y los opcionales con su tipo', () => {
    const input = ok(formValues());
    expect(input).toMatchObject({
      sku: 'QA-T147-001', slug: 'qa-heritage-38', name: 'Heritage 38', category_id: CATEGORY_ID, order_policy: 'made_to_order', movement_code: 'automatic',
      case_material_code: 'steel', price: { amount: CENTS_1250_5, currency: 'PEN' }, lead_time_days: LEAD_30, water_resistance_m: WATER,
    });
    expect(input.case_diameter_mm).toBe('38.5');
    expect(Number.isInteger(input.price.amount)).toBe(true);
    expect(input.specs).toEqual(formValues().specs);
    expect(Object.keys(input).every((k) => ALLOWED_INPUT_KEYS.includes(k))).toBe(true);
  });

  test.each([
    ['1250', CENTS_1250],
    ['1250.5', CENTS_1250_5],
    ['1250.50', CENTS_1250_5],
    ['0.01', ONE],
  ])('precio "%s" aceptado → %i céntimos enteros', (price, cents) => {
    expect(ok(formValues({ price })).price).toEqual({ amount: cents, currency: 'PEN' });
  });

  test.each([['1.250,50'], [''], ['0'], ['0.00'], ['-5'], ['12,5'], ['abc'], ['1e3'], ['1250.505'], [' '], ['S/ 1250'], ['1 250'], ['99999999999']])(
    'precio %j rechazado: { ok: false } con error en "price" y sin input',
    (price) => {
      const r = validateProductForm(formValues({ price }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(typeof r.errors.price).toBe('string');
      expect((r.errors.price ?? '').length).toBeGreaterThan(NONE);
    },
  );

  test.each([['sku'], ['name'], ['category_id']] as const)('obligatorio vacío o en blanco: "%s" → error en ese campo', (field) => {
    expect(Object.keys(fail(formValues({ [field]: '' })))).toContain(field);
  });

  test('varios errores a la vez: uno por campo, con texto en español (no el del backend)', () => {
    const errors = fail(formValues({ sku: '', name: '', price: '0' }));
    expect(Object.keys(errors).sort()).toEqual(expect.arrayContaining(['name', 'price', 'sku']));
    Object.values(errors).forEach((m) => {
      expect(typeof m).toBe('string');
      expect(m.toLowerCase()).not.toContain('field required');
      expect(m.toLowerCase()).not.toContain('value is not');
    });
  });

  test('el plazo obligatorio fuera de «stock» es regla del backend: la interfaz no lo exige', () => {
    expect(validateProductForm(formValues({ order_policy: 'made_to_order', lead_time_days: '' })).ok).toBe(true);
    expect(validateProductForm(formValues({ order_policy: 'backorder', lead_time_days: '' })).ok).toBe(true);
  });

  test('un opcional vacío no viaja como cadena vacía ni NaN (ausente o null)', () => {
    const input = ok(formValues({ slug: '', lead_time_days: '', movement_code: '', case_material_code: '', case_diameter_mm: '', water_resistance_m: '' })) as Record<string, unknown>;
    ['slug', 'lead_time_days', 'movement_code', 'case_material_code', 'case_diameter_mm', 'water_resistance_m'].forEach((k) => expect([undefined, null], k).toContain(input[k]));
    expect(JSON.stringify(input)).not.toContain('NaN');
  });

  test('el input nunca lleva status, id, published_at ni images', () => {
    const input = ok(formValues()) as Record<string, unknown>;
    ['status', 'id', 'published_at', 'images', 'user_id', 'role'].forEach((k) => expect(input, k).not.toHaveProperty(k));
  });

  test('las especificaciones conservan su orden', () => {
    const specs = [{ label: 'Z', value: '1' }, { label: 'A', value: '2' }, { label: 'M', value: '3' }];
    expect(ok(formValues({ specs })).specs).toEqual(specs);
  });

  test.each([['sku'], ['name'], ['category_id'], ['price']])('un valor en blanco en "%s" (leído del formulario) no pasa como lleno', (field) => {
    const base: Entry[] = [['sku', 'A'], ['name', 'N'], ['category_id', CATEGORY_ID], ['price', '10'], ['order_policy', 'stock']];
    const entries = base.map(([k, v]): Entry => (k === field ? [k, '   '] : [k, v]));
    expect(validateProductForm(readProductForm(toFormData(entries))).ok).toBe(false);
  });

  test('un solo espacio en blanco no vale como nombre (leído del formulario)', () => {
    const r = validateProductForm(readProductForm(toFormData([['sku', 'A'], ['name', '   '], ['category_id', CATEGORY_ID], ['price', '10'], ['order_policy', 'stock']])));
    expect(r.ok).toBe(false);
  });
});

describe('diffProduct · solo lo cambiado', () => {
  const base = formValues();

  test('sin cambios → {}', () => {
    expect(diffProduct(base, formValues())).toEqual({});
  });

  test('solo el nombre → { name } y nada más', () => {
    expect(diffProduct(base, formValues({ name: 'Heritage 40' }))).toEqual({ name: 'Heritage 40' });
  });

  test('vaciar un opcional → null (resistencia al agua)', () => {
    expect(diffProduct(base, formValues({ water_resistance_m: '' }))).toEqual({ water_resistance_m: null });
  });

  test.each([['lead_time_days'], ['movement_code'], ['case_material_code'], ['case_diameter_mm'], ['water_resistance_m']] as const)('vaciar "%s" → null', (field) => {
    expect(diffProduct(base, formValues({ [field]: '' }))).toEqual({ [field]: null });
  });

  test('un opcional que seguía vacío no genera null (sin ruido)', () => {
    const empty = formValues({ water_resistance_m: '', movement_code: '', case_diameter_mm: '' });
    expect(diffProduct(empty, formValues({ water_resistance_m: '', movement_code: '', case_diameter_mm: '', name: 'Otro' }))).toEqual({ name: 'Otro' });
  });

  test('rellenar un opcional vacío: números como números y el diámetro como cadena decimal', () => {
    const empty = formValues({ water_resistance_m: '', lead_time_days: '', case_diameter_mm: '', movement_code: '' });
    const patch = diffProduct(empty, formValues({ water_resistance_m: '100', lead_time_days: '42', case_diameter_mm: '40.5', movement_code: 'manual' }));
    expect(patch).toEqual({ water_resistance_m: WATER_100, lead_time_days: LEAD, case_diameter_mm: '40.5', movement_code: 'manual' });
  });

  test('el precio viaja como { amount, currency: "PEN" } con amount entero de parseSoles', () => {
    expect(diffProduct(base, formValues({ price: '1300.5' }))).toEqual({ price: { amount: CENTS_1300_5, currency: 'PEN' } });
    expect(diffProduct(base, formValues({ price: '1250' }))).toEqual({ price: { amount: CENTS_1250, currency: 'PEN' } });
  });

  test('varios campos: solo los que cambian', () => {
    expect(diffProduct(base, formValues({ sku: 'QA-T147-002', category_id: OTHER_CATEGORY_ID, order_policy: 'stock', description: 'Nueva' }))).toEqual({
      sku: 'QA-T147-002', category_id: OTHER_CATEGORY_ID, order_policy: 'stock', description: 'Nueva',
    });
  });

  test('las especificaciones se envían completas, en su orden, solo si cambian', () => {
    const swapped = [...base.specs].reverse();
    expect(diffProduct(base, formValues({ specs: swapped }))).toEqual({ specs: swapped });
    const added = [...base.specs, { label: 'Cristal', value: 'Zafiro' }];
    expect(diffProduct(base, formValues({ specs: added }))).toEqual({ specs: added });
    expect(diffProduct(base, formValues({ specs: [] }))).toEqual({ specs: [] });
    expect(diffProduct(base, formValues({ specs: [...base.specs] }))).toEqual({});
    const edited = [{ label: 'Calibre', value: 'VM-02' }, base.specs[ONE]];
    expect(diffProduct(base, formValues({ specs: edited }))).toEqual({ specs: edited });
  });

  test('nunca incluye status, id, images, published_at ni claves ajenas al producto', () => {
    const patch = diffProduct(base, formValues({ name: 'X', price: '1', specs: [] })) as Record<string, unknown>;
    ['status', 'id', 'images', 'published_at', 'user_id', 'role'].forEach((k) => expect(patch, k).not.toHaveProperty(k));
    expect(Object.keys(patch).every((k) => ALLOWED_INPUT_KEYS.includes(k))).toBe(true);
  });

  test('no modifica los valores recibidos', () => {
    const original = formValues();
    const next = formValues({ name: 'Otro', specs: [{ label: 'Z', value: '1' }] });
    const snapOriginal = JSON.stringify(original);
    const snapNext = JSON.stringify(next);
    diffProduct(original, next);
    expect(JSON.stringify(original)).toBe(snapOriginal);
    expect(JSON.stringify(next)).toBe(snapNext);
  });

  test('toProductValues(p) comparado consigo mismo no produce cambios (el formulario recién cargado no envía nada)', () => {
    const p = adminProduct();
    expect(diffProduct(toProductValues(p), toProductValues(p))).toEqual({});
    const sparse = adminProduct({ lead_time_days: null, movement_code: null, case_material_code: null, case_diameter_mm: null, water_resistance_m: null, specs: [] });
    expect(diffProduct(toProductValues(sparse), toProductValues(sparse))).toEqual({});
  });

  test('el valor leído de un formulario sin tocar equivale al producto: sin cambios (las filas vacías del editor no cuentan)', async () => {
    const p = adminProduct();
    const original = toProductValues(p);
    const next = readProductForm(toFormData(await entriesFor(original)));
    expect(diffProduct(original, next)).toEqual({});
  });
});

describe('saltos de línea del navegador', () => {
  // Los navegadores envían los saltos de un <textarea> como CRLF: una descripción de varias líneas sin tocar no es un cambio.
  test('una descripción con CRLF equivale a la del producto con LF: sin cambios', () => {
    const p = adminProduct({ description: 'Línea 1\nLínea 2\n\nLínea 4', specs: [] });
    const original = toProductValues(p);
    const next = readProductForm(toFormData([['description', 'Línea 1\r\nLínea 2\r\n\r\nLínea 4'], ['sku', original.sku], ['name', original.name], ['category_id', original.category_id], ['price', original.price], ['order_policy', original.order_policy], ['slug', original.slug], ['lead_time_days', original.lead_time_days], ['movement_code', original.movement_code], ['case_material_code', original.case_material_code], ['case_diameter_mm', original.case_diameter_mm], ['water_resistance_m', original.water_resistance_m]]));
    expect(diffProduct(original, next)).toEqual({});
  });
});

describe('precio de entrada (H-B6): parseSoles y solesInput de punta a punta', () => {
  test.each([['1250', CENTS_1250], ['1250.5', CENTS_1250_5]])('"%s" se acepta', (text, cents) => {
    expect(parseSoles(text)).toEqual({ ok: true, cents });
  });
  test.each([['1.250,50'], [''], ['0']])('%j se rechaza', (text) => {
    expect(parseSoles(text)).toEqual({ ok: false });
  });
  test('lo aceptado vuelve igual por solesInput', () => {
    ['1250', '1250.5', '1250.50'].forEach((text) => {
      const r = parseSoles(text);
      if (!r.ok) throw new Error(text);
      expect(parseSoles(solesInput(r.cents))).toEqual(r);
    });
  });
});
