import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/lib/api/http';
import { serverTransport } from '../../src/lib/api/server';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

const FAKE_BEARER = 'abc.def.ghi';
const LEAKY_BEARER = 'tok-secreto';

// T-120 · serverTransport (contrato 3.1) con un `fetch` falso. No hay red.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let fetchMock: ReturnType<typeof vi.fn>;
const lastCall = (): Call => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, Call['init']];
  return { url, init };
};
// Las cabeceras se comparan sin distinguir mayúsculas.
const headersOf = (c: Call) => Object.fromEntries(Object.entries(c.init.headers).map(([k, v]) => [k.toLowerCase(), v]));

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('URL y petición', () => {
  test('URL = API_BASE_URL + /api/v1 + path', async () => {
    await serverTransport()({ method: 'GET', path: '/catalog/categories' });
    expect(lastCall().url).toBe('http://api.test:8000/api/v1/catalog/categories');
    expect(lastCall().init.method).toBe('GET');
  });

  test('la query va ordenada y escapada; sin query no hay "?"', async () => {
    const t = serverTransport();
    await t({ method: 'GET', path: '/catalog/products', query: { sort: 'price_asc', q: 'a b', category: ['x', 'y'], none: undefined } });
    expect(lastCall().url).toBe('http://api.test:8000/api/v1/catalog/products?category=x&category=y&q=a%20b&sort=price_asc');
    await t({ method: 'GET', path: '/catalog/products', query: {} });
    expect(lastCall().url).toBe('http://api.test:8000/api/v1/catalog/products');
  });

  test.each(['catalog/products', 'http://evil.test/x', 'https://evil.test', '//evil.test/x', '', 'javascript:alert(1)'])(
    'path no válido (%j) → ApiError invalid_request y fetch NO se llama',
    async (path) => {
      const err = await serverTransport({ accessToken: 'tok' })({ method: 'GET', path }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: 'invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test('un path con una URL absoluta incrustada no cambia el host de destino', async () => {
    await serverTransport({ accessToken: 'tok' })({ method: 'GET', path: '/catalog/products/http://evil.test' });
    expect(new URL(lastCall().url).host).toBe('api.test:8000');
  });
});

describe('cabeceras', () => {
  test('siempre Accept: application/json', async () => {
    await serverTransport()({ method: 'GET', path: '/x' });
    expect(headersOf(lastCall()).accept).toBe('application/json');
  });

  test('sin token no hay Authorization (undefined, null y cadena vacía)', async () => {
    for (const opts of [undefined, {}, { accessToken: null }, { accessToken: undefined }, { accessToken: '' }]) {
      await serverTransport(opts)({ method: 'GET', path: '/x' });
      expect(headersOf(lastCall())).not.toHaveProperty('authorization');
    }
  });

  test('con token: Authorization: Bearer <token>', async () => {
    await serverTransport({ accessToken: FAKE_BEARER })({ method: 'GET', path: '/x' });
    expect(headersOf(lastCall()).authorization).toBe(`Bearer ${FAKE_BEARER}`);
  });

  test('el token es por transporte: un transporte sin token no hereda el de otro', async () => {
    const withTok = serverTransport({ accessToken: 'tok-1' });
    const without = serverTransport();
    await withTok({ method: 'GET', path: '/x' });
    await without({ method: 'GET', path: '/x' });
    expect(headersOf(lastCall())).not.toHaveProperty('authorization');
  });

  test('Content-Type: application/json solo si hay cuerpo; el cuerpo va como JSON', async () => {
    const t = serverTransport();
    await t({ method: 'GET', path: '/x' });
    expect(headersOf(lastCall())).not.toHaveProperty('content-type');
    expect(lastCall().init.body).toBeUndefined();
    await t({ method: 'POST', path: '/x', body: { a: 1, b: 'ñ' } });
    expect(headersOf(lastCall())['content-type']).toBe('application/json');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ a: 1, b: 'ñ' });
    expect(lastCall().init.method).toBe('POST');
  });

  test('las cabeceras del llamador se reenvían (p. ej. Idempotency-Key)', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: {}, headers: { 'Idempotency-Key': 'k-1' } });
    expect(headersOf(lastCall())['idempotency-key']).toBe('k-1');
  });
});

describe('respuestas', () => {
  test('2xx con JSON → el cuerpo', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], total: 0, page: 1, page_size: 20 }));
    expect(await serverTransport()({ method: 'GET', path: '/x' })).toEqual({ items: [], total: 0, page: 1, page_size: 20 });
  });

  test('204 → undefined', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await serverTransport()({ method: 'DELETE', path: '/x' })).toBeUndefined();
  });

  test('ErrorOut 404 → ApiError con code, message, status y details', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'El reloj no existe.', details: null } }, 404));
    const err = await serverTransport()({ method: 'GET', path: '/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'El reloj no existe.', details: null });
  });

  test('ErrorOut 422 con details → ApiError con details', async () => {
    const details = [{ loc: ['query', 'page'], msg: 'x' }];
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'validation_error', message: 'Datos no válidos.', details } }, 422));
    const err = await serverTransport()({ method: 'GET', path: '/x' }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_error', details });
  });

  test('5xx con formato común conserva su code y status', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'service_unavailable', message: 'No disponible.' } }, 503));
    expect(await serverTransport()({ method: 'GET', path: '/x' }).catch((e) => e)).toMatchObject({ status: 503, code: 'service_unavailable' });
  });

  test.each([
    ['HTML', () => new Response('<html>Bad Gateway</html>', { status: 502 }), 502],
    ['texto con traza', () => new Response('Traceback (most recent call last): secreto', { status: 500 }), 500],
    ['JSON sin el formato', () => json({ detail: 'boom' }, 500), 500],
    ['200 que no es JSON', () => new Response('hola', { status: 200 }), 200],
  ])('%s → invalid_response con el status real y sin filtrar el cuerpo', async (_n, make, status) => {
    fetchMock.mockResolvedValueOnce(make());
    const err = (await serverTransport()({ method: 'GET', path: '/x' }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code: 'invalid_response' });
    expect(`${err.message}${err.stack}${JSON.stringify(err)}`).not.toMatch(/Traceback|secreto|Bad Gateway|boom/);
  });

  test('fallo de red → ApiError status 0, code network (sin el mensaje del error nativo)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED 10.0.0.5:8000'));
    const err = (await serverTransport({ accessToken: LEAKY_BEARER })({ method: 'GET', path: '/x' }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
    expect(`${err.message}${JSON.stringify(err)}`).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|tok-secreto/);
  });
});

describe('sin reintentos', () => {
  test.each([
    ['red', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['500', () => fetchMock.mockImplementation(async () => json({ error: { code: 'internal_error', message: 'x' } }, 500))],
    ['503', () => fetchMock.mockImplementation(async () => new Response('', { status: 503 }))],
    ['404', () => fetchMock.mockImplementation(async () => json({ error: { code: 'not_found', message: 'x' } }, 404))],
    ['cuerpo no JSON', () => fetchMock.mockImplementation(async () => new Response('<html>', { status: 200 }))],
  ])('un error (%s) provoca una sola llamada a fetch', async (_n, arrange) => {
    arrange();
    await serverTransport()({ method: 'POST', path: '/x', body: { a: 1 } }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('señales', () => {
  // fetch falso que respeta la señal, como el real.
  const hangUntilAborted = () =>
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          const s = init.signal as AbortSignal;
          if (s.aborted) rej(s.reason);
          s.addEventListener('abort', () => rej(s.reason));
        }),
    );

  test('la señal del llamador aborta la petición y no se confunde con un timeout', async () => {
    hangUntilAborted();
    const ctl = new AbortController();
    const p = serverTransport()({ method: 'GET', path: '/x', signal: ctl.signal }).catch((e) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    ctl.abort();
    const err = (await p) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).not.toBe('timeout');
    expect(err.status).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('una señal ya abortada no deja la petición colgada', async () => {
    hangUntilAborted();
    const err = await serverTransport()({ method: 'GET', path: '/x', signal: AbortSignal.abort() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).not.toBe('timeout');
  });

  test('toda petición lleva una señal de tiempo máximo', async () => {
    await serverTransport()({ method: 'GET', path: '/x' });
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  test('corta a los 8 s con ApiError status 0, code timeout (tiempo real)', async () => {
    hangUntilAborted();
    const t0 = Date.now();
    const err = (await serverTransport({ accessToken: 'tok' })({ method: 'GET', path: '/x' }).catch((e) => e)) as ApiError;
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(7500);
    expect(elapsed).toBeLessThan(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 15000);
});
