// Ayudante E2E de T-148: productos de prueba `QA-T148-*` con imágenes generadas por la suite, contra el backend y la BD locales reales, y su limpieza.
// Nunca toca otros productos: todo borrado exige que el SKU empiece por `QA-T148-` y por el prefijo de esta ejecución (los 12 relojes de la semilla,
// `DEMO-*`, no se tocan). En Storage solo se borran, por la API, las imágenes de esos productos. La fila se borra con `docker exec … psql`.
import { execFileSync } from 'node:child_process';
import { jpegBytes, pngBytes, RGB_BLUE, webpBytes } from '../../tests/helpers/t148-files';
import type { QaUser } from './admin';
import { api, unique, type ApiProduct } from './t147';

export { activeCategories, api, getProduct, unique, type ApiProduct } from './t147';

export const SKU_PREFIX = 'QA-T148-';
const DB_CONTAINER = 'supabase_db_valmont';
const PAGE_SIZE = 48;
const MAX_PAGES = 10;
const PRICE_CENTS = 125000;
const CREATED = 201;
const OK = 200;
const NO_CONTENT = 204;
const TIMEOUT_MS = 30_000;
const ONE = 1;
const COLOR_STEP = 40;
const COLOR_DOUBLE = 80;
const BYTE = 256;
const SMALL_SIDE = 48;
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza cualquier otra cosa (se interpola en SQL).
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&testString=3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cada archivo de pruebas y cada proyecto de Playwright (otro proceso) usa su propio prefijo: la limpieza de uno no borra los productos del otro. */
export const newRunPrefix = (): string => `${SKU_PREFIX}${unique()}-`;

/** Todas las URL de imagen que esta ejecución llegó a ver: al final se comprueba que Storage ya no las sirve. */
export const seenUrls = new Set<string>();

export type ApiImage = { id: string; url: string; alt: string };

/** Crea un producto de prueba por la API (borrador, publicable en cuanto tenga una imagen) con el SKU `<prefijo>-<etiqueta>`. */
export async function createProduct(user: QaUser, categoryId: string, prefix: string, over: Record<string, unknown> = {}): Promise<ApiProduct> {
  const tag = unique();
  const res = await api<ApiProduct>(user, 'POST', '/catalog/admin/products', {
    sku: `${prefix}${tag}`,
    slug: `qa-t148-${tag.toLowerCase()}`,
    name: `Reloj QA T148 ${tag}`,
    description: 'Producto de prueba del E2E de T-148.',
    category_id: categoryId,
    price: { amount: PRICE_CENTS, currency: 'PEN' },
    order_policy: 'stock',
    specs: [],
    ...over,
  });
  if (res.status !== CREATED) throw new Error(`no se pudo crear el producto de prueba: ${res.status}`);
  return res.body;
}

/** Sube una imagen por la API y devuelve la imagen creada. */
export async function uploadViaApi(user: QaUser, productId: string, data: Uint8Array, alt: string, name = 'qa.png', type = 'image/png'): Promise<ApiImage> {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(data)], { type }), name);
  form.append('alt', alt);
  const res = await api<ApiImage>(user, 'POST', `/catalog/admin/products/${productId}/images`, form);
  if (![OK, CREATED].includes(res.status)) throw new Error(`no se pudo subir la imagen de prueba: ${res.status}`);
  seenUrls.add(res.body.url);
  return res.body;
}

/** `n` imágenes de colores distintos (PNG de 48×48) con alt `<prefijo> <i>`. */
export async function uploadMany(user: QaUser, productId: string, n: number, prefix = 'QA imagen'): Promise<ApiImage[]> {
  return Array.from({ length: n }).reduce<Promise<ApiImage[]>>(async (prev, _, i) => {
    const done = await prev;
    const rgb = Uint8Array.from([(i * COLOR_STEP + COLOR_STEP) % BYTE, (i * COLOR_DOUBLE) % BYTE, (BYTE - i * COLOR_STEP) % BYTE]);
    const image = await uploadViaApi(user, productId, pngBytes({ width: SMALL_SIDE, height: SMALL_SIDE, rgb }), `${prefix} ${i + ONE}`);
    return [...done, image];
  }, Promise.resolve([]));
}

/** Imágenes del producto, en el orden que devuelve la API de administración. */
export async function imagesOf(user: QaUser, productId: string): Promise<ApiImage[]> {
  const res = await api<ApiProduct>(user, 'GET', `/catalog/admin/products/${productId}`);
  res.body.images.forEach((i) => seenUrls.add(i.url));
  return res.body.images;
}

/** Estado HTTP con el que Storage sirve una URL pública (200 = existe). */
export async function urlStatus(url: string): Promise<number> {
  const res = await fetch(url);
  await res.arrayBuffer();
  return res.status;
}

/** Los bytes de una URL pública de imagen. */
export async function urlBytes(url: string): Promise<{ status: number; type: string | null; data: Uint8Array }> {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type'), data: new Uint8Array(await res.arrayBuffer()) };
}

export const samples = { jpeg: jpegBytes, webp: webpBytes, png: () => pngBytes({ rgb: RGB_BLUE }) };

function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  }).trim();
}

/** Productos `QA-T148-*` que existen ahora (por la API de administración). */
export async function leftovers(user: QaUser): Promise<ApiProduct[]> {
  const found: ApiProduct[] = [];
  await Array.from({ length: MAX_PAGES }, (_, i) => i + ONE).reduce<Promise<void>>(async (prev, page) => {
    await prev;
    const res = await api<{ items: ApiProduct[] }>(user, 'GET', `/catalog/admin/products?page=${page}&page_size=${PAGE_SIZE}`);
    found.push(...(res.body?.items ?? []).filter((p) => p.sku.startsWith(SKU_PREFIX)));
  }, Promise.resolve());
  return found;
}

/**
 * Limpieza: despublica, borra las imágenes por la API (así Storage queda limpio) y borra las filas `<prefijo>*` (y solo ellas).
 * Devuelve cuántos productos quedaron (0 si Docker permitió borrar; si no, quedan como borradores y el traspaso lo anota).
 */
export async function cleanup(user: QaUser, prefix: string): Promise<number> {
  if (!prefix.startsWith(SKU_PREFIX) || prefix === SKU_PREFIX || prefix.includes("'")) throw new Error('prefijo de limpieza no válido');
  const items = (await leftovers(user)).filter((p) => p.sku.startsWith(prefix) && UUID.test(p.id));
  await items.reduce<Promise<void>>(async (prev, p) => {
    await prev;
    if (p.status === 'published') await api(user, 'POST', `/catalog/admin/products/${p.id}/unpublish`);
    await p.images.reduce<Promise<void>>(async (inner, img) => {
      await inner;
      seenUrls.add(img.url);
      const res = await api(user, 'DELETE', `/catalog/admin/products/${p.id}/images/${img.id}`);
      if (![NO_CONTENT, OK].includes(res.status)) console.warn(`T-148 limpieza: DELETE de imagen → ${res.status}`);
    }, Promise.resolve());
  }, Promise.resolve());
  try {
    const ids = items.map((p) => `'${p.id}'`).join(',');
    if (ids) {
      ['app.product_images', 'app.stock_movements', 'app.inventory_items'].forEach((t) => psql(`DELETE FROM ${t} WHERE product_id IN (${ids})`));
      psql(`DELETE FROM app.products WHERE id IN (${ids}) AND sku LIKE '${prefix}%'`);
    }
  } catch {
    // sin Docker o con dependencias: quedan como borradores
  }
  return (await leftovers(user)).filter((p) => p.sku.startsWith(prefix)).length;
}
