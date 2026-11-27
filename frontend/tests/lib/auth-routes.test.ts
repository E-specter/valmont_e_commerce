import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { BEARER_VALUE, FakeServer, ORIGIN, fakeCookies } from '../helpers/t126';

// T-126 · `GET /auth/callback` (PKCE, redirección abierta, PATCH de mejor esfuerzo) y `/salir` (solo POST con Origin propio).
const h = vi.hoisted(() => ({ api: 'http://127.0.0.1:1' }));
vi.mock('astro:env/server', () => ({
  get API_BASE_URL() {
    return h.api;
  },
  SUPABASE_URL: 'http://sb.test:54321',
  SUPABASE_ANON_KEY: 'anon-value-for-tests',
}));

const backend = new FakeServer();
beforeAll(async () => {
  await backend.start();
  h.api = backend.base;
});
afterAll(() => backend.stop());
beforeEach(() => {
  backend.reset();
  backend.reply = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
});

// Nombres de variables, ficheros o trazas que no deben verse nunca.
const LEAK = /SUPABASE|ANON|KEY|\.ts:\d+|at \w+ \(/i;
type Meta = Record<string, unknown>;
const sessionWith = (meta: Meta | undefined) => ({ access_token: BEARER_VALUE, user: { user_metadata: meta } });

function supabase(opts: { exchange?: () => Promise<unknown>; signOut?: () => Promise<unknown> } = {}) {
  const exchangeCodeForSession = vi.fn(opts.exchange ?? (async () => ({ data: { session: sessionWith(undefined) }, error: null })));
  const signOut = vi.fn(opts.signOut ?? (async () => ({ error: null })));
  return { auth: { exchangeCodeForSession, signOut }, exchangeCodeForSession, signOut };
}

async function callback(query: string, sb = supabase()) {
  const { GET } = await import('../../src/pages/auth/callback');
  const url = new URL(`${ORIGIN}/auth/callback${query}`);
  const res = (await GET({ url, locals: { supabase: sb, session: null }, request: new Request(url), cookies: fakeCookies() } as never)) as Response;
  return { res, sb, location: res.headers.get('location') };
}

describe('GET /auth/callback · fallos → /ingresar?error=confirmacion', () => {
  const FAIL = '/ingresar?error=confirmacion';

  test.each([['', 'sin parámetros'], ['?next=/cuenta', 'sin code'], ['?code=', 'code vacío'], ['?error=access_denied', 'solo error'], ['?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid', 'error de Supabase'], ['?code=abc&error=access_denied', 'code y error a la vez']])(
    '%s (%s)',
    async (query) => {
      const { res, location, sb } = await callback(query);
      expect(res.status).toBe(302);
      expect(location).toBe(FAIL);
      expect(sb.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    },
  );

  test('error al canjear el código → mismo destino y el mensaje del error no se refleja', async () => {
    const { res, location } = await callback('?code=abc', supabase({ exchange: async () => ({ data: { session: null }, error: { message: 'secret-detail-123', code: 'flow_state_not_found' } }) }));
    expect(res.status).toBe(302);
    expect(location).toBe(FAIL);
    expect(location).not.toContain('secret-detail');
  });

  test('sin sesión en la respuesta → fallo', async () => {
    const { location } = await callback('?code=abc', supabase({ exchange: async () => ({ data: { session: null }, error: null }) }));
    expect(location).toBe(FAIL);
  });

  test('el canje lanza (sin red o sin configuración) → fallo genérico, sin propagar', async () => {
    const { res, location } = await callback('?code=abc', supabase({ exchange: async () => { throw new Error('boom: SUPABASE_ANON_KEY'); } }));
    expect(res.status).toBe(302);
    expect(location).toBe(FAIL);
    expect(backend.seen).toHaveLength(0);
  });

  test('sin configuración (locals.supabase lanza) → 500 genérico, sin nombres de variables ni trazas', async () => {
    const { GET } = await import('../../src/pages/auth/callback');
    const url = new URL(`${ORIGIN}/auth/callback?code=abc&next=/cuenta`);
    const locals = {
      session: null,
      get supabase(): never {
        throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24');
      },
    };
    const res = (await GET({ url, locals, request: new Request(url), cookies: fakeCookies() } as never)) as Response;
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(LEAK);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(backend.seen).toHaveLength(0);
  });

  test('el `code` canjeado se pasa tal cual y no aparece en la redirección', async () => {
    const { location, sb } = await callback('?code=pkce-code-0001&next=/cuenta');
    expect(sb.exchangeCodeForSession).toHaveBeenCalledWith('pkce-code-0001');
    expect(location).not.toContain('pkce-code-0001');
  });
});

describe('GET /auth/callback · éxito y `next`', () => {
  test.each([[''], ['&next='], ['&next=cuenta'], ['&next=//evil.com'], ['&next=///evil.com'], ['&next=/\\evil.com'], ['&next=https://evil.com/cuenta'], ['&next=javascript:alert(1)'], ['&next=/a%0d%0aSet-Cookie:x=1'], ['&next=/a%0ab'], ['&next=%2F%2Fevil.com'], ['&next=%5C%5Cevil.com'], ['&next=data:text/html,x'], ['&next=http://localhost:4321@evil.com']])(
    'next hostil o ausente (%j) → /cuenta',
    async (extra) => {
      const { res, location } = await callback(`?code=abc${extra}`);
      expect(res.status).toBe(302);
      expect(location).toBe('/cuenta');
    },
  );

  test.each(['/cuenta/pedidos', '/checkout', '/relojes?categoria=a&page=2', '/carrito'])('next interno %s se respeta', async (next) => {
    const { location } = await callback(`?code=abc&next=${encodeURIComponent(next)}`);
    expect(location).toBe(next);
  });

  test('toda redirección de éxito es relativa al propio origen', async () => {
    for (const next of ['//evil.com', 'https://evil.com', '/x', '/\\evil.com', '%2F%2Fevil.com']) {
      const { location } = await callback(`?code=abc&next=${encodeURIComponent(next)}`);
      expect(new URL(location!, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  test('Cache-Control: private, no-store también en el éxito', async () => {
    expect((await callback('?code=abc')).res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('GET /auth/callback · PATCH /identity/me de mejor esfuerzo', () => {
  const meta = { full_name: 'Ana Pérez', accept_privacy_version: '2026-11' };
  const ok = (m: Meta | undefined) => supabase({ exchange: async () => ({ data: { session: sessionWith(m) }, error: null }) });

  test('con full_name y accept_privacy_version hace UNA vez PATCH con el Bearer de la sesión', async () => {
    const { location } = await callback('?code=abc&next=/cuenta', ok(meta));
    expect(location).toBe('/cuenta');
    expect(backend.seen).toHaveLength(1);
    const [call] = backend.seen;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('/api/v1/identity/me');
    expect(call.headers.authorization).toBe(`Bearer ${BEARER_VALUE}`);
    expect(JSON.parse(call.body)).toEqual({ full_name: 'Ana Pérez', accept_privacy_version: '2026-11' });
  });

  test('solo envía esos dos campos (no el resto de user_metadata)', async () => {
    await callback('?code=abc', ok({ ...meta, role: 'admin', is_admin: true, customer_id: 'otro', email: 'x@example.com' }));
    expect(Object.keys(JSON.parse(backend.seen[0].body)).sort()).toEqual(['accept_privacy_version', 'full_name']);
  });

  test.each([
    ['sin metadatos', undefined],
    ['metadatos vacíos', {}],
    ['solo nombre', { full_name: 'Ana' }],
    ['solo versión', { accept_privacy_version: '2026-11' }],
    ['nombre no es texto', { full_name: 7, accept_privacy_version: '2026-11' }],
    ['versión no es texto', { full_name: 'Ana', accept_privacy_version: { a: 1 } }],
    ['nulos', { full_name: null, accept_privacy_version: null }],
  ])('%s → no hay PATCH y la redirección sigue', async (_n, m) => {
    const { location } = await callback('?code=abc', ok(m as Meta | undefined));
    expect(location).toBe('/cuenta');
    expect(backend.seen).toHaveLength(0);
  });

  test.each([[400], [401], [409], [422], [500], [503]])('el backend responde %i → el usuario entra igualmente (sin error visible)', async (status) => {
    backend.reply = { status, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"x","message":"m","details":null}}' };
    const { res, location } = await callback('?code=abc&next=/checkout', ok(meta));
    expect(res.status).toBe(302);
    expect(location).toBe('/checkout');
    expect(backend.seen).toHaveLength(1); // sin reintentos
  });

  test('backend caído → el usuario entra igualmente', async () => {
    const dead = await new FakeServer().start();
    const base = dead.base;
    await dead.stop();
    h.api = base;
    try {
      const { location } = await callback('?code=abc', ok(meta));
      expect(location).toBe('/cuenta');
    } finally {
      h.api = backend.base;
    }
  });
});

describe('/salir', () => {
  const run = async (method: 'GET' | 'POST', headers: Record<string, string> = {}, sb = supabase()) => {
    const mod = await import('../../src/pages/salir');
    const url = new URL(`${ORIGIN}/salir`);
    const request = new Request(url, { method, headers });
    const cookies = fakeCookies();
    const handler = (method === 'GET' ? mod.GET : mod.POST) as (c: unknown) => Promise<Response> | Response;
    const res = await handler({ request, url, locals: { supabase: sb, session: null }, cookies });
    return { res, cookies, sb };
  };
  const COOKIE = 'theme=dark; sb-127-auth-token.0=a; sb-127-auth-token.1=b';

  test('GET → 405 con Allow: POST; no cierra sesión ni borra cookies (un enlace o imagen no puede cerrar la sesión)', async () => {
    const { res, cookies, sb } = await run('GET', { cookie: COOKIE });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(sb.signOut).not.toHaveBeenCalled();
    expect(cookies.ops).toEqual([]);
  });

  test.each([
    ['sin Origin', {}],
    ['Origin ajeno', { origin: 'https://evil.test' }],
    ['Origin null', { origin: 'null' }],
    ['otro puerto', { origin: 'http://localhost:4322' }],
    ['otro esquema', { origin: 'https://localhost:4321' }],
    ['sufijo', { origin: 'http://localhost:4321.evil.test' }],
    ['solo Referer propio (no basta)', { referer: `${ORIGIN}/cuenta` }],
  ])('POST %s → 403: no cierra sesión ni borra cookies', async (_n, headers) => {
    const { res, cookies, sb } = await run('POST', { cookie: COOKIE, ...headers });
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(sb.signOut).not.toHaveBeenCalled();
    expect(cookies.ops).toEqual([]);
  });

  test('POST con Origin propio → 303 a /, signOut local y cookies sb-* borradas (las ajenas no)', async () => {
    const { res, cookies, sb } = await run('POST', { origin: ORIGIN, cookie: COOKIE });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(sb.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookies.deleted()).toEqual(['sb-127-auth-token.0', 'sb-127-auth-token.1']);
  });

  test('POST sin sesión ni cookies sigue siendo 303 (idempotente)', async () => {
    const { res, cookies } = await run('POST', { origin: ORIGIN });
    expect(res.status).toBe(303);
    expect(cookies.ops).toEqual([]);
  });

  test('si Supabase falla al cerrar (red), igualmente 303 y las cookies se borran', async () => {
    const { res, cookies } = await run('POST', { origin: ORIGIN, cookie: COOKIE }, supabase({ signOut: async () => { throw new Error('red'); } }));
    expect(res.status).toBe(303);
    expect(cookies.deleted()).toEqual(['sb-127-auth-token.0', 'sb-127-auth-token.1']);
  });

  test.each([['con cookie sb-*', { cookie: 'sb-127-auth-token=a' }], ['sin cookie', {}]])('POST con Origin propio y sin configuración (%s) → 500 genérico; no revienta', async (_n, extra) => {
    const mod = await import('../../src/pages/salir');
    const url = new URL(`${ORIGIN}/salir`);
    const request = new Request(url, { method: 'POST', headers: { origin: ORIGIN, ...extra } });
    const locals = {
      session: null,
      get supabase(): never {
        throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24');
      },
    };
    const res = (await (mod.POST as (c: unknown) => Promise<Response>)({ request, url, locals, cookies: fakeCookies() })) as Response;
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(LEAK);
    expect(res.headers.get('location')).toBeNull();
  });

  test('la redirección es siempre a "/" (no depende de ningún parámetro del cliente)', async () => {
    const { res } = await run('POST', { origin: ORIGIN, 'x-forwarded-host': 'evil.test' });
    expect(res.headers.get('location')).toBe('/');
  });
});
