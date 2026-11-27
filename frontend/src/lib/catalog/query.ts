// Consulta del catálogo desde la URL (T-124). La URL es la fuente de verdad: aquí se valida con
// una lista cerrada de claves (N-3) y nunca se reenvía un parámetro desconocido a la API.
import type { AttributeValue, Category, ProductFilters, ProductSort } from '../api/catalog';
import { formatMoney } from '../format';

export type CatalogQuery = {
  q?: string;
  category?: string;
  movement?: string;
  case_material?: string;
  price_min_soles?: number; // soles enteros en la URL
  price_max_soles?: number;
  available?: boolean;
  sort?: ProductSort;
  page: number;
};

export const PAGE_SIZE = 24;
const SORTS: readonly ProductSort[] = ['newest', 'price_asc', 'price_desc', 'relevance'];
// Slug de la API: acepta "oro-rosa" y "automatic"; rechaza "Oro Rosa" y "../x".
// Prueba: https://regex101.com/?regex=%5E%5Ba-z0-9%5D%5Ba-z0-9_-%5D%7B0%2C63%7D%24
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOLES = 100_000_000;
const CENTS = 100; // céntimos por sol (D-015)
const MAX_Q = 100; // el servidor responde 422 por encima

export function parseCatalogQuery(sp: URLSearchParams): { query: CatalogQuery; filters: ProductFilters; invalid: boolean } {
  let invalid = false;
  const get = (k: string) => sp.get(k)?.trim() || undefined;
  const slug = (k: string) => {
    const v = get(k);
    if (v === undefined) return undefined;
    if (SLUG.test(v)) return v;
    invalid = true;
    return undefined;
  };
  const soles = (k: string) => {
    const v = get(k);
    if (v === undefined) return undefined;
    // Entero sin signo ni decimales: acepta "1500"; rechaza "-5" y "15.5".
    // Prueba: https://regex101.com/?regex=%5E%5Cd%7B1%2C9%7D%24
    const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (n <= MAX_SOLES) return n;
    invalid = true;
    return undefined;
  };

  const query: Partial<CatalogQuery> & { page: number } = { page: 1 };
  // Quita control: acepta "ab" y devuelve "ab"; deja "reloj" igual.
  // Prueba: https://regex101.com/?regex=%5B%5Cx00-%5Cx1f%5Cx7f%5D
  // Sin caracteres de control (0-31 y 127) antes de recortar; si queda vacía, se trata como ausente.
  const q = (get('q') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_Q);
  if (q) query.q = q;
  const parsed = {
    category: slug('category'),
    movement: slug('movement'),
    case_material: slug('case_material'),
    price_min_soles: soles('price_min'),
    price_max_soles: soles('price_max'),
  };
  Object.entries(parsed).forEach(([k, v]) => v !== undefined && Object.assign(query, { [k]: v }));

  const avail = get('available');
  if (avail === '1' || avail === 'true') query.available = true;
  else if (avail !== undefined && avail !== '0' && avail !== 'false') invalid = true;

  const sort = get('sort');
  if (sort !== undefined) {
    // `relevance` sin `q` es 422 en el servidor (CATALOG-R8).
    if ((SORTS as readonly string[]).includes(sort) && (sort !== 'relevance' || query.q)) query.sort = sort as ProductSort;
    else invalid = true;
  }

  const page = get('page');
  if (page !== undefined) {
    // Entero positivo: acepta "2"; rechaza "abc" y "-1".
    // Prueba: https://regex101.com/?regex=%5E%5Cd%7B1%2C6%7D%24
    const n = /^\d{1,6}$/.test(page) ? Number(page) : 0;
    if (n >= 1) query.page = n;
    else invalid = true;
  }

  const filters: ProductFilters = { page: query.page, page_size: PAGE_SIZE };
  if (query.q) filters.q = query.q;
  if (query.category) filters.category = query.category;
  if (query.movement) filters.movement = query.movement;
  if (query.case_material) filters.case_material = query.case_material;
  if (query.price_min_soles !== undefined) filters.price_min = query.price_min_soles * CENTS;
  if (query.price_max_soles !== undefined) filters.price_max = query.price_max_soles * CENTS;
  if (query.available) filters.available = true;
  if (query.sort) filters.sort = query.sort;
  return { query, filters, invalid };
}

export function catalogHref(q: Partial<CatalogQuery>): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.category) p.set('category', q.category);
  if (q.movement) p.set('movement', q.movement);
  if (q.case_material) p.set('case_material', q.case_material);
  if (q.price_min_soles !== undefined) p.set('price_min', String(q.price_min_soles));
  if (q.price_max_soles !== undefined) p.set('price_max', String(q.price_max_soles));
  if (q.available) p.set('available', '1');
  if (q.sort) p.set('sort', q.sort);
  if (q.page && q.page > 1) p.set('page', String(q.page));
  const s = p.toString();
  return s ? `/relojes?${s}` : '/relojes';
}

export function activeChips(
  q: CatalogQuery,
  lookups: { categories: Category[]; movements: AttributeValue[]; case_materials: AttributeValue[] },
): { label: string; removeHref: string }[] {
  // Quitar un filtro regenera la URL sin él y sin `page`.
  const without = (...keys: (keyof CatalogQuery)[]) => {
    const rest: Partial<CatalogQuery> = { ...q, page: 1 };
    keys.forEach((k) => delete rest[k]);
    return catalogHref(rest);
  };
  const soles = (n: number) => formatMoney({ amount: n * CENTS, currency: 'PEN' });
  const chips: { label: string; removeHref: string }[] = [];
  if (q.q) chips.push({ label: `Búsqueda: ${q.q}`, removeHref: q.sort === 'relevance' ? without('q', 'sort') : without('q') });
  if (q.category)
    chips.push({ label: lookups.categories.find((c) => c.slug === q.category)?.name ?? q.category, removeHref: without('category') });
  if (q.movement)
    chips.push({ label: lookups.movements.find((m) => m.code === q.movement)?.label ?? q.movement, removeHref: without('movement') });
  if (q.case_material)
    chips.push({
      label: lookups.case_materials.find((m) => m.code === q.case_material)?.label ?? q.case_material,
      removeHref: without('case_material'),
    });
  if (q.price_min_soles !== undefined) chips.push({ label: `Desde ${soles(q.price_min_soles)}`, removeHref: without('price_min_soles') });
  if (q.price_max_soles !== undefined) chips.push({ label: `Hasta ${soles(q.price_max_soles)}`, removeHref: without('price_max_soles') });
  if (q.available) chips.push({ label: 'Solo disponibles', removeHref: without('available') });
  return chips;
}
