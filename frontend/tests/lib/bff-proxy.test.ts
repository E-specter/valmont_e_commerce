import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { BEARER_VALUE, FakeServer, ORIGIN, SESSION, fakeCookies } from '../helpers/t126';

// T-126 · contrato 3.3: proxy `/bff/*` contra un backend HTTP real de pruebas. Seguridad: lista de permitidos, SSRF, CSRF,
// cabeceras, tamaño, redirecciones, tiempo, Set-Cookie y 401. Se llama al manejador público `ALL` con el contexto de Astro.
const h = vi.hoisted(() => ({ api: 'http://127.0.0.1:1' }));
vi.mock('astro:env/server', () => ({
  get API_BASE_URL() {
    return h.api;
  },
  SUPABASE_URL: 'http://sb.test',
  SUPABASE_ANON_KEY: 'anon-value-for-tests',
}));

const BEARER_A = 'bearer-a-value-0001';
const BEARER_B = 'bearer-b-value-0002';
const backend = new FakeServer();
const evil = new FakeServer(); // destino hostil: no debe recibir nunca nada
const JSON_HEADERS = { 'content-type': 'application/json' };

beforeAll(async () => {
  await backend.start();
  await evil.start();
  h.api = backend.base;
});
afterAll(async () => {
  await backend.stop();
  await evil.stop();
});
beforeEach(() => {
  backend.reset();
  evil.reset();
  backend.reply = { status: 200, headers: JSON_HEADERS, body: '{"items":[]}' };
});
afterEach(() => vi.restoreAllMocks());

type Init = { method?: string; headers?: Record<string, string>; body?: string; path?: string; session?: typeof SESSION | null; search?: string };

async function call(path: string | undefined, init: Init = {}) {
  const { ALL } = await import('../../src/pages/bff/[...path]');
  const method = init.method ?? 'GET';
  const url = new URL(`${ORIGIN}/bff/${path ?? ''}${init.search ?? ''}`);
  const headers = { ...(method === 'GET' || method === 'HEAD' ? {} : { origin: ORIGIN }), ...init.headers };
  const request = new Request(url, { method, headers, body: init.body });
  const cookies = fakeCookies();
  const signOut = vi.fn(async () => ({ error: null }));
  const session = init.session === undefined ? SESSION : init.session;
  const locals = { session, supabase: { auth: { signOut } } };
  const res = (await ALL({ request, url, params: { path }, locals, cookies } as never)) as Response;
  return { res, cookies, signOut, text: await res.text() };
}
const errorCode = (text: string) => (JSON.parse(text) as { error: { code: string } }).error.code;
const lastSeen = () => backend.seen.at(-1)!;

describe('lista de permitidos y destino (SSRF)', () => {
  test.each(['cart', 'cart/items', 'cart/items/abc-123', 'wishlist', 'wishlist/items/1', 'orders', 'orders/abc', 'orders/abc/cancel'])(
    'permitida: %s llega a /api/v1/%s',
    async (path) => {
      const { res } = await call(path);
      expect(res.status).toBe(200);
      expect(backend.seen).toHaveLength(1);
      expect(lastSeen().url).toBe(`/api/v1/${path}`);
    },
  );

  test.each([
    'orders/admin', 'orders/admin/x', 'orders/admin/x/transitions', 'orders/Admin', 'orders/ADMIN/1',
    'identity/me', 'identity', 'catalog/products', 'catalog', 'payments', 'carts', 'cart2', 'cartx/items', 'Cart', 'xcart', 'admin', 'assistant',
    '', 'cart/', 'cart//items', 'orders//admin', '/cart', '//cart',
  ])('fuera de la lista → 404 not_found y no llama al backend: %j', async (path) => {
    const { res, text } = await call(path);
    expect(res.status).toBe(404);
    expect(errorCode(text)).toBe('not_found');
    expect(backend.seen).toHaveLength(0);
  });

  test('sin ruta (params.path indefinido) → 404', async () => {
    const { res } = await call(undefined);
    expect(res.status).toBe(404);
    expect(backend.seen).toHaveLength(0);
  });

  test.each([
    'cart/..', 'cart/../identity/me', 'cart/../../x', 'cart/./x', 'cart/.', 'orders/../orders/admin',
    'cart/..\\identity', 'cart\\..\\x', 'cart/a\\b', 'cart/a?x=1', 'cart?x=1', 'cart/a#frag', 'cart#x', 'cart/a\nb', 'cart/a\u0000b', 'cart/a\tb', 'cart/a\u007fb',
    'orders/..', 'orders/a/../admin',
  ])('recorrido, "?", "#", "\\" o control → 404 sin llegar al backend: %j', async (path) => {
    const { res } = await call(path);
    expect(res.status).toBe(404);
    expect(backend.seen).toHaveLength(0);
  });

  test('un segmento con %2e literal (ya decodificado una vez por Astro) viaja codificado, sin recorrer', async () => {
    const { res } = await call('cart/%2e%2e/identity');
    expect(res.status).toBe(200);
    expect(lastSeen().url).toBe('/api/v1/cart/%252e%252e/identity');
  });

  test('segmentos con caracteres especiales van codificados: no cambian el host ni la ruta', async () => {
    const { res } = await call('cart/items/a@evil.test:80');
    expect(res.status).toBe(200);
    expect(lastSeen().url).toBe('/api/v1/cart/items/a%40evil.test%3A80');
    expect(evil.seen).toHaveLength(0);
  });

  test('un segmento con URL absoluta o "//host" no cambia el destino', async () => {
    await call(`cart/items/${encodeURIComponent('http://127.0.0.1:' + evil.port)}`);
    await call('cart/items/http://evil.test/x'); // "http:" y "" fallan la lista; el resto codifica
    expect(evil.seen).toHaveLength(0);
    expect(backend.seen.every((s) => s.url.startsWith('/api/v1/cart/items/'))).toBe(true);
  });

  test('la query se reenvía tal cual (sin duplicar ni cambiar el destino)', async () => {
    await call('orders', { search: '?page=2&page_size=10&status=a%20b' });
    expect(lastSeen().url).toBe('/api/v1/orders?page=2&page_size=10&status=a%20b');
  });

  test('una query con una URL no cambia el host', async () => {
    await call('cart', { search: `?next=http://127.0.0.1:${evil.port}/x` });
    expect(evil.seen).toHaveLength(0);
    expect(new URL(lastSeen().url, 'http://x').pathname).toBe('/api/v1/cart');
  });
});

describe('métodos', () => {
  test.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])('%s se reenvía con su método', async (method) => {
    const body = method === 'GET' ? undefined : '{"a":1}';
    const { res } = await call('cart/items', { method, body, headers: body ? { 'content-type': 'application/json' } : {} });
    expect(res.status).toBe(200);
    expect(lastSeen().method).toBe(method);
  });

  test.each(['HEAD', 'OPTIONS', 'PROPFIND', 'PURGE'])('%s → 405 method_not_allowed sin llegar al backend', async (method) => {
    const { res, text } = await call('cart', { method, headers: { origin: ORIGIN } });
    expect(res.status).toBe(405);
    expect(errorCode(text)).toBe('method_not_allowed');
    expect(backend.seen).toHaveLength(0);
  });
});

describe('CSRF: Origin en métodos que no son GET', () => {
  const write = { method: 'POST', body: '{"product_id":"p"}', headers: { 'content-type': 'application/json' } };

  test.each([
    ['ajeno', 'https://evil.test'],
    ['ajeno con el mismo host y otro puerto', 'http://localhost:4322'],
    ['mismo host, otro esquema', 'https://localhost:4321'],
    ['subdominio', 'http://x.localhost:4321'],
    ['sufijo', 'http://localhost:4321.evil.test'],
    ['"null"', 'null'],
    ['con ruta', 'http://localhost:4321/'],
    ['mayúsculas', 'HTTP://LOCALHOST:4321'],
  ])('POST con Origin %s → 403 forbidden', async (_n, origin) => {
    const { res, text } = await call('cart/items', { ...write, headers: { ...write.headers, origin } });
    expect(res.status).toBe(403);
    expect(errorCode(text)).toBe('forbidden');
    expect(backend.seen).toHaveLength(0);
  });

  test('POST sin Origin → 403', async () => {
    const { ALL } = await import('../../src/pages/bff/[...path]');
    const url = new URL(`${ORIGIN}/bff/cart/items`);
    const request = new Request(url, { method: 'POST', body: write.body, headers: write.headers });
    expect(request.headers.get('origin')).toBeNull();
    const res = (await ALL({ request, url, params: { path: 'cart/items' }, locals: { session: SESSION, supabase: {} }, cookies: fakeCookies() } as never)) as Response;
    expect(res.status).toBe(403);
    expect(backend.seen).toHaveLength(0);
  });

  test.each(['POST', 'PATCH', 'PUT', 'DELETE'])('%s con Origin ajeno → 403 aunque no haya sesión (el origen se comprueba antes)', async (method) => {
    const { res } = await call('cart/items/x', { method, headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}', session: null });
    expect(res.status).toBe(403);
    expect(backend.seen).toHaveLength(0);
  });

  test('Origin propio → pasa; el mismo valor exacto que url.origin', async () => {
    const { res } = await call('cart/items', { ...write, headers: { ...write.headers, origin: ORIGIN } });
    expect(res.status).toBe(200);
  });

  test('GET no exige Origin (lecturas desde el mismo origen)', async () => {
    const { res } = await call('cart');
    expect(res.status).toBe(200);
  });

  test('el 403 ocurre antes de leer el cuerpo ni llamar al backend (Origin ajeno + cuerpo enorme)', async () => {
    const { res } = await call('cart/items', { ...write, body: 'x'.repeat(100_000), headers: { ...write.headers, origin: 'https://evil.test' } });
    expect(res.status).toBe(403);
  });
});

describe('sesión', () => {
  test('sin sesión → 401 unauthenticated (formato común) y no llama al backend', async () => {
    const { res, text } = await call('cart', { session: null });
    expect(res.status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: { code: 'unauthenticated', message: expect.any(String), details: null } });
    expect(backend.seen).toHaveLength(0);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('con sesión añade el Bearer del servidor (el del cliente se descarta)', async () => {
    await call('cart', { headers: { authorization: 'Bearer forged-by-client' } });
    expect(lastSeen().headers.authorization).toBe(`Bearer ${BEARER_VALUE}`);
  });

  test('el 401 no revela el token ni la sesión', async () => {
    const { text } = await call('cart', { session: null });
    expect(text).not.toContain(BEARER_VALUE);
  });
});

describe('cabeceras que entran al backend', () => {
  test('solo salen authorization, accept, content-type e idempotency-key (más las del cliente HTTP)', async () => {
    await call('orders', {
      method: 'POST',
      body: '{"a":1}',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'key-0001',
        cookie: 'sb-x-auth-token=SECRET-COOKIE; other=1',
        authorization: 'Bearer forged-by-client',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.test',
        'x-forwarded-proto': 'https',
        forwarded: 'for=6.6.6.6',
        'x-real-ip': '6.6.6.6',
        'x-api-key': 'k',
        'x-request-id': 'r-1',
        referer: 'https://evil.test/',
        'user-agent': 'curl/evil',
        host: 'evil.test',
        'x-http-method-override': 'DELETE',
        'x-user-id': 'someone-else',
        'x-customer-id': 'someone-else',
        'accept-language': 'xx',
        'proxy-authorization': 'Basic x',
      },
    });
    const sent = Object.keys(lastSeen().headers);
    // Conexión: las pone el cliente HTTP de Node (host, connection, content-length, accept-encoding, user-agent...), no el código.
    const transport = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'user-agent', 'accept-language', 'sec-fetch-mode', 'transfer-encoding']);
    const app = sent.filter((k) => !transport.has(k)).sort();
    expect(app).toEqual(['accept', 'authorization', 'content-type', 'idempotency-key']);
    const all = JSON.stringify(lastSeen().headers);
    expect(all).not.toMatch(/SECRET-COOKIE|forged-by-client|6\.6\.6\.6|evil\.test|someone-else|DELETE|curl\/evil/);
    expect(lastSeen().headers.host).not.toBe('evil.test');
    expect(lastSeen().headers['x-http-method-override']).toBeUndefined();
    expect(lastSeen().method).toBe('POST');
  });

  test('Cookie nunca se reenvía, ni siquiera sola', async () => {
    await call('cart', { headers: { cookie: 'sb-x-auth-token=SECRET-COOKIE' } });
    expect(lastSeen().headers.cookie).toBeUndefined();
    expect(JSON.stringify(lastSeen().headers)).not.toContain('SECRET-COOKIE');
  });

  test('Idempotency-Key se reenvía tal cual', async () => {
    await call('orders', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'idempotency-key': 'abc-123_XYZ.7' } });
    expect(lastSeen().headers['idempotency-key']).toBe('abc-123_XYZ.7');
  });

  test('sin Idempotency-Key no se inventa una', async () => {
    await call('orders', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(lastSeen().headers['idempotency-key']).toBeUndefined();
  });

  test.each([['con espacio', 'a b'], ['con salto de línea', 'a\r\nX-Evil: 1'], ['vacía', ''], ['demasiado larga', 'k'.repeat(129)], ['con tabulación', 'a\tb'], ['no ASCII', 'clave-ñ']])(
    'Idempotency-Key inválida (%s) → 400 y no llega al backend',
    async (_n, key) => {
      let result;
      try {
        result = await call('orders', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'idempotency-key': key } });
      } catch {
        return; // el propio Request rechaza la cabecera (saltos de línea): ya no llega nada
      }
      expect(result.res.status).toBe(400);
      expect(errorCode(result.text)).toBe('invalid_request');
      expect(backend.seen).toHaveLength(0);
    },
  );

  test('Idempotency-Key de 128 caracteres es válida', async () => {
    const { res } = await call('orders', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'idempotency-key': 'k'.repeat(128) } });
    expect(res.status).toBe(200);
  });
});

describe('cuerpo: tamaño y tipo', () => {
  const json = { 'content-type': 'application/json' };

  test('el cuerpo JSON se reenvía íntegro', async () => {
    const body = '{"product_id":"p-1","quantity":2,"nota":"ñandú ✓"}';
    await call('cart/items', { method: 'POST', body, headers: json });
    expect(lastSeen().body).toBe(body);
    expect(lastSeen().headers['content-type']).toBe('application/json');
  });

  test('límite: 16 KiB exactos pasan; 16 KiB + 1 → 413 payload_too_large', async () => {
    const pad = (n: number) => JSON.stringify({ x: 'a'.repeat(n - '{"x":""}'.length) });
    const ok = pad(16 * 1024);
    expect(ok.length).toBe(16 * 1024);
    expect((await call('cart/items', { method: 'POST', body: ok, headers: json })).res.status).toBe(200);
    backend.reset();
    const big = pad(16 * 1024 + 1);
    const { res, text } = await call('cart/items', { method: 'POST', body: big, headers: json });
    expect(res.status).toBe(413);
    expect(errorCode(text)).toBe('payload_too_large');
    expect(backend.seen).toHaveLength(0);
  });

  test('un cuerpo enorme (2 MiB) → 413 sin llegar al backend', async () => {
    const { res } = await call('cart/items', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }), headers: json });
    expect(res.status).toBe(413);
    expect(backend.seen).toHaveLength(0);
  });

  test('Content-Length declarado mayor que el tope → 413 aunque el cuerpo real sea pequeño', async () => {
    const { res } = await call('cart/items', { method: 'POST', body: '{}', headers: { ...json, 'content-length': String(1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(backend.seen).toHaveLength(0);
  });

  test('Content-Length mentiroso a la baja no esquiva el tope (se cuenta lo leído)', async () => {
    const { res } = await call('cart/items', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(64 * 1024) }), headers: { ...json, 'content-length': '2' } });
    expect(res.status).toBe(413);
    expect(backend.seen).toHaveLength(0);
  });

  test.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/html', 'application/xml', ''])(
    'Content-Type %j con cuerpo → 415 unsupported_media_type',
    async (ct) => {
      const { res, text } = await call('cart/items', { method: 'POST', body: '{"a":1}', headers: ct ? { 'content-type': ct } : {} });
      // Sin cabecera, Request fija text/plain;charset=UTF-8 para un cuerpo de texto
      expect(res.status).toBe(415);
      expect(errorCode(text)).toBe('unsupported_media_type');
      expect(backend.seen).toHaveLength(0);
    },
  );

  test.each(['application/jsonx', 'application/json-patch+json', 'application/jsonx; charset=utf-8', 'text/application/json'])('Content-Type %j (no es exactamente application/json) → 415', async (ct) => {
    const { res, text } = await call('cart/items', { method: 'POST', body: '{"a":1}', headers: { 'content-type': ct } });
    expect(res.status).toBe(415);
    expect(errorCode(text)).toBe('unsupported_media_type');
    expect(backend.seen).toHaveLength(0);
  });

  test('application/json con charset y mayúsculas se admite', async () => {
    expect((await call('cart/items', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'Application/JSON; charset=utf-8' } })).res.status).toBe(200);
  });

  test.each(['{not json', '{"a":', '[1,', 'undefined', "{'a':1}", '{"a":1}}'])('JSON inválido %j → 400 invalid_request', async (body) => {
    const { res, text } = await call('cart/items', { method: 'POST', body, headers: json });
    expect(res.status).toBe(400);
    expect(errorCode(text)).toBe('invalid_request');
    expect(backend.seen).toHaveLength(0);
  });

  test('POST sin cuerpo (p. ej. /orders/{id}/cancel) se admite y no envía cuerpo ni Content-Type', async () => {
    const { res } = await call('orders/abc/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(lastSeen().body).toBe('');
    expect(lastSeen().headers['content-type']).toBeUndefined();
  });

  test('DELETE sin cuerpo se admite', async () => {
    expect((await call('cart/items/p-1', { method: 'DELETE' })).res.status).toBe(200);
  });

  test('un GET con cuerpo no lo reenvía (no hay cuerpo en lecturas)', async () => {
    const { ALL } = await import('../../src/pages/bff/[...path]');
    const url = new URL(`${ORIGIN}/bff/cart`);
    const request = new Request(url, { method: 'GET', headers: {} });
    const res = (await ALL({ request, url, params: { path: 'cart' }, locals: { session: SESSION, supabase: {} }, cookies: fakeCookies() } as never)) as Response;
    expect(res.status).toBe(200);
    expect(lastSeen().body).toBe('');
  });
});

describe('respuesta: estado y cuerpo del backend', () => {
  test('201 de POST /orders y su cuerpo exacto se conservan', async () => {
    const body = '{"id":"o-1","status":"pending_payment","total":{"amount":125000,"currency":"PEN"}}';
    backend.reply = { status: 201, headers: { ...JSON_HEADERS, location: '/api/v1/orders/o-1' }, body };
    const { res, text } = await call('orders', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' } });
    expect(res.status).toBe(201);
    expect(text).toBe(body);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test.each([400, 404, 409, 422, 429, 500, 503])('el estado %i y su cuerpo de error se conservan', async (status) => {
    const body = `{"error":{"code":"c_${status}","message":"m","details":{"field":"x"}}}`;
    backend.reply = { status, headers: JSON_HEADERS, body };
    const { res, text } = await call('cart/items', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(status);
    expect(text).toBe(body);
  });

  test('204 → 204 sin cuerpo', async () => {
    backend.reply = { status: 204 };
    const { res, text } = await call('cart/items/p-1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(text).toBe('');
  });

  test('un cuerpo grande (500 KiB) del backend pasa íntegro', async () => {
    const body = JSON.stringify({ items: Array.from({ length: 6000 }, (_, i) => ({ i, n: 'reloj-' + i })) });
    backend.reply = { status: 200, headers: JSON_HEADERS, body };
    expect((await call('orders')).text).toBe(body);
  });

  test('Cache-Control: no-store en éxito, error y 204', async () => {
    for (const [status, body] of [[200, '{}'], [422, '{"error":{}}'], [204, '']] as const) {
      backend.reply = { status, headers: JSON_HEADERS, body };
      expect((await call('cart')).res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('nunca devuelve Set-Cookie del backend ni otras cabeceras suyas (Location, Server, X-*, Authorization, WWW-Authenticate)', async () => {
    backend.reply = {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        'set-cookie': ['sid=backend-session; Path=/', 'sb-x-auth-token=evil; Path=/'],
        'x-internal-debug': 'trace-1',
        server: 'uvicorn-internal',
        'www-authenticate': 'Bearer',
        'access-control-allow-origin': '*',
        'content-security-policy': 'default-src *',
        'x-request-id': 'r-9',
        location: 'http://evil.test/',
      },
      body: '{"ok":true}',
    };
    const { res, cookies } = await call('cart');
    const names = [...res.headers.keys()].sort();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(names).toEqual(['cache-control', 'content-type']);
    expect(cookies.ops).toEqual([]); // y el proxy no escribe cookies en una respuesta correcta
  });

  test('respuesta no JSON del backend (p. ej. HTML de error con traza) → 502 invalid_response y no se filtra el contenido', async () => {
    backend.reply = { status: 500, headers: { 'content-type': 'text/html' }, body: '<pre>Traceback (most recent call last): File "/app/secret.py"</pre>' };
    const { res, text } = await call('cart');
    expect(res.status).toBe(502);
    expect(errorCode(text)).toBe('invalid_response');
    expect(text).not.toMatch(/Traceback|secret\.py/);
  });

  test.each(['application/jsonx', 'application/json-patch+json', 'text/json'])('respuesta del backend con Content-Type %j → 502 invalid_response', async (ct) => {
    backend.reply = { status: 200, headers: { 'content-type': ct }, body: '{"a":1}' };
    const { res, text } = await call('cart');
    expect(res.status).toBe(502);
    expect(errorCode(text)).toBe('invalid_response');
  });

  test('respuesta application/json; charset=utf-8 del backend se acepta', async () => {
    backend.reply = { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":1}' };
    expect((await call('cart')).res.status).toBe(200);
  });

  test('respuesta sin Content-Type → 502', async () => {
    backend.reply = { status: 200, headers: {}, body: '{"a":1}' };
    expect((await call('cart')).res.status).toBe(502);
  });
});

describe('redirect: manual (no seguir redirecciones)', () => {
  test.each([301, 302, 303, 307, 308])('el backend responde %i hacia un servidor ajeno: no se sigue y no se reenvía el Bearer', async (status) => {
    backend.reply = { status, headers: { location: `http://127.0.0.1:${evil.port}/steal` }, body: '' };
    const { res } = await call('cart');
    expect(evil.seen).toHaveLength(0);
    expect(backend.seen).toHaveLength(1);
    expect(res.status).not.toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(JSON.stringify([...res.headers.entries()])).not.toContain('steal');
  });

  test('una redirección en POST tampoco se sigue (el cuerpo y el Bearer no viajan al destino)', async () => {
    backend.reply = { status: 307, headers: { location: `http://127.0.0.1:${evil.port}/steal` }, body: '' };
    await call('orders', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    expect(evil.seen).toHaveLength(0);
  });

  test('fetch se invoca con redirect "manual"', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await call('cart');
    expect((spy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });
});

describe('tiempo y red', () => {
  test('el límite es de 10 s y, al agotarse, 504 timeout (formato común)', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(150));
    backend.reply = { status: 200, headers: JSON_HEADERS, body: '{}', delayMs: 1500 };
    const { res, text } = await call('cart');
    expect(spy).toHaveBeenCalledWith(10_000);
    expect(res.status).toBe(504);
    expect(JSON.parse(text)).toEqual({ error: { code: 'timeout', message: expect.any(String), details: null } });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('backend caído (conexión rechazada) → 502 network sin detalles internos', async () => {
    const dead = await new FakeServer().start();
    const base = dead.base;
    await dead.stop();
    h.api = base;
    try {
      const { res, text } = await call('cart');
      expect(res.status).toBe(502);
      expect(errorCode(text)).toBe('network');
      expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack|at /);
    } finally {
      h.api = backend.base;
    }
  });

  test('fetch que lanza un error cualquiera → 502 network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
    const { res, text } = await call('cart');
    expect(res.status).toBe(502);
    expect(errorCode(text)).toBe('network');
  });

  test('un API_BASE_URL con barra final no duplica "/"', async () => {
    h.api = `${backend.base}/`;
    try {
      await call('cart');
      expect(lastSeen().url).toBe('/api/v1/cart');
    } finally {
      h.api = backend.base;
    }
  });
});

describe('401 del backend: limpia la sesión', () => {
  const unauthorized = '{"error":{"code":"unauthenticated","message":"Autenticación requerida.","details":null}}';

  test('el estado y el cuerpo se conservan, signOut local y borra las cookies sb-* de la petición', async () => {
    backend.reply = { status: 401, headers: { ...JSON_HEADERS, 'www-authenticate': 'Bearer', 'set-cookie': 'evil=1' }, body: unauthorized };
    const { res, text, cookies, signOut } = await call('cart', { headers: { cookie: 'sb-x-auth-token.0=a; sb-x-auth-token.1=b; theme=dark; sb-x-auth-token-code-verifier=c' } });
    expect(res.status).toBe(401);
    expect(text).toBe(unauthorized);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookies.deleted()).toEqual(['sb-x-auth-token-code-verifier', 'sb-x-auth-token.0', 'sb-x-auth-token.1']);
    expect(res.headers.get('set-cookie')).toBeNull(); // las cookies borradas las emite Astro (cookies), no esta Response
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  test.each([200, 403, 404, 422, 500])('un %i del backend NO borra la sesión', async (status) => {
    backend.reply = { status, headers: JSON_HEADERS, body: '{}' };
    const { cookies, signOut } = await call('cart', { headers: { cookie: 'sb-x-auth-token=a' } });
    expect(cookies.deleted()).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  test('un 401 sin Cookie en la petición tampoco rompe', async () => {
    backend.reply = { status: 401, headers: JSON_HEADERS, body: unauthorized };
    const { res } = await call('cart');
    expect(res.status).toBe(401);
  });
});

describe('aislamiento: la identidad sale de la sesión', () => {
  test('parámetros de identidad del cliente en la query o el cuerpo se reenvían como datos, pero el Bearer es el de la sesión', async () => {
    await call('orders', { search: '?customer_id=otro-usuario', headers: { 'x-customer-id': 'otro-usuario' } });
    expect(lastSeen().headers['x-customer-id']).toBeUndefined();
    expect(lastSeen().headers.authorization).toBe(`Bearer ${BEARER_VALUE}`);
  });

  test('dos sesiones distintas usan cada una su propio token (sin caché entre peticiones)', async () => {
    await call('cart', { session: { ...SESSION, accessToken: BEARER_A } });
    await call('cart', { session: { ...SESSION, accessToken: BEARER_B } });
    expect(backend.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${BEARER_A}`, `Bearer ${BEARER_B}`]);
  });
});
