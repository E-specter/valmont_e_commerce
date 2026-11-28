import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/lib/api/http';
import { serverTransport } from '../../src/lib/api/server';
import { uploadProductImage, reorderImages } from '../../src/lib/api/admin-catalog';
import { apiFor } from '../../src/lib/server/session';
import { asFile, jpegBytes } from '../helpers/t148-files';
import { IMG_A, IMG_B, PRODUCT_ID } from '../helpers/t148';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-148 · `serverTransport` con `FormData` y `timeoutMs`, y `apiFor(locals, { timeoutMs })` (paquete T-148: transporte). `fetch` falso, sin red.
const TIMEOUT_SHORT_MS = 120;
const TIMEOUT_ELAPSED_MAX_MS = 3000;
const FAKE_BEARER = 'abc.def.ghi';
const FILE_NAME = 'frente.jpg';
const ALT = 'Frente del reloj';
const ONE = 1;
const TWO = 2;
const TOO_LARGE = 413;
const HTTP_OK = 200;
const UNSUPPORTED = 415;
const UNAVAILABLE = 503;
const UNPROCESSABLE = 422;

const json = (body: unknown, status = HTTP_OK) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let fetchMock: ReturnType<typeof vi.fn>;
const lastCall = (): Call => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, Call['init']];
  return { url, init };
};
const headersOf = (c: Call): Record<string, string> => Object.fromEntries(Object.entries(c.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
const form = (): FormData => {
  const fd = new FormData();
  fd.append('file', asFile(jpegBytes(), FILE_NAME, 'image/jpeg'));
  fd.append('alt', ALT);
  return fd;
};
/** Resuelve con el error en vez de rechazar. */
const settle = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    return await p;
  } catch (e) {
    return e;
  }
};
/** `fetch` que respeta la señal, como el real. */
const hangUntilAborted = () =>
  fetchMock.mockImplementation(
    (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        const s = init.signal as AbortSignal;
        if (s.aborted) rej(s.reason);
        s.addEventListener('abort', () => rej(s.reason));
      }),
  );

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('serverTransport · cuerpo FormData', () => {
  test('el FormData viaja tal cual (la misma instancia), sin JSON.stringify', async () => {
    const fd = form();
    await serverTransport({ accessToken: FAKE_BEARER })({ method: 'POST', path: '/catalog/admin/products/x/images', body: fd });
    expect(lastCall().init.body).toBe(fd);
    expect(typeof lastCall().init.body).not.toBe('string');
    expect(lastCall().init.method).toBe('POST');
  });

  test('no pone Content-Type (lo añade fetch con el límite del multipart), en ninguna capitalización', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: form() });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  test('aunque el llamador pase un Content-Type (p. ej. application/json), con FormData no se envía: rompería el límite del multipart', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: form(), headers: { 'Content-Type': 'application/json' } });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    await serverTransport()({ method: 'POST', path: '/x', body: form(), headers: { 'content-type': 'multipart/form-data; boundary=manual' } });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  test('con FormData siguen Accept: application/json y el Bearer; las demás cabeceras del llamador se reenvían', async () => {
    await serverTransport({ accessToken: FAKE_BEARER })({ method: 'POST', path: '/x', body: form(), headers: { 'X-Req': 'r-1' } });
    const h = headersOf(lastCall());
    expect(h.accept).toBe('application/json');
    expect(h.authorization).toBe(`Bearer ${FAKE_BEARER}`);
    expect(h['x-req']).toBe('r-1');
  });

  test('el archivo y el texto alternativo llegan intactos en el FormData que ve fetch', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: form() });
    const sent = lastCall().init.body as FormData;
    const file = sent.get('file') as File;
    expect(file).toBeInstanceOf(File);
    expect(file.size).toBe(jpegBytes().length);
    expect(sent.get('alt')).toBe(ALT);
  });

  test('uploadProductImage (T-144) usa el transporte sin Content-Type propio', async () => {
    await uploadProductImage(serverTransport({ accessToken: FAKE_BEARER }), PRODUCT_ID, asFile(jpegBytes(), FILE_NAME, 'image/jpeg'), ALT);
    expect(lastCall().url).toBe(`http://api.test:8000/api/v1/catalog/admin/products/${PRODUCT_ID}/images`);
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(lastCall().init.body).toBeInstanceOf(FormData);
  });

  test('la validación de `path` se conserva con FormData: una URL absoluta o `//host` no llega a fetch', async () => {
    const t = serverTransport({ accessToken: 'tok' });
    const errors = await Promise.all(['http://evil.test/x', '//evil.test/x', 'catalog/x', ''].map((path) => t({ method: 'POST', path, body: form() }).catch((e) => e)));
    errors.forEach((e) => expect(e).toMatchObject({ status: 0, code: 'invalid_request' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('un FormData vacío (sin entradas) sigue siendo FormData, no JSON `{}`', async () => {
    const empty = new FormData();
    await serverTransport()({ method: 'POST', path: '/x', body: empty });
    expect(lastCall().init.body).toBe(empty);
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });
});

describe('serverTransport · JSON sin cambios', () => {
  test('un objeto sigue yendo como JSON con Content-Type: application/json', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: { a: 1, b: 'ñ' } });
    expect(headersOf(lastCall())['content-type']).toBe('application/json');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ a: 1, b: 'ñ' });
  });

  test('el arreglo de UUID de `PUT …/images/order` va como JSON array (no como FormData)', async () => {
    await reorderImages(serverTransport({ accessToken: FAKE_BEARER }), PRODUCT_ID, [IMG_B, IMG_A]);
    expect(lastCall().init.method).toBe('PUT');
    expect(lastCall().url).toBe(`http://api.test:8000/api/v1/catalog/admin/products/${PRODUCT_ID}/images/order`);
    expect(headersOf(lastCall())['content-type']).toBe('application/json');
    expect(JSON.parse(lastCall().init.body as string)).toEqual([IMG_B, IMG_A]);
  });

  test('sin cuerpo no hay Content-Type ni body (GET y DELETE)', async () => {
    await serverTransport()({ method: 'DELETE', path: '/x' });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    expect(lastCall().init.body).toBeUndefined();
  });

  test('un cuerpo `null` o una cadena no se confunde con FormData', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: 'texto' });
    expect(JSON.parse(lastCall().init.body as string)).toBe('texto');
    expect(headersOf(lastCall())['content-type']).toBe('application/json');
  });
});

describe('serverTransport · timeoutMs', () => {
  test('timeoutMs corto → ApiError status 0 code timeout, a ese tiempo y no a los 8 s', async () => {
    hangUntilAborted();
    const t0 = Date.now();
    const err = (await serverTransport({ accessToken: 'tok', timeoutMs: TIMEOUT_SHORT_MS })({ method: 'GET', path: '/x' }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(TIMEOUT_ELAPSED_MAX_MS);
    expect(fetchMock).toHaveBeenCalledTimes(ONE);
  });

  test('con FormData también rige timeoutMs', async () => {
    hangUntilAborted();
    const err = (await serverTransport({ timeoutMs: TIMEOUT_SHORT_MS })({ method: 'POST', path: '/x', body: form() }).catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'timeout' });
  });

  test('la señal del llamador sigue ganando sobre timeoutMs y no se confunde con un timeout', async () => {
    hangUntilAborted();
    const ctl = new AbortController();
    const p = settle(serverTransport({ timeoutMs: TIMEOUT_ELAPSED_MAX_MS })({ method: 'GET', path: '/x', signal: ctl.signal }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(ONE));
    ctl.abort();
    expect(((await p) as ApiError).code).not.toBe('timeout');
  });

  test('cada transporte lleva su propio tiempo: uno corto no acorta a otro', async () => {
    const short = serverTransport({ timeoutMs: TIMEOUT_SHORT_MS });
    const normal = serverTransport();
    hangUntilAborted();
    const [a] = await Promise.all([short({ method: 'GET', path: '/x' }).catch((e) => e)]);
    expect((a as ApiError).code).toBe('timeout');
    fetchMock.mockImplementation(async () => json({ ok: true }));
    expect(await normal({ method: 'GET', path: '/x' })).toEqual({ ok: true });
  });

  test('toda petición sigue llevando una señal de tiempo máximo (también con FormData)', async () => {
    await serverTransport()({ method: 'POST', path: '/x', body: form() });
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('serverTransport · errores de la subida', () => {
  test.each([
    ['file_too_large', TOO_LARGE],
    ['payload_too_large', TOO_LARGE],
    ['invalid_image', UNPROCESSABLE],
    ['image_dimensions_exceeded', UNPROCESSABLE],
    ['animated_image', UNPROCESSABLE],
    ['unsupported_media_type', UNSUPPORTED],
    ['storage_unavailable', UNAVAILABLE],
  ])('ErrorOut %s conserva su code y su status', async (code, status) => {
    fetchMock.mockResolvedValueOnce(json({ error: { code, message: 'Message in English.', details: null } }, status));
    const err = await serverTransport()({ method: 'POST', path: '/x', body: form() }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code });
  });

  test('un 413 de texto plano (p. ej. del proxy) → ApiError con status 413 y sin filtrar el cuerpo', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Request Entity Too Large: secreto-interno', { status: TOO_LARGE }));
    const err = (await serverTransport()({ method: 'POST', path: '/x', body: form() }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(TOO_LARGE);
    expect(`${err.message}${JSON.stringify(err)}`).not.toContain('secreto-interno');
  });

  test('una subida no se reintenta: un error, una sola llamada', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await serverTransport()({ method: 'POST', path: '/x', body: form() }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(ONE);
  });
});

describe('apiFor(locals, { timeoutMs })', () => {
  const locals = (accessToken: string | null) => ({ session: accessToken ? { accessToken } : null, supabase: {} }) as never;

  test('sin opciones se comporta como antes: Bearer de la sesión y 8 s', async () => {
    await apiFor(locals(FAKE_BEARER))({ method: 'GET', path: '/x' });
    expect(headersOf(lastCall()).authorization).toBe(`Bearer ${FAKE_BEARER}`);
  });

  test('sin sesión no hay Authorization', async () => {
    await apiFor(locals(null))({ method: 'GET', path: '/x' });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  test('con { timeoutMs } el tiempo llega al transporte y el Bearer se conserva', async () => {
    hangUntilAborted();
    const t = apiFor(locals(FAKE_BEARER), { timeoutMs: TIMEOUT_SHORT_MS });
    const err = (await t({ method: 'POST', path: '/x', body: form() }).catch((e) => e)) as ApiError;
    expect(err).toMatchObject({ status: 0, code: 'timeout' });
    expect(headersOf(lastCall()).authorization).toBe(`Bearer ${FAKE_BEARER}`);
  });

  test('con { timeoutMs } y FormData, no hay Content-Type propio', async () => {
    await apiFor(locals(FAKE_BEARER), { timeoutMs: TIMEOUT_ELAPSED_MAX_MS })({ method: 'POST', path: '/x', body: form() });
    expect(Object.keys(lastCall().init.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  test('apiFor(locals, {}) y apiFor(locals, undefined) valen lo mismo que apiFor(locals)', async () => {
    await Promise.all([apiFor(locals(null), {}), apiFor(locals(null), undefined)].map((t) => t({ method: 'GET', path: '/x' })));
    expect(fetchMock).toHaveBeenCalledTimes(TWO);
  });
});
