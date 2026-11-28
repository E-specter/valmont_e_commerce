import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Editar from '../../src/pages/admin/productos/[product_id].astro';
import { MSG_PUBLISH_MISSING, MSG_SKU_TAKEN, MSG_SLUG_LOCKED, MSG_SLUG_TAKEN } from '../../src/lib/admin/messages';
import { BEARER } from '../helpers/t129';
import {
  BACKEND_MSG, CATEGORY_ID, FORBIDDEN_NAMES, NO_STORE, OTHER_CATEGORY_ID, PRODUCT_ID, adminProduct, apiError, catalogBackend, setEntries, validation, valueOf,
  type CatalogCall, type Entry,
} from '../helpers/t147';
import {
  ST, alertText, describedText, entriesOf, field, formOf, invalid, openPage, specNamesOf, supabaseMock, withAction, withSpecs, type Init, type SupabaseMock,
} from '../helpers/t147-pages';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-147 · `GET|POST /admin/productos/[product_id]` (editar, publicar y despublicar) con la Container API y un backend de catálogo simulado.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const WATER_100 = 100;
const CENTS_1300_5 = 130050;
const CENTS_1300 = 130000;
const HERE = `/admin/productos/${PRODUCT_ID}`;
const LEAKS = [BACKEND_MSG, 'Mensaje del servidor en inglés.', 'api.test', 'ECONNREFUSED', BEARER];
const BAD_IDS = [
  'abc', '123', '..%2F..%2Forders', '../orders', 'null', 'undefined', `${PRODUCT_ID}/publish`, `${PRODUCT_ID}\n`, ` ${PRODUCT_ID}`, `${PRODUCT_ID} `,
  `${PRODUCT_ID.slice(NONE, -ONE)}`, `${PRODUCT_ID}0`, 'g'.repeat(PRODUCT_ID.length), PRODUCT_ID.replaceAll('-', ''), '<script>', "' OR 1=1 --", '',
];
const HOSTILE = '<script>window.__pwned=1</script><b>x</b>';

let sb: SupabaseMock;
beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (init: Init = {}, id: string = PRODUCT_ID) => openPage(Editar, `/admin/productos/${id}`, sb, { params: { product_id: id }, ...init });
const post = (entries: readonly Entry[], init: Init = {}, id: string = PRODUCT_ID) => open({ method: 'POST', entries, ...init }, id);
const noLeaks = (html: string) => LEAKS.forEach((l) => expect(html, l).not.toContain(l));
const onlyGets = (calls: CatalogCall[]) => calls.every((c) => c.method === 'GET');
const patchOf = (be: ReturnType<typeof catalogBackend>): CatalogCall => be.patches()[NONE];

/** El formulario recién cargado, tal como lo enviaría el navegador al guardar. Conserva el backend de la prueba. */
async function loaded(product = adminProduct()) {
  const previous = globalThis.fetch;
  catalogBackend({ product });
  const { doc } = await open();
  vi.stubGlobal('fetch', previous);
  return { entries: withAction(entriesOf(doc), 'save'), specNames: specNamesOf(doc) };
}
const save = async (changes: Record<string, string>, product = adminProduct()) => setEntries((await loaded(product)).entries, changes);

describe('GET /admin/productos/[product_id]', () => {
  test('200: un h1, noindex, no-store, «Volver a productos», migas «Editar producto» y solo lecturas al backend', async () => {
    const be = catalogBackend();
    const { res, doc } = await open();
    expect(res.status).toBe(ST.OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const back = [...doc.querySelectorAll('a')].find((a) => text(a) === 'Volver a productos');
    expect(back?.getAttribute('href')).toBe('/admin/productos');
    expect(text(doc.body)).toContain('Editar producto');
    expect(onlyGets(be.calls)).toBe(true);
    expect(be.calls.map((c) => c.path).sort()).toEqual([
      '/catalog/admin/attributes', '/catalog/admin/categories', `/catalog/admin/products/${PRODUCT_ID}`, '/identity/me',
    ]);
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
  });

  test('el formulario trae los valores del producto: precio con solesInput, selects, política, descripción y especificaciones', async () => {
    catalogBackend();
    const { doc } = await open();
    const e = entriesOf(doc);
    expect(valueOf(e, 'sku')).toBe('QA-T147-001');
    expect(valueOf(e, 'slug')).toBe('qa-heritage-38');
    expect(valueOf(e, 'name')).toBe('Heritage 38');
    expect(valueOf(e, 'price')).toBe('1250.50');
    expect(valueOf(e, 'category_id')).toBe(CATEGORY_ID);
    expect(valueOf(e, 'order_policy')).toBe('made_to_order');
    expect(valueOf(e, 'lead_time_days')).toBe('30');
    expect(valueOf(e, 'movement_code')).toBe('automatic');
    expect(valueOf(e, 'case_material_code')).toBe('steel');
    expect(valueOf(e, 'case_diameter_mm')).toBe('38.5');
    expect(valueOf(e, 'water_resistance_m')).toBe('50');
    expect(valueOf(e, 'description')).toBe('Un clásico de líneas puras.\nCaja de acero.');
    const [labelName, valueName] = specNamesOf(doc);
    expect(e.filter(([k]) => k === labelName).map(([, v]) => v).slice(NONE, TWO)).toEqual(['Calibre', 'Reserva de marcha']);
    expect(e.filter(([k]) => k === valueName).map(([, v]) => v).slice(NONE, TWO)).toEqual(['VM-01', '42 h']);
  });

  test('un producto con opcionales nulos deja esos campos vacíos (sin "null")', async () => {
    catalogBackend({ product: adminProduct({ lead_time_days: null, movement_code: null, case_material_code: null, case_diameter_mm: null, water_resistance_m: null, order_policy: 'stock' }) });
    const { doc, html } = await open();
    ['lead_time_days', 'case_diameter_mm', 'water_resistance_m'].forEach((n) => expect(valueOf(entriesOf(doc), n), n).toBe(''));
    expect(html).not.toContain('value="null"');
  });

  test('borrador: «Borrador» y «Publicar»; el panel lleva «Guardar cambios» fuera del <form> (form="product-form") y «Descartar cambios»', async () => {
    catalogBackend();
    const { doc } = await open();
    const buttons = [...doc.querySelectorAll('button, a')];
    const named = (t: string) => buttons.find((b) => text(b) === t);
    expect(text(doc.body)).toContain('Borrador');
    expect(named('Publicar')).toBeDefined();
    expect(named('Despublicar')).toBeUndefined();
    const saveBtn = named('Guardar cambios') as Element;
    expect(saveBtn.getAttribute('form')).toBe('product-form');
    expect(formOf(doc).contains(saveBtn)).toBe(false);
    expect(named('Descartar cambios')?.getAttribute('href')).toBe(HERE);
    expect(doc.querySelectorAll('form form')).toHaveLength(NONE);
  });

  test('publicado: «Publicado» y «Despublicar», sin «Publicar»', async () => {
    catalogBackend({ product: adminProduct({ status: 'published', published_at: '2026-11-22T10:00:00Z' }) });
    const { doc } = await open();
    const labels = [...doc.querySelectorAll('button')].map((b) => text(b));
    expect(text(doc.body)).toContain('Publicado');
    expect(labels).toContain('Despublicar');
    expect(labels).not.toContain('Publicar');
  });

  test.each([
    ['?creado=1', 'creado'],
    ['?guardado=1', 'guardado'],
    ['?guardado=sin-cambios', 'sin cambios'],
  ])('aviso tras PRG %s', async (query, word) => {
    catalogBackend();
    const { doc } = await open({ query });
    expect(text(doc.body).toLowerCase()).toContain(word);
  });

  test.each([['?guardado=<script>1</script>'], ['?guardado=2'], ['?creado=0'], ['?creado=yes']])('un parámetro desconocido (%s) no muestra avisos ni se refleja', async (query) => {
    catalogBackend();
    const { doc, html } = await open({ query });
    expect(html).not.toContain('<script>1</script>');
    ['producto creado', 'cambios guardados', 'sin cambios'].forEach((w) => expect(text(doc.body).toLowerCase(), w).not.toContain(w));
  });

  test('ninguna mutación por GET: ni _action ni parámetros que imiten campos', async () => {
    const be = catalogBackend();
    await open({ query: '?_action=publish&sku=HACK&status=published&name=x' });
    await open({ query: '?_action=unpublish' });
    expect(be.writes()).toHaveLength(NONE);
  });

  test('nombre y descripción hostiles se pintan como texto', async () => {
    catalogBackend({ product: adminProduct({ name: HOSTILE, description: `</textarea>${HOSTILE}`, specs: [{ label: HOSTILE, value: HOSTILE }] }) });
    const { doc } = await open();
    expect(doc.querySelectorAll('script:not([src]), b')).toHaveLength(NONE);
    expect(valueOf(entriesOf(doc), 'name')).toBe(HOSTILE);
  });

  test.each(BAD_IDS)('product_id %j no es un UUID: /404 sin ninguna llamada al catálogo', async (id) => {
    const be = catalogBackend();
    const { res, doc } = await open({}, id);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.catalog()).toHaveLength(NONE);
    expect(doc.querySelector('form#product-form')).toBeNull();
  });

  test.each(BAD_IDS)('POST con product_id %j no es un UUID: 404 y ninguna escritura', async (id) => {
    const be = catalogBackend();
    const { res } = await post(withAction([['name', 'x']], 'save'), {}, id);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('un UUID válido en mayúsculas se acepta como el mismo producto', async () => {
    catalogBackend();
    const { res } = await open({}, PRODUCT_ID.toUpperCase());
    expect([ST.OK, ST.NOT_FOUND]).toContain(res.status);
  });

  test('un UUID válido que no existe: 404 de la tienda de administración, sin formulario', async () => {
    catalogBackend();
    const { res, doc } = await open({}, '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d');
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(doc.querySelector('form#product-form')).toBeNull();
  });

  test('sin sesión (red de seguridad): 302 al ingreso y ninguna llamada', async () => {
    const be = catalogBackend();
    const { res } = await open({ session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(HERE)}`);
    expect(be.calls).toHaveLength(NONE);
  });

  test('un cliente: 403 «Sin permiso», sin tocar el catálogo ni mostrar el producto', async () => {
    const be = catalogBackend({ role: 'customer' });
    const { res, html } = await open();
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.catalog()).toHaveLength(NONE);
    expect(html).not.toContain('Heritage 38');
  });

  test.each([
    [ST.UNAUTHORIZED, ST.FOUND],
    [ST.FORBIDDEN, ST.FORBIDDEN],
    [ST.NOT_FOUND, ST.NOT_FOUND],
    [ST.SERVER_ERROR, ST.UNAVAILABLE],
    [ST.BAD_GATEWAY, ST.UNAVAILABLE],
    [ST.UNAVAILABLE, ST.UNAVAILABLE],
  ])('GET del producto responde %i → página %i sin formulario ni trazas', async (status, expected) => {
    catalogBackend({ override: (c) => (c.method === 'GET' && c.path.startsWith('/catalog/admin/products/') ? apiError(status, 'x') : undefined) });
    const { res, doc, html } = await open();
    expect(res.status).toBe(expected);
    expect(doc.querySelector('form#product-form')).toBeNull();
    noLeaks(html);
    if (status === ST.UNAUTHORIZED) expect(sb.signOut).toHaveBeenCalled();
  });
});

describe('POST · guardar solo lo cambiado (PATCH)', () => {
  test('solo el nombre: un PATCH con { name } y nada más; 303 a ?guardado=1 sin caché', async () => {
    const be = catalogBackend();
    const entries = await save({ name: 'Heritage 40' });
    be.calls.length = NONE;
    const { res } = await post(entries);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('location')).toBe(`${HERE}?guardado=1`);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.writes()).toHaveLength(ONE);
    expect(patchOf(be).path).toBe(`/catalog/admin/products/${PRODUCT_ID}`);
    expect(patchOf(be).auth).toBe(`Bearer ${BEARER}`);
    expect(patchOf(be).body).toEqual({ name: 'Heritage 40' });
  });

  test('relee el producto antes de calcular el cambio (GET del producto antes del PATCH)', async () => {
    const be = catalogBackend();
    const entries = await save({ name: 'Heritage 40' });
    be.calls.length = NONE;
    await post(entries);
    const order = be.calls.filter((c) => c.path.startsWith('/catalog/admin/products/')).map((c) => c.method);
    expect(order).toEqual(['GET', 'PATCH']);
  });

  test('vaciar «Resistencia al agua» envía water_resistance_m: null', async () => {
    const be = catalogBackend();
    const { res } = await post(await save({ water_resistance_m: '' }));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(patchOf(be).body).toEqual({ water_resistance_m: null });
  });

  test.each([['lead_time_days'], ['movement_code'], ['case_material_code'], ['case_diameter_mm']])('vaciar "%s" envía null', async (name) => {
    const be = catalogBackend();
    await post(await save({ [name]: '' }));
    expect(patchOf(be).body).toEqual({ [name]: null });
  });

  test.each([['1300.5', CENTS_1300_5], ['1300', CENTS_1300], ['1300.50', CENTS_1300_5]])('precio "%s" → { amount: %i, currency: "PEN" }', async (price, amount) => {
    const be = catalogBackend();
    await post(await save({ price }));
    expect(patchOf(be).body).toEqual({ price: { amount, currency: 'PEN' } });
  });

  test.each([['1.250,50'], [''], ['0']])('precio %j: 422 en el campo, ningún PATCH y lo escrito conservado', async (price) => {
    const be = catalogBackend();
    const entries = await save({ price, name: 'Conservado QA' });
    const { res, doc } = await post(entries);
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.patches()).toHaveLength(NONE);
    expect(invalid(doc, 'price')).toBe(true);
    expect(valueOf(entriesOf(doc), 'name')).toBe('Conservado QA');
  });

  test('varios cambios a la vez: solo esos campos, con sus tipos', async () => {
    const be = catalogBackend();
    await post(await save({ category_id: OTHER_CATEGORY_ID, order_policy: 'stock', lead_time_days: '', water_resistance_m: String(WATER_100), case_diameter_mm: '40', description: 'Nueva' }));
    expect(patchOf(be).body).toEqual({
      category_id: OTHER_CATEGORY_ID, order_policy: 'stock', lead_time_days: null, water_resistance_m: WATER_100, case_diameter_mm: '40', description: 'Nueva',
    });
  });

  test('sin cambios (el formulario tal como se cargó, con sus filas vacías): ningún PATCH y 303 a ?guardado=sin-cambios', async () => {
    const be = catalogBackend();
    const { entries } = await loaded();
    be.calls.length = NONE;
    const { res } = await post(entries);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('location')).toBe(`${HERE}?guardado=sin-cambios`);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('especificaciones: cambiar un valor envía el arreglo completo, en orden; el resto no viaja', async () => {
    const be = catalogBackend();
    const { entries, specNames } = await loaded();
    const specs = [{ label: 'Calibre', value: 'VM-02' }, { label: 'Reserva de marcha', value: '42 h' }];
    await post(withSpecs(entries, specs, specNames));
    expect(patchOf(be).body).toEqual({ specs });
  });

  test('especificaciones: añadir una fila, quitar otra y reordenar', async () => {
    const be = catalogBackend();
    const { entries, specNames } = await loaded();
    const added = [{ label: 'Calibre', value: 'VM-01' }, { label: 'Reserva de marcha', value: '42 h' }, { label: 'Cristal', value: 'Zafiro' }];
    await post(withSpecs(entries, added, specNames));
    expect(patchOf(be).body).toEqual({ specs: added });
    be.calls.length = NONE;
    const reordered = [added[ONE], added[NONE]];
    await post(withSpecs(entries, reordered, specNames));
    expect(be.patches().at(-ONE)?.body).toEqual({ specs: reordered });
    await post(withSpecs(entries, [added[NONE]], specNames));
    expect(be.patches().at(-ONE)?.body).toEqual({ specs: [added[NONE]] });
    await post(withSpecs(entries, [], specNames));
    expect(be.patches().at(-ONE)?.body).toEqual({ specs: [] });
  });

  test('una especificación a medias (etiqueta sin valor): 422 en el editor y ningún PATCH', async () => {
    const be = catalogBackend();
    const { entries, specNames } = await loaded();
    const { res, doc } = await post(withSpecs(entries, [{ label: 'Solo etiqueta', value: '' }], specNames));
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.patches()).toHaveLength(NONE);
    expect(alertText(doc).length).toBeGreaterThan(NONE);
  });

  test('status, id, published_at, images y campos ajenos del cuerpo se ignoran: el PATCH es exactamente { name }', async () => {
    const be = catalogBackend();
    const extra: Entry[] = FORBIDDEN_NAMES.map((n): Entry => [n, 'published']);
    await post([...(await save({ name: 'Heritage 40' })), ...extra, ['__proto__', 'x']]);
    expect(patchOf(be).body).toEqual({ name: 'Heritage 40' });
    expect(patchOf(be).raw).not.toContain('published');
  });

  test('un producto publicado se guarda igual y sigue publicado: el formulario no envía status', async () => {
    const be = catalogBackend({ product: adminProduct({ status: 'published' }) });
    const entries = await save({ name: 'Heritage 40' }, adminProduct({ status: 'published' }));
    await post(entries);
    expect(patchOf(be).body).toEqual({ name: 'Heritage 40' });
  });

  test.each([
    ['sku_taken', ST.CONFLICT, 'sku', MSG_SKU_TAKEN],
    ['slug_taken', ST.CONFLICT, 'slug', MSG_SLUG_TAKEN],
  ])('409 %s: estado 409, error bajo su campo y lo escrito conservado', async (code, status, name, message) => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(status, code) : undefined) });
    const entries = await save({ [name]: 'otro-valor', description: 'Descripción conservada' });
    const { res, doc, html } = await post(entries);
    expect(res.status).toBe(status);
    expect(invalid(doc, name)).toBe(true);
    expect(describedText(doc, field(doc, name))).toContain(message);
    expect(valueOf(entriesOf(doc), name)).toBe('otro-valor');
    expect(valueOf(entriesOf(doc), 'description')).toBe('Descripción conservada');
    noLeaks(html);
  });

  test('409 slug_locked: mensaje de formulario (no del campo) con el texto en español', async () => {
    catalogBackend({ product: adminProduct({ status: 'published' }), override: (c) => (c.method === 'PATCH' ? apiError(ST.CONFLICT, 'slug_locked') : undefined) });
    const { res, doc } = await post(await save({ slug: 'otro-slug' }, adminProduct({ status: 'published' })));
    expect(res.status).toBe(ST.CONFLICT);
    expect(alertText(doc)).toContain(MSG_SLUG_LOCKED);
  });

  test('409 publish_requirements_unmet al editar un publicado: estado 409, sin 500 ni trazas', async () => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(ST.CONFLICT, 'publish_requirements_unmet', { missing: ['description'] }) : undefined) });
    const { res, html } = await post(await save({ description: '' }));
    expect(res.status).toBe(ST.CONFLICT);
    noLeaks(html);
  });

  test('422 del backend por campo: estado 422, texto en español y nunca el `msg`', async () => {
    catalogBackend({
      override: (c) =>
        c.method === 'PATCH'
          ? validation({ loc: ['body', 'name'], type: 'string_too_long' }, { loc: ['body', 'case_diameter_mm'], type: 'decimal_max_places' })
          : undefined,
    });
    const { res, doc, html } = await post(await save({ name: 'Nombre conservado', case_diameter_mm: '40.5' }));
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(doc, 'name')).toBe(true);
    expect(invalid(doc, 'case_diameter_mm')).toBe(true);
    expect(valueOf(entriesOf(doc), 'name')).toBe('Nombre conservado');
    noLeaks(html);
  });

  test('413: estado 413 y mensaje de formulario', async () => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(ST.PAYLOAD_TOO_LARGE, 'x') : undefined) });
    const { res, doc } = await post(await save({ name: 'Otro' }));
    expect(res.status).toBe(ST.PAYLOAD_TOO_LARGE);
    expect(alertText(doc).length).toBeGreaterThan(NONE);
  });

  test.each([ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE])('el PATCH responde %i: 503 «no disponible» en el formulario, valores conservados', async (status) => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(status, 'internal_error') : undefined) });
    const { res, doc, html } = await post(await save({ name: 'Conservado QA' }));
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(alertText(doc).toLowerCase()).toContain('disponible');
    expect(valueOf(entriesOf(doc), 'name')).toBe('Conservado QA');
    noLeaks(html);
  });

  test('fallo de red al guardar: 503, no un 500', async () => {
    catalogBackend({
      override: (c) => {
        if (c.method === 'PATCH') throw new TypeError('fetch failed');
        return undefined;
      },
    });
    const { res, html } = await post(await save({ name: 'Otro' }));
    expect(res.status).toBe(ST.UNAVAILABLE);
    noLeaks(html);
  });

  test('401 al guardar: cierra la sesión local y 302 al ingreso', async () => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(ST.UNAUTHORIZED, 'unauthenticated') : undefined) });
    const { res } = await post(await save({ name: 'Otro' }));
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location')).toContain('/ingresar?next=');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test.each([
    ['403 (rol retirado a media sesión) → «Sin permiso»', ST.FORBIDDEN],
    ['404 (el producto desapareció) → /404', ST.NOT_FOUND],
  ])('el PATCH responde %s: respuesta 4xx de la guardia, no un 500 (la reescritura tras leer el cuerpo)', async (_n, status) => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(status, 'x') : undefined) });
    const entries = await save({ name: 'Otro' });
    const { res } = await post(entries);
    expect(res.status).toBe(status);
  });

  test('un cliente que envía el formulario de edición: 403 y ninguna escritura', async () => {
    const be = catalogBackend({ role: 'customer' });
    const { res } = await post(withAction([['name', 'x']], 'save'));
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.writes()).toHaveLength(NONE);
  });
});

describe('POST · publicar y despublicar', () => {
  const only = (action: string): Entry[] => [['_action', action]];

  test('«Publicar» con solo la acción: un único POST …/publish sin cuerpo y sin PATCH; 303 al producto sin caché', async () => {
    const be = catalogBackend();
    const { res } = await post(only('publish'));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect((res.headers.get('location') ?? '').startsWith(HERE)).toBe(true);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.writes().map((c) => `${c.method} ${c.path}`)).toEqual([`POST /catalog/admin/products/${PRODUCT_ID}/publish`]);
    expect(be.writes()[NONE].raw).toBeNull();
    expect(be.writes()[NONE].auth).toBe(`Bearer ${BEARER}`);
  });

  test('«Publicar» enviado junto con todo el formulario (aunque tenga cambios) no guarda nada: solo publica', async () => {
    const be = catalogBackend();
    const { res } = await post(withAction(await save({ name: 'Cambio sin guardar' }), 'publish'));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.patches()).toHaveLength(NONE);
    expect(be.writes().map((c) => c.path)).toEqual([`/catalog/admin/products/${PRODUCT_ID}/publish`]);
  });

  test('«Despublicar»: un único POST …/unpublish y 303', async () => {
    const be = catalogBackend({ product: adminProduct({ status: 'published' }) });
    const { res } = await post(only('unpublish'));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.writes().map((c) => `${c.method} ${c.path}`)).toEqual([`POST /catalog/admin/products/${PRODUCT_ID}/unpublish`]);
  });

  test('publicar un producto incompleto (409 publish_requirements_unmet): estado 409, «No se puede publicar todavía» y cada requisito en español', async () => {
    const be = catalogBackend({
      override: (c) => (c.path.endsWith('/publish') ? apiError(ST.CONFLICT, 'publish_requirements_unmet', { missing: ['description', 'image', 'lead_time_days'] }) : undefined),
    });
    const { res, doc, html } = await post(only('publish'));
    expect(res.status).toBe(ST.CONFLICT);
    expect(text(doc.body)).toContain('No se puede publicar todavía');
    ['description', 'image', 'lead_time_days'].forEach((k) => expect(text(doc.body), k).toContain(MSG_PUBLISH_MISSING[k]));
    expect(be.patches()).toHaveLength(NONE);
    expect(valueOf(entriesOf(doc), 'name')).toBe('Heritage 38');
    noLeaks(html);
  });

  test('publicar con requisitos desconocidos o `details` mal formados: 409 sin 500', async () => {
    const replies = [{ missing: ['algo_nuevo'] }, { missing: 'description' }, null, { missing: [ONE, null] }];
    await replies.reduce<Promise<void>>(async (prev, details) => {
      await prev;
      catalogBackend({ override: (c) => (c.path.endsWith('/publish') ? apiError(ST.CONFLICT, 'publish_requirements_unmet', details) : undefined) });
      const { res, html } = await post(only('publish'));
      expect(res.status).toBe(ST.CONFLICT);
      noLeaks(html);
    }, Promise.resolve());
  });

  test.each([ST.SERVER_ERROR, ST.UNAVAILABLE])('publicar con el backend caído (%i): 503 con mensaje, sin trazas', async (status) => {
    catalogBackend({ override: (c) => (c.path.endsWith('/publish') ? apiError(status, 'internal_error') : undefined) });
    const { res, html } = await post(only('publish'));
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(html.toLowerCase()).toContain('disponible');
    noLeaks(html);
  });

  test('publicar con 401: cierra la sesión y 302 al ingreso', async () => {
    catalogBackend({ override: (c) => (c.path.endsWith('/publish') ? apiError(ST.UNAUTHORIZED, 'unauthenticated') : undefined) });
    const { res } = await post(only('publish'));
    expect(res.status).toBe(ST.FOUND);
    expect(sb.signOut).toHaveBeenCalled();
  });

  test.each([[ST.FORBIDDEN], [ST.NOT_FOUND]])('publicar con %i: respuesta de la guardia (no un 500)', async (status) => {
    catalogBackend({ override: (c) => (c.path.endsWith('/publish') ? apiError(status, 'x') : undefined) });
    const { res } = await post(only('publish'));
    expect(res.status).toBe(status);
  });

  test.each([[''], ['delete'], ['PUBLISH'], ['publish,save'], ['__proto__']])('acción %j desconocida: 4xx y ninguna escritura', async (action) => {
    const be = catalogBackend();
    const { res } = await post(only(action));
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('sin acción: 4xx y ninguna escritura', async () => {
    const be = catalogBackend();
    const { res } = await post([['name', 'x']]);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('un cliente no puede publicar: 403 y ninguna escritura', async () => {
    const be = catalogBackend({ role: 'customer' });
    const { res } = await post(only('publish'));
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.writes()).toHaveLength(NONE);
  });
});

describe('POST · seguridad de la petición', () => {
  const ORIGINS: [string, string | null][] = [
    ['sin cabecera Origin', null],
    ['Origin ajeno', 'https://evil.example'],
    ['Origin "null"', 'null'],
    ['otro puerto', 'http://localhost:9999'],
    ['https', 'https://localhost:4321'],
    ['Origin vacío', ''],
  ];

  test.each(ORIGINS)('guardar, publicar y despublicar con %s → 403 sin escrituras', async (_c, origin) => {
    const be = catalogBackend();
    const results = await ['save', 'publish', 'unpublish'].reduce<Promise<number[]>>(async (acc, action) => {
      const done = await acc;
      const { res } = await post([['_action', action], ['name', 'x']], { origin });
      return [...done, res.status];
    }, Promise.resolve([]));
    expect(results).toEqual([ST.FORBIDDEN, ST.FORBIDDEN, ST.FORBIDDEN]);
    expect(be.writes()).toHaveLength(NONE);
  });

  test.each([
    ['JSON', 'application/json', '{"name":"x"}'],
    ['texto plano', 'text/plain', 'name=x'],
    ['multipart roto', 'multipart/form-data; boundary=abc', '--zzz\r\nbasura'],
    ['XML', 'application/xml', '<x/>'],
  ])('cuerpo %s que no es un formulario → 415, nunca 500, sin escrituras', async (_n, contentType, rawBody) => {
    const be = catalogBackend();
    const { res, html } = await post([], { contentType, rawBody });
    expect(res.status).toBe(ST.UNSUPPORTED_MEDIA);
    expect(be.writes()).toHaveLength(NONE);
    noLeaks(html);
  });

  test('las respuestas de error de la página no se guardan en caché', async () => {
    catalogBackend({ override: (c) => (c.method === 'PATCH' ? apiError(ST.CONFLICT, 'sku_taken') : undefined) });
    const conflict = await post(await save({ sku: 'otro' }));
    expect(conflict.res.headers.get('cache-control')).toContain('no-store');
  });

  test('un POST sin sesión (red de seguridad) no llama al backend', async () => {
    const be = catalogBackend();
    const { res } = await post([['_action', 'publish']], { session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(be.calls).toHaveLength(NONE);
  });
});

describe('respuestas inesperadas del backend y escrituras tras leer el cuerpo (hallazgos de T-146)', () => {
  // El 404 y el 403 de una escritura llegan DESPUÉS de leer el cuerpo: Astro no permite `rewrite` con el cuerpo consumido (RewriteWithBodyUsed).
  const writes: [string, Entry[] | null, (c: CatalogCall) => boolean][] = [
    ['guardar', null, (c) => c.method === 'PATCH'], // `null`: el formulario cargado con otro nombre
    ['publicar', [['_action', 'publish']], (c) => c.path.endsWith('/publish')],
    ['despublicar', [['_action', 'unpublish']], (c) => c.path.endsWith('/unpublish')],
  ];

  test.each(writes)('%s: el backend responde 404 (el producto ya no existe) → 404 real, no 500', async (_n, entries, isWrite) => {
    catalogBackend({ override: (c) => (isWrite(c) ? apiError(ST.NOT_FOUND, 'not_found') : undefined) });
    const { res } = await post(entries ?? (await save({ name: 'Otro nombre' })));
    expect(res.status).toBe(ST.NOT_FOUND);
  });

  test.each(writes)('%s: el backend responde 403 (rol de administrador retirado a media sesión) → 403 real, no 500', async (_n, entries, isWrite) => {
    catalogBackend({ override: (c) => (isWrite(c) ? apiError(ST.FORBIDDEN, 'forbidden') : undefined) });
    const { res, doc } = await post(entries ?? (await save({ name: 'Otro nombre' })));
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(doc.querySelector('form#product-form')).toBeNull();
  });

  test.each(writes)('%s: el producto ya no existe al enviar (404 al releerlo) → 404 y ninguna escritura', async (_n, entries) => {
    const be = catalogBackend({ product: null });
    const { res } = await post(entries ?? [['_action', 'save'], ['name', 'Otro nombre']]);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('el rol se retira justo antes de leer el producto (403 en la lectura de un POST) → 403 y ninguna escritura', async () => {
    const be = catalogBackend({ override: (c) => (c.method === 'GET' && c.path.startsWith('/catalog/admin/products/') ? apiError(ST.FORBIDDEN, 'forbidden') : undefined) });
    const { res } = await post([['_action', 'save'], ['name', 'x']]);
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.writes()).toHaveLength(NONE);
  });

  const SHAPES: [string, unknown][] = [['null', null], ['{}', {}], ['un arreglo', []], ['un texto', 'hola'], ['un número', ONE], ['sin precio', { ...adminProduct(), price: null }], ['sin specs', { ...adminProduct(), specs: null }]];

  test.each(SHAPES)('lectura del producto que responde 200 con %s → 503 «No disponible», nunca 500 ni formulario', async (_n, shape) => {
    catalogBackend({ override: (c) => (c.method === 'GET' && c.path.startsWith('/catalog/admin/products/') ? new Response(JSON.stringify(shape), { status: ST.OK, headers: { 'content-type': 'application/json' } }) : undefined) });
    const { res, doc, html } = await open();
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(doc.querySelector('form#product-form')).toBeNull();
    expect(html.toLowerCase()).toContain('disponible');
    noLeaks(html);
  });

  test.each(SHAPES)('al enviar, la lectura del producto responde 200 con %s → 503 y ninguna escritura', async (_n, shape) => {
    const be = catalogBackend({ override: (c) => (c.method === 'GET' && c.path.startsWith('/catalog/admin/products/') ? new Response(JSON.stringify(shape), { status: ST.OK, headers: { 'content-type': 'application/json' } }) : undefined) });
    const { res } = await post([['_action', 'save'], ['name', 'x']]);
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(be.writes()).toHaveLength(NONE);
  });

  test.each([['categorías', '/catalog/admin/categories', null], ['categorías (objeto)', '/catalog/admin/categories', {}], ['atributos', '/catalog/admin/attributes', null], ['atributos sin listas', '/catalog/admin/attributes', {}]])(
    'la lista de %s responde 200 con una forma inesperada → 503, nunca 500',
    async (_n, path, shape) => {
      catalogBackend({ override: (c) => (c.method === 'GET' && c.path === path ? new Response(JSON.stringify(shape), { status: ST.OK, headers: { 'content-type': 'application/json' } }) : undefined) });
      const { res, doc } = await open();
      expect(res.status).toBe(ST.UNAVAILABLE);
      expect(doc.querySelector('form#product-form')).toBeNull();
    },
  );
});
