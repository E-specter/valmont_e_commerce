// Catálogo público (catalog SPEC §7). Tipos a mano desde el OpenAPI; el precio y la
// disponibilidad son los del servidor (RN-09): nada se calcula aquí.
import type { Money, Page, Transport } from './http';

export type Category = { slug: string; name: string; description: string | null };
export type AttributeValue = { code: string; label: string };
export type ProductImage = { id: string; url: string; alt: string };
export type Availability = {
  status: 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_request';
  lead_time_days: number | null;
};
export type ProductSummary = {
  id: string;
  slug: string;
  sku: string;
  name: string;
  category: { slug: string; name: string };
  price: Money;
  original_price: Money | null;
  discount_amount: Money | null;
  movement: AttributeValue | null;
  case_material: AttributeValue | null;
  case_diameter_mm: number | null;
  water_resistance_m: number | null;
  main_image: ProductImage;
  availability: Availability;
};
export type ProductDetail = ProductSummary & {
  description: string;
  specs: { label: string; value: string }[];
  images: ProductImage[];
  related: ProductSummary[];
};
export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'relevance';
export type ProductFilters = {
  q?: string;
  category?: string;
  movement?: string;
  case_material?: string;
  case_diameter_mm_min?: number;
  case_diameter_mm_max?: number;
  water_resistance_m_min?: number;
  price_min?: number;
  price_max?: number; // céntimos
  available?: boolean;
  sort?: ProductSort;
  page?: number;
  page_size?: number;
};

export function listProducts(t: Transport, f: ProductFilters = {}): Promise<Page<ProductSummary>> {
  // `available` solo se envía si es true (false o ausente = sin filtro).
  return t({ method: 'GET', path: '/catalog/products', query: { ...f, available: f.available ? true : undefined } });
}

export function getProduct(t: Transport, slug: string): Promise<ProductDetail> {
  return t({ method: 'GET', path: `/catalog/products/${encodeURIComponent(slug)}` });
}

export function listCategories(t: Transport): Promise<Category[]> {
  return t({ method: 'GET', path: '/catalog/categories' });
}

export function getAttributes(t: Transport): Promise<{ movements: AttributeValue[]; case_materials: AttributeValue[] }> {
  return t({ method: 'GET', path: '/catalog/attributes' });
}
