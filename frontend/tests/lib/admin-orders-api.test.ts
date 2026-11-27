import { describe, expect, test } from 'vitest';
import { getAdminOrder, listAdminOrders, transitionOrder } from '../../src/lib/api/admin-orders';
import { cleanQuery, MONEY, ORDER_ID, recorder, wire } from '../helpers/t144';

// T-144 · lib/api/admin-orders.ts (STATUS ui §10.5 3.7; orders SPEC §7). Transporte simulado: método, ruta, consulta y cuerpo exactos.
const ONE = 1;
const PAGE_TWO = 2;
const PAGE_THREE = 3;
const PAGE_SIZE = 20;
const PATH = '/orders/admin';
const detail = { id: ORDER_ID, number: 'VAL-000123', status: 'pagado', total: MONEY, can_transition_to: ['en_preparacion', 'cancelado'] };

describe('listAdminOrders', () => {
  test('GET /orders/admin sin cuerpo y sin consulta cuando no hay filtros', async () => {
    const { transport, seen } = recorder();
    await listAdminOrders(transport);
    expect(seen).toHaveLength(ONE);
    expect(seen[0]).toMatchObject({ method: 'GET', path: PATH });
    expect(seen[0].body).toBeUndefined();
    expect(cleanQuery(seen[0].query)).toEqual({});
  });

  test('envía las claves de AdminOrderQuery tal cual (estado, q, fechas, página y tamaño)', async () => {
    const { transport, last } = recorder();
    await listAdminOrders(transport, { status: 'pagado', q: 'ana díaz', created_from: '2026-11-01', created_to: '2026-11-27', page: PAGE_TWO, page_size: PAGE_SIZE });
    expect(cleanQuery(last().query)).toEqual({ status: 'pagado', q: 'ana díaz', created_from: '2026-11-01', created_to: '2026-11-27', page: PAGE_TWO, page_size: PAGE_SIZE });
  });

  test('lista cerrada: una clave ajena (user_id, sort, evil) no viaja', async () => {
    const { transport, last } = recorder();
    const hostile = { status: 'enviado', page: PAGE_THREE, user_id: 'x', sort: 'asc', evil: '1' } as never;
    await listAdminOrders(transport, hostile);
    expect(Object.keys(cleanQuery(last().query)).sort()).toEqual(['page', 'status']);
  });

  test('el texto de q va como valor de consulta, no en la ruta', async () => {
    const { transport, last } = recorder();
    await listAdminOrders(transport, { q: 'a&b=c#d/../x' });
    expect(last().path).toBe(PATH);
    expect(cleanQuery(last().query)).toEqual({ q: 'a&b=c#d/../x' });
  });

  test('devuelve la página del servidor sin transformarla', async () => {
    const page = { items: [], total: 0, page: ONE, page_size: PAGE_SIZE };
    const { transport } = recorder(() => page);
    await expect(listAdminOrders(transport)).resolves.toEqual(page);
  });

  test('un error del transporte se propaga sin envolver', async () => {
    const boom = new Error('boom');
    const { transport } = recorder(() => {
      throw boom;
    });
    await expect(listAdminOrders(transport)).rejects.toBe(boom);
  });
});

describe('getAdminOrder', () => {
  test('GET /orders/admin/{id} sin cuerpo ni consulta', async () => {
    const { transport, last } = recorder(() => detail);
    await expect(getAdminOrder(transport, ORDER_ID)).resolves.toEqual(detail);
    expect(last()).toMatchObject({ method: 'GET', path: `${PATH}/${ORDER_ID}` });
    expect(last().body).toBeUndefined();
    expect(cleanQuery(last().query)).toEqual({});
  });

  test('el id va codificado en la ruta: no puede escapar de /orders/admin ni añadir consulta', async () => {
    const { transport, last } = recorder();
    await getAdminOrder(transport, '../x/y?z=1#h');
    expect(last().path).toBe(`${PATH}/${encodeURIComponent('../x/y?z=1#h')}`);
    // Rechaza una ruta con '?', '#' o '../' sin codificar: acepta '/orders/admin/..%2Fx', rechaza '/orders/admin/../x?z=1'.
    expect(['?', '#', '../'].filter((w) => last().path.includes(w))).toEqual([]);
  });
});

describe('transitionOrder', () => {
  test('POST /orders/admin/{id}/transitions con solo `to` cuando no hay más datos', async () => {
    const { transport, last } = recorder(() => detail);
    await transitionOrder(transport, ORDER_ID, { to: 'en_preparacion' });
    expect(last()).toMatchObject({ method: 'POST', path: `${PATH}/${ORDER_ID}/transitions` });
    expect(wire(last().body)).toEqual({ to: 'en_preparacion' });
  });

  test('envía únicamente to, note, carrier y tracking_code', async () => {
    const { transport, last } = recorder();
    await transitionOrder(transport, ORDER_ID, { to: 'enviado', note: 'Entregado a courier', carrier: 'Olva', tracking_code: 'OL-1234' });
    expect(wire(last().body)).toEqual({ to: 'enviado', note: 'Entregado a courier', carrier: 'Olva', tracking_code: 'OL-1234' });
  });

  test('cancelar lleva la nota tal cual', async () => {
    const { transport, last } = recorder();
    await transitionOrder(transport, ORDER_ID, { to: 'cancelado', note: 'Cliente lo pidió' });
    expect(wire(last().body)).toEqual({ to: 'cancelado', note: 'Cliente lo pidió' });
  });

  test('descarta cualquier otra clave: user_id, status, total, role, actor', async () => {
    const { transport, last } = recorder();
    const hostile = { to: 'entregado', user_id: 'u', status: 'pagado', total: MONEY, role: 'admin', actor: 'admin', amount: 1 } as never;
    await transitionOrder(transport, ORDER_ID, hostile);
    expect(wire(last().body)).toEqual({ to: 'entregado' });
  });

  test('devuelve el detalle recibido sin recalcular estados', async () => {
    const { transport } = recorder(() => ({ ...detail, status: 'cancelado', can_transition_to: [] }));
    await expect(transitionOrder(transport, ORDER_ID, { to: 'cancelado', note: 'x' })).resolves.toMatchObject({ status: 'cancelado', can_transition_to: [] });
  });

  test('el id se codifica en la ruta', async () => {
    const { transport, last } = recorder();
    await transitionOrder(transport, 'a/b', { to: 'entregado' });
    expect(last().path).toBe(`${PATH}/a%2Fb/transitions`);
  });
});
