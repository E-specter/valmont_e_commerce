// Formulario de producto del backoffice (T-147). Módulo neutro: sin astro:env ni lib/server.
// Solo valida formato; las reglas de negocio (plazo según política, publicación) son del backend.
import type { AdminAttributeValue, AdminCategory, AdminProduct, OrderPolicy, ProductInput, ProductPatch } from '../api/admin-catalog';
import { ApiError } from '../api/http';
import { fieldErrors } from './errors';
import { MSG_FIELD_INVALID, MSG_FIELD_REQUIRED, MSG_SKU_TAKEN, MSG_SLUG_LOCKED, MSG_SLUG_TAKEN, MSG_UNAVAILABLE } from './messages';
import { parseSoles, solesInput } from './money';

export type ProductFormValues = {
  sku: string;
  slug: string;
  name: string;
  description: string;
  category_id: string;
  price: string;
  order_policy: OrderPolicy;
  lead_time_days: string;
  movement_code: string;
  case_material_code: string;
  case_diameter_mm: string;
  water_resistance_m: string;
  specs: { label: string; value: string }[];
};
export type ProductFormErrors = Partial<Record<keyof ProductFormValues | 'form', string>>;

export const MSG_TOO_LARGE = 'Los datos enviados son demasiado grandes.';
export const MSG_NO_CHANGES = 'Sin cambios: no hay nada que guardar.';
export const MSG_SPEC_PAIR = 'Completa la etiqueta y el valor, o deja la fila vacía.';
export const MSG_SAVE_FIRST = 'Guarda el producto para añadir imágenes.';
export const MSG_PUBLISH_BLOCKED = 'Para publicar falta completar:';
export const MAX_SPECS = 40;
const CONFLICT = 409;
const TOO_LARGE = 413;
const UNPROCESSABLE = 422;
const SERVER_ERROR = 500;

const POLICIES: readonly OrderPolicy[] = ['stock', 'made_to_order', 'backorder'];
// Entero sin signo de hasta 5 dígitos: acepta "45", rechaza "4.5" o "-1".
// https://regex101.com/?regex=%5E%5B0-9%5D%7B1%2C5%7D%24&testString=45
const INT = /^[0-9]{1,5}$/;
// Hasta 3 enteros y un decimal: acepta "38.5", rechaza "38.55" o "38,5".
// https://regex101.com/?regex=%5E%5B0-9%5D%7B1%2C3%7D(%3F%3A%5C.%5B0-9%5D)%3F%24&testString=38.5
const DECIMAL_1 = /^[0-9]{1,3}(?:\.[0-9])?$/;

export const EMPTY_PRODUCT_VALUES: ProductFormValues = {
  sku: '', slug: '', name: '', description: '', category_id: '', price: '', order_policy: 'stock',
  lead_time_days: '', movement_code: '', case_material_code: '', case_diameter_mm: '', water_resistance_m: '', specs: [],
};

const text = (v: FormDataEntryValue | null) => (typeof v === 'string' ? v.trim() : '');
// El navegador envía los saltos de un <textarea> como CRLF: se normalizan a LF antes de validar y comparar.
const multiline = (v: FormDataEntryValue | null) => text(v).replace(/\r\n?/g, '\n');
const blankPair = (s: { label: string; value: string }) => !s.label && !s.value;

/** Lee solo los campos conocidos; `status`, `id`, `images` y demás se ignoran. */
export function readProductForm(fd: FormData): ProductFormValues {
  const policy = text(fd.get('order_policy'));
  const labels = fd.getAll('spec_label').map(text);
  const values = fd.getAll('spec_value').map(text);
  return {
    sku: text(fd.get('sku')),
    slug: text(fd.get('slug')),
    name: text(fd.get('name')),
    description: multiline(fd.get('description')),
    category_id: text(fd.get('category_id')),
    price: text(fd.get('price')),
    order_policy: (POLICIES as readonly string[]).includes(policy) ? (policy as OrderPolicy) : 'stock',
    lead_time_days: text(fd.get('lead_time_days')),
    movement_code: text(fd.get('movement_code')),
    case_material_code: text(fd.get('case_material_code')),
    case_diameter_mm: text(fd.get('case_diameter_mm')),
    water_resistance_m: text(fd.get('water_resistance_m')),
    specs: labels.map((label, i) => ({ label, value: values[i] ?? '' })).filter((s) => !blankPair(s)),
  };
}

export function toProductValues(p: AdminProduct): ProductFormValues {
  return {
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    description: p.description,
    category_id: p.category_id,
    price: solesInput(p.price.amount),
    order_policy: p.order_policy,
    lead_time_days: p.lead_time_days === null ? '' : String(p.lead_time_days),
    movement_code: p.movement_code ?? '',
    case_material_code: p.case_material_code ?? '',
    case_diameter_mm: p.case_diameter_mm === null ? '' : String(p.case_diameter_mm),
    water_resistance_m: p.water_resistance_m === null ? '' : String(p.water_resistance_m),
    specs: p.specs.map(({ label, value }) => ({ label, value })),
  };
}

/** Solo formato: obligatorios, precio con `parseSoles`, enteros y diámetro con un decimal. */
export function validateProductForm(
  v: ProductFormValues,
): { ok: true; input: ProductInput } | { ok: false; errors: ProductFormErrors } {
  const errors: ProductFormErrors = {};
  (['sku', 'name', 'category_id', 'price'] as const).filter((k) => !v[k]).forEach((k) => (errors[k] = MSG_FIELD_REQUIRED));
  const price = v.price ? parseSoles(v.price) : null;
  if (price && !price.ok) errors.price = MSG_FIELD_INVALID;
  if (v.lead_time_days && !INT.test(v.lead_time_days)) errors.lead_time_days = MSG_FIELD_INVALID;
  if (v.water_resistance_m && !INT.test(v.water_resistance_m)) errors.water_resistance_m = MSG_FIELD_INVALID;
  if (v.case_diameter_mm && !DECIMAL_1.test(v.case_diameter_mm)) errors.case_diameter_mm = MSG_FIELD_INVALID;
  if (v.specs.some((s) => !s.label || !s.value)) errors.specs = MSG_SPEC_PAIR;
  if (Object.keys(errors).length > 0 || !price || !price.ok) return { ok: false, errors };
  return {
    ok: true,
    input: {
      sku: v.sku,
      ...(v.slug ? { slug: v.slug } : {}),
      name: v.name,
      description: v.description,
      category_id: v.category_id,
      price: { amount: price.cents, currency: 'PEN' },
      order_policy: v.order_policy,
      ...(v.lead_time_days ? { lead_time_days: Number(v.lead_time_days) } : {}),
      ...(v.movement_code ? { movement_code: v.movement_code } : {}),
      ...(v.case_material_code ? { case_material_code: v.case_material_code } : {}),
      ...(v.case_diameter_mm ? { case_diameter_mm: v.case_diameter_mm } : {}),
      ...(v.water_resistance_m ? { water_resistance_m: Number(v.water_resistance_m) } : {}),
      specs: v.specs,
    },
  };
}

/** Solo lo cambiado; un opcional vaciado viaja como `null`. Supone `next` ya validado. */
export function diffProduct(original: ProductFormValues, next: ProductFormValues): ProductPatch {
  const patch: ProductPatch = {};
  const changed = (k: keyof ProductFormValues) => original[k] !== next[k];
  if (changed('sku')) patch.sku = next.sku;
  if (changed('slug')) patch.slug = next.slug || null;
  if (changed('name')) patch.name = next.name;
  if (changed('description')) patch.description = next.description;
  if (changed('category_id')) patch.category_id = next.category_id;
  if (changed('price')) {
    const p = parseSoles(next.price);
    if (p.ok) patch.price = { amount: p.cents, currency: 'PEN' };
  }
  if (changed('order_policy')) patch.order_policy = next.order_policy;
  if (changed('lead_time_days')) patch.lead_time_days = next.lead_time_days ? Number(next.lead_time_days) : null;
  if (changed('movement_code')) patch.movement_code = next.movement_code || null;
  if (changed('case_material_code')) patch.case_material_code = next.case_material_code || null;
  if (changed('case_diameter_mm')) patch.case_diameter_mm = next.case_diameter_mm || null;
  if (changed('water_resistance_m')) patch.water_resistance_m = next.water_resistance_m ? Number(next.water_resistance_m) : null;
  if (JSON.stringify(original.specs) !== JSON.stringify(next.specs)) patch.specs = next.specs;
  return patch;
}

// En el 422 el último elemento de `loc` es el del cuerpo: el importe llega como `amount` y los pares como `label`/`value`.
const LOC_TO_FIELD: Record<string, keyof ProductFormValues> = { amount: 'price', label: 'specs', value: 'specs' };
const SAVE_FIELDS = [
  'sku', 'slug', 'name', 'description', 'category_id', 'order_policy', 'lead_time_days', 'movement_code',
  'case_material_code', 'case_diameter_mm', 'water_resistance_m', 'specs', ...Object.keys(LOC_TO_FIELD),
];

/** Traduce un error del backend al guardar (409, 413, 422, 5xx) a mensajes por campo; `null` si no es de formulario. */
export function saveErrors(e: unknown): ProductFormErrors | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === CONFLICT && e.code === 'sku_taken') return { sku: MSG_SKU_TAKEN };
  if (e.status === CONFLICT && e.code === 'slug_taken') return { slug: MSG_SLUG_TAKEN };
  if (e.status === CONFLICT && e.code === 'slug_locked') return { form: MSG_SLUG_LOCKED };
  if (e.status === TOO_LARGE) return { form: MSG_TOO_LARGE };
  if (e.status === UNPROCESSABLE) {
    const out: ProductFormErrors = {};
    Object.entries(fieldErrors(e, SAVE_FIELDS)).forEach(([k, msg]) => {
      out[LOC_TO_FIELD[k] ?? (k as keyof ProductFormValues)] ??= msg;
    });
    return Object.keys(out).length ? out : { form: MSG_FIELD_INVALID };
  }
  if (e.status >= SERVER_ERROR || e.status === 0) return { form: MSG_UNAVAILABLE };
  return null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const listOf = <T>(x: unknown, ok: (i: Record<string, unknown>) => boolean): T[] | null =>
  Array.isArray(x) && x.every((i) => isObj(i) && ok(i)) ? (x as T[]) : null;
const isAttr = (i: Record<string, unknown>) => typeof i.code === 'string' && typeof i.label === 'string' && typeof i.is_active === 'boolean';

/** Valida la forma de las listas del backend; `null` (200 con una forma inesperada) = servicio no disponible. */
export function parseFormLists(
  categories: unknown,
  attrs: unknown,
): { categories: AdminCategory[]; movements: AdminAttributeValue[]; caseMaterials: AdminAttributeValue[] } | null {
  const cats = listOf<AdminCategory>(categories, (i) => typeof i.id === 'string' && typeof i.name === 'string' && typeof i.is_active === 'boolean');
  const a = isObj(attrs) ? attrs : {};
  const movements = listOf<AdminAttributeValue>(a.movements, isAttr);
  const caseMaterials = listOf<AdminAttributeValue>(a.case_materials, isAttr);
  return cats && movements && caseMaterials ? { categories: cats, movements, caseMaterials } : null;
}
