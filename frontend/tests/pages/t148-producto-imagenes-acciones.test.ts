import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Editar from '../../src/pages/admin/productos/[product_id].astro';
import Nuevo from '../../src/pages/admin/productos/nuevo.astro';
import {
  FOREIGN_IMG, HOME, HOSTILE_ALT, IMAGES, IMG_A, IMG_B, IMG_C, IMG_D, NO_STORE, PRODUCT_ID, ST, actionEntries, actionOf, entriesFor, errorOf, formsFor, idsOf, imageForms,
  imageOf, imagesBackend, moveEntries, noLeaks, openProduct, submitterOf, uploadBody, withImages, type PageInit,
} from '../helpers/t148';
import { MSG_LAST_IMAGE } from '../../src/lib/admin/messages';
import { asFile, pngBytes } from '../helpers/t148-files';
import { RE_BACKEND_ENGLISH, RE_RETRY } from '../helpers/t148-re';
import { catalogBackend, serialize, setEntries, valueOf, type Entry } from '../helpers/t147';
import { COOKIE, entriesOf, openPage, supabaseMock, withAction, type SupabaseMock } from '../helpers/t147-pages';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-148 · acciones de imagen de `POST /admin/productos/[product_id]`: `image-alt`, `image-move`, `image-order`, `image-delete`, más la seguridad común
// (Origin, cuerpo, ids, rol) y la regresión de T-147. Los nombres de los campos se leen del marcado; el backend es simulado con las reglas del contrato.
const NONE = 0;
const HUGE = 100_000;
const LONG_ID = 1000;
const ONE = 1;
const ALT_MAX = 150;
const FIRST = 0;
const LAST_2 = 2;
const FOREIGN_PRODUCT = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ALL_IDS = [IMG_A, IMG_B, IMG_C];

let sb: SupabaseMock;
beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Be = ReturnType<typeof imagesBackend>;
const open = (init: PageInit = {}, id: string = PRODUCT_ID) => openProduct(Editar, sb, init, id);
async function loaded(be: Be): Promise<Document> {
  const { doc } = await open();
  be.calls.splice(NONE);
  return doc;
}
const postEntries = (entries: readonly Entry[], init: PageInit = {}) => open({ method: 'POST', entries, ...init });
const textFieldOf = (form: Element): string => form.querySelector('input[type="text"]')?.getAttribute('name') ?? 'alt';
/** Entradas del formulario `image-alt` de una imagen con el texto cambiado. */
function altEntries(doc: Document, id: string, alt: string): Entry[] {
  const form = formsFor(doc, 'image-alt', id)[FIRST];
  const field = textFieldOf(form);
  return entriesFor(form, submitterOf(form) ?? undefined).map(([k, v]): Entry => (k === field ? [k, alt] : [k, v]));
}
/** Entradas del formulario `image-order` con otra lista de ids (cadena separada por comas, como la escribe la isla). */
function orderEntries(doc: Document, ids: readonly string[], raw?: string): Entry[] {
  const form = imageForms(doc).find((f) => actionOf(f) === 'image-order') as HTMLFormElement;
  const field = serialize(form).find(([k]) => k !== '_action')?.[FIRST] ?? 'ids';
  return [['_action', 'image-order'], [field, raw ?? ids.join(',')]];
}
const moveOf = (doc: Document, id: string, word: 'subir' | 'bajar') => moveEntries(doc, id, word);
const putBody = (be: Be): unknown => be.puts()[FIRST]?.json;
const noBackendWrite = (be: Be): void => expect(be.writes()).toHaveLength(NONE);
const thumbs = (doc: Document): (string | null)[] => [...doc.querySelectorAll('ol img, ul img')].map((i) => i.getAttribute('src'));

describe('GET con imágenes', () => {
  test('200: la lista sale del producto, en orden, con la primera como principal; solo lecturas al backend (sin llamadas de imágenes)', async () => {
    const be = imagesBackend();
    const { res, doc } = await open();
    expect(res.status).toBe(ST.OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
    expect(be.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(be.calls.map((c) => c.path).sort()).toEqual(
      ['/catalog/admin/attributes', '/catalog/admin/categories', `/catalog/admin/products/${PRODUCT_ID}`, '/identity/me'].sort(),
    );
    expect(text(doc.body)).toContain('Principal');
  });

  test.each([
    ['images ausente', (p: Record<string, unknown>) => ({ ...p, images: undefined })],
    ['images null', (p: Record<string, unknown>) => ({ ...p, images: null })],
    ['images es una cadena', (p: Record<string, unknown>) => ({ ...p, images: 'x' })],
    ['images es un objeto', (p: Record<string, unknown>) => ({ ...p, images: { 0: IMAGES[FIRST] } })],
    ['un elemento null', (p: Record<string, unknown>) => ({ ...p, images: [null] })],
    ['un elemento sin url', (p: Record<string, unknown>) => ({ ...p, images: [{ id: IMG_A, alt: 'x' }] })],
    ['un elemento sin alt', (p: Record<string, unknown>) => ({ ...p, images: [{ id: IMG_A, url: 'http://s/x.webp' }] })],
    ['un id que no es texto', (p: Record<string, unknown>) => ({ ...p, images: [{ id: ONE, url: 'http://s/x.webp', alt: 'x' }] })],
  ])('forma inesperada (%s) → 503, nunca 500, sin filtrar nada', async (_n, mutate) => {
    imagesBackend({ product: mutate(withImages(IMAGES.map((i) => ({ ...i }))) as unknown as Record<string, unknown>) as never });
    const { res, html } = await open();
    expect(res.status).toBe(ST.UNAVAILABLE);
    noLeaks(html);
  });

  test('el texto del servidor (alt) se pinta como texto', async () => {
    imagesBackend({ product: withImages([imageOf(IMG_A, 'a', HOSTILE_ALT)]) });
    const { doc } = await open();
    expect([...doc.querySelectorAll('script')].map((s) => s.textContent).join('')).not.toContain('__pwned');
    expect(doc.querySelectorAll('[onerror]')).toHaveLength(NONE);
  });

  test('un cliente (rol customer) → 403 sin pintar las imágenes ni llamar a catálogo', async () => {
    const be = imagesBackend({ role: 'customer' });
    const { res, html } = await open();
    expect(res.status).toBe(ST.FORBIDDEN);
    expect(be.catalog()).toHaveLength(NONE);
    expect(html).not.toContain(IMAGES[FIRST].url);
  });

  test('el product_id que no es UUID → 404 sin ninguna llamada al backend', async () => {
    const be = imagesBackend();
    const { res } = await open({}, 'no-es-un-uuid');
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.calls).toHaveLength(NONE);
  });
});

describe('image-alt', () => {
  test('PATCH …/images/{id} con exactamente { alt } y 303; la lista nueva trae el texto', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res } = await postEntries(altEntries(doc, IMG_B, 'Perfil izquierdo del reloj'));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('location')?.startsWith(HOME)).toBe(true);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const patches = be.imageWrites();
    expect(patches).toHaveLength(ONE);
    expect(patches[FIRST]).toMatchObject({ method: 'PATCH', path: `/catalog/admin/products/${PRODUCT_ID}/images/${IMG_B}`, json: { alt: 'Perfil izquierdo del reloj' } });
    expect(Object.keys(patches[FIRST].json as object)).toEqual(['alt']);
    expect(patches[FIRST].auth?.startsWith('Bearer ')).toBe(true);
    const { doc: after } = await open();
    expect([...after.querySelectorAll('input[type="text"]')].map((i) => i.getAttribute('value'))).toContain('Perfil izquierdo del reloj');
  });

  test('el alt se recorta; con tildes y ñ queda tal cual', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    await postEntries(altEntries(doc, IMG_A, '  Esfera áurea ñ  '));
    expect(be.imageWrites()[FIRST].json).toEqual({ alt: 'Esfera áurea ñ' });
  });

  test('el alt hostil viaja como texto y no se altera', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const alt = HOSTILE_ALT.slice(NONE, ALT_MAX);
    const { res } = await postEntries(altEntries(doc, IMG_A, alt));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.imageWrites()[FIRST].json).toEqual({ alt });
  });

  test.each([['vacío', ''], ['solo espacios', '   '], ['151 caracteres', 'a'.repeat(ALT_MAX + ONE)]])(
    'alt %s → 422 en el campo de ESA imagen y en ninguna otra; sin 5xx',
    async (_n, alt) => {
      const be = imagesBackend();
      const doc = await loaded(be);
      const { res, doc: after, html } = await postEntries(altEntries(doc, IMG_B, alt));
      expect(res.status).toBe(ST.UNPROCESSABLE);
      expect(res.headers.get('cache-control')).toBe(NO_STORE);
      const own = (id: string) => formsFor(after, 'image-alt', id)[FIRST].querySelector('input[type="text"]');
      expect(own(IMG_B)?.getAttribute('aria-invalid')).toBe('true');
      expect(own(IMG_A)?.getAttribute('aria-invalid')).not.toBe('true');
      expect(own(IMG_C)?.getAttribute('aria-invalid')).not.toBe('true');
      expect(be.currentIds()).toEqual(ALL_IDS);
      noLeaks(html);
      expect(html).not.toMatch(RE_BACKEND_ENGLISH);
    },
  );

  test('422 del backend → 422 en el campo de esa imagen, con el texto en español', async () => {
    const be = imagesBackend({
      override: (c) => (c.method === 'PATCH' ? errorOf(ST.UNPROCESSABLE, 'validation_error', [{ loc: ['body', 'alt'], type: 'string_too_long', msg: 'MSG-DEL-BACKEND-QX' }]) : undefined),
    });
    const doc = await loaded(be);
    const { res, doc: after, html } = await postEntries(altEntries(doc, IMG_C, 'texto'));
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(formsFor(after, 'image-alt', IMG_C)[FIRST].querySelector('input[type="text"]')?.getAttribute('aria-invalid')).toBe('true');
    noLeaks(html);
  });

  test('una imagen que ya no existe (404 del backend) → 404; una de otro producto (UUID ajeno) también', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = altEntries(doc, IMG_A, 'x').map(([k, v]): Entry => (v === IMG_A ? [k, FOREIGN_IMG] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.currentIds()).toEqual(ALL_IDS);
  });

  test('el id de la URL manda: un `product_id` o `image_url` extra del formulario no cambia ni la ruta ni el cuerpo', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    await postEntries([...altEntries(doc, IMG_A, 'texto'), ['product_id', FOREIGN_PRODUCT], ['user_id', 'otro'], ['url', 'http://evil.test/x.webp'], ['role', 'admin']]);
    const call = be.imageWrites()[FIRST];
    expect(call.path).toBe(`/catalog/admin/products/${PRODUCT_ID}/images/${IMG_A}`);
    expect(call.json).toEqual({ alt: 'texto' });
  });
});

describe('image-move (botones «Subir» y «Bajar»)', () => {
  const table: [string, string, 'subir' | 'bajar', string[] | null][] = [
    ['la primera, Subir', IMG_A, 'subir', null],
    ['la primera, Bajar', IMG_A, 'bajar', [IMG_B, IMG_A, IMG_C]],
    ['la del medio, Subir', IMG_B, 'subir', [IMG_B, IMG_A, IMG_C]],
    ['la del medio, Bajar', IMG_B, 'bajar', [IMG_A, IMG_C, IMG_B]],
    ['la última, Subir', IMG_C, 'subir', [IMG_A, IMG_C, IMG_B]],
    ['la última, Bajar', IMG_C, 'bajar', null],
  ];

  test.each(table)('%s → un PUT …/images/order con el arreglo completo en el nuevo orden (o nada en los extremos), y 303', async (_n, id, word, expected) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res } = await postEntries(moveOf(doc, id, word));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    if (expected) {
      expect(be.puts()).toHaveLength(ONE);
      expect(be.puts()[FIRST].path).toBe(`/catalog/admin/products/${PRODUCT_ID}/images/order`);
      expect(putBody(be)).toEqual(expected);
      expect(be.currentIds()).toEqual(expected);
    } else {
      // En los extremos no hay nada que mover: o no hay PUT o es el mismo orden.
      be.puts().forEach((p) => expect(p.json).toEqual(ALL_IDS));
      expect(be.currentIds()).toEqual(ALL_IDS);
    }
    expect(be.imageWrites().filter((c) => c.method !== 'PUT')).toHaveLength(NONE);
  });

  test('el PUT lleva exactamente el conjunto de ids (sin repetidos ni ajenos) como arreglo JSON de cadenas', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    await postEntries(moveOf(doc, IMG_B, 'subir'));
    const body = putBody(be) as string[];
    expect(Array.isArray(body)).toBe(true);
    expect([...body].sort()).toEqual([...ALL_IDS].sort());
    expect(new Set(body).size).toBe(ALL_IDS.length);
    expect(be.puts()[FIRST].headers.get('content-type')).toBe('application/json');
  });

  test('el servidor calcula el orden sobre el estado actual, no sobre el que vio el navegador (otro administrador movió antes)', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    be.state.product = withImages([IMAGES[LAST_2], IMAGES[FIRST], IMAGES[ONE]].map((i) => ({ ...i }))); // ahora [C, A, B]
    await postEntries(moveOf(doc, IMG_A, 'bajar'));
    expect(putBody(be)).toEqual([IMG_C, IMG_B, IMG_A]);
  });

  test('una imagen que ya no está en el producto → 4xx sin PUT y sin 500', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    be.state.product = withImages([IMAGES[FIRST], IMAGES[ONE]].map((i) => ({ ...i }))); // se borró C
    const { res } = await postEntries(moveOf(doc, IMG_C, 'subir'));
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
  });

  test.each([['arriba'], ['up '], ['UP'], ['../'], [''], ['1'], ['subir; DROP TABLE']])('dirección inválida (%j) → 4xx y sin PUT', async (dir) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = moveOf(doc, IMG_B, 'subir');
    const dirName = entries.find(([k, v]) => k !== '_action' && v !== IMG_B)?.[FIRST] ?? 'direction';
    const { res } = await postEntries(setEntries(entries, { [dirName]: dir }));
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
  });

  test('sin dirección → 4xx y sin PUT', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = moveOf(doc, IMG_B, 'subir').filter(([k, v]) => k === '_action' || v === IMG_B);
    const { res } = await postEntries(entries);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
  });

  test('el backend rechaza el PUT (422) → 422 con aviso, sin filtrar su msg; 404 → 404; 5xx → 503', async () => {
    const cases: [Response, number][] = [
      [errorOf(ST.UNPROCESSABLE, 'validation_error', [{ loc: ['body'], type: 'value_error', msg: 'MSG-DEL-BACKEND-QX' }]), ST.UNPROCESSABLE],
      [errorOf(ST.NOT_FOUND, 'not_found'), ST.NOT_FOUND],
      [errorOf(ST.SERVER_ERROR, 'internal_error'), ST.UNAVAILABLE],
      [new Response('<html>Bad Gateway</html>', { status: ST.BAD_GATEWAY }), ST.UNAVAILABLE],
    ];
    await cases.reduce<Promise<void>>(async (prev, [response, status]) => {
      await prev;
      vi.unstubAllGlobals();
      const be = imagesBackend({ override: (c) => (c.method === 'PUT' ? response.clone() : undefined) });
      const doc = await loaded(be);
      const { res, html } = await postEntries(moveOf(doc, IMG_B, 'subir'));
      expect(res.status, String(status)).toBe(status);
      noLeaks(html);
    }, Promise.resolve());
  });
});

describe('image-order (arrastrar y soltar)', () => {
  test('una permutación válida → un PUT con ese arreglo exacto y 303', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res } = await postEntries(orderEntries(doc, [IMG_C, IMG_A, IMG_B]));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.puts()).toHaveLength(ONE);
    expect(be.puts()[FIRST].path).toBe(`/catalog/admin/products/${PRODUCT_ID}/images/order`);
    expect(putBody(be)).toEqual([IMG_C, IMG_A, IMG_B]);
    expect(be.currentIds()).toEqual([IMG_C, IMG_A, IMG_B]);
  });

  test('con los botones y con arrastrar y soltar se produce el mismo PUT (misma ruta, mismo cuerpo)', async () => {
    const viaButton = imagesBackend();
    const doc1 = await loaded(viaButton);
    await postEntries(moveOf(doc1, IMG_B, 'subir'));
    const buttonCall = viaButton.puts()[FIRST];
    vi.unstubAllGlobals();
    const viaDrag = imagesBackend();
    const doc2 = await loaded(viaDrag);
    await postEntries(orderEntries(doc2, [IMG_B, IMG_A, IMG_C]));
    const dragCall = viaDrag.puts()[FIRST];
    expect([dragCall.method, dragCall.path, dragCall.json]).toEqual([buttonCall.method, buttonCall.path, buttonCall.json]);
  });

  test('el mismo orden que el actual no cambia nada: 303 y el orden no varía', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res } = await postEntries(orderEntries(doc, ALL_IDS));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.currentIds()).toEqual(ALL_IDS);
    be.puts().forEach((p) => expect(p.json).toEqual(ALL_IDS));
  });

  test.each([
    ['falta un id', [IMG_A, IMG_B]],
    ['sobra un id ajeno', [IMG_A, IMG_B, IMG_C, FOREIGN_IMG]],
    ['un id ajeno en lugar de uno propio', [IMG_A, IMG_B, FOREIGN_IMG]],
    ['un id repetido', [IMG_A, IMG_A, IMG_B]],
    ['un id que no es UUID', [IMG_A, IMG_B, 'tres']],
    ['con espacios', [` ${IMG_A}`, IMG_B, IMG_C]],
    ['una lista vacía', []],
  ])('%s → 4xx, sin PUT y el orden no cambia', async (_n, ids) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res, html } = await postEntries(orderEntries(doc, ids));
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
    expect(be.currentIds()).toEqual(ALL_IDS);
    noLeaks(html);
  });

  test.each([['JSON', JSON.stringify(ALL_IDS)], ['con punto y coma', ALL_IDS.join(';')], ['con saltos de línea', ALL_IDS.join('\n')], ['una cadena enorme', 'a,'.repeat(HUGE)]])(
    'el campo ids con formato inesperado (%s) → 4xx o el orden correcto, nunca 5xx',
    async (_n, raw) => {
      const be = imagesBackend();
      const doc = await loaded(be);
      const { res } = await postEntries(orderEntries(doc, ALL_IDS, raw));
      expect(res.status).toBeLessThan(ST.SERVER_ERROR);
      expect(be.currentIds().sort()).toEqual([...ALL_IDS].sort());
    },
  );

  test('sin el campo ids → 4xx y sin PUT', async () => {
    const be = imagesBackend();
    await loaded(be);
    const { res } = await postEntries([['_action', 'image-order']]);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
  });

  test('si el conjunto de imágenes cambió desde que se pintó (se subió o borró otra) el envío no pisa lo nuevo', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    be.state.product = withImages([...IMAGES, imageOf(IMG_D, 'd')].map((i) => ({ ...i }))); // otra pestaña subió D
    const { res } = await postEntries(orderEntries(doc, [IMG_C, IMG_B, IMG_A]));
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.currentIds()).toEqual([IMG_A, IMG_B, IMG_C, IMG_D]);
  });

  test('un 422 o un 404 del backend en el PUT → 422/404, nunca 500', async () => {
    const be = imagesBackend({ override: (c) => (c.method === 'PUT' ? errorOf(ST.NOT_FOUND, 'not_found') : undefined) });
    const doc = await loaded(be);
    const { res } = await postEntries(orderEntries(doc, [IMG_C, IMG_B, IMG_A]));
    expect(res.status).toBe(ST.NOT_FOUND);
  });
});

describe('image-delete', () => {
  test('DELETE …/images/{id} y 303; la imagen desaparece de la lista', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const { res } = await postEntries(actionEntries(doc, 'image-delete', IMG_B));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.imageWrites()).toHaveLength(ONE);
    expect(be.imageWrites()[FIRST]).toMatchObject({ method: 'DELETE', path: `/catalog/admin/products/${PRODUCT_ID}/images/${IMG_B}` });
    const { doc: after } = await open();
    expect(thumbs(after)).toEqual([IMAGES[FIRST].url, IMAGES[LAST_2].url]);
  });

  test('borrar la primera hace principal a la siguiente', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    await postEntries(actionEntries(doc, 'image-delete', IMG_A));
    const { doc: after } = await open();
    expect(thumbs(after)[FIRST]).toBe(IMAGES[ONE].url);
    expect(text(after.body)).toContain('Principal');
  });

  test('la última imagen de un producto publicado → 409 last_image con «Un producto publicado necesita al menos una imagen» y la imagen sigue', async () => {
    const only = [IMAGES[FIRST]];
    const be = imagesBackend({ product: withImages(only.map((i) => ({ ...i })), { status: 'published' }) });
    const doc = await loaded(be);
    const { res, doc: after, html } = await postEntries(actionEntries(doc, 'image-delete', IMG_A));
    expect(res.status).toBe(ST.CONFLICT);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(text(after.body)).toContain(MSG_LAST_IMAGE);
    expect(text(after.body)).toContain('Un producto publicado necesita al menos una imagen');
    expect([...after.querySelectorAll('[role="alert"]')].some((a) => text(a).includes('Un producto publicado necesita'))).toBe(true);
    expect(thumbs(after)).toEqual([IMAGES[FIRST].url]);
    expect(be.currentIds()).toEqual([IMG_A]);
    noLeaks(html);
  });

  test('borrar otra imagen de un producto publicado (queda más de una) → 303', async () => {
    const be = imagesBackend({ product: withImages(IMAGES.map((i) => ({ ...i })), { status: 'published' }) });
    const doc = await loaded(be);
    const { res } = await postEntries(actionEntries(doc, 'image-delete', IMG_C));
    expect(res.status).toBe(ST.SEE_OTHER);
  });

  test('un borrador sí puede quedarse sin imágenes (204 y 303)', async () => {
    const be = imagesBackend({ product: withImages([IMAGES[FIRST]].map((i) => ({ ...i }))) });
    const doc = await loaded(be);
    const { res } = await postEntries(actionEntries(doc, 'image-delete', IMG_A));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.currentIds()).toEqual([]);
  });

  test('una imagen ajena o ya borrada → 404 (el backend decide) y no se toca nada más', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = actionEntries(doc, 'image-delete', IMG_A).map(([k, v]): Entry => (v === IMG_A ? [k, FOREIGN_IMG] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.currentIds()).toEqual(ALL_IDS);
  });

  test('un `product_id` o `image_id` extra no desvía el borrado: la ruta usa el producto de la URL', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    await postEntries([...actionEntries(doc, 'image-delete', IMG_B), ['product_id', FOREIGN_PRODUCT]]);
    expect(be.imageWrites()[FIRST].path).toBe(`/catalog/admin/products/${PRODUCT_ID}/images/${IMG_B}`);
  });

  test('un 5xx del backend → 503 con aviso y «Reintentar»; la imagen sigue en la lista', async () => {
    const be = imagesBackend({ override: (c) => (c.method === 'DELETE' ? errorOf(ST.SERVER_ERROR, 'internal_error') : undefined) });
    const doc = await loaded(be);
    const { res, doc: after, html } = await postEntries(actionEntries(doc, 'image-delete', IMG_B));
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(thumbs(after)).toHaveLength(IMAGES.length);
    expect(text(after.body)).toMatch(RE_RETRY);
    noLeaks(html);
  });
});

describe('ids de imagen hostiles', () => {
  const bad = ['abc', '', 'order', '../order', '..%2Forder', `${IMG_A}/x`, `${IMG_A}\n`, ` ${IMG_A}`, `${IMG_A.slice(NONE, -ONE)}`, "' OR 1=1 --", 'null', '<script>', '%00', 'a'.repeat(LONG_ID)];

  test.each(bad)('image-delete con image_id %j → 4xx y ninguna llamada de escritura', async (id) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = actionEntries(doc, 'image-delete', IMG_A).map(([k, v]): Entry => (v === IMG_A ? [k, id] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    noBackendWrite(be);
  });

  test.each(bad)('image-alt con image_id %j → 4xx y ninguna llamada de escritura', async (id) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = altEntries(doc, IMG_A, 'x').map(([k, v]): Entry => (v === IMG_A ? [k, id] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    noBackendWrite(be);
  });

  test.each(bad)('image-move con image_id %j → 4xx y sin PUT', async (id) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = moveOf(doc, IMG_B, 'subir').map(([k, v]): Entry => (v === IMG_B ? [k, id] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBeGreaterThanOrEqual(ST.BAD_REQUEST);
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(be.puts()).toHaveLength(NONE);
  });
});

describe('seguridad común de las acciones de imagen (RT-B1, RT-B2, RT-B8)', () => {
  /** Una petición de cada acción de imagen, armada con el marcado. */
  async function everyAction(be: Be): Promise<[string, PageInit][]> {
    const doc = await loaded(be);
    return [
      ['image-upload', { multipart: uploadBody(doc, asFile(pngBytes(), 'x.png', 'image/png'), 'texto') }],
      ['image-alt', { entries: altEntries(doc, IMG_A, 'x') }],
      ['image-move', { entries: moveOf(doc, IMG_B, 'subir') }],
      ['image-order', { entries: orderEntries(doc, [IMG_C, IMG_B, IMG_A]) }],
      ['image-delete', { entries: actionEntries(doc, 'image-delete', IMG_B) }],
    ];
  }
  const each = async (be: Be, extra: PageInit, check: (name: string, run: ReturnType<typeof open>) => Promise<void>) => {
    const all = await everyAction(be);
    await all.reduce<Promise<void>>(async (prev, [name, base]) => {
      await prev;
      be.calls.splice(NONE);
      await check(name, open({ method: 'POST', ...base, ...extra }));
    }, Promise.resolve());
  };

  test.each([['de otro sitio', 'https://evil.example'], ['con otro puerto', 'http://localhost:4322'], ['la cadena null', 'null'], ['vacío', ''], ['sin el protocolo', 'localhost:4321']])(
    'Origin %s → 403 en cada acción, no-store y SIN ninguna llamada al backend',
    async (_n, origin) => {
      const be = imagesBackend();
      await each(be, { origin }, async (name, run) => {
        const { res } = await run;
        expect(res.status, name).toBe(ST.FORBIDDEN);
        expect(res.headers.get('cache-control'), name).toBe(NO_STORE);
        expect(be.calls, name).toHaveLength(NONE);
      });
    },
  );

  test('sin cabecera Origin → 403 en cada acción y sin llamadas', async () => {
    const be = imagesBackend();
    await each(be, { origin: null }, async (name, run) => {
      const { res } = await run;
      expect(res.status, name).toBe(ST.FORBIDDEN);
      expect(be.calls, name).toHaveLength(NONE);
    });
  });

  test.each([
    ['text/plain', 'text/plain', '_action=image-delete'],
    ['application/json', 'application/json', '{"_action":"image-delete"}'],
    ['multipart roto', 'multipart/form-data; boundary=zzz', 'basura sin partes'],
    ['multipart sin boundary', 'multipart/form-data', 'x'],
  ])('cuerpo %s → 415 y sin escrituras (nunca 500)', async (_n, contentType, rawBody) => {
    const be = imagesBackend();
    await loaded(be);
    const { res } = await open({ method: 'POST', rawBody, contentType });
    expect(res.status).toBe(ST.UNSUPPORTED_MEDIA);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    noBackendWrite(be);
  });

  test.each([[''], ['image-hack'], ['image-'], ['IMAGE-DELETE'], ['image-delete '], ['delete'], ['image-upload\n']])('_action %j → 400 y sin escrituras', async (action) => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const entries = actionEntries(doc, 'image-delete', IMG_B).map(([k, v]): Entry => (k === '_action' ? [k, action] : [k, v]));
    const { res } = await postEntries(entries);
    expect(res.status).toBe(ST.BAD_REQUEST);
    noBackendWrite(be);
  });

  test('sin _action → 400 y sin escrituras', async () => {
    const be = imagesBackend();
    await loaded(be);
    const { res } = await postEntries([['image_id', IMG_B]]);
    expect(res.status).toBe(ST.BAD_REQUEST);
    noBackendWrite(be);
  });

  test('un cliente (customer) → 403 en cada acción y ninguna llamada de escritura', async () => {
    const all = await everyAction(imagesBackend());
    vi.unstubAllGlobals();
    const beCustomer = imagesBackend({ role: 'customer' });
    await all.reduce<Promise<void>>(async (prev, [name, base]) => {
      await prev;
      const { res } = await open({ method: 'POST', ...base });
      expect(res.status, name).toBe(ST.FORBIDDEN);
    }, Promise.resolve());
    noBackendWrite(beCustomer);
  });

  test('un rol que no es texto o desconocido tampoco entra (nunca 200 ni 303)', async () => {
    const roles = [ONE, '', 'ADMIN', 'superadmin', ['admin']];
    await roles.reduce<Promise<void>>(async (prev, role) => {
      await prev;
      vi.unstubAllGlobals();
      const be = imagesBackend({ role: role as never });
      const { res } = await open({ method: 'POST', entries: [['_action', 'image-delete'], ['image_id', IMG_A]] });
      expect([ST.FORBIDDEN, ST.UNAVAILABLE], JSON.stringify(role)).toContain(res.status);
      noBackendWrite(be);
    }, Promise.resolve());
  });

  test('401 del backend en una acción de imagen → sesión cerrada y 302 al ingreso', async () => {
    const be = imagesBackend({ override: (c) => (c.method === 'DELETE' ? errorOf(ST.UNAUTHORIZED, 'unauthenticated') : undefined) });
    const doc = await loaded(be);
    const { res } = await postEntries(actionEntries(doc, 'image-delete', IMG_B));
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location') ?? '').toContain('/ingresar');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test('403 y 404 del backend DESPUÉS de leer el cuerpo → 403 y 404 (nunca 500) en cada acción', async () => {
    const outcomes: [number][] = [[ST.FORBIDDEN], [ST.NOT_FOUND]];
    await outcomes.reduce<Promise<void>>(async (prev, [status]) => {
      await prev;
      vi.unstubAllGlobals();
      const be = imagesBackend({ override: (c) => (c.method !== 'GET' ? errorOf(status, status === ST.FORBIDDEN ? 'forbidden' : 'not_found') : undefined) });
      const all = await everyAction(be);
      await all.reduce<Promise<void>>(async (inner, [name, base]) => {
        await inner;
        const { res, html } = await open({ method: 'POST', ...base });
        expect(res.status, `${name} ${status}`).toBe(status);
        noLeaks(html);
      }, Promise.resolve());
    }, Promise.resolve());
  });

  test('un 5xx o una caída de red en cada acción → 503 (nunca 500) y sin trazas', async () => {
    const be = imagesBackend({
      override: (c) => {
        if (c.method === 'GET') return undefined;
        throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.5');
      },
    });
    const all = await everyAction(be);
    await all.reduce<Promise<void>>(async (prev, [name, base]) => {
      await prev;
      const { res, html } = await open({ method: 'POST', ...base });
      expect(res.status, name).toBe(ST.UNAVAILABLE);
      noLeaks(html);
      expect(html).not.toContain('10.0.0.5');
    }, Promise.resolve());
  });

  test('el product_id de la URL que no es UUID → 404 en cada acción, sin llamadas', async () => {
    const be = imagesBackend();
    const all = await everyAction(be);
    be.calls.splice(NONE);
    await all.reduce<Promise<void>>(async (prev, [name, base]) => {
      await prev;
      const { res } = await open({ method: 'POST', ...base }, '../../orders');
      expect(res.status, name).toBe(ST.NOT_FOUND);
    }, Promise.resolve());
    expect(be.calls).toHaveLength(NONE);
  });

  test('ninguna respuesta de error repite el cuerpo del cliente: ni el alt tecleado en un campo oculto ni un id', async () => {
    const be = imagesBackend({ override: (c) => (c.method === 'PATCH' ? errorOf(ST.SERVER_ERROR, 'internal_error') : undefined) });
    const doc = await loaded(be);
    const { html } = await postEntries([...altEntries(doc, IMG_A, 'ALT-SECRETO-QX'), ['password', 'valor-secreto-QX']]);
    expect(html).not.toContain('valor-secreto-QX');
  });
});

describe('regresión de T-147 con la sección de imágenes montada', () => {
  test('guardar el formulario principal sigue enviando solo los campos cambiados y no toca las imágenes', async () => {
    const be = imagesBackend();
    const { doc } = await open();
    be.calls.splice(NONE);
    const entries = setEntries(withAction(entriesOf(doc), 'save'), { name: 'Heritage 38 Plus' });
    const { res } = await postEntries(entries);
    expect(res.status).toBe(ST.SEE_OTHER);
    const patches = be.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(ONE);
    expect(patches[FIRST].json).toEqual({ name: 'Heritage 38 Plus' });
    expect(be.imageWrites()).toHaveLength(NONE);
  });

  test('el formulario principal no incluye ningún control de imágenes (ni archivo, ni ids, ni image_id, ni dirección)', async () => {
    imagesBackend();
    const { doc } = await open();
    const main = doc.querySelector('form#product-form') as HTMLFormElement;
    const names = serialize(main).map(([k]) => k);
    ['file', 'ids', 'image_id', 'direction'].forEach((n) => expect(names).not.toContain(n));
    expect(main.querySelector('input[type="file"]')).toBeNull();
    expect(main.querySelector('dialog')).toBeNull();
    expect(valueOf(entriesOf(doc), 'name')).toBe('Heritage 38');
  });

  test('toda la página: un solo #product-form, ningún formulario dentro de otro y cada formulario de imagen vive fuera del principal', async () => {
    imagesBackend();
    const { doc } = await open();
    expect(doc.querySelectorAll('form#product-form')).toHaveLength(ONE);
    expect(doc.querySelectorAll('form form')).toHaveLength(NONE);
    imageForms(doc).forEach((f) => expect(f.closest('form#product-form')).toBeNull());
  });

  test('publicar y despublicar siguen funcionando (POST …/publish) sin llamadas de imágenes', async () => {
    const be = imagesBackend();
    const { doc } = await open();
    be.calls.splice(NONE);
    const { res } = await postEntries([['_action', 'publish']]);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(be.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/catalog/admin/products/${PRODUCT_ID}/publish`]);
    expect(doc).toBeDefined();
  });

  test('crear (nuevo): sin gestor de imágenes y con el aviso «Guarda el producto para añadir imágenes»', async () => {
    catalogBackend();
    const { res, doc } = await openPage(Nuevo, '/admin/productos/nuevo', sb, { cookie: COOKIE });
    expect(res.status).toBe(ST.OK);
    expect(doc.querySelector('input[type="file"]')).toBeNull();
    expect(imageForms(doc)).toHaveLength(NONE);
    expect(text(doc.body)).toContain('Guarda el producto para añadir imágenes');
  });

  test('las rutas de imágenes del producto de otro id no se confunden: el GET usa el id de la URL', async () => {
    const be = imagesBackend({ product: withImages(IMAGES.map((i) => ({ ...i }))) });
    const { res } = await open({}, FOREIGN_PRODUCT);
    expect(res.status).toBe(ST.NOT_FOUND);
    expect(be.calls.some((c) => c.path.includes(FOREIGN_PRODUCT))).toBe(true);
    expect(idsOf(IMAGES)).toEqual(ALL_IDS);
  });
});
