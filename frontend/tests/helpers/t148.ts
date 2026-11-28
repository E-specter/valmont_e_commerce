// Ayudantes de T-148 (imágenes del producto): datos, un backend de catálogo simulado con las reglas de las imágenes (catalog SPEC §7 y T-018i),
// la apertura de la página de edición con un cuerpo de formulario o multipart, y la lectura de los formularios de ImageManager tal como los enviaría
// el navegador. Los nombres de los campos NO se suponen: se leen del marcado (sobre el contrato `_action` del paquete).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { vi } from 'vitest';
import NoDisponible from '../../src/pages/admin/no-disponible.astro';
import SinPermiso from '../../src/pages/admin/sin-permiso.astro';
import NotFound from '../../src/pages/404.astro';
import type { AdminProduct, ProductImage } from '../../src/lib/api/admin-catalog';
import { FIVE_MIB } from './t148-files';
import { parseHtml } from './render';
import { SESSION, json, profile } from './t129';
import { ORIGIN, ST } from './t142';
import { BACKEND_MSG, PRODUCT_ID, adminProduct, apiError, serialize, validation, type Entry } from './t147';
import { COOKIE, type SupabaseMock } from './t147-pages';
import { text } from './ui';

export { BACKEND_MSG, ORIGIN, PRODUCT_ID, ST };

const NONE = 0;
const ONE = 1;
const ALT_MAX = 150;
const API_PREFIX = '/api/v1';
const PARTS_IMAGES = 6; // ['', 'catalog', 'admin', 'products', '<id>', 'images']
const PARTS_IMAGE = 7; // … + '<image id>' o 'order'
const PRODUCT_AT = 4;
const SEGMENT_AT = 5;
const LAST_AT = 6;
const SIG_JPEG = 'ffd8ff';
const SIG_PNG = '89504e47';
const SIG_RIFF = '52494646';
const SIG_WEBP = '57454250';
const WEBP_TAG_AT = 8;
const SIG_LEN = 4;
const PAD = 8;
const CREATED = 201;
const NO_CONTENT = 204;

export const IMG_A = 'a1111111-1111-4111-8111-111111111111';
export const IMG_B = 'b2222222-2222-4222-8222-222222222222';
export const IMG_C = 'c3333333-3333-4333-8333-333333333333';
export const IMG_D = 'd4444444-4444-4444-8444-444444444444';
export const FOREIGN_IMG = 'f9999999-9999-4999-8999-999999999999';
export const STORAGE = 'http://storage.test/storage/v1/object/public/products';
export const HOME = `/admin/productos/${PRODUCT_ID}`;
export const NO_STORE = 'private, no-store';
export const HOSTILE_ALT = '<script>window.__pwned=1</script><img src=x onerror=alert(1)>';
/** Un nombre de archivo del cliente que nunca debe aparecer en la pantalla, en el backend ni en un registro. */
export const HOSTILE_NAME = 'sneaky"><script>x</script>-QXNAME.png';

export const imageOf = (id: string, n: string, alt = `Vista ${n} del reloj`): ProductImage => ({ id, url: `${STORAGE}/${n}.webp`, alt });
export const IMAGES = [imageOf(IMG_A, 'a'), imageOf(IMG_B, 'b'), imageOf(IMG_C, 'c')];
export const withImages = (images: ProductImage[], over: Partial<AdminProduct> = {}): AdminProduct =>
  adminProduct({ images, main_image: images[NONE] ?? null, ...over });
export const idsOf = (images: readonly ProductImage[]): string[] => images.map((i) => i.id);

// ---------------------------------------------------------------------------------------------------------------------
// Backend simulado

export type ImageCall = {
  method: string;
  path: string;
  auth: string | null;
  json: unknown;
  form: FormData | null;
  headers: Headers;
  signal: AbortSignal | null;
};
type Override = (c: ImageCall) => Response | undefined | Promise<Response | undefined>;
export type ImagesBackendInit = { role?: string; product?: AdminProduct | null; override?: Override };

const startsWith = (data: Uint8Array, hex: string, at = NONE): boolean => Buffer.from(data.subarray(at, at + SIG_LEN)).toString('hex').startsWith(hex);
/** Firma real del archivo: lo que el backend mira (nunca el nombre ni el `Content-Type`). */
export const looksLikeImage = (data: Uint8Array): boolean =>
  startsWith(data, SIG_JPEG) || startsWith(data, SIG_PNG) || (startsWith(data, SIG_RIFF) && startsWith(data, SIG_WEBP, WEBP_TAG_AT));

/**
 * `fetch` falso de `/identity/me`, categorías, atributos y las rutas de producto e imágenes. Aplica las reglas del backend: firma del archivo (415),
 * más de 5 MiB (413), `alt` de 1 a 150 (422), el orden es el conjunto completo (422), la última imagen de un producto publicado (409), 404 por producto
 * e imagen. `override` fuerza una respuesta por llamada.
 */
export function imagesBackend(init: ImagesBackendInit = {}) {
  const state = { product: init.product === undefined ? withImages(IMAGES.map((i) => ({ ...i }))) : init.product, uploads: NONE };
  const calls: ImageCall[] = [];
  const notFound = (): Response => apiError(ST.NOT_FOUND, 'not_found');
  const images = (): ProductImage[] => state.product?.images ?? [];
  const sync = (next: ProductImage[]): void => {
    if (state.product) state.product = { ...state.product, images: next, main_image: next[NONE] ?? null };
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, req?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.startsWith(API_PREFIX) ? u.pathname.slice(API_PREFIX.length) : u.pathname;
    const body = req?.body;
    const raw = typeof body === 'string' ? body : null;
    const call: ImageCall = {
      method: req?.method ?? 'GET',
      path,
      auth: new Headers(req?.headers).get('authorization'),
      json: raw ? (JSON.parse(raw) as unknown) : null,
      form: body instanceof FormData ? body : null,
      headers: new Headers(req?.headers),
      signal: req?.signal ?? null,
    };
    calls.push(call);
    const forced = await init.override?.(call);
    if (forced) return forced;
    const m = call.method;
    if (path === '/identity/me' && m === 'GET') return json(profile({ role: init.role ?? 'admin' }));
    if (path === '/catalog/admin/categories' && m === 'GET') return json(adminLists.categories);
    if (path === '/catalog/admin/attributes' && m === 'GET') return json(adminLists.attributes);
    const parts = path.split('/');
    if (!path.startsWith('/catalog/admin/products/')) return notFound();
    const p = state.product;
    if (!p || parts[PRODUCT_AT] !== p.id) return notFound();
    const segment = parts[SEGMENT_AT];
    if (parts.length === SEGMENT_AT && m === 'GET') return json(p);
    if (parts.length === SEGMENT_AT && m === 'PATCH') {
      state.product = { ...p, ...(call.json as Partial<AdminProduct>) };
      return json(state.product);
    }
    if (parts.length === PARTS_IMAGES && (segment === 'publish' || segment === 'unpublish') && m === 'POST') {
      state.product = { ...p, status: segment === 'publish' ? 'published' : 'draft' };
      return json(state.product);
    }
    if (parts.length === PARTS_IMAGES && segment === 'images' && m === 'POST') return uploadRoute(call);
    if (parts.length === PARTS_IMAGE && segment === 'images') return imageRoute(call, parts[LAST_AT] ?? '');
    return apiError(ST.METHOD_NOT_ALLOWED, 'method_not_allowed');
  });

  async function uploadRoute(call: ImageCall): Promise<Response> {
    const file = call.form?.get('file');
    const alt = String(call.form?.get('alt') ?? '');
    if (!(file instanceof File)) return validation({ loc: ['body', 'file'], type: 'missing' });
    if (file.size > FIVE_MIB) return apiError(ST.PAYLOAD_TOO_LARGE, 'file_too_large');
    if (alt.length < ONE || alt.length > ALT_MAX) return validation({ loc: ['body', 'alt'], type: alt.length ? 'string_too_long' : 'string_too_short' });
    if (!looksLikeImage(new Uint8Array(await file.arrayBuffer()))) return apiError(ST.UNSUPPORTED_MEDIA, 'unsupported_media_type');
    state.uploads += ONE;
    const created = { id: `${String(state.uploads).padStart(PAD, '0')}-0000-4000-8000-000000000000`, url: `${STORAGE}/new-${state.uploads}.webp`, alt };
    sync([...images(), created]);
    return json(created, CREATED);
  }

  function imageRoute(call: ImageCall, last: string): Response {
    const list = images();
    if (last === 'order') {
      const ids = Array.isArray(call.json) ? (call.json as string[]) : [];
      const same = ids.length === list.length && new Set(ids).size === ids.length && ids.every((id) => list.some((i) => i.id === id));
      if (call.method !== 'PUT') return apiError(ST.METHOD_NOT_ALLOWED, 'method_not_allowed');
      if (!same) return validation({ loc: ['body'], type: 'value_error' });
      sync(ids.map((id) => list.find((i) => i.id === id) as ProductImage));
      return json(images());
    }
    const at = list.findIndex((i) => i.id === last);
    if (at < NONE) return notFound();
    if (call.method === 'PATCH') {
      const alt = String((call.json as { alt?: unknown } | null)?.alt ?? '');
      if (alt.length < ONE || alt.length > ALT_MAX) return validation({ loc: ['body', 'alt'], type: 'string_too_short' });
      sync(list.map((i, n) => (n === at ? { ...i, alt } : i)));
      return json(images()[at]);
    }
    if (call.method === 'DELETE') {
      if (state.product?.status === 'published' && list.length === ONE) return apiError(ST.CONFLICT, 'last_image');
      sync(list.filter((_, n) => n !== at));
      return new Response(null, { status: NO_CONTENT });
    }
    return apiError(ST.METHOD_NOT_ALLOWED, 'method_not_allowed');
  }

  vi.stubGlobal('fetch', fetchMock);
  return {
    state,
    calls,
    fetchMock,
    /** Escrituras sobre imágenes (todo menos GET bajo /images). */
    imageWrites: (): ImageCall[] => calls.filter((c) => c.method !== 'GET' && c.path.includes('/images')),
    puts: (): ImageCall[] => calls.filter((c) => c.method === 'PUT'),
    writes: (): ImageCall[] => calls.filter((c) => c.method !== 'GET'),
    catalog: (): ImageCall[] => calls.filter((c) => c.path.startsWith('/catalog')),
    currentIds: (): string[] => idsOf(images()),
  };
}

const adminLists = {
  categories: [{ id: '2c9d1e4b-3a5f-4b7c-8d90-0a1b2c3d4e5f', slug: 'clasicos', name: 'Clásicos', description: null, position: 1, is_active: true }],
  attributes: {
    movements: [{ code: 'automatic', label: 'Automático', position: 1, is_active: true }],
    case_materials: [{ code: 'steel', label: 'Acero', position: 1, is_active: true }],
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Apertura de la página

type PageComponent = Parameters<AstroContainer['renderToResponse']>[0];
export type PageInit = {
  method?: string;
  query?: string;
  entries?: readonly Entry[];
  /** Cuerpo multipart (la subida); el tipo con su límite lo pone la propia petición. */
  multipart?: FormData;
  rawBody?: string;
  contentType?: string;
  /** `undefined` = el del sitio; `null` = sin cabecera `Origin`. */
  origin?: string | null;
  headers?: Record<string, string>;
  session?: unknown;
};

/** Renderiza la página de edición con la Container API y las rutas a las que reescribe la guardia. */
export async function openProduct(page: PageComponent, sb: SupabaseMock, init: PageInit = {}, id: string = PRODUCT_ID) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body: BodyInit | undefined = !hasBody ? undefined : (init.multipart ?? init.rawBody ?? new URLSearchParams([...(init.entries ?? [])]).toString());
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  const contentType = init.multipart ? undefined : (init.contentType ?? 'application/x-www-form-urlencoded');
  const headers: Record<string, string> = {
    ...(hasBody && contentType ? { 'content-type': contentType } : {}),
    ...(hasBody && origin !== null ? { origin } : {}),
    cookie: COOKIE,
    ...init.headers,
  };
  const request = new Request(`${ORIGIN}/admin/productos/${id}${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  container.insertPageRoute('/admin/sin-permiso', SinPermiso);
  container.insertPageRoute('/admin/no-disponible', NoDisponible);
  container.insertPageRoute('/404', NotFound);
  const session = 'session' in init ? init.session : SESSION;
  const res = await container.renderToResponse(page, {
    request,
    params: { product_id: id },
    locals: { session: session as App.Locals['session'], supabase: sb as unknown as App.Locals['supabase'] },
    routeType: 'page',
  });
  const html = await res.clone().text();
  return { res, html, doc: parseHtml(html) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lectura del marcado de ImageManager

const lower = (s: string): string => s.toLowerCase();
/** Nombre accesible aproximado de un control: `aria-label` o su texto. */
export const nameOf = (el: Element): string => (el.getAttribute('aria-label') ?? text(el)).trim();

/** Formularios de la sección de imágenes: todos menos el principal y los del panel de publicación. */
export function imageForms(doc: ParentNode): HTMLFormElement[] {
  return ([...doc.querySelectorAll('form')] as HTMLFormElement[]).filter((f) => {
    if (f.id === 'product-form') return false;
    const action = serialize(f).find(([k]) => k === '_action')?.[ONE] ?? '';
    return action.startsWith('image-');
  });
}

export const actionOf = (form: Element): string => serialize(form).find(([k]) => k === '_action')?.[ONE] ?? '';
/** Entradas que enviaría el navegador al pulsar «enviar» en ese formulario (el botón con nombre se suma). */
export const entriesFor = (form: Element, submitter?: Element): Entry[] => {
  const named = submitter?.getAttribute('name');
  return [...serialize(form), ...(named ? ([[named, submitter?.getAttribute('value') ?? '']] as Entry[]) : [])];
};
export const entry = (entries: readonly Entry[], name: string): string | undefined => entries.find(([k]) => k === name)?.[ONE];
// Acepta un UUID en minúsculas como "a1111111-1111-4111-8111-111111111111"; rechaza "a1111111" o un nombre de archivo.
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&testString=a1111111-1111-4111-8111-111111111111
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** La entrada (distinta de `_action`) que lleva el id de una imagen. */
export const imageIdIn = (entries: readonly Entry[]): string | undefined => entries.find(([k, v]) => k !== '_action' && uuidLike.test(v))?.[ONE];
/** El nombre del campo del id de la imagen en un formulario. */
export const idFieldOf = (entries: readonly Entry[]): string => entries.find(([k, v]) => k !== '_action' && uuidLike.test(v))?.[NONE] ?? '';
/** Las entradas que no son `_action` ni el id: aquí, la dirección del movimiento. */
export const rest = (entries: readonly Entry[]): Entry[] => entries.filter(([k, v]) => k !== '_action' && !uuidLike.test(v));

/** Formularios de una acción cuyo campo de id vale `imageId` (o todos los de esa acción si no se indica). */
export function formsFor(doc: ParentNode, action: string, imageId?: string): HTMLFormElement[] {
  return imageForms(doc).filter((f) => actionOf(f) === action && (imageId === undefined || imageIdIn(serialize(f)) === imageId));
}
export const submitterOf = (form: Element): Element | null => form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');

/** Entradas de «Subir» o «Bajar» (la dirección la decide el marcado) de una imagen: se elige por el nombre accesible del botón. */
export function moveEntries(doc: ParentNode, imageId: string, word: 'subir' | 'bajar'): Entry[] {
  const form = formsFor(doc, 'image-move', imageId).find((f) => lower(nameOf(submitterOf(f) as Element)).includes(word));
  if (!form) throw new Error(`no hay un formulario image-move «${word}» para ${imageId}`);
  return entriesFor(form, submitterOf(form) ?? undefined);
}
/** Entradas de una acción de imagen (alt, borrar) con campos de texto sustituidos por `over` por nombre. */
export function actionEntries(doc: ParentNode, action: string, imageId: string, over: Record<string, string> = {}): Entry[] {
  const form = formsFor(doc, action, imageId)[NONE];
  if (!form) throw new Error(`no hay un formulario ${action} para ${imageId}`);
  return entriesFor(form, submitterOf(form) ?? undefined).map(([k, v]): Entry => [k, k in over ? over[k] : v]);
}
/** Formulario de subida: el que lleva el `<input type="file">`. */
export const uploadForm = (doc: ParentNode): HTMLFormElement | null => ([...doc.querySelectorAll('form')] as HTMLFormElement[]).find((f) => f.querySelector('input[type="file"]')) ?? null;
export const fileFieldName = (doc: ParentNode): string => uploadForm(doc)?.querySelector('input[type="file"]')?.getAttribute('name') ?? 'file';
/** Campo de texto del `alt` de la subida (el único `input[type=text]` del formulario de subida). */
export const uploadAltName = (doc: ParentNode): string => uploadForm(doc)?.querySelector('input:not([type="file"]):not([type="hidden"])')?.getAttribute('name') ?? 'alt';

/** Cuerpo multipart tal como lo enviaría el navegador al subir un archivo. */
export function uploadBody(doc: ParentNode, file: File | null, alt: string, extra: Entry[] = []): FormData {
  const fd = new FormData();
  const action = actionOf(uploadForm(doc) as Element);
  fd.append('_action', action);
  fd.append(uploadAltName(doc), alt);
  if (file) fd.append(fileFieldName(doc), file);
  extra.forEach(([k, v]) => fd.append(k, v));
  return fd;
}

/** Texto que el administrador lee en avisos y errores (`role="alert"`, `.error`, `Notice`). */
export const pageText = (doc: Document): string => text(doc.body);

/** Respuestas con el mismo aspecto que las del backend (formato común). */
export const errorOf = (status: number, code: string, details: unknown = null): Response => apiError(status, code, details);
export { BACKEND_MSG as MSG_FROM_BACKEND };
export const noLeaks = (html: string): void => {
  [BACKEND_MSG, 'Mensaje del servidor en inglés.', 'api.test', 'ECONNREFUSED', 'Traceback'].forEach((l) => {
    if (html.includes(l)) throw new Error(`la pantalla filtra «${l}»`);
  });
};
