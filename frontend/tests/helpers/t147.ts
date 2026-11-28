// Ayudantes de T-147 (formulario de producto y publicación): fábricas de datos, serialización de un formulario como lo haría el navegador
// y un backend de catálogo simulado con las reglas del contrato (catalog SPEC §7). Sin red.
import { vi } from 'vitest';
import type { AdminAttributeValue, AdminCategory, AdminProduct } from '../../src/lib/api/admin-catalog';
import type { ProductFormValues } from '../../src/lib/admin/product-form';
import { PRODUCT_ID } from './t144';
import { json, profile } from './t129';

export { PRODUCT_ID };
export const NEW_ID = '5d1e7a3c-2b4f-4a6d-9e80-abcdef012345';
export const CATEGORY_ID = '2c9d1e4b-3a5f-4b7c-8d90-0a1b2c3d4e5f';
export const OTHER_CATEGORY_ID = '4e0f2a6d-5c7b-4d9e-8fa1-1b2c3d4e5f60';
/** Texto del `msg` del backend: nunca debe llegar a la pantalla (RT-B9). */
export const BACKEND_MSG = 'MSG-DEL-BACKEND-QX';
export const API_V1 = 'http://api.test:8000/api/v1';
export const NO_STORE = 'private, no-store';
export const SOLES_CENTS = 125050; // 'S/ 1250.50'
const ST_CREATED = 201;
const ST_NOT_FOUND = 404;
const ST_NOT_ALLOWED = 405;
const ST_INVALID = 422;
const POSITION_FIRST = 1;
const POSITION_SECOND = 2;
const DIAMETER_MM = 38.5;
const WATER_M = 50;
const LEAD_DAYS = 30;
const ONE = 1;
const API_PREFIX = '/api/v1';
const PARTS_ONE = 5; // ['', 'catalog', 'admin', 'products', '<id>']: el id es el índice 4
const PARTS_ACTION = 6; // … + 'publish'

export const CATEGORIES: AdminCategory[] = [
  { id: CATEGORY_ID, slug: 'clasicos', name: 'Clásicos', description: null, position: POSITION_FIRST, is_active: true },
  { id: OTHER_CATEGORY_ID, slug: 'deportivos', name: 'Deportivos', description: null, position: POSITION_SECOND, is_active: true },
];
export const MOVEMENTS: AdminAttributeValue[] = [
  { code: 'automatic', label: 'Automático', position: POSITION_FIRST, is_active: true },
  { code: 'manual', label: 'Manual', position: POSITION_SECOND, is_active: true },
];
export const CASE_MATERIALS: AdminAttributeValue[] = [
  { code: 'steel', label: 'Acero', position: POSITION_FIRST, is_active: true },
  { code: 'gold', label: 'Oro', position: POSITION_SECOND, is_active: true },
];

/** Producto de administración completo (borrador), con todos los opcionales. */
export function adminProduct(over: Partial<AdminProduct> = {}): AdminProduct {
  return {
    id: PRODUCT_ID,
    slug: 'qa-heritage-38',
    sku: 'QA-T147-001',
    name: 'Heritage 38',
    category: { slug: 'clasicos', name: 'Clásicos' },
    price: { amount: SOLES_CENTS, currency: 'PEN' },
    movement: { code: 'automatic', label: 'Automático' },
    case_material: { code: 'steel', label: 'Acero' },
    case_diameter_mm: DIAMETER_MM,
    water_resistance_m: WATER_M,
    main_image: null,
    description: 'Un clásico de líneas puras.\nCaja de acero.',
    specs: [
      { label: 'Calibre', value: 'VM-01' },
      { label: 'Reserva de marcha', value: '42 h' },
    ],
    images: [],
    status: 'draft',
    order_policy: 'made_to_order',
    lead_time_days: LEAD_DAYS,
    category_id: CATEGORY_ID,
    movement_code: 'automatic',
    case_material_code: 'steel',
    published_at: null,
    created_at: '2026-11-20T15:00:00Z',
    updated_at: '2026-11-21T15:00:00Z',
    ...over,
  };
}

/** Valores del formulario (todo texto). */
export function formValues(over: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    sku: 'QA-T147-001',
    slug: 'qa-heritage-38',
    name: 'Heritage 38',
    description: 'Un clásico de líneas puras.',
    category_id: CATEGORY_ID,
    price: '1250.50',
    order_policy: 'made_to_order',
    lead_time_days: '30',
    movement_code: 'automatic',
    case_material_code: 'steel',
    case_diameter_mm: '38.5',
    water_resistance_m: '50',
    specs: [
      { label: 'Calibre', value: 'VM-01' },
      { label: 'Reserva de marcha', value: '42 h' },
    ],
    ...over,
  };
}

/** Los 12 campos escalares del formulario (`name` = clave de `ProductFormValues`). */
export const SCALAR_FIELDS = [
  'sku', 'slug', 'name', 'description', 'category_id', 'price', 'order_policy', 'lead_time_days', 'movement_code', 'case_material_code',
  'case_diameter_mm', 'water_resistance_m',
] as const;
/** Nombres que un formulario de producto nunca debe enviar (RT-B3 · criterio «nunca envía status, id, published_at ni images»). */
export const FORBIDDEN_NAMES = ['status', 'id', 'published_at', 'images', 'user_id', 'role', 'currency', 'amount', 'created_at', 'updated_at'];

export type Entry = [string, string];

/** Serializa los controles con nombre de un contenedor como lo haría el navegador al enviar (sin botones de envío). */
export function serialize(scope: ParentNode): Entry[] {
  const out: Entry[] = [];
  scope.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    if (el.hasAttribute('disabled')) return;
    const name = el.getAttribute('name') as string;
    if (el.tagName === 'SELECT') {
      const options = [...el.querySelectorAll('option')];
      const chosen = options.find((o) => o.hasAttribute('selected')) ?? options.find((o) => !o.hasAttribute('disabled'));
      if (chosen) out.push([name, chosen.getAttribute('value') ?? (chosen.textContent ?? '').trim()]);
      return;
    }
    if (el.tagName === 'TEXTAREA') {
      // Como el analizador HTML, un salto inicial no cuenta.
      const body = el.textContent ?? '';
      out.push([name, body.startsWith('\n') ? body.slice(ONE) : body]);
      return;
    }
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if ((el as HTMLInputElement).checked ?? el.hasAttribute('checked')) out.push([name, el.getAttribute('value') ?? 'on']);
      return;
    }
    if (type === 'submit' || type === 'button' || type === 'file') return;
    out.push([name, (el as HTMLInputElement).value ?? el.getAttribute('value') ?? '']);
  });
  return out;
}

/** FormData con las entradas (los nombres repetidos se conservan en orden). */
export function toFormData(entries: readonly Entry[]): FormData {
  const fd = new FormData();
  entries.forEach(([k, v]) => fd.append(k, v));
  return fd;
}

/** Sustituye el valor de todas las entradas con ese nombre (o la añade si no hay). */
export function setEntry(entries: readonly Entry[], name: string, value: string): Entry[] {
  const found = entries.some(([k]) => k === name);
  return found ? entries.map(([k, v]): Entry => (k === name ? [k, value] : [k, v])) : [...entries, [name, value]];
}
export function setEntries(entries: readonly Entry[], changes: Record<string, string>): Entry[] {
  return Object.entries(changes).reduce<Entry[]>((acc, [k, v]) => setEntry(acc, k, v), [...entries]);
}
export const without = (entries: readonly Entry[], ...names: string[]): Entry[] => entries.filter(([k]) => !names.includes(k));
export const valueOf = (entries: readonly Entry[], name: string): string | undefined => entries.find(([k]) => k === name)?.[1];
/** Entradas que no son escalares ni `_action`: las del editor de especificaciones (su nombre lo decide el componente). */
export const specEntries = (entries: readonly Entry[]): Entry[] => entries.filter(([k]) => !(SCALAR_FIELDS as readonly string[]).includes(k) && k !== '_action');
/** Cambia el valor de la primera entrada de especificación cuyo valor es `from`. */
export function changeSpecValue(entries: readonly Entry[], from: string, to: string): Entry[] {
  const idx = entries.findIndex(([k, v]) => v === from && specEntries([[k, v]]).length === 1);
  if (idx < 0) throw new Error(`no hay una entrada de especificación con el valor «${from}»`);
  return entries.map((e, i): Entry => (i === idx ? [e[0], to] : e));
}

// ---------------------------------------------------------------------------------------------------------------------
// Backend de catálogo simulado

export type CatalogCall = { method: string; path: string; url: string; auth: string | null; body: Record<string, unknown> | unknown[] | null; raw: string | null };
type Override = (c: CatalogCall) => Response | undefined | Promise<Response | undefined>;
export type CatalogBackendInit = {
  role?: string;
  product?: AdminProduct | null;
  categories?: AdminCategory[];
  movements?: AdminAttributeValue[];
  caseMaterials?: AdminAttributeValue[];
  override?: Override;
};

const notFound = (): Response => json({ error: { code: 'not_found', message: 'No existe.', details: null } }, ST_NOT_FOUND);

/**
 * `fetch` falso con las rutas de T-147: identity/me, categorías, atributos, producto (GET/PATCH), alta, publicar y despublicar.
 * Registra cada llamada con su cuerpo JSON. `override` fuerza una respuesta por llamada (409, 422, 5xx…).
 */
export function catalogBackend(init: CatalogBackendInit = {}) {
  const state = { product: init.product === undefined ? adminProduct() : init.product };
  const calls: CatalogCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, req?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const path = u.pathname.startsWith(API_PREFIX) ? u.pathname.slice(API_PREFIX.length) : u.pathname;
    const raw = typeof req?.body === 'string' ? req.body : null;
    const call: CatalogCall = {
      method: req?.method ?? 'GET', path, url, auth: new Headers(req?.headers).get('authorization'), body: raw ? (JSON.parse(raw) as CatalogCall['body']) : null, raw,
    };
    calls.push(call);
    const forced = await init.override?.(call);
    if (forced) return forced;
    const m = call.method;
    if (path === '/identity/me' && m === 'GET') return json(profile({ role: init.role ?? 'admin' }));
    if (path === '/catalog/admin/categories' && m === 'GET') return json(init.categories ?? CATEGORIES);
    if (path === '/catalog/admin/attributes' && m === 'GET') return json({ movements: init.movements ?? MOVEMENTS, case_materials: init.caseMaterials ?? CASE_MATERIALS });
    if (path === '/catalog/admin/products' && m === 'POST') {
      const b = (call.body ?? {}) as Record<string, unknown>;
      return json(adminProduct({ id: NEW_ID, sku: String(b.sku ?? ''), name: String(b.name ?? ''), status: 'draft' }), ST_CREATED);
    }
    // '/catalog/admin/products/<id>' o '/catalog/admin/products/<id>/publish|unpublish'; cualquier otra ruta (p. ej. '/images') no existe.
    const parts = path.split('/');
    const sub = parts[PARTS_ONE] ?? '';
    const isOne = path.startsWith('/catalog/admin/products/') && (parts.length === PARTS_ONE || (parts.length === PARTS_ACTION && ['publish', 'unpublish'].includes(sub)));
    if (!isOne) return notFound();
    const p = state.product;
    if (!p || parts[PARTS_ONE - ONE] !== p.id) return notFound();
    if (m === 'GET' && !sub) return json(p);
    if (m === 'PATCH' && !sub) return json(p);
    if (m === 'POST' && sub === 'publish') return json({ ...p, status: 'published' });
    if (m === 'POST' && sub === 'unpublish') return json({ ...p, status: 'draft' });
    return json({ error: { code: 'method_not_allowed', message: 'No permitido.', details: null } }, ST_NOT_ALLOWED);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    state,
    calls,
    fetchMock,
    /** Llamadas de escritura (todo menos GET). */
    writes: (): CatalogCall[] => calls.filter((c) => c.method !== 'GET'),
    /** Llamadas a /catalog/… (las que un 404 por UUID inválido no debe hacer). */
    catalog: (): CatalogCall[] => calls.filter((c) => c.path.startsWith('/catalog')),
    patches: (): CatalogCall[] => calls.filter((c) => c.method === 'PATCH'),
    posts: (): CatalogCall[] => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/catalog')),
  };
}

export const apiError = (status: number, code: string, details: unknown = null): Response =>
  json({ error: { code, message: 'Mensaje del servidor en inglés.', details } }, status);
export const validation = (...details: { loc: (string | number)[]; type: string }[]): Response =>
  apiError(ST_INVALID, 'validation_error', details.map((d) => ({ ...d, msg: BACKEND_MSG })));
