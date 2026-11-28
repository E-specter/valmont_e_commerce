// Ayudante E2E de T-147: productos de prueba `QA-T147-*` contra el backend y la BD locales reales, y su limpieza.
// Nunca toca otros productos: todo borrado exige que el SKU empiece por `QA-T147-` (los 12 relojes de la semilla, `DEMO-*`, no se tocan).
// El catálogo no tiene API de borrado (CATALOG-R4): se despublica y se quitan las imágenes por la API; la fila se borra con `docker exec … psql`
// (mismo contenedor que usa `helpers/admin.ts`). Si Docker no responde, los productos quedan como BORRADORES (no visibles en la tienda).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API, type QaUser } from './admin';

export const SKU_PREFIX = 'QA-T147-';
const DB_CONTAINER = 'supabase_db_valmont';
const RADIX = 36;
const SKIP = 2;
const LEN = 6;
const PAGE_SIZE = 48;
const MAX_PAGES = 10;
const PRICE_CENTS = 125000;
const CREATED = 201;
const OK = 200;
const TIMEOUT_MS = 30_000;
const PNG = fileURLToPath(new URL('./fixtures/qa-t147.png', import.meta.url)); // PNG RGB de 64×64 de un solo color
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza cualquier otra cosa (se interpola en SQL).
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&testString=3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ApiProduct = {
  id: string; slug: string; sku: string; name: string; status: 'draft' | 'published'; description: string; order_policy: string; lead_time_days: number | null;
  price: { amount: number; currency: string }; category_id: string; movement_code: string | null; case_material_code: string | null; case_diameter_mm: number | null;
  water_resistance_m: number | null; specs: { label: string; value: string }[]; images: { id: string; url: string; alt: string }[]; updated_at: string;
};

/** Sufijo único por ejecución y por prueba, solo letras y números. */
export const unique = (): string => `${Date.now().toString(RADIX)}${Math.random().toString(RADIX).slice(SKIP, LEN)}`.toUpperCase();

/** Cada ejecución (y cada proyecto de Playwright, que es otro proceso) usa su propio prefijo: la limpieza de uno no borra los productos del otro. */
export const RUN_PREFIX = `${SKU_PREFIX}${unique()}-`;

function payload(body: unknown): { headers: Record<string, string>; body: BodyInit | undefined } {
  if (body === undefined) return { headers: {}, body: undefined };
  if (body instanceof FormData) return { headers: {}, body };
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Llamada a la API real con el token del administrador. */
export async function api<T>(user: QaUser, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const sent = payload(body);
  // Un socket reutilizado que el servidor ya cerró (ECONNRESET) bajo carga: se reintenta una vez; la petición no llegó a procesarse.
  const send = (): Promise<Response> => fetch(`${API}/api/v1${path}`, { method, headers: { authorization: `Bearer ${user.token}`, ...sent.headers }, body: sent.body });
  const res = await send().catch(() => send());
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export const getProduct = async (user: QaUser, id: string): Promise<ApiProduct> => (await api<ApiProduct>(user, 'GET', `/catalog/admin/products/${id}`)).body;

export async function activeCategories(user: QaUser): Promise<{ id: string; name: string; slug: string; is_active: boolean }[]> {
  const list = (await api<{ id: string; name: string; slug: string; is_active: boolean }[]>(user, 'GET', '/catalog/admin/categories')).body;
  return list.filter((c) => c.is_active);
}

/** Crea un producto de prueba por la API (borrador) con el SKU `QA-T147-<sufijo>`. */
export async function createProductViaApi(user: QaUser, categoryId: string, over: Record<string, unknown> = {}): Promise<ApiProduct> {
  const tag = unique();
  const res = await api<ApiProduct>(user, 'POST', '/catalog/admin/products', {
    sku: `${RUN_PREFIX}${tag}`,
    name: `Reloj QA T147 ${tag}`,
    description: 'Producto de prueba del E2E de T-147.',
    category_id: categoryId,
    price: { amount: PRICE_CENTS, currency: 'PEN' },
    order_policy: 'stock',
    specs: [],
    ...over,
  });
  if (res.status !== CREATED) throw new Error(`no se pudo crear el producto de prueba: ${res.status}`);
  return res.body;
}

/** Sube una imagen por la API (la interfaz de imágenes es de T-148). */
export async function addImage(user: QaUser, productId: string, alt = 'Imagen de prueba QA T-147'): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(readFileSync(PNG))], { type: 'image/png' }), 'qa-t147.png');
  form.append('alt', alt);
  const res = await api(user, 'POST', `/catalog/admin/products/${productId}/images`, form);
  if (![OK, CREATED].includes(res.status)) throw new Error(`no se pudo subir la imagen de prueba: ${res.status}`);
}

function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  }).trim();
}

/** Productos `QA-T147-*` que existen ahora (por la API de administración). */
export async function leftovers(user: QaUser): Promise<ApiProduct[]> {
  const found: ApiProduct[] = [];
  await Array.from({ length: MAX_PAGES }, (_, i) => i + 1).reduce<Promise<void>>(async (prev, page) => {
    await prev;
    const res = await api<{ items: ApiProduct[] }>(user, 'GET', `/catalog/admin/products?page=${page}&page_size=${PAGE_SIZE}`);
    found.push(...(res.body?.items ?? []).filter((p) => p.sku.startsWith(SKU_PREFIX)));
  }, Promise.resolve());
  return found;
}

/**
 * Limpieza: despublica, quita las imágenes por la API y borra las filas `QA-T147-*` (y solo ellas). Devuelve cuántos quedaron
 * (0 si Docker permitió borrar; si no, quedan como borradores y el traspaso lo anota).
 */
export async function cleanup(user: QaUser): Promise<number> {
  const items = (await leftovers(user)).filter((p) => p.sku.startsWith(RUN_PREFIX) && UUID.test(p.id));
  await items.reduce<Promise<void>>(async (prev, p) => {
    await prev;
    if (p.status === 'published') await api(user, 'POST', `/catalog/admin/products/${p.id}/unpublish`);
    await p.images.reduce<Promise<void>>(async (inner, img) => {
      await inner;
      await api(user, 'DELETE', `/catalog/admin/products/${p.id}/images/${img.id}`);
    }, Promise.resolve());
  }, Promise.resolve());
  try {
    const ids = items.map((p) => `'${p.id}'`).join(',');
    if (ids) {
      ['app.product_images', 'app.stock_movements', 'app.inventory_items'].forEach((t) => psql(`DELETE FROM ${t} WHERE product_id IN (${ids})`));
      psql(`DELETE FROM app.products WHERE id IN (${ids}) AND sku LIKE '${SKU_PREFIX}%'`);
    }
  } catch {
    // sin Docker o con dependencias: quedan como borradores
  }
  return (await leftovers(user)).filter((p) => p.sku.startsWith(RUN_PREFIX)).length;
}
