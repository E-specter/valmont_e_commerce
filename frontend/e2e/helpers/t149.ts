// Ayudante E2E de T-149: productos de prueba `QA-T149-*` contra el backend y la BD locales reales, y su limpieza.
// Nunca toca otros productos: todo borrado exige que el SKU empiece por `QA-T149-` (los 12 relojes de la semilla, `DEMO-*`, no se tocan).
// El catálogo no tiene API de borrado: la fila se borra con `docker exec … psql` (mismo contenedor que `helpers/admin.ts`).
// Si Docker no responde, los productos quedan como BORRADORES (no visibles en la tienda) y la suite lo avisa.
import { execFileSync } from 'node:child_process';
import type { QaUser } from './admin';
import { api, unique, type ApiProduct } from './t147';

export { activeCategories } from './t147';
export type { ApiProduct };

export const SKU_PREFIX = 'QA-T149-';
export const RUN_PREFIX = `${SKU_PREFIX}${unique()}-`;
/** Palabra única de la ejecución para buscar por texto: el `q` del backend es de texto completo (tsvector), no una subcadena del SKU. */
export const MARK = `qa149${unique().toLowerCase()}`;
const DB_CONTAINER = 'supabase_db_valmont';
const PAGE_SIZE = 48;
const MAX_PAGES = 10;
export const PRICE_CENTS = 125000;
const CREATED = 201;
const TIMEOUT_MS = 30_000;
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza cualquier otra cosa (se interpola en SQL).
// https://regex101.com/?regex=%5E%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D%24&testString=3f1c2a9e-5b7d-4c1e-9a10-0123456789ab
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Crea un borrador de prueba por la API con el SKU `QA-T149-<ejecución>-<etiqueta>`. */
export async function createDraft(user: QaUser, categoryId: string, tag: string, over: Record<string, unknown> = {}): Promise<ApiProduct> {
  const res = await api<ApiProduct>(user, 'POST', '/catalog/admin/products', {
    sku: `${RUN_PREFIX}${tag}`,
    slug: `${RUN_PREFIX}${tag}`.toLowerCase(), // único por ejecución: el slug derivado del nombre chocaría con restos de otra
    name: `Reloj ${MARK} ${tag.toLowerCase()}`,
    description: 'Producto de prueba del E2E de T-149.',
    category_id: categoryId,
    price: { amount: PRICE_CENTS, currency: 'PEN' },
    order_policy: 'stock',
    specs: [],
    ...over,
  });
  if (res.status !== CREATED) throw new Error(`no se pudo crear el producto de prueba: ${res.status}`);
  return res.body;
}

function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  }).trim();
}

/** Todos los productos que ve el administrador (recorre las páginas), con el filtro opcional de la API. */
export async function allProducts(user: QaUser, query = ''): Promise<ApiProduct[]> {
  const found: ApiProduct[] = [];
  await Array.from({ length: MAX_PAGES }, (_, i) => i + 1).reduce<Promise<void>>(async (prev, page) => {
    await prev;
    const res = await api<{ items: ApiProduct[] }>(user, 'GET', `/catalog/admin/products?page=${page}&page_size=${PAGE_SIZE}${query}`);
    found.push(...(res.body?.items ?? []));
  }, Promise.resolve());
  return found;
}

/** Productos `QA-T149-*` que existen ahora (sin `q`: el texto completo no sirve para buscar por prefijo de SKU). */
export const leftovers = async (user: QaUser): Promise<ApiProduct[]> => (await allProducts(user)).filter((p) => p.sku.startsWith(SKU_PREFIX));

/** Limpieza: borra las filas `QA-T149-<ejecución>-*` (y solo ellas). Devuelve cuántas quedaron (0 = todo borrado). */
export async function cleanup(user: QaUser): Promise<number> {
  const items = (await leftovers(user)).filter((p) => p.sku.startsWith(RUN_PREFIX) && UUID.test(p.id));
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
