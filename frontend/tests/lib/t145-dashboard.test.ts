import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadDashboard, type Count, type DashboardData } from '../../src/lib/admin/dashboard';
import { ApiError } from '../../src/lib/api/http';
import { cleanQuery, recorder, ST, type Req } from '../helpers/t144';
import { LOW_ROWS, OUT_ROWS, PENDING_ROWS, PREPARE_ROWS, TOTALS, lowStockItems, ordersToPrepare, outItems, pageOf, summary } from '../helpers/t145';

// T-145 · lib/admin/dashboard.ts: `loadDashboard(t)` con un transporte simulado (sin red). Contrato: STATUS ui §10.7 T-145 y D-B3 A (KPI derivados de los listados).
const ORDERS = '/orders/admin';
const STOCK = '/inventory/admin/stock';
const FOUR = 4;
const NONE = 0;
const ONE = 1;
const TIMEOUT_MS = 3000;
const BIG_TOTAL = 9999;
const FRACTION = 1.5;

type Key = 'pagado' | 'pendiente_pago' | 'low_stock' | 'out_of_stock';
const KEYS: Key[] = ['pagado', 'pendiente_pago', 'low_stock', 'out_of_stock'];
const keyOf = (r: Req): Key => (r.query as { status: Key }).status;

const healthy = (): Record<Key, unknown> => ({
  pagado: pageOf(ordersToPrepare(), { total: TOTALS.toPrepare, page_size: PREPARE_ROWS }),
  pendiente_pago: pageOf([summary({ status: 'pendiente_pago' })], { total: TOTALS.pendingPayment, page_size: PENDING_ROWS }),
  low_stock: pageOf(lowStockItems() as never, { total: TOTALS.lowStock, page_size: LOW_ROWS }),
  out_of_stock: pageOf(outItems() as never, { total: TOTALS.outOfStock, page_size: OUT_ROWS }),
});

/** Transporte que responde con lo sano salvo lo que se pise por clave; `throw` simula el fallo de esa llamada. */
const backend = (over: Partial<Record<Key, () => unknown>> = {}) => recorder((req) => (over[keyOf(req)] ? over[keyOf(req)]!() : healthy()[keyOf(req)]));
const failing = (e: unknown) => () => {
  throw e;
};
const api = (status: number, code = 'internal_error') => new ApiError(status, code, 'MSG-DEL-BACKEND-QX');

/** Cuál de los dos campos de la salida refleja cada llamada. */
const COUNT_OF: Record<Key, keyof Pick<DashboardData, 'toPrepare' | 'pendingPayment' | 'lowStock' | 'outOfStock'>> = {
  pagado: 'toPrepare', pendiente_pago: 'pendingPayment', low_stock: 'lowStock', out_of_stock: 'outOfStock',
};
const COUNTS = Object.values(COUNT_OF);
const ok = (total: number): Count => ({ ok: true, total });
const BAD: Count = { ok: false };

afterEach(() => vi.restoreAllMocks());

describe('loadDashboard · las 4 llamadas y sus consultas exactas', () => {
  test('hace exactamente 4 GET sin cuerpo: pedidos pagado (5), pedidos pendiente_pago (1), stock low_stock (4) y stock out_of_stock (1)', async () => {
    const { transport, seen } = backend();
    await loadDashboard(transport);
    expect(seen).toHaveLength(FOUR);
    expect(seen.every((r) => r.method === 'GET' && r.body === undefined)).toBe(true);
    const sent = seen.map((r) => `${r.path}|${JSON.stringify(Object.fromEntries(Object.entries(cleanQuery(r.query)).sort()))}`).sort();
    expect(sent).toEqual(
      [
        `${ORDERS}|{"page_size":${PREPARE_ROWS},"status":"pagado"}`,
        `${ORDERS}|{"page_size":${PENDING_ROWS},"status":"pendiente_pago"}`,
        `${STOCK}|{"page_size":${LOW_ROWS},"status":"low_stock"}`,
        `${STOCK}|{"page_size":${OUT_ROWS},"status":"out_of_stock"}`,
      ].sort(),
    );
  });

  test('ninguna consulta lleva q, page, fechas ni claves ajenas; no toca otras rutas (ni reportes)', async () => {
    const { transport, seen } = backend();
    await loadDashboard(transport);
    seen.forEach((r) => expect(Object.keys(cleanQuery(r.query)).sort()).toEqual(['page_size', 'status']));
    expect(new Set(seen.map((r) => r.path))).toEqual(new Set([ORDERS, STOCK]));
  });

  test('las 4 salen a la vez (Promise.allSettled): ninguna espera a que otra termine', async () => {
    let inFlight = NONE;
    let release!: () => void;
    const all4 = new Promise<void>((r) => (release = r));
    const t = recorder().transport;
    const barrier = (async <T>(req: Req): Promise<T> => {
      if (++inFlight === FOUR) release();
      await all4; // si fueran en serie, la primera nunca volvería: la prueba caduca
      return t<T>(req);
    }) as typeof t;
    await expect(loadDashboard(barrier)).resolves.toBeDefined();
    expect(inFlight).toBe(FOUR);
  }, TIMEOUT_MS);

  test('con la API sana: cada Count lleva el `total` del listado (no la longitud de la página) y las listas llegan en el orden recibido', async () => {
    const data = await loadDashboard(backend().transport);
    expect(data.toPrepare).toEqual(ok(TOTALS.toPrepare));
    expect(data.pendingPayment).toEqual(ok(TOTALS.pendingPayment));
    expect(data.lowStock).toEqual(ok(TOTALS.lowStock));
    expect(data.outOfStock).toEqual(ok(TOTALS.outOfStock));
    expect(data.ordersToPrepare).toEqual(ordersToPrepare());
    expect(data.ordersToPrepare?.map((o) => o.number)).toEqual(ordersToPrepare().map((o) => o.number));
    expect(data.lowStockItems).toEqual(lowStockItems());
    expect(data.ordersToPrepare).toHaveLength(PREPARE_ROWS);
  });

  test('total 0 es un dato válido: { ok: true, total: 0 } con la lista vacía (no es un fallo)', async () => {
    const empty = (): unknown => pageOf([], { total: NONE });
    const data = await loadDashboard(backend({ pagado: empty, pendiente_pago: empty, low_stock: empty, out_of_stock: empty }).transport);
    COUNTS.forEach((c) => expect(data[c]).toEqual(ok(NONE)));
    expect(data.ordersToPrepare).toEqual([]);
    expect(data.lowStockItems).toEqual([]);
  });

  test('no calcula nada: un `total` mayor que las filas se devuelve tal cual, sin sumar ni contar filas', async () => {
    const data = await loadDashboard(backend({ pagado: () => pageOf(ordersToPrepare(), { total: BIG_TOTAL }) }).transport);
    expect(data.toPrepare).toEqual(ok(BIG_TOTAL));
  });
});

describe('loadDashboard · un fallo parcial degrada solo su bloque', () => {
  const cases: [Key, string, unknown][] = KEYS.flatMap((k) => [
    [k, '5xx', api(ST.SERVER)] as [Key, string, unknown],
    [k, '503', api(ST.UNAVAILABLE, 'service_unavailable')] as [Key, string, unknown],
    [k, 'red caída', new ApiError(NONE, 'network', 'sin conexión')] as [Key, string, unknown],
    [k, 'tiempo agotado', new ApiError(NONE, 'timeout', 'lento')] as [Key, string, unknown],
    [k, 'error no tipado', new TypeError('fetch failed')] as [Key, string, unknown],
  ]);

  test.each(cases)('%s falla (%s): solo su Count es { ok: false }; los demás conservan su total', async (key, _kind, error) => {
    const data = await loadDashboard(backend({ [key]: failing(error) }).transport);
    COUNTS.forEach((c) => (c === COUNT_OF[key] ? expect(data[c]).toEqual(BAD) : expect(data[c]).toEqual(ok(TOTALS[c]))));
  });

  test('si falla «pagado», ordersToPrepare es null (y stock sigue); si falla «low_stock», lowStockItems es null (y pedidos siguen)', async () => {
    const a = await loadDashboard(backend({ pagado: failing(api(ST.SERVER)) }).transport);
    expect(a.ordersToPrepare).toBeNull();
    expect(a.lowStockItems).toEqual(lowStockItems());
    const b = await loadDashboard(backend({ low_stock: failing(api(ST.SERVER)) }).transport);
    expect(b.lowStockItems).toBeNull();
    expect(b.ordersToPrepare).toEqual(ordersToPrepare());
  });

  test('si fallan «pendiente_pago» o «out_of_stock», las dos listas siguen intactas', async () => {
    const data = await loadDashboard(backend({ pendiente_pago: failing(api(ST.SERVER)), out_of_stock: failing(api(ST.SERVER)) }).transport);
    expect(data.ordersToPrepare).toEqual(ordersToPrepare());
    expect(data.lowStockItems).toEqual(lowStockItems());
  });

  test('si fallan las 4, devuelve cuatro { ok: false } y dos listas null: nunca lanza', async () => {
    const boom = failing(api(ST.UNAVAILABLE));
    const data = await loadDashboard(backend({ pagado: boom, pendiente_pago: boom, low_stock: boom, out_of_stock: boom }).transport);
    COUNTS.forEach((c) => expect(data[c]).toEqual(BAD));
    expect(data.ordersToPrepare).toBeNull();
    expect(data.lowStockItems).toBeNull();
  });

  test('404 y 422 son fallos de ese bloque, no del panel (solo 401 y 403 se relanzan)', async () => {
    const data = await loadDashboard(backend({ pendiente_pago: failing(api(ST.NOT_FOUND, 'not_found')), out_of_stock: failing(api(ST.INVALID, 'validation_error')) }).transport);
    expect(data.pendingPayment).toEqual(BAD);
    expect(data.outOfStock).toEqual(BAD);
    expect(data.toPrepare).toEqual(ok(TOTALS.toPrepare));
  });

  test('no escribe en la consola ni deja pasar el mensaje del backend a la salida', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const data = await loadDashboard(backend({ pagado: failing(api(ST.SERVER)) }).transport);
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    expect(JSON.stringify(data)).not.toContain('MSG-DEL-BACKEND-QX');
  });
});

describe('loadDashboard · 401 y 403 se relanzan (los trata adminErrorResponse)', () => {
  const auth: [Key, number][] = KEYS.flatMap((k) => [[k, ST.UNAUTHORIZED] as [Key, number], [k, ST.FORBIDDEN] as [Key, number]]);

  test.each(auth)('%s responde %i: loadDashboard rechaza con la MISMA ApiError (aunque las otras tres vayan bien)', async (key, status) => {
    const e = api(status, status === ST.UNAUTHORIZED ? 'unauthenticated' : 'forbidden');
    const rejected = await loadDashboard(backend({ [key]: failing(e) }).transport).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejected).toBe(e);
  });

  test('un 401 manda sobre un 5xx de otra llamada: se relanza el 401', async () => {
    const e = api(ST.UNAUTHORIZED, 'unauthenticated');
    const rejected = await loadDashboard(backend({ pagado: failing(api(ST.SERVER)), low_stock: failing(e) }).transport).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejected).toBe(e);
  });

  test('un 403 manda sobre un 5xx de otra llamada: se relanza el 403', async () => {
    const e = api(ST.FORBIDDEN, 'forbidden');
    const rejected = await loadDashboard(backend({ out_of_stock: failing(api(ST.UNAVAILABLE)), pendiente_pago: failing(e) }).transport).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejected).toBe(e);
  });

  test('si hay 401 y 403 a la vez, rechaza con una de las dos (ApiError con 401 o 403), nunca con datos', async () => {
    const rejected = await loadDashboard(
      backend({ pagado: failing(api(ST.UNAUTHORIZED, 'unauthenticated')), low_stock: failing(api(ST.FORBIDDEN, 'forbidden')) }).transport,
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(rejected).toBeInstanceOf(ApiError);
    expect([ST.UNAUTHORIZED, ST.FORBIDDEN]).toContain((rejected as ApiError).status);
  });
});

describe('loadDashboard · una respuesta 200 con forma inesperada no es un dato', () => {
  const shapes: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['un objeto vacío', {}],
    ['un arreglo', []],
    ['un texto', 'texto'],
    ['total como texto', { items: [], total: '7', page: 1, page_size: 1 }],
    ['total null', { items: [], total: null, page: 1, page_size: 1 }],
    ['sin total', { items: [], page: 1, page_size: 1 }],
    ['total negativo', { items: [], total: -ONE, page: 1, page_size: 1 }],
    ['total decimal', { items: [], total: FRACTION, page: 1, page_size: 1 }],
  ];
  const matrix = KEYS.flatMap((k) => shapes.map(([name, body]) => [k, name, body] as [Key, string, unknown]));

  test.each(matrix)('%s con %s → su Count es { ok: false } y las demás llamadas no se afectan', async (key, _name, body) => {
    const data = await loadDashboard(backend({ [key]: () => body }).transport);
    COUNTS.forEach((c) => (c === COUNT_OF[key] ? expect(data[c]).toEqual(BAD) : expect(data[c]).toEqual(ok(TOTALS[c]))));
  });

  test('«pagado» con total válido pero `items` que no es un arreglo: la lista queda en null (no revienta el panel)', async () => {
    const data = await loadDashboard(backend({ pagado: () => ({ items: { 0: 'x' }, total: TOTALS.toPrepare, page: 1, page_size: PREPARE_ROWS }) }).transport);
    expect(data.ordersToPrepare).toBeNull();
  });

  test('«low_stock» con total válido pero `items` que no es un arreglo: la lista queda en null', async () => {
    const data = await loadDashboard(backend({ low_stock: () => ({ items: 'x', total: TOTALS.lowStock, page: 1, page_size: LOW_ROWS }) }).transport);
    expect(data.lowStockItems).toBeNull();
  });
});

describe('loadDashboard · filas inválidas', () => {
  test('si hay filas y NINGUNA es válida, el bloque degrada: Count { ok: false } y lista null (pedidos y stock)', async () => {
    const junk = [null, {}, { id: 'x' }];
    const data = await loadDashboard(
      backend({ pagado: () => ({ items: junk, total: TOTALS.toPrepare, page: 1, page_size: PREPARE_ROWS }), low_stock: () => ({ items: junk, total: TOTALS.lowStock, page: 1, page_size: LOW_ROWS }) }).transport,
    );
    expect(data.toPrepare).toEqual(BAD);
    expect(data.ordersToPrepare).toBeNull();
    expect(data.lowStockItems).toBeNull();
    expect(data.lowStock).toEqual(BAD);
    expect(data.pendingPayment).toEqual(ok(TOTALS.pendingPayment));
  });

  test('con filas mezcladas se conservan solo las válidas, en su orden, y el total sigue siendo el del servidor', async () => {
    const good = ordersToPrepare();
    const goodStock = lowStockItems();
    const data = await loadDashboard(
      backend({
        pagado: () => ({ items: [null, good[0], {}, good[1]], total: TOTALS.toPrepare, page: 1, page_size: PREPARE_ROWS }),
        low_stock: () => ({ items: [goodStock[0], 'x', goodStock[1]], total: TOTALS.lowStock, page: 1, page_size: LOW_ROWS }),
      }).transport,
    );
    expect(data.ordersToPrepare).toEqual([good[0], good[1]]);
    expect(data.lowStockItems).toEqual([goodStock[0], goodStock[1]]);
    expect(data.toPrepare).toEqual(ok(TOTALS.toPrepare));
  });
});
