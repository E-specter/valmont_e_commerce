// Catálogo del backoffice (catalog SPEC §7). Tipos 1:1 con el OpenAPI; el precio viaja en céntimos
// (`Money`) y lo valida el servidor. 401/403/409/422 llegan como ApiError.
import type { Money, Page, Transport } from './http';

export type ProductStatus = 'draft' | 'published';
export type OrderPolicy = 'stock' | 'made_to_order' | 'backorder';
export type ProductImage = { id: string; url: string; alt: string };
export type AdminProduct = {
  id: string;
  slug: string;
  sku: string;
  name: string;
  category: { slug: string; name: string };
  price: Money;
  movement: { code: string; label: string } | null;
  case_material: { code: string; label: string } | null;
  case_diameter_mm: number | null;
  water_resistance_m: number | null;
  main_image: ProductImage | null;
  description: string;
  specs: { label: string; value: string }[];
  images: ProductImage[];
  status: ProductStatus;
  order_policy: OrderPolicy;
  lead_time_days: number | null;
  category_id: string;
  movement_code: string | null;
  case_material_code: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ProductInput = {
  sku: string;
  slug?: string | null;
  name: string;
  description: string;
  category_id: string;
  price: Money;
  order_policy: OrderPolicy;
  lead_time_days?: number | null;
  movement_code?: string | null;
  case_material_code?: string | null;
  case_diameter_mm?: string | null; // cadena decimal: el servidor acepta number | string
  water_resistance_m?: number | null;
  specs: { label: string; value: string }[];
};
/** Solo lo cambiado; null borra los opcionales. */
export type ProductPatch = Partial<ProductInput>;
export type AdminCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
  is_active: boolean;
};
export type AdminAttributeValue = { code: string; label: string; position: number; is_active: boolean };

const seg = encodeURIComponent;
const product = (id: string) => `/catalog/admin/products/${seg(id)}`;

/** GET /catalog/admin/products; page_size ≤ 48. */
export function listAdminProducts(
  t: Transport,
  q: { q?: string; status?: ProductStatus; page?: number; page_size?: number } = {},
): Promise<Page<AdminProduct>> {
  const { q: text, status, page, page_size } = q;
  return t({ method: 'GET', path: '/catalog/admin/products', query: { q: text, status, page, page_size } });
}

export function getAdminProduct(t: Transport, id: string): Promise<AdminProduct> {
  return t({ method: 'GET', path: product(id) });
}

/** 201. */
export function createProduct(t: Transport, input: ProductInput): Promise<AdminProduct> {
  return t({ method: 'POST', path: '/catalog/admin/products', body: input });
}

/** PATCH con lo recibido, sin añadir claves. */
export function updateProduct(t: Transport, id: string, patch: ProductPatch): Promise<AdminProduct> {
  return t({ method: 'PATCH', path: product(id), body: patch });
}

/** 409 `publish_requirements_unmet` con `details.missing`. */
export function publishProduct(t: Transport, id: string): Promise<AdminProduct> {
  return t({ method: 'POST', path: `${product(id)}/publish` });
}

export function unpublishProduct(t: Transport, id: string): Promise<AdminProduct> {
  return t({ method: 'POST', path: `${product(id)}/unpublish` });
}

export function listAdminCategories(t: Transport): Promise<AdminCategory[]> {
  return t({ method: 'GET', path: '/catalog/admin/categories' });
}

export function getAdminAttributes(
  t: Transport,
): Promise<{ movements: AdminAttributeValue[]; case_materials: AdminAttributeValue[] }> {
  return t({ method: 'GET', path: '/catalog/admin/attributes' });
}

/**
 * POST …/images, multipart con `file` y `alt` (1–150). Aquí solo se arma el FormData: la rama de
 * FormData del transporte (sin Content-Type fijo y sin JSON.stringify) es de T-148.
 */
export function uploadProductImage(t: Transport, productId: string, file: File, alt: string): Promise<ProductImage> {
  const form = new FormData();
  form.append('file', file);
  form.append('alt', alt);
  return t({ method: 'POST', path: `${product(productId)}/images`, body: form });
}

export function updateImageAlt(t: Transport, productId: string, imageId: string, alt: string): Promise<ProductImage> {
  return t({ method: 'PATCH', path: `${product(productId)}/images/${seg(imageId)}`, body: { alt } });
}

/** PUT …/images/order; el cuerpo es el arreglo de UUID. */
export function reorderImages(t: Transport, productId: string, imageIds: string[]): Promise<ProductImage[]> {
  return t({ method: 'PUT', path: `${product(productId)}/images/order`, body: imageIds });
}

/** 204; 409 `last_image`. */
export function deleteImage(t: Transport, productId: string, imageId: string): Promise<void> {
  return t({ method: 'DELETE', path: `${product(productId)}/images/${seg(imageId)}` });
}
