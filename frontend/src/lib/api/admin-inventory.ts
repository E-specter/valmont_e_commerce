// Stock del backoffice, solo lectura (inventory SPEC §7). Las cifras son las del servidor.
import type { Page, Transport } from './http';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_request';
export type StockItem = {
  product_id: string;
  sku: string;
  name: string;
  product_status: 'draft' | 'published';
  on_hand: number;
  reserved: number;
  available: number;
  status: StockStatus;
};

/** GET /inventory/admin/stock; page_size ≤ 48. */
export function listStock(
  t: Transport,
  q: { q?: string; status?: StockStatus; page?: number; page_size?: number } = {},
): Promise<Page<StockItem>> {
  const { q: text, status, page, page_size } = q;
  return t({ method: 'GET', path: '/inventory/admin/stock', query: { q: text, status, page, page_size } });
}
