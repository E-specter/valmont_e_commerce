import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Nuevo from '../../src/pages/admin/productos/nuevo.astro';
import { MSG_FIELD_INVALID, MSG_FIELD_TOO_LONG, MSG_SKU_TAKEN, MSG_SLUG_TAKEN } from '../../src/lib/admin/messages';
import { BEARER, inSequence } from '../helpers/t129';
import {
  BACKEND_MSG, CATEGORIES, CATEGORY_ID, FORBIDDEN_NAMES, NEW_ID, NO_STORE, apiError, catalogBackend, setEntries, validation, valueOf,
  type CatalogCall, type Entry,
} from '../helpers/t147';
import {
  ST, alertText, describedText, entriesOf, field, formOf, invalid, isRedirect, openPage, specNamesOf, supabaseMock, withSpecs, type Init, type SupabaseMock,
} from '../helpers/t147-pages';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-147 · `GET|POST /admin/productos/nuevo` con la Container API, un `fetch` falso como backend (identity y catalog) y Supabase simulado.
// La guardia del middleware (T-126) no corre aquí: se prueba la página por sí sola y, de extremo a extremo, en el E2E.
const NONE = 0;
const ONE = 1;
const PATH = '/admin/productos/nuevo';
const LEAD = 42;
const WATER = 50;
const CENTS_1250 = 125000;
const CENTS_1250_5 = 125050;
const LEAKS = [BACKEND_MSG, 'Mensaje del servidor en inglés.', 'api.test', 'ECONNREFUSED', BEARER];
const SPECS = [{ label: 'Calibre', value: 'VM-01' }, { label: 'Reserva de marcha', value: '42 h' }];
const HOSTILE = '<script>window.__pwned=1</script><b>x</b>';

let sb: SupabaseMock;
beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (init: Init = {}) => openPage(Nuevo, PATH, sb, init);
const post = (entries: readonly Entry[], init: Init = {}) => open({ method: 'POST', entries, ...init });
/** El formulario recién cargado (lo que el navegador enviaría sin tocar nada) más los obligatorios. */
async function baseEntries(over: Record<string, string> = {}): Promise<Entry[]> {
  const previous = globalThis.fetch; // el backend de la prueba (con sus `override`) se conserva
  catalogBackend();
  const { doc } = await open();
  vi.stubGlobal('fetch', previous);
  return setEntries(entriesOf(doc), { sku: 'QA-T147-N1', name: 'Reloj Nuevo QA', category_id: CATEGORY_ID, price: '1250', ...over });
}
const created = (b: ReturnType<typeof catalogBackend>): CatalogCall => b.posts().find((c) => c.path === '/catalog/admin/products') as CatalogCall;
const noLeaks = (html: string) => LEAKS.forEach((l) => expect(html, l).not.toContain(l));

describe('GET /admin/productos/nuevo', () => {
  test('200: un h1, noindex, no-store, formulario POST vacío y «Crear producto» / «Cancelar» al pie', async () => {
    catalogBackend();
    const { res, doc } = await open();
    expect(res.status).toBe(ST.OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1')).toLowerCase()).toContain('nuevo producto');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(formOf(doc).getAttribute('method')?.toLowerCase()).toBe('post');
    expect((field(doc, 'sku') as HTMLInputElement).getAttribute('value') ?? '').toBe('');
    const names = [...doc.querySelectorAll('button, a')].map((b) => text(b));
    expect(names).toContain('Crear producto');
    expect(names).toContain('Cancelar');
    expect(names).not.toContain('Publicar');
  });

  test('las categorías y atributos salen del backend; el rol y los listados se piden con el Bearer de la sesión', async () => {
    const be = catalogBackend();
    const { doc } = await open();
    const options = [...(field(doc, 'category_id') as Element).querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(expect.arrayContaining(CATEGORIES.map((c) => c.id)));
    expect(be.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(
      ['GET /catalog/admin/attributes', 'GET /catalog/admin/categories', 'GET /identity/me'],
    );
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('ninguna mutación por GET: ni con _action en la URL ni con parámetros que imiten campos', async () => {
    const be = catalogBackend();
    const { doc } = await open({ query: '?_action=publish&sku=HACK&status=published&name=x&creado=1' });
    expect(be.writes()).toHaveLength(NONE);
    expect((field(doc, 'sku') as Element).getAttribute('value') ?? '').toBe('');
  });

  test('sin sesión (red de seguridad): 302 al ingreso y ninguna llamada', async () => {
    const be = catalogBackend();
    const { res } = await open({ session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(PATH)}`);
    expect(be.calls).toHaveLength(NONE);
  });

  test('un cliente (rol ≠ admin): 403 «Sin permiso», sin llamadas a catálogo y sin formulario', async () => {
    const be = catalogBackend({ role: 'customer' });
    const { res, doc, html } = await open();
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.catalog()).toHaveLength(NONE);
    expect(doc.querySelector('form#product-form')).toBeNull();
    expect(html).not.toContain('Crear producto');
  });

  test('/identity/me 401: cierra la sesión local y 302 al ingreso con `next`', async () => {
    catalogBackend({ override: (c) => (c.path === '/identity/me' ? apiError(ST.UNAUTHORIZED, 'unauthenticated') : undefined) });
    const { res } = await open();
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location')).toContain('/ingresar?next=');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test.each([ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE])('/identity/me %i: 503 «no disponible», sin formulario ni trazas', async (status) => {
    catalogBackend({ override: (c) => (c.path === '/identity/me' ? apiError(status, 'internal_error') : undefined) });
    const { res, doc, html } = await open();
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(doc.querySelector('form#product-form')).toBeNull();
    noLeaks(html);
  });

  test.each([[ST.SERVER_ERROR, ST.UNAVAILABLE], [ST.FORBIDDEN, ST.FORBIDDEN]])('listas de categorías con %i: página %i, sin formulario', async (status, expected) => {
    catalogBackend({ override: (c) => (c.path === '/catalog/admin/categories' ? apiError(status, 'x') : undefined) });
    const { res, doc } = await open();
    expect(res.status).toBe(expected);
    expect(doc.querySelector('form#product-form')).toBeNull();
  });
});

describe('POST /admin/productos/nuevo · crear', () => {
  test('con todos los campos: un solo POST /catalog/admin/products con el cuerpo exacto y 303 a /admin/productos/{id}?creado=1 (no-store)', async () => {
    const be = catalogBackend();
    const { doc } = await open();
    const specNames = specNamesOf(doc);
    const entries = withSpecs(
      setEntries(entriesOf(doc), {
        sku: 'QA-T147-FULL', slug: 'qa-t147-full', name: 'Reloj Completo QA', description: 'Descripción\ncon salto', category_id: CATEGORY_ID, price: '1250.50',
        order_policy: 'made_to_order', lead_time_days: String(LEAD), movement_code: 'automatic', case_material_code: 'steel', case_diameter_mm: '38.5',
        water_resistance_m: String(WATER),
      }),
      SPECS,
      specNames,
    );
    const { res } = await post(entries);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('location')).toBe(`/admin/productos/${NEW_ID}?creado=1`);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.writes()).toHaveLength(ONE);
    const call = created(be);
    expect(call.method).toBe('POST');
    expect(call.auth).toBe(`Bearer ${BEARER}`);
    expect(call.body).toEqual({
      sku: 'QA-T147-FULL', slug: 'qa-t147-full', name: 'Reloj Completo QA', description: 'Descripción\ncon salto', category_id: CATEGORY_ID,
      price: { amount: CENTS_1250_5, currency: 'PEN' }, order_policy: 'made_to_order', lead_time_days: LEAD, movement_code: 'automatic',
      case_material_code: 'steel', case_diameter_mm: '38.5', water_resistance_m: WATER, specs: SPECS,
    });
  });

  test('solo obligatorios: los opcionales vacíos no viajan como "" ni NaN y las filas vacías del editor no son especificaciones', async () => {
    const be = catalogBackend();
    const { res } = await post(await baseEntries());
    expect(res.status).toBe(ST.SEE_OTHER);
    const body = created(be).body as Record<string, unknown>;
    expect(body).toMatchObject({ sku: 'QA-T147-N1', name: 'Reloj Nuevo QA', category_id: CATEGORY_ID, price: { amount: CENTS_1250, currency: 'PEN' }, specs: [] });
    ['slug', 'lead_time_days', 'movement_code', 'case_material_code', 'case_diameter_mm', 'water_resistance_m'].forEach((k) => expect([undefined, null], k).toContain(body[k]));
    expect(created(be).raw).not.toContain('NaN');
  });

  test.each([['1250', CENTS_1250], ['1250.5', CENTS_1250_5], ['1250.50', CENTS_1250_5]])('precio "%s" → amount entero %i', async (price, cents) => {
    const be = catalogBackend();
    const { res } = await post(await baseEntries({ price }));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect((created(be).body as { price: unknown }).price).toEqual({ amount: cents, currency: 'PEN' });
  });

  test.each([['1.250,50'], [''], ['0'], ['abc'], ['-5']])('precio %j: 422 en el campo, sin llamada de alta y con lo escrito conservado', async (price) => {
    const be = catalogBackend();
    const entries = await baseEntries({ price, name: 'Conservado QA' });
    be.calls.length = NONE;
    const { res, doc } = await post(entries);
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.posts()).toHaveLength(NONE);
    expect(invalid(doc, 'price')).toBe(true);
    expect(describedText(doc, field(doc, 'price')).length).toBeGreaterThan(NONE);
    expect((field(doc, 'name') as Element).getAttribute('value')).toBe('Conservado QA');
    expect((field(doc, 'sku') as Element).getAttribute('value')).toBe('QA-T147-N1');
    expect(alertText(doc).length).toBeGreaterThan(NONE);
  });

  test.each([['sku'], ['name'], ['category_id']])('falta el obligatorio "%s": 422 en ese campo y ninguna llamada de alta', async (name) => {
    const be = catalogBackend();
    const entries = await baseEntries({ [name]: '' });
    be.calls.length = NONE;
    const { res, doc } = await post(entries);
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.posts()).toHaveLength(NONE);
    expect(invalid(doc, name)).toBe(true);
  });

  test('un campo en blanco (solo espacios) no vale como relleno', async () => {
    const be = catalogBackend();
    const entries = await baseEntries({ name: '    ' });
    be.calls.length = NONE;
    const { res } = await post(entries);
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(be.posts()).toHaveLength(NONE);
  });

  test('campos extra (status, id, published_at, images, user_id, role…) y un cuerpo con claves ajenas se ignoran', async () => {
    const be = catalogBackend();
    const extra: Entry[] = FORBIDDEN_NAMES.map((n): Entry => [n, 'published']);
    const { res } = await post([...(await baseEntries()), ...extra, ['__proto__', 'x'], ['constructor', 'x']]);
    expect(res.status).toBe(ST.SEE_OTHER);
    const keys = Object.keys(created(be).body as object);
    FORBIDDEN_NAMES.forEach((n) => expect(keys, n).not.toContain(n));
    expect(keys.sort()).toEqual(expect.arrayContaining(['sku', 'name', 'category_id', 'price', 'order_policy', 'specs']));
    expect(created(be).raw).not.toContain('published');
  });

  test('la identidad no sale del formulario: ni user_id ni rol viajan al backend', async () => {
    const be = catalogBackend();
    await post([...(await baseEntries()), ['user_id', 'otro-usuario'], ['role', 'admin']]);
    expect(created(be).raw).not.toContain('otro-usuario');
    expect(be.calls.every((c) => c.auth === `Bearer ${BEARER}`)).toBe(true);
  });

  test('409 sku_taken: estado 409, error bajo el campo SKU con el texto en español y lo escrito conservado', async () => {
    const be = catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.CONFLICT, 'sku_taken') : undefined) });
    const { res, doc, html } = await post(await baseEntries({ name: 'Conservado QA', description: 'Texto largo\ncon salto' }));
    expect(res.status).toBe(ST.CONFLICT);
    expect(invalid(doc, 'sku')).toBe(true);
    expect(describedText(doc, field(doc, 'sku'))).toContain(MSG_SKU_TAKEN);
    expect(invalid(doc, 'name')).toBe(false);
    const kept = entriesOf(doc);
    expect(valueOf(kept, 'name')).toBe('Conservado QA');
    expect(valueOf(kept, 'description')).toBe('Texto largo\ncon salto');
    expect(valueOf(kept, 'price')).toBe('1250');
    expect(valueOf(kept, 'category_id')).toBe(CATEGORY_ID);
    noLeaks(html);
    expect(be.posts()).toHaveLength(ONE);
  });

  test('409 slug_taken: error bajo el campo del slug', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.CONFLICT, 'slug_taken') : undefined) });
    const { res, doc } = await post(await baseEntries({ slug: 'ya-existe' }));
    expect(res.status).toBe(ST.CONFLICT);
    expect(invalid(doc, 'slug')).toBe(true);
    expect(describedText(doc, field(doc, 'slug'))).toContain(MSG_SLUG_TAKEN);
    expect(valueOf(entriesOf(doc), 'slug')).toBe('ya-existe');
  });

  test('413: estado 413 y mensaje de formulario (role="alert"), sin perder lo escrito', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.PAYLOAD_TOO_LARGE, 'file_too_large') : undefined) });
    const { res, doc, html } = await post(await baseEntries({ name: 'Conservado QA' }));
    expect(res.status).toBe(ST.PAYLOAD_TOO_LARGE);
    expect(alertText(doc).length).toBeGreaterThan(NONE);
    expect(valueOf(entriesOf(doc), 'name')).toBe('Conservado QA');
    noLeaks(html);
  });

  test('422 del backend por campo: estado 422, un error por campo en español, lo escrito conservado y el `msg` del backend nunca se muestra', async () => {
    catalogBackend({
      override: (c) =>
        c.method === 'POST' && c.path === '/catalog/admin/products'
          ? validation(
              { loc: ['body', 'name'], type: 'string_too_long' },
              { loc: ['body', 'description'], type: 'string_too_long' },
              { loc: ['body', 'lead_time_days'], type: 'int_parsing' },
              { loc: ['body', 'case_diameter_mm'], type: 'decimal_max_places' },
              { loc: ['body', 'water_resistance_m'], type: 'greater_than_equal' },
            )
          : undefined,
    });
    const { res, doc, html } = await post(await baseEntries({ name: 'Nombre conservado', lead_time_days: '4', case_diameter_mm: '38.5' }));
    expect(res.status).toBe(ST.UNPROCESSABLE);
    const messages = (name: string) => describedText(doc, field(doc, name));
    expect(messages('name')).toContain(MSG_FIELD_TOO_LONG);
    expect(messages('description')).toContain(MSG_FIELD_TOO_LONG);
    ['lead_time_days', 'case_diameter_mm', 'water_resistance_m'].forEach((n) => expect(messages(n), n).toContain(MSG_FIELD_INVALID));
    ['name', 'description', 'lead_time_days', 'case_diameter_mm', 'water_resistance_m'].forEach((n) => expect(invalid(doc, n), n).toBe(true));
    expect(invalid(doc, 'sku')).toBe(false);
    expect(valueOf(entriesOf(doc), 'name')).toBe('Nombre conservado');
    expect(valueOf(entriesOf(doc), 'lead_time_days')).toBe('4');
    noLeaks(html);
    expect(alertText(doc).length).toBeGreaterThan(NONE);
  });

  test('422 del importe (loc body.price.amount) cae en el campo Precio', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? validation({ loc: ['body', 'price', 'amount'], type: 'greater_than' }) : undefined) });
    const { res, doc } = await post(await baseEntries());
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(doc, 'price')).toBe(true);
  });

  test('422 con una ubicación desconocida o sin detalles: sigue siendo un 422 con mensaje de formulario, nunca un 500', async () => {
    await inSequence([validation({ loc: ['body', 'campo_nuevo'], type: 'x' }), apiError(ST.UNPROCESSABLE, 'validation_error', null)], async (reply) => {
      catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? reply : undefined) });
      const { res, doc, html } = await post(await baseEntries());
      expect(res.status).toBe(ST.UNPROCESSABLE);
      expect(alertText(doc).length).toBeGreaterThan(NONE);
      noLeaks(html);
    });
  });

  test.each([ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE])('el alta responde %i: 503 con «no disponible» en el formulario, lo escrito conservado y sin trazas', async (status) => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(status, 'internal_error') : undefined) });
    const { res, doc, html } = await post(await baseEntries({ name: 'Conservado QA' }));
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(alertText(doc).toLowerCase()).toContain('disponible');
    expect(valueOf(entriesOf(doc), 'name')).toBe('Conservado QA');
    noLeaks(html);
  });

  test('fallo de red al crear: 503 y mensaje, no un 500', async () => {
    catalogBackend({
      override: (c) => {
        if (c.method === 'POST' && c.path === '/catalog/admin/products') throw new TypeError('fetch failed');
        return undefined;
      },
    });
    const { res, doc, html } = await post(await baseEntries());
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(alertText(doc).length).toBeGreaterThan(NONE);
    noLeaks(html);
  });

  test('401 al crear: cierra la sesión local y 302 al ingreso', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.UNAUTHORIZED, 'unauthenticated') : undefined) });
    const { res } = await post(await baseEntries());
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location')).toContain('/ingresar?next=');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test('403 al crear (rol retirado a media sesión): 403 «Sin permiso»', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.FORBIDDEN, 'forbidden') : undefined) });
    const { res, doc } = await post(await baseEntries());
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(doc.querySelector('form#product-form')).toBeNull();
  });

  test('un cliente que envía el formulario: 403 y ninguna llamada de alta', async () => {
    const be = catalogBackend({ role: 'customer' });
    const entries = await baseEntries();
    be.calls.length = NONE;
    const { res } = await post(entries);
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('valores hostiles: se conservan como texto al reabrir el formulario con un error', async () => {
    catalogBackend({ override: (c) => (c.method === 'POST' && c.path === '/catalog/admin/products' ? apiError(ST.CONFLICT, 'sku_taken') : undefined) });
    const { doc } = await post(await baseEntries({ name: HOSTILE, description: `</textarea>${HOSTILE}` }));
    expect(doc.querySelectorAll('script:not([src]), b')).toHaveLength(NONE);
    expect(valueOf(entriesOf(doc), 'name')).toBe(HOSTILE);
  });
});

describe('POST /admin/productos/nuevo · seguridad de la petición', () => {
  const ORIGINS: [string, string | null][] = [
    ['sin cabecera Origin', null],
    ['Origin ajeno', 'https://evil.example'],
    ['Origin "null"', 'null'],
    ['mismo host en otro puerto', 'http://localhost:9999'],
    ['mismo host en https', 'https://localhost:4321'],
    ['Origin con ruta', 'http://localhost:4321/admin'],
    ['Origin vacío', ''],
  ];

  test.each(ORIGINS)('%s → 403 sin llamadas de escritura ni del servidor', async (_c, origin) => {
    const be = catalogBackend();
    const entries = await baseEntries();
    be.calls.length = NONE;
    const { res, html } = await post(entries, { origin });
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.writes()).toHaveLength(NONE);
    expect(html).not.toContain('Reloj Nuevo QA');
    noLeaks(html);
  });

  test('con el Origin del propio sitio sí se procesa', async () => {
    const be = catalogBackend();
    const { res } = await post(await baseEntries(), { origin: 'http://localhost:4321' });
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.posts()).toHaveLength(ONE);
  });

  test.each([
    ['JSON', 'application/json', '{"sku":"QA-T147-J","name":"x"}'],
    ['texto plano', 'text/plain', 'sku=QA-T147-J'],
    ['multipart sin límite', 'multipart/form-data', 'sku=QA-T147-J'],
    ['multipart roto', 'multipart/form-data; boundary=abc', '--zzz\r\nbasura'],
    ['XML', 'application/xml', '<x/>'],
  ])('cuerpo %s que no es un formulario → 415, nunca 500, sin escritura', async (_n, contentType, rawBody) => {
    const be = catalogBackend();
    const { res, html } = await post([], { contentType, rawBody });
    expect(res.status).toBe(ST.UNSUPPORTED_MEDIA);
    expect(be.writes()).toHaveLength(NONE);
    noLeaks(html);
  });

  test('la respuesta de error de seguridad no se guarda en caché', async () => {
    catalogBackend();
    const forbidden = await post([], { origin: null });
    const unsupported = await post([], { contentType: 'application/json', rawBody: '{}' });
    [forbidden.res, unsupported.res].forEach((r) => expect(r.headers.get('cache-control') ?? NO_STORE).toContain('no-store'));
  });

  test('la redirección tras crear no se guarda en caché y apunta a una ruta interna', async () => {
    catalogBackend();
    const { res } = await post(await baseEntries());
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect((res.headers.get('location') ?? '').startsWith('/admin/productos/')).toBe(true);
    expect(res.headers.get('location')).not.toContain('//');
  });

  test('un POST sin sesión (red de seguridad) no llama al backend', async () => {
    const be = catalogBackend();
    const { res } = await post(await baseEntries(), { session: null });
    expect(res.status).toBe(ST.FOUND);
    expect(be.writes()).toHaveLength(NONE);
  });
});
