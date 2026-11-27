import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BEARER_VALUE, fakeCookies } from '../helpers/t126';

// T-126 · contrato 3.2: middleware con una `Request` simulada. Rutas prerenderizadas, públicas, protegidas, con y sin cookie,
// cookies renovadas, configuración ausente (500 genérico) y cliente de Supabase perezoso (uno por petición).
const h = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  env: { anon: 'anon-value-for-tests' as string | undefined },
}));
vi.mock('astro:env/server', () => ({
  API_BASE_URL: 'http://api.test:8000',
  SUPABASE_URL: 'http://sb.test:54321',
  get SUPABASE_ANON_KEY() {
    return h.env.anon;
  },
}));
vi.mock('@supabase/ssr', async (orig) => ({ ...(await orig<typeof import('@supabase/ssr')>()), createServerClient: h.createServerClient }));

type Claims = { data: { claims: Record<string, unknown> | null } | null; error: Error | null };
let claims: () => Promise<Claims>;
let makeClient: () => unknown;

const COOKIE = 'sb-127-auth-token=base64-AAAA';
const good = async (): Promise<Claims> => ({ data: { claims: { sub: 'user-1', email: 'cliente@example.com', exp: 4102444800 } }, error: null });

async function run(path: string, init: { cookie?: string; prerendered?: boolean; next?: () => Response; cookies?: ReturnType<typeof fakeCookies> } = {}) {
  const { onRequest } = await import('../../src/middleware');
  const url = new URL(`http://localhost:4321${path}`);
  const request = new Request(url, { headers: init.cookie ? { cookie: init.cookie } : {} });
  const cookies = init.cookies ?? fakeCookies();
  const locals = {} as Record<string, unknown>;
  const next = vi.fn(async () => (init.next ? init.next() : new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
  const res = (await (onRequest as unknown as (c: unknown, n: unknown) => Promise<Response>)({ request, cookies, url, locals, isPrerendered: init.prerendered ?? false }, next)) as Response;
  return { res, next, locals, cookies };
}

beforeEach(() => {
  h.env.anon = 'anon-value-for-tests';
  claims = good;
  h.createServerClient.mockReset().mockImplementation(() => makeClient());
  makeClient = () => ({
    auth: {
      getClaims: vi.fn(() => claims()),
      getSession: vi.fn(async () => ({ data: { session: { access_token: BEARER_VALUE, expires_at: 4102444000 } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  });
});

const PROTECTED = ['/cuenta', '/cuenta/x', '/Cuenta', '/%63uenta', '//cuenta', '/carrito', '/carrito/x', '/checkout', '/checkout/pago', '/CHECKOUT'];
const PUBLIC = ['/', '/cuentas', '/carritos', '/relojes', '/relojes/x', '/nosotros', '/ingresar', '/registro', '/privacidad', '/terminos'];

describe('rutas prerenderizadas', () => {
  test('no se tocan: pasa a next(), no crea cliente, no lee cookies ni rellena locals', async () => {
    const { res, next, locals } = await run('/nosotros', { prerendered: true, cookie: COOKIE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(h.createServerClient).not.toHaveBeenCalled();
    expect(locals).toEqual({});
  });

  test.each(PROTECTED)('ni siquiera una ruta protegida prerenderizada (%s) se redirige: la guardia no la ve', async (path) => {
    const { next, locals } = await run(path, { prerendered: true });
    expect(next).toHaveBeenCalledTimes(1);
    expect(locals).toEqual({});
  });
});

describe('rutas públicas sin cookie de sesión', () => {
  test.each(PUBLIC)('%s → next(), locals.session = null y NO se crea cliente de Supabase', async (path) => {
    const { res, next, locals } = await run(path);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(locals.session).toBeNull();
    expect(h.createServerClient).not.toHaveBeenCalled();
  });

  test('no toca la caché pública de la respuesta ni añade Set-Cookie', async () => {
    const { res } = await run('/relojes', { next: () => new Response('x', { headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' } }) });
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=60');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('funciona aunque falte la clave anónima (el sitio público sigue)', async () => {
    h.env.anon = undefined;
    const { res, next } = await run('/relojes');
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('una cookie ajena (theme, sb-x-other) no cuenta como sesión', async () => {
    const { locals } = await run('/relojes', { cookie: 'theme=dark; sb-x-other=1' });
    expect(locals.session).toBeNull();
    expect(h.createServerClient).not.toHaveBeenCalled();
  });
});

describe('guardia de rutas protegidas sin sesión', () => {
  test.each(PROTECTED)('%s sin cookie → 302 a /ingresar?next=… con Cache-Control private, no-store; no llama a next()', async (path) => {
    const { res, next } = await run(`${path}?a=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/ingresar?next=${encodeURIComponent(new URL(`http://localhost:4321${path}?a=1`).pathname + '?a=1')}`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(next).not.toHaveBeenCalled();
    expect(h.createServerClient).not.toHaveBeenCalled();
  });

  test('conserva ruta y query en next (codificados)', async () => {
    const { res } = await run('/carrito?x=1&y=a b');
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcarrito%3Fx%3D1%26y%3Da%2520b');
  });

  test.each(['/cuentas', '/carritos', '/checkout-x', '/micuenta'])('%s NO se protege', async (path) => {
    const { res, next } = await run(path);
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('con cookie pero claims inválidas → 302 (sesión caducada o manipulada)', async () => {
    claims = async () => ({ data: null, error: new Error('invalid JWT') });
    const { res, next } = await run('/cuenta', { cookie: COOKIE });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcuenta');
    expect(next).not.toHaveBeenCalled();
  });

  test('con cookie y un getClaims que lanza (red caída) → 302, nunca entra a la ruta privada', async () => {
    claims = async () => {
      throw new Error('fetch failed');
    };
    const { res, next } = await run('/checkout', { cookie: COOKIE });
    expect(res.status).toBe(302);
    expect(next).not.toHaveBeenCalled();
  });

  test('una cookie basura no da acceso: claims sin sub → 302', async () => {
    claims = async () => ({ data: { claims: {} }, error: null });
    expect((await run('/cuenta', { cookie: 'sb-x-auth-token=garbage' })).res.status).toBe(302);
  });
});

describe('con sesión válida', () => {
  test('ruta protegida: next(), locals.session completa y Cache-Control private, no-store', async () => {
    const { res, next, locals } = await run('/cuenta/pedidos', { cookie: COOKIE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(locals.session).toEqual({ userId: 'user-1', email: 'cliente@example.com', accessToken: BEARER_VALUE, expiresAt: 4102444800 });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('el token solo vive en locals: no está en la respuesta, sus cabeceras ni en Set-Cookie', async () => {
    const { res } = await run('/cuenta', { cookie: COOKIE });
    expect(await res.clone().text()).not.toContain(BEARER_VALUE);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(BEARER_VALUE);
  });

  test('ruta pública con cookie válida: locals.session se resuelve y la respuesta no se vuelve privada sin motivo', async () => {
    const { res, locals } = await run('/relojes', { cookie: COOKIE, next: () => new Response('x', { headers: { 'cache-control': 'public, max-age=30' } }) });
    expect(locals.session).toMatchObject({ userId: 'user-1' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
  });

  test('cookies renovadas o borradas por la librería → la respuesta nunca va a cachés compartidas', async () => {
    const cookies = fakeCookies();
    claims = async () => {
      cookies.set('sb-127-auth-token', 'renovada', { httpOnly: true });
      return good();
    };
    const { res } = await run('/relojes', { cookie: COOKIE, cookies, next: () => new Response('x', { headers: { 'cache-control': 'public, max-age=30' } }) });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('la respuesta conserva estado, cuerpo y cabeceras de la página', async () => {
    const { res } = await run('/cuenta', { cookie: COOKIE, next: () => new Response('<p>hola</p>', { status: 418, headers: { 'x-page': 'a', 'content-type': 'text/html' } }) });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('<p>hola</p>');
    expect(res.headers.get('x-page')).toBe('a');
  });

  test('con sesión, una ruta protegida sigue sin crearse otra por cada acceso: un solo cliente por petición', async () => {
    const { locals } = await run('/cuenta', { cookie: COOKIE });
    const a = locals.supabase;
    const b = locals.supabase;
    expect(a).toBe(b);
    expect(h.createServerClient).toHaveBeenCalledTimes(1);
  });

  test('cada petición tiene su propio cliente (nunca compartido)', async () => {
    const one = (await run('/cuenta', { cookie: COOKIE })).locals.supabase;
    const two = (await run('/cuenta', { cookie: COOKIE })).locals.supabase;
    expect(one).not.toBe(two);
    expect(h.createServerClient).toHaveBeenCalledTimes(2);
  });

  test('locals.supabase en una ruta pública sin cookie se crea solo si se pide (perezoso)', async () => {
    const { locals } = await run('/salir');
    expect(h.createServerClient).not.toHaveBeenCalled();
    expect(locals.supabase).toBeDefined();
    expect(h.createServerClient).toHaveBeenCalledTimes(1);
  });
});

describe('sin configuración de Supabase', () => {
  test('ruta protegida con cookie → 500 genérico, sin nombres de variables ni trazas', async () => {
    h.env.anon = undefined;
    const { res, next } = await run('/cuenta', { cookie: COOKIE });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/SUPABASE|ANON|KEY|env|AuthConfigError|Error:|at .*\(|node_modules/i);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(next).not.toHaveBeenCalled();
  });

  test.each(['/bff/cart', '/salir', '/auth/callback'])('%s con cookie sb-* y sin configuración → 500 genérico', async (path) => {
    h.env.anon = undefined;
    const { res, next } = await run(path, { cookie: COOKIE });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/SUPABASE|ANON|KEY|AuthConfigError/i);
    expect(next).not.toHaveBeenCalled();
  });

  test('/bff/cart SIN cookie y sin configuración → sigue hasta el manejador (que da 401)', async () => {
    h.env.anon = undefined;
    const { next } = await run('/bff/cart');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('ruta pública con cookie → el sitio sigue (sesión nula)', async () => {
    h.env.anon = undefined;
    const { res, locals } = await run('/relojes', { cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(locals.session).toBeNull();
  });

  test('ruta protegida SIN cookie → 302 al ingreso (no necesita configuración)', async () => {
    h.env.anon = undefined;
    const { res } = await run('/cuenta');
    expect(res.status).toBe(302);
  });
});
