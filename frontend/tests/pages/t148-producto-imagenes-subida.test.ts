import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Editar from '../../src/pages/admin/productos/[product_id].astro';
import {
  BACKEND_MSG, HOME, HOSTILE_ALT, HOSTILE_NAME, IMAGES, IMG_A, NO_STORE, PRODUCT_ID, ST, entriesFor, errorOf, formsFor, imagesBackend, noLeaks, openProduct, uploadBody, uploadForm, withImages,
  type ImageCall, type PageInit,
} from '../helpers/t148';
import { apngBytes, animatedWebpBytes, asFile, bigPng, corruptPng, FIVE_MIB, gifBytes, jpegBytes, pngBytes, pngOfSize, SIX_MIB, textBytes, webpBytes } from '../helpers/t148-files';
import { RE_BACKEND_ENGLISH, RE_RETRY, RE_TOO_BIG_MSG, RE_TYPE_MSG } from '../helpers/t148-re';
import { supabaseMock, type SupabaseMock } from '../helpers/t147-pages';
import { validation } from '../helpers/t147';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-148 · subida de imágenes: `POST /admin/productos/[product_id]` con `_action=image-upload` (multipart). La página corre con la Container API y un backend
// de catálogo simulado que aplica las reglas del contrato (firma, 5 MiB, alt de 1 a 150). El cuerpo se arma leyendo los nombres del marcado.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const ALT_MAX = 150;
const UPLOAD_TIMEOUT_MIN_MS = 19_000;
const UPLOAD_TIMEOUT_MAX_MS = 25_000;
const SLOW_TEST_MS = 45_000;
const WIDE_PX = 5000;
const TALL_PX = 5001; // 25 005 000 px: justo sobre el tope de 25 MP
const GRACE_MS = 5000;
const ALT = 'Frente del reloj, esfera verde';
const RED_PNG = pngBytes({ rgb: Uint8Array.from(Buffer.from('c83c3c', 'hex')) });

let sb: SupabaseMock;
beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (init: PageInit = {}, id: string = PRODUCT_ID) => openProduct(Editar, sb, init, id);
/** Abre la página para leer el marcado y borra el registro de llamadas: lo que se mira después son solo las del POST. */
async function loaded(be: ReturnType<typeof imagesBackend>) {
  const { doc } = await open();
  be.calls.splice(NONE);
  return doc;
}
/** Sube `file` con `alt` leyendo los nombres de campo del marcado. */
async function upload(be: ReturnType<typeof imagesBackend>, file: File | null, alt: string, init: PageInit = {}) {
  const doc = await loaded(be);
  return open({ method: 'POST', multipart: uploadBody(doc, file, alt), ...init });
}
const posts = (be: ReturnType<typeof imagesBackend>): ImageCall[] => be.imageWrites().filter((c) => c.method === 'POST');
const png = (name = 'frente.png') => asFile(RED_PNG, name, 'image/png');

const describedIds = (el: Element | null): string[] => (el?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
/** Texto de los mensajes que el estado de error añade a `aria-describedby` respecto del estado sin errores. */
function errorText(doc: Document, base: Document, pick: (d: Document) => Element | null): string {
  const known = new Set(describedIds(pick(base)));
  return describedIds(pick(doc))
    .filter((id) => !known.has(id))
    .map((id) => text(doc.querySelector(`[id="${id}"]`)))
    .join(' ');
}
const pickFile = (d: Document): Element | null => d.querySelector('input[type="file"]');
const pickUploadAlt = (d: Document): Element | null => uploadForm(d)?.querySelector('input:not([type="file"]):not([type="hidden"])') ?? null;
const invalid = (el: Element | null): boolean => el?.getAttribute('aria-invalid') === 'true';
const thumbs = (doc: Document): (string | null)[] => [...doc.querySelectorAll('ol img, ul img')].map((i) => i.getAttribute('src'));

describe('subida válida', () => {
  test.each([
    ['JPEG', () => asFile(jpegBytes(), 'frente.jpg', 'image/jpeg'), 'image/jpeg'],
    ['PNG', () => png(), 'image/png'],
    ['WebP', () => asFile(webpBytes(), 'frente.webp', 'image/webp'), 'image/webp'],
  ])('%s válido → un solo POST multipart a …/images con el archivo y el alt, y 303 de vuelta a la edición', async (_n, make, type) => {
    const be = imagesBackend();
    const file = make();
    const { res } = await upload(be, file, ALT);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(res.headers.get('location')?.startsWith(HOME)).toBe(true);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const sent = posts(be);
    expect(sent).toHaveLength(ONE);
    expect(sent[NONE].path).toBe(`/catalog/admin/products/${PRODUCT_ID}/images`);
    expect(sent[NONE].form).toBeInstanceOf(FormData);
    const part = sent[NONE].form?.get('file') as File;
    expect(part.size).toBe(file.size);
    expect(part.type).toBe(type);
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
    expect(sent[NONE].form?.get('alt')).toBe(ALT);
    expect(be.currentIds()).toHaveLength(IMAGES.length + ONE);
  });

  test('la petición lleva el Bearer de la sesión y ningún Content-Type propio (lo pone fetch con el límite)', async () => {
    const be = imagesBackend();
    await upload(be, png(), ALT);
    const call = posts(be)[NONE];
    expect(call.auth?.startsWith('Bearer ')).toBe(true);
    expect(call.headers.has('content-type')).toBe(false);
    expect(call.json).toBeNull();
  });

  test('el campo del formulario solo envía `file` y `alt` al backend (más nada: sin id de producto, sin _action)', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const body = uploadBody(doc, png(), ALT, [['user_id', 'x'], ['product_id', 'otro'], ['role', 'admin'], ['url', 'http://evil.test/a.png']]);
    await open({ method: 'POST', multipart: body });
    expect([...(posts(be)[NONE].form?.keys() ?? [])].sort()).toEqual(['alt', 'file']);
  });

  test('el alt se recorta; las tildes y la ñ se conservan', async () => {
    const be = imagesBackend();
    await upload(be, png(), '   Reloj áureo, caja de acero ñ   ');
    expect(posts(be)[NONE].form?.get('alt')).toBe('Reloj áureo, caja de acero ñ');
  });

  test('el alt de 150 caracteres exactos se acepta', async () => {
    const be = imagesBackend();
    const { res } = await upload(be, png(), 'a'.repeat(ALT_MAX));
    expect(res.status).toBe(ST.SEE_OTHER);
  });

  test('el alt hostil viaja tal cual (texto) y no se interpreta', async () => {
    const be = imagesBackend();
    const { res } = await upload(be, png(), HOSTILE_ALT.slice(NONE, ALT_MAX));
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(posts(be)[NONE].form?.get('alt')).toBe(HOSTILE_ALT.slice(NONE, ALT_MAX));
  });

  test('el nombre del archivo del cliente no se usa: ni se reenvía al backend ni se pinta', async () => {
    const be = imagesBackend();
    const { res } = await upload(be, png(HOSTILE_NAME), ALT);
    expect(res.status).toBe(ST.SEE_OTHER);
    const part = posts(be)[NONE].form?.get('file') as File;
    expect(part.name).not.toContain('QXNAME');
    expect(part.name).not.toContain('<script>');
  });

  test('el archivo de exactamente 5 MiB (el límite) se acepta', async () => {
    const be = imagesBackend();
    const file = asFile(pngOfSize(FIVE_MIB), 'justo.png', 'image/png');
    expect(file.size).toBe(FIVE_MIB);
    const { res } = await upload(be, file, ALT);
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(posts(be)).toHaveLength(ONE);
  });

  test('un archivo con el tipo declarado equivocado (JPEG con type "text/plain") se reenvía: el tipo lo decide el servidor por la firma', async () => {
    const be = imagesBackend();
    const { res } = await upload(be, asFile(jpegBytes(), 'x.txt', 'text/plain'), ALT);
    expect(res.status).toBe(ST.SEE_OTHER);
  });

  test('tras subir, la página que se recarga (GET) lista la imagen nueva al final y la principal sigue siendo la primera', async () => {
    const be = imagesBackend();
    await upload(be, png(), ALT);
    const { doc } = await open();
    expect(thumbs(doc)).toHaveLength(IMAGES.length + ONE);
    expect(thumbs(doc)[NONE]).toBe(IMAGES[NONE].url);
  });
});

describe('validación del formulario (sin llamar al backend)', () => {
  test.each([['vacío', ''], ['solo espacios', '    '], ['solo tabuladores y saltos', '\t\n  ']])(
    'alt %s → 422 junto al campo del alt de la subida, sin llamar al backend',
    async (_n, alt) => {
      const be = imagesBackend();
      const base = await loaded(be);
      const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), alt) });
      expect(res.status).toBe(ST.UNPROCESSABLE);
      expect(res.headers.get('cache-control')).toBe(NO_STORE);
      expect(be.imageWrites()).toHaveLength(NONE);
      expect(invalid(pickUploadAlt(doc))).toBe(true);
      expect(errorText(doc, base, pickUploadAlt).length).toBeGreaterThan(NONE);
      expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
      expect(uploadForm(doc)).not.toBeNull();
      noLeaks(html);
    },
  );

  test('alt de 151 caracteres → 422 en su campo; nunca 5xx ni 303', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { res, doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), 'a'.repeat(ALT_MAX + ONE)) });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(pickUploadAlt(doc))).toBe(true);
    expect(posts(be).length).toBeLessThanOrEqual(ONE);
    expect(be.currentIds()).toHaveLength(IMAGES.length);
  });

  test('sin parte de archivo → 422 junto al archivo, sin llamar al backend', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { res, doc } = await open({ method: 'POST', multipart: uploadBody(base, null, ALT) });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(pickFile(doc))).toBe(true);
    expect(errorText(doc, base, pickFile).length).toBeGreaterThan(NONE);
    expect(be.imageWrites()).toHaveLength(NONE);
  });

  test('archivo vacío (el navegador envía un archivo de 0 bytes y nombre vacío si no se eligió ninguno) → 422 en el archivo y sin llamada', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { res, doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(new Uint8Array(NONE), '', 'application/octet-stream'), ALT) });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(pickFile(doc))).toBe(true);
    expect(be.imageWrites()).toHaveLength(NONE);
  });

  test('el campo `file` enviado como texto (no como archivo) → 422 en el archivo, sin llamada y sin 500', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const body = uploadBody(base, null, ALT);
    body.append(uploadForm(base)?.querySelector('input[type="file"]')?.getAttribute('name') ?? 'file', 'esto es texto, no un archivo');
    const { res, doc } = await open({ method: 'POST', multipart: body });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(pickFile(doc))).toBe(true);
    expect(be.imageWrites()).toHaveLength(NONE);
  });

  test('varios archivos en el mismo campo: se sube como mucho uno y no hay 500', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const body = uploadBody(base, png('a.png'), ALT);
    body.append(uploadForm(base)?.querySelector('input[type="file"]')?.getAttribute('name') ?? 'file', png('b.png'));
    const { res } = await open({ method: 'POST', multipart: body });
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
    expect(posts(be).length).toBeLessThanOrEqual(ONE);
  });

  test('tras un error de formulario, el resto de la página sigue entera: lista, botones, subida y la acción de publicar', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), '') });
    expect(thumbs(doc)).toHaveLength(IMAGES.length);
    expect(doc.querySelectorAll('form#product-form')).toHaveLength(ONE);
    expect([...doc.querySelectorAll('button')].map((b) => text(b))).toContain('Publicar');
  });

  test('el error de la subida se anuncia con un resumen role="alert" (RT-B10) que repite el mensaje del campo', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), '') });
    const alerts = [...doc.querySelectorAll('[role="alert"]')].map((a) => text(a));
    expect(alerts.length).toBeGreaterThan(NONE);
    expect(alerts.join(' ')).toContain(errorText(doc, base, pickUploadAlt));
  });

  test('lo escrito se conserva: tras un error del archivo, el texto alternativo tecleado sigue en su campo (criterio de T-148)', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(gifBytes(), 'x.gif', 'image/gif'), ALT) });
    expect((pickUploadAlt(doc) as HTMLInputElement).getAttribute('value')).toBe(ALT);
  });
});

describe('archivos rechazados por tamaño', () => {
  test('5 MiB + 1 → 413 con «5 MiB» junto al archivo; la lista no cambia', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const big = asFile(pngOfSize(FIVE_MIB + ONE), 'grande.png', 'image/png');
    const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, big, ALT) });
    expect(res.status).toBe(ST.PAYLOAD_TOO_LARGE);
    expect(invalid(pickFile(doc))).toBe(true);
    expect(errorText(doc, base, pickFile)).toMatch(RE_TOO_BIG_MSG);
    expect(be.currentIds()).toHaveLength(IMAGES.length);
    expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
    noLeaks(html);
    expect(html).not.toContain('grande.png');
  });

  test('Content-Length mayor de 6 MiB → 413 antes de leer el cuerpo: sin llamadas al backend de escritura y con el mensaje', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT), headers: { 'content-length': String(SIX_MIB + ONE) } });
    expect(res.status).toBe(ST.PAYLOAD_TOO_LARGE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(be.writes()).toHaveLength(NONE);
    expect(text(doc.body)).toMatch(RE_TOO_BIG_MSG);
    expect(uploadForm(doc)).not.toBeNull();
    expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
    noLeaks(html);
  });

  test('Content-Length mayor de 6 MiB también corta una acción distinta de la subida (no se lee ningún cuerpo grande)', async () => {
    const be = imagesBackend();
    const { res } = await open({ method: 'POST', rawBody: '_action=publish', headers: { 'content-length': String(SIX_MIB * TWO) } });
    expect(res.status).toBe(ST.PAYLOAD_TOO_LARGE);
    expect(be.writes()).toHaveLength(NONE);
  });

  test('Content-Length de exactamente 6 MiB no se rechaza por adelantado (el límite es «mayor que»)', async () => {
    const be = imagesBackend();
    const { res } = await upload(be, png(), ALT, { headers: { 'content-length': String(SIX_MIB) } });
    expect(res.status).toBe(ST.SEE_OTHER);
    expect(posts(be)).toHaveLength(ONE);
  });

  test.each([['abc'], ['-1'], ['']])('Content-Length ilegible (%j) no rompe: se procesa el cuerpo real', async (value) => {
    const be = imagesBackend();
    const { res } = await upload(be, png(), ALT, { headers: { 'content-length': value } });
    expect(res.status).toBeLessThan(ST.SERVER_ERROR);
  });
});

describe('archivos rechazados por el backend (cada error traducido en su campo, sin el msg del servidor)', () => {
  const cases: [string, () => File, number, string][] = [
    ['GIF → 415 unsupported_media_type', () => asFile(gifBytes(), 'animacion.gif', 'image/gif'), ST.UNSUPPORTED_MEDIA, 'unsupported_media_type'],
    ['texto renombrado a .png → 415', () => asFile(textBytes(), 'falso.png', 'image/png'), ST.UNSUPPORTED_MEDIA, 'unsupported_media_type'],
    ['PNG corrupto → 422 invalid_image', () => asFile(corruptPng(), 'roto.png', 'image/png'), ST.UNPROCESSABLE, 'invalid_image'],
    ['más de 25 MP → 422 image_dimensions_exceeded', () => asFile(bigPng(WIDE_PX, TALL_PX), 'enorme.png', 'image/png'), ST.UNPROCESSABLE, 'image_dimensions_exceeded'],
    ['WebP animado → 422 animated_image', () => asFile(animatedWebpBytes(), 'anim.webp', 'image/webp'), ST.UNPROCESSABLE, 'animated_image'],
    ['PNG animado (APNG) → 422 animated_image', () => asFile(apngBytes(), 'anim.png', 'image/png'), ST.UNPROCESSABLE, 'animated_image'],
  ];
  /** El backend responde por el contenido del archivo, como el real. */
  const backendFor = (code: string, status: number) =>
    imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') && !c.signal?.aborted && code !== 'unsupported_media_type' ? errorOf(status, code) : undefined) });

  test.each(cases)('%s: estado %#', async (_name, make, status, code) => {
    const be = backendFor(code, status);
    const base = await loaded(be);
    const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, make(), ALT) });
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(invalid(pickFile(doc)), 'el error va en el campo del archivo').toBe(true);
    expect(errorText(doc, base, pickFile).length).toBeGreaterThan(NONE);
    expect(errorText(doc, base, pickFile)).not.toMatch(RE_BACKEND_ENGLISH);
    noLeaks(html);
    ['animacion.gif', 'falso.png', 'roto.png', 'enorme.png', 'anim.webp', 'anim.png'].forEach((n) => expect(html).not.toContain(n));
    expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
    expect(uploadForm(doc)).not.toBeNull();
  });

  test('415 dice «Formato no admitido: usa JPEG, PNG o WebP»', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(gifBytes(), 'x.gif', 'image/gif'), ALT) });
    const msg = errorText(doc, base, pickFile);
    expect(msg).toMatch(RE_TYPE_MSG);
    expect(msg).toContain('Formato no admitido');
  });

  test('413 file_too_large y 413 payload_too_large nombran el límite de 5 MiB', async () => {
    const codes = ['file_too_large', 'payload_too_large'];
    await codes.reduce<Promise<void>>(async (prev, code) => {
      await prev;
      vi.unstubAllGlobals();
      const be = imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') ? errorOf(ST.PAYLOAD_TOO_LARGE, code, { max_bytes: SIX_MIB }) : undefined) });
      const base = await loaded(be);
      const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
      expect(res.status, code).toBe(ST.PAYLOAD_TOO_LARGE);
      expect(errorText(doc, base, pickFile), code).toMatch(RE_TOO_BIG_MSG);
      noLeaks(html);
    }, Promise.resolve());
  });

  test('los errores de contenido de imagen no se confunden: inválida, demasiados píxeles y animada tienen textos distintos', async () => {
    const codes: [string, number][] = [['invalid_image', ST.UNPROCESSABLE], ['image_dimensions_exceeded', ST.UNPROCESSABLE], ['animated_image', ST.UNPROCESSABLE]];
    const seen: string[] = [];
    await codes.reduce<Promise<void>>(async (prev, [code, status]) => {
      await prev;
      vi.unstubAllGlobals();
      const be = backendFor(code, status);
      const base = await loaded(be);
      const { doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
      seen.push(errorText(doc, base, pickFile));
    }, Promise.resolve());
    expect(seen.every((s) => s.length > NONE)).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('422 de validación sobre el alt → en el campo del alt de la subida, con texto en español y sin el msg del backend', async () => {
    const be = imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') ? validation({ loc: ['body', 'alt'], type: 'string_too_long' }) : undefined) });
    const base = await loaded(be);
    const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.UNPROCESSABLE);
    expect(invalid(pickUploadAlt(doc))).toBe(true);
    expect(invalid(pickFile(doc))).toBe(false);
    expect(errorText(doc, base, pickUploadAlt).length).toBeGreaterThan(NONE);
    expect(html).not.toContain(BACKEND_MSG);
  });
});

describe('fallos del servicio y de la sesión durante la subida', () => {
  const failing = (make: (c: ImageCall) => Response | Promise<Response>) =>
    imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') ? make(c) : undefined) });

  test('Storage caído (503 storage_unavailable) → 503 con un aviso y «Reintentar»; la página y lo escrito siguen', async () => {
    const be = failing(() => errorOf(ST.UNAVAILABLE, 'storage_unavailable'));
    const base = await loaded(be);
    const { res, doc, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(doc.querySelectorAll('[role="alert"]').length).toBeGreaterThan(NONE);
    expect(text(doc.body)).toMatch(RE_RETRY);
    expect(thumbs(doc)).toEqual(IMAGES.map((i) => i.url));
    expect(uploadForm(doc)).not.toBeNull();
    noLeaks(html);
  });

  test.each([
    ['500 con el formato común', () => errorOf(ST.SERVER_ERROR, 'internal_error')],
    ['502 con HTML', () => new Response('<html>Bad Gateway</html>', { status: ST.BAD_GATEWAY })],
    ['504', () => new Response('', { status: ST.GATEWAY_TIMEOUT })],
    ['200 que no es JSON', () => new Response('hola', { status: ST.OK })],
  ])('%s → 503 sin filtrar el cuerpo', async (_n, make) => {
    const be = failing(make);
    const base = await loaded(be);
    const { res, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.UNAVAILABLE);
    noLeaks(html);
    expect(html).not.toContain('Bad Gateway');
  });

  test('caída de red al subir → 503 y sin el mensaje del error nativo', async () => {
    const be = failing(() => {
      throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.5:8000');
    });
    const base = await loaded(be);
    const { res, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.UNAVAILABLE);
    noLeaks(html);
    expect(html).not.toContain('10.0.0.5');
  });

  test('la subida espera hasta unos 20 s (no los 8 s de las lecturas) antes de dar 503', async () => {
    const be = failing(
      (c) =>
        new Promise<Response>((_res, rej) => {
          // Nunca responde: solo la señal de tiempo la corta, como haría el fetch real.
          c.signal?.addEventListener('abort', () => rej(c.signal?.reason));
        }),
    );
    const base = await loaded(be);
    const t0 = Date.now();
    const slow = open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    const { res } = await Promise.race([slow, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no cortó en 30 s')), UPLOAD_TIMEOUT_MAX_MS + GRACE_MS))]);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(ST.UNAVAILABLE);
    expect(elapsed).toBeGreaterThanOrEqual(UPLOAD_TIMEOUT_MIN_MS);
    expect(elapsed).toBeLessThan(UPLOAD_TIMEOUT_MAX_MS);
  }, SLOW_TEST_MS);

  test('401 del backend → se cierra la sesión local y 302 al ingreso', async () => {
    const be = failing(() => errorOf(ST.UNAUTHORIZED, 'unauthenticated'));
    const base = await loaded(be);
    const { res } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.FOUND);
    expect(res.headers.get('location') ?? '').toContain('/ingresar');
    expect(sb.signOut).toHaveBeenCalled();
  });

  test('403 del backend tras leer el cuerpo → 403 (nunca 500)', async () => {
    const be = failing(() => errorOf(ST.FORBIDDEN, 'forbidden'));
    const base = await loaded(be);
    const { res, html } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.FORBIDDEN);
    noLeaks(html);
  });

  test('404 del backend tras leer el cuerpo (el producto desapareció) → 404 (nunca 500)', async () => {
    const be = failing(() => errorOf(ST.NOT_FOUND, 'not_found'));
    const base = await loaded(be);
    const { res } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.NOT_FOUND);
  });

  test('409 inesperado → 409 con un aviso de formulario, no 5xx', async () => {
    const be = failing(() => errorOf(ST.CONFLICT, 'conflict'));
    const base = await loaded(be);
    const { res, doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), ALT) });
    expect(res.status).toBe(ST.CONFLICT);
    expect(doc.querySelectorAll('[role="alert"]').length).toBeGreaterThan(NONE);
  });
});

describe('privacidad: ni el archivo ni el alt se registran', () => {
  test('en ningún camino (éxito, error del backend, caída) se escribe el nombre del archivo ni el alt en console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const be = imagesBackend();
    await upload(be, png(HOSTILE_NAME), 'ALT-PRIVADO-QX');
    vi.unstubAllGlobals();
    const be2 = imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') ? errorOf(ST.UNAVAILABLE, 'storage_unavailable') : undefined) });
    await upload(be2, png(HOSTILE_NAME), 'ALT-PRIVADO-QX');
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
    expect(logged).not.toContain('QXNAME');
    expect(logged).not.toContain('ALT-PRIVADO-QX');
  });
});

describe('forma del producto', () => {
  test('el backend que ya trae el producto con `images` vacío deja el mismo formulario de subida', async () => {
    imagesBackend({ product: withImages([]) });
    const { doc, res } = await open();
    expect(res.status).toBe(ST.OK);
    expect(thumbs(doc)).toEqual([]);
    expect(uploadForm(doc)).not.toBeNull();
  });

  test('el id de la imagen del producto de la lista no se confunde con el de la subida: IMG_A sigue en su lugar tras subir otra', async () => {
    const be = imagesBackend();
    await upload(be, png(), ALT);
    expect(be.currentIds()[NONE]).toBe(IMG_A);
  });
});

describe('conservar el alt y enlazar el resumen tras un error (H2 y H3)', () => {
  const typed = '  Perfil izquierdo, caja de acero  ';
  const kept = 'Perfil izquierdo, caja de acero';
  const alertOf = (doc: Document): Element | null => doc.querySelector('[role="alert"]');
  const failing = (make: () => Response) => imagesBackend({ override: (c) => (c.method === 'POST' && c.path.endsWith('/images') ? make() : undefined) });

  test.each([
    ['415 por el GIF', () => imagesBackend(), () => asFile(gifBytes(), 'x.gif', 'image/gif')],
    ['413 por 5 MiB + 1', () => imagesBackend(), () => asFile(pngOfSize(FIVE_MIB + ONE), 'g.png', 'image/png')],
    ['422 invalid_image', () => failing(() => errorOf(ST.UNPROCESSABLE, 'invalid_image')), () => png()],
    ['422 animated_image', () => failing(() => errorOf(ST.UNPROCESSABLE, 'animated_image')), () => png()],
    ['503 storage_unavailable', () => failing(() => errorOf(ST.UNAVAILABLE, 'storage_unavailable')), () => png()],
    ['500 del backend', () => failing(() => errorOf(ST.SERVER_ERROR, 'internal_error')), () => png()],
    ['409 inesperado', () => failing(() => errorOf(ST.CONFLICT, 'conflict')), () => png()],
  ])('%s: el alt recortado vuelve en su campo', async (_n, backend, make) => {
    const be = backend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, make(), typed) });
    expect((pickUploadAlt(doc) as HTMLInputElement).getAttribute('value')).toBe(kept);
  });

  test('un alt hostil vuelve como texto, sin HTML ni eventos vivos', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const alt = HOSTILE_ALT.slice(NONE, ALT_MAX);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(gifBytes(), 'x.gif', 'image/gif'), alt) });
    expect((pickUploadAlt(doc) as HTMLInputElement).getAttribute('value')).toBe(alt);
    expect([...doc.querySelectorAll('script')].map((s) => s.textContent).join('')).not.toContain('__pwned');
    expect(doc.querySelectorAll('[onerror]')).toHaveLength(NONE);
  });

  test('con alt vacío el campo vuelve vacío y no se inventa un valor', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), '   ') });
    expect((pickUploadAlt(doc) as HTMLInputElement).getAttribute('value') ?? '').toBe('');
  });

  test('el alt de una subida no se cuela en los campos de las otras imágenes', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(gifBytes(), 'x.gif', 'image/gif'), typed) });
    const others = [...doc.querySelectorAll('ol input[type="text"]')].map((i) => i.getAttribute('value'));
    expect(others).toEqual(IMAGES.map((i) => i.alt));
  });

  test('el resumen role="alert" enlaza al campo con error y el destino existe', async () => {
    const be = imagesBackend();
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, asFile(gifBytes(), 'x.gif', 'image/gif'), kept) });
    const alert = alertOf(doc) as Element;
    expect(alert).not.toBeNull();
    const hrefs = [...alert.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain(`#${pickFile(doc)?.getAttribute('id')}`);
    hrefs.forEach((h) => expect(doc.querySelector(`[id="${h.slice(ONE)}"]`), h).not.toBeNull());
    expect(alert.getAttribute('tabindex')).toBe('-1');
  });

  test('un error de alt de una imagen enlaza a su campo y solo a él', async () => {
    const be = imagesBackend();
    const doc = await loaded(be);
    const form = formsFor(doc, 'image-alt', IMAGES[ONE].id)[NONE];
    const fieldName = (form.querySelector('input[type="text"]') as HTMLInputElement).getAttribute('name') ?? 'alt';
    const entries = entriesFor(form).map(([k, v]): [string, string] => (k === fieldName ? [k, ''] : [k, v]));
    const { doc: after } = await open({ method: 'POST', entries });
    const alert = alertOf(after) as Element;
    const hrefs = [...alert.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    const own = (form.querySelector('input[type="text"]') as HTMLInputElement).getAttribute('id');
    expect(hrefs).toEqual([`#${own}`]);
    expect(after.querySelector(`[id="${own}"]`)).not.toBeNull();
  });

  test('un 503 del backend ofrece «Reintentar» dentro del resumen enfocable', async () => {
    const be = failing(() => errorOf(ST.UNAVAILABLE, 'storage_unavailable'));
    const base = await loaded(be);
    const { doc } = await open({ method: 'POST', multipart: uploadBody(base, png(), kept) });
    expect(text(alertOf(doc))).toMatch(RE_RETRY);
  });
});
