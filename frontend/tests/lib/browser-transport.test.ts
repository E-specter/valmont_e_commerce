import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/lib/api/http';
import { browserTransport } from '../../src/lib/api/browser';

// T-126 · contrato 3.3 (cliente): `browserTransport` llama a `/bff` del mismo origen, sin token ni credenciales de otro origen.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Init = RequestInit & { headers: Record<string, string> };
let fetchMock: ReturnType<typeof vi.fn>;
const last = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, Init];
  return { url, init };
};

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('URL y petición', () => {
  test('GET → fetch("/bff" + path) con credenciales de mismo origen y Accept JSON', async () => {
    await browserTransport({ method: 'GET', path: '/cart' });
    expect(last().url).toBe('/bff/cart');
    expect(last().init.method).toBe('GET');
    expect(last().init.credentials).toBe('same-origin');
    expect(last().init.headers.Accept).toBe('application/json');
    expect(last().init.body).toBeUndefined();
  });

  test('la URL es siempre relativa: nunca contiene un host ni un esquema', async () => {
    await browserTransport({ method: 'GET', path: '/cart/items/http://evil.test' });
    expect(last().url.startsWith('/bff/')).toBe(true);
    expect(last().url).not.toMatch(/^[a-z]+:/i);
  });

  test('la query se serializa ordenada y escapada', async () => {
    await browserTransport({ method: 'GET', path: '/orders', query: { page: 2, status: 'a b', none: undefined } });
    expect(last().url).toBe('/bff/orders?page=2&status=a%20b');
  });

  test('POST con cuerpo: JSON + Content-Type; las cabeceras del llamante (Idempotency-Key) se conservan', async () => {
    await browserTransport({ method: 'POST', path: '/orders', body: { a: 1 }, headers: { 'Idempotency-Key': 'k-1' } });
    expect(last().init.body).toBe('{"a":1}');
    expect(last().init.headers['Content-Type']).toBe('application/json');
    expect(last().init.headers['Idempotency-Key']).toBe('k-1');
  });

  test('POST sin cuerpo no envía Content-Type', async () => {
    await browserTransport({ method: 'POST', path: '/orders/abc/cancel' });
    expect(last().init.body).toBeUndefined();
    expect(last().init.headers['Content-Type']).toBeUndefined();
  });

  test.each(['cart', '//evil.test/x', '', 'http://evil.test/x', 'https://evil.test', 'javascript:alert(1)', '\\evil.test'])(
    'path no válido %j → ApiError invalid_request y fetch NO se llama',
    async (path) => {
      const err = await browserTransport({ method: 'GET', path }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test('no lleva Authorization ni token: el navegador no conoce ninguno', async () => {
    await browserTransport({ method: 'GET', path: '/cart' });
    expect(JSON.stringify(last().init.headers)).not.toMatch(/authorization|bearer/i);
  });
});

describe('respuestas y errores', () => {
  test('devuelve el JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [1] }));
    await expect(browserTransport({ method: 'GET', path: '/cart' })).resolves.toEqual({ items: [1] });
  });

  test('204 → undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(browserTransport({ method: 'DELETE', path: '/cart/items/p' })).resolves.toBeUndefined();
  });

  test('401 del proxy → ApiError(401, "unauthenticated", details)', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'unauthenticated', message: 'Inicia sesión.', details: null } }, 401));
    const err = await browserTransport({ method: 'GET', path: '/cart' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  test('422 con detalles → ApiError con details', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_error', message: 'x', details: [{ loc: ['a'] }] } }, 422));
    const err = await browserTransport({ method: 'POST', path: '/cart/items', body: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_error', details: [{ loc: ['a'] }] });
  });

  test('respuesta que no es JSON → ApiError invalid_response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const err = await browserTransport({ method: 'GET', path: '/cart' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_response');
  });

  test('fallo de red → ApiError(0, "network")', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = await browserTransport({ method: 'GET', path: '/cart' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });

  test('tiempo agotado → ApiError(0, "timeout") (12 s, por encima de los 10 s del proxy)', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(100));
    fetchMock.mockImplementation((_u: string, init: Init) => new Promise((_ok, fail) => init.signal!.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))));
    const err = await browserTransport({ method: 'GET', path: '/cart' }).catch((e) => e);
    expect(spy).toHaveBeenCalledWith(12_000);
    expect(err).toMatchObject({ status: 0, code: 'timeout' });
  });

  test('cancelación del llamante → no se confunde con timeout (code network)', async () => {
    const ctrl = new AbortController();
    fetchMock.mockImplementation((_u: string, init: Init) => new Promise((_ok, fail) => init.signal!.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))));
    const p = browserTransport({ method: 'GET', path: '/cart', signal: ctrl.signal }).catch((e) => e);
    ctrl.abort();
    expect(await p).toMatchObject({ status: 0, code: 'network' });
  });

  test('no usa localStorage ni sessionStorage', async () => {
    const get = vi.fn();
    vi.stubGlobal('localStorage', { getItem: get, setItem: get });
    vi.stubGlobal('sessionStorage', { getItem: get, setItem: get });
    await browserTransport({ method: 'GET', path: '/cart' });
    expect(get).not.toHaveBeenCalled();
  });
});
