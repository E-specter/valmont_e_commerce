import { describe, expect, test } from 'vitest';
import { orderQueryString, parseOrderQuery } from '../../src/lib/admin/order-query';
import { ORDER_STATUSES } from '../../src/lib/admin/status';

// T-144 · lib/admin/order-query.ts (STATUS ui §10.5 3.8): lista blanca de la consulta del listado de pedidos.
// parseOrderQuery: lista cerrada; status por lista blanca; fechas YYYY-MM-DD; q ≤ 100; page 1…1000; page_size fijo 20.
const PAGE_SIZE = 20;
const MAX_Q = 100;
const OVER_Q = 150;
const PAGE_TWO = 2;
const PAGE_MAX = 1000;
const ALLOWED = ['created_from', 'created_to', 'page', 'page_size', 'q', 'status'];
const sp = (init: string | Record<string, string>) => new URLSearchParams(init);
const parse = (init: string | Record<string, string>) => parseOrderQuery(sp(init));

describe('parseOrderQuery · consulta válida', () => {
  test('sin parámetros: solo el tamaño de página fijo', () => {
    const { query, invalid } = parse('');
    expect(query.page_size).toBe(PAGE_SIZE);
    expect(Object.keys(query).filter((k) => !['page_size', 'page'].includes(k))).toEqual([]);
    expect(query.page ?? 1).toBe(1);
    expect(invalid).toEqual([]);
  });

  test('conserva estado, texto, fechas y página válidos', () => {
    const { query, invalid } = parse({ status: 'pagado', q: 'VAL-000123', created_from: '2026-11-01', created_to: '2026-11-27', page: String(PAGE_TWO) });
    expect(query).toMatchObject({ status: 'pagado', q: 'VAL-000123', created_from: '2026-11-01', created_to: '2026-11-27', page: PAGE_TWO, page_size: PAGE_SIZE });
    expect(invalid).toEqual([]);
  });

  test.each(ORDER_STATUSES)('status %s está en la lista blanca', (status) => {
    expect(parse({ status }).query.status).toBe(status);
  });

  test('page 1 y page 1000 son los límites válidos', () => {
    expect(parse({ page: '1' }).query.page ?? 1).toBe(1);
    expect(parse({ page: String(PAGE_MAX) }).query.page).toBe(PAGE_MAX);
  });

  test('q de exactamente 100 caracteres se conserva entera', () => {
    expect(parse({ q: 'a'.repeat(MAX_Q) }).query.q).toHaveLength(MAX_Q);
  });
});

describe('parseOrderQuery · descarta lo inválido sin lanzar', () => {
  test.each(['otro', 'PAGADO', 'pagado ', 'cancelado;drop', '', 'expirado,pagado', '__proto__'])('status %j se descarta', (status) => {
    const { query } = parse({ status });
    expect(query.status).toBeUndefined();
  });

  test('status inválido se anota en `invalid`', () => {
    expect(parse({ status: 'otro' }).invalid).toContain('status');
  });

  test.each(['x', '27/11/2026', '2026-1-1', '2026-11-27T00:00:00Z', '20261127', ' 2026-11-27', '2026-11-27 ', '２０２６-11-27', '2026-11-27;x'])(
    'fecha mal formada %j se descarta (created_from y created_to)',
    (date) => {
      const { query } = parse({ created_from: date, created_to: date });
      expect(query.created_from).toBeUndefined();
      expect(query.created_to).toBeUndefined();
    },
  );

  test('fecha mal formada se anota en `invalid` con su clave', () => {
    expect(parse({ created_from: 'x' }).invalid).toContain('created_from');
    expect(parse({ created_to: 'x' }).invalid).toContain('created_to');
  });

  test.each(['0', '-1', '1001', '99999999999999999999', 'abc', '1.5', '1e2', '', '0x10', 'NaN'])('page %j fuera de 1…1000 o no entera se descarta', (page) => {
    const { query } = parse({ page });
    expect(query.page === undefined || query.page === 1).toBe(true);
  });

  test('page inválida se anota en `invalid`', () => {
    expect(parse({ page: '0' }).invalid).toContain('page');
    expect(parse({ page: '1001' }).invalid).toContain('page');
  });

  test('q con más de 100 caracteres se recorta a 100', () => {
    const { query } = parse({ q: 'b'.repeat(OVER_Q) });
    expect(query.q).toHaveLength(MAX_Q);
    expect(query.q).toBe('b'.repeat(MAX_Q));
  });

  test('page_size del cliente se ignora: siempre 20', () => {
    ['500', '1', '0', '-5', 'x', '50'].forEach((v) => expect(parse({ page_size: v }).query.page_size).toBe(PAGE_SIZE));
  });

  test('claves ajenas (user_id, sort, __proto__, constructor) no pasan a la consulta', () => {
    const { query } = parse('user_id=x&sort=asc&evil=1&__proto__=polluted&constructor=y&status=pagado');
    expect(Object.keys(query).filter((k) => !ALLOWED.includes(k))).toEqual([]);
    expect(query.status).toBe('pagado');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('cualquier entrada produce solo claves de la lista cerrada', () => {
    const noisy = parse('status=otro&q=x&created_from=bad&created_to=2026-11-27&page=9999&zzz=1&page_size=99&a[]=1');
    expect(Object.keys(noisy.query).every((k) => ALLOWED.includes(k))).toBe(true);
  });

  test('un parámetro repetido no lanza y deja un valor válido o ninguno', () => {
    const { query } = parse('status=pagado&status=enviado&page=2&page=3');
    expect([undefined, 'pagado', 'enviado']).toContain(query.status);
  });
});

describe('orderQueryString', () => {
  test('claves en orden alfabético', () => {
    const s = orderQueryString({ status: 'pagado', q: 'ana', created_to: '2026-11-27', created_from: '2026-11-01', page: PAGE_TWO });
    const keys = [...sp(s).keys()];
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(expect.arrayContaining(['created_from', 'created_to', 'page', 'q', 'status']));
  });

  test('es estable: el orden de inserción no cambia el resultado', () => {
    const a = orderQueryString({ status: 'pagado', q: 'ana', page: PAGE_TWO });
    const b = orderQueryString({ page: PAGE_TWO, q: 'ana', status: 'pagado' });
    expect(a).toBe(b);
  });

  test('omite page=1 y no emite claves vacías', () => {
    expect(sp(orderQueryString({ status: 'pagado', page: 1 })).has('page')).toBe(false);
    expect(orderQueryString({ page: 1 })).toBe('');
    expect(orderQueryString({})).toBe('');
    expect(orderQueryString({ q: '', status: undefined, created_from: undefined })).toBe('');
  });

  test('conserva page cuando es mayor que 1', () => {
    expect(sp(orderQueryString({ page: PAGE_TWO })).get('page')).toBe(String(PAGE_TWO));
  });

  test('codifica el texto: & = # y espacios no crean parámetros nuevos', () => {
    const s = orderQueryString({ q: 'a&b=c#d e', status: 'pagado' });
    const back = sp(s);
    expect([...back.keys()].sort()).toEqual(['q', 'status']);
    expect(back.get('q')).toBe('a&b=c#d e');
    expect(s.includes('#')).toBe(false);
  });

  test('ida y vuelta: parse(orderQueryString(q)) reconstruye la misma consulta', () => {
    const original = parse({ status: 'enviado', q: 'ana díaz & co', created_from: '2026-11-01', created_to: '2026-11-27', page: String(PAGE_TWO) }).query;
    const again = parseOrderQuery(sp(orderQueryString(original))).query;
    expect(again).toEqual(original);
  });

  test('la cadena de una consulta saneada nunca trae claves ajenas', () => {
    const { query } = parse('user_id=x&status=pagado&evil=1&page=0');
    expect([...sp(orderQueryString(query)).keys()].every((k) => ALLOWED.includes(k))).toBe(true);
  });
});
