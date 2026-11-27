import { afterEach, describe, expect, test, vi } from 'vitest';
import { createProduct, deleteImage, getAdminProduct, listAdminProducts, publishProduct, updateProduct } from '../../src/lib/api/admin-catalog';
import { listStock } from '../../src/lib/api/admin-inventory';
import { getAdminOrder, listAdminOrders, transitionOrder } from '../../src/lib/api/admin-orders';
import { ApiError, type Transport } from '../../src/lib/api/http';
import { serverTransport } from '../../src/lib/api/server';
import { API_BASE, CRED, errRes, jsonRes, MONEY, ORDER_ID, PRODUCT_ID, IMAGE_ID, ST, stubFetch, UUID_V4 } from '../helpers/t144';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-144 · los clientes de administración sobre el transporte REAL del servidor (D-050) con un `fetch` falso:
// URL final, cabeceras, cuerpo y traducción de errores a ApiError. No hay red.
const HTTP = ST;
const NO_BODY = 204;
const PAGE_TWO = 2;
const SIZE = 20;

afterEach(() => vi.unstubAllGlobals());

const t = (): Transport => serverTransport({ accessToken: CRED });

describe('URL, método y cuerpo reales', () => {
  test('listAdminOrders: consulta codificada, en orden alfabético y sin parámetros de más', async () => {
    const calls = stubFetch(() => jsonRes({ items: [], total: 0, page: 1, page_size: SIZE }));
    await listAdminOrders(t(), { status: 'pagado', q: 'ana & luis=1#x', created_from: '2026-11-01', page: PAGE_TWO, page_size: SIZE });
    const url = new URL(calls[0].url);
    expect(calls[0].method).toBe('GET');
    expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE.replace('/api/v1', '')}/api/v1/orders/admin`);
    expect([...url.searchParams.keys()]).toEqual(['created_from', 'page', 'page_size', 'q', 'status']);
    expect(url.searchParams.get('q')).toBe('ana & luis=1#x');
    expect(url.hash).toBe('');
    expect(calls[0].body).toBeUndefined();
  });

  test('transitionOrder: JSON con solo los campos permitidos', async () => {
    const calls = stubFetch(() => jsonRes({ id: ORDER_ID }));
    await transitionOrder(t(), ORDER_ID, { to: 'enviado', carrier: 'Olva', tracking_code: 'OL-1', user_id: 'x' } as never);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${API_BASE}/orders/admin/${ORDER_ID}/transitions`);
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].body))).toEqual({ to: 'enviado', carrier: 'Olva', tracking_code: 'OL-1' });
  });

  test('createProduct y updateProduct: el cuerpo JSON es lo recibido', async () => {
    const calls = stubFetch(() => jsonRes({ id: PRODUCT_ID }));
    const input = {
      sku: 'VAL-0001',
      name: 'Aurelia',
      description: 'd',
      category_id: PRODUCT_ID,
      price: MONEY,
      order_policy: 'stock',
      specs: [],
    } as const;
    await createProduct(t(), { ...input, specs: [] });
    await updateProduct(t(), PRODUCT_ID, { slug: null });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${API_BASE}/catalog/admin/products`],
      ['PATCH', `${API_BASE}/catalog/admin/products/${PRODUCT_ID}`],
    ]);
    expect(JSON.parse(String(calls[0].body))).toEqual(input);
    expect(JSON.parse(String(calls[1].body))).toEqual({ slug: null });
  });

  test('deleteImage: 204 sin cuerpo resuelve a undefined', async () => {
    stubFetch(() => new Response(null, { status: NO_BODY }));
    await expect(deleteImage(t(), PRODUCT_ID, IMAGE_ID)).resolves.toBeUndefined();
  });

  test('los ids con caracteres especiales no alteran la ruta final', async () => {
    const calls = stubFetch(() => jsonRes({}));
    await getAdminOrder(t(), '../../identity/me?x=1');
    const url = new URL(calls[0].url);
    expect(url.pathname.startsWith('/api/v1/orders/admin/')).toBe(true);
    expect(url.pathname).not.toContain('/identity/');
    expect(url.search).toBe('');
  });
});

describe('Authorization', () => {
  test('con token envía Bearer; sin token no envía la cabecera', async () => {
    const calls = stubFetch(() => jsonRes({ items: [], total: 0, page: 1, page_size: SIZE }));
    await listStock(serverTransport({ accessToken: CRED }));
    await listStock(serverTransport());
    await listStock(serverTransport({ accessToken: null }));
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${CRED}`);
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[2].headers.get('authorization')).toBeNull();
  });

  test('el token no viaja en la URL ni en el cuerpo de ninguna petición', async () => {
    const calls = stubFetch(() => jsonRes({}));
    await getAdminProduct(t(), PRODUCT_ID);
    await publishProduct(t(), PRODUCT_ID);
    await transitionOrder(t(), ORDER_ID, { to: 'entregado' });
    calls.forEach((c) => {
      expect(c.url).not.toContain(CRED);
      expect(String(c.body ?? '')).not.toContain(CRED);
    });
  });
});

describe('Idempotency-Key (T-018c)', () => {
  // El OpenAPI de administración no declara Idempotency-Key (se comprueba en admin-api-contract): solo los pagos la exigen.
  // Si el desarrollador la añade igualmente, debe ser un UUID v4 distinto por operación.
  test('si una mutación envía Idempotency-Key, es un UUID v4 y distinto en cada operación', async () => {
    const calls = stubFetch(() => jsonRes({}));
    await transitionOrder(t(), ORDER_ID, { to: 'entregado' });
    await transitionOrder(t(), ORDER_ID, { to: 'entregado' });
    await publishProduct(t(), PRODUCT_ID);
    const keys = calls.map((c) => c.headers.get('idempotency-key')).filter((k): k is string => k !== null);
    keys.forEach((k) => expect(k).toMatch(UUID_V4));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('las lecturas nunca envían Idempotency-Key', async () => {
    const calls = stubFetch(() => jsonRes({ items: [], total: 0, page: 1, page_size: SIZE }));
    await listAdminOrders(t());
    await listAdminProducts(t());
    await listStock(t());
    calls.forEach((c) => expect(c.headers.get('idempotency-key')).toBeNull());
  });
});

type Call = [string, () => Promise<unknown>];
const operations: Call[] = [
  ['listAdminOrders', () => listAdminOrders(t())],
  ['getAdminOrder', () => getAdminOrder(t(), ORDER_ID)],
  ['transitionOrder', () => transitionOrder(t(), ORDER_ID, { to: 'cancelado', note: 'x' })],
  ['listStock', () => listStock(t())],
  ['getAdminProduct', () => getAdminProduct(t(), PRODUCT_ID)],
  ['publishProduct', () => publishProduct(t(), PRODUCT_ID)],
  ['deleteImage', () => deleteImage(t(), PRODUCT_ID, IMAGE_ID)],
];
const statuses: [number, string][] = [
  [HTTP.UNAUTHORIZED, 'unauthenticated'],
  [HTTP.FORBIDDEN, 'forbidden'],
  [HTTP.NOT_FOUND, 'not_found'],
  [HTTP.CONFLICT, 'invalid_transition'],
  [HTTP.TOO_LARGE, 'file_too_large'],
  [HTTP.UNSUPPORTED, 'unsupported_media_type'],
  [HTTP.INVALID, 'validation_error'],
  [HTTP.UNAVAILABLE, 'storage_unavailable'],
  [HTTP.SERVER, 'internal_error'],
];

describe.each(operations)('errores de %s', (_name, run) => {
  test.each(statuses)('HTTP %i → ApiError con status y code del cuerpo', async (status, code) => {
    stubFetch(() => errRes(status, code));
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code });
  });
});

describe('detalles y errores sin filtraciones', () => {
  test('422 conserva details (loc, type) y 409 conserva details.from/to/allowed', async () => {
    const details = [{ loc: ['body', 'note'], type: 'string_too_short', msg: 'MSG-DEL-BACKEND-QX' }];
    stubFetch(() => errRes(HTTP.INVALID, 'validation_error', details));
    await expect(transitionOrder(t(), ORDER_ID, { to: 'cancelado', note: '' })).rejects.toMatchObject({ status: HTTP.INVALID, details });
    const conflict = { from: 'entregado', to: 'cancelado', allowed: [] };
    stubFetch(() => errRes(HTTP.CONFLICT, 'invalid_transition', conflict));
    await expect(transitionOrder(t(), ORDER_ID, { to: 'cancelado', note: 'x' })).rejects.toMatchObject({ code: 'invalid_transition', details: conflict });
  });

  test('409 publish_requirements_unmet conserva details.missing', async () => {
    stubFetch(() => errRes(HTTP.CONFLICT, 'publish_requirements_unmet', { missing: ['description', 'image'] }));
    await expect(publishProduct(t(), PRODUCT_ID)).rejects.toMatchObject({ status: HTTP.CONFLICT, details: { missing: ['description', 'image'] } });
  });

  test('un 500 con traza en HTML o texto → ApiError invalid_response sin la traza', async () => {
    const trace = 'Traceback (most recent call last):\n  File "/app/valmont/main.py", line 9, in handler\nPassword=hunter2';
    stubFetch(() => new Response(trace, { status: HTTP.SERVER, headers: { 'content-type': 'text/plain' } }));
    const err = (await getAdminOrder(t(), ORDER_ID).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(HTTP.SERVER);
    expect(err.code).toBe('invalid_response');
    const shown = `${err.message} ${JSON.stringify(err.details)}`;
    expect(['Traceback', 'valmont', 'hunter2', 'main.py'].filter((w) => shown.includes(w))).toEqual([]);
  });

  test('un fallo de red → ApiError status 0 code network, sin el mensaje interno', async () => {
    stubFetch(() => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.5:5432');
    });
    const err = (await listAdminOrders(t()).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
    // Rechaza el detalle interno: acepta 'No se pudo conectar', rechaza 'connect ECONNREFUSED 10.0.0.5:5432'.
    expect(['ECONNREFUSED', '10.0.0.5', '5432'].filter((w) => err.message.includes(w))).toEqual([]);
  });

  test('el mensaje del ApiError no incluye el token ni la URL', async () => {
    stubFetch(() => errRes(HTTP.FORBIDDEN, 'forbidden'));
    const err = (await listAdminOrders(t()).catch((e: unknown) => e)) as ApiError;
    expect(`${err.message} ${err.code}`).not.toContain(CRED);
    expect(err.message).not.toContain('api.test');
  });
});
