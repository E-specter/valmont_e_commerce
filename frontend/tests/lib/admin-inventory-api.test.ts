import { describe, expect, test } from 'vitest';
import * as inventory from '../../src/lib/api/admin-inventory';
import { listStock } from '../../src/lib/api/admin-inventory';
import { cleanQuery, recorder } from '../helpers/t144';

// T-144 · lib/api/admin-inventory.ts: solo lectura (GET /inventory/admin/stock, page_size ≤ 48).
const PAGE_TWO = 2;
const SIZE = 4;

describe('listStock', () => {
  test('GET /inventory/admin/stock sin cuerpo ni consulta por omisión', async () => {
    const { transport, last } = recorder();
    await listStock(transport);
    expect(last()).toMatchObject({ method: 'GET', path: '/inventory/admin/stock' });
    expect(last().body).toBeUndefined();
    expect(cleanQuery(last().query)).toEqual({});
  });

  test('envía q, status, page y page_size', async () => {
    const { transport, last } = recorder();
    await listStock(transport, { q: 'VAL-001', status: 'low_stock', page: PAGE_TWO, page_size: SIZE });
    expect(cleanQuery(last().query)).toEqual({ q: 'VAL-001', status: 'low_stock', page: PAGE_TWO, page_size: SIZE });
  });

  test('lista cerrada: nada que no sea q, status, page y page_size', async () => {
    const { transport, last } = recorder();
    await listStock(transport, { status: 'out_of_stock', user_id: 'u', on_hand: 0, sort: 'x' } as never);
    expect(Object.keys(cleanQuery(last().query))).toEqual(['status']);
  });

  test('devuelve la página tal cual y propaga los errores', async () => {
    const page = { items: [], total: 0, page: 1, page_size: SIZE };
    await expect(listStock(recorder(() => page).transport)).resolves.toEqual(page);
    const boom = new Error('x');
    const failing = recorder(() => {
      throw boom;
    });
    await expect(listStock(failing.transport)).rejects.toBe(boom);
  });

  test('es solo lectura: el módulo exporta una única función, listStock', () => {
    const fns = Object.entries(inventory).filter(([, v]) => typeof v === 'function');
    expect(fns.map(([k]) => k)).toEqual(['listStock']);
  });
});
