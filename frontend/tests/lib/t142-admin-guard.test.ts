import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PROTECTED_PREFIXES, isProtectedPath, loginUrl } from '../../src/lib/server/guard';
import { BEARER_VALUE, fakeCookies } from '../helpers/t126';

// T-142 · `/admin` en PROTECTED_PREFIXES: tabla de rutas de `isProtectedPath` y el middleware real sin y con sesión.
const h = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000', SUPABASE_URL: 'http://sb.test:54321', SUPABASE_ANON_KEY: 'anon-value-for-tests' }));
vi.mock('@supabase/ssr', async (orig) => ({ ...(await orig<typeof import('@supabase/ssr')>()), createServerClient: h.createServerClient }));

const FOUND = 302;
const OK = 200;
const NO_STORE = 'private, no-store';
const COOKIE = 'sb-127-auth-token=base64-AAAA';
const FAR_FUTURE = 4102444800;
const FAR_FUTURE_SESSION = 4102444000;

const PROTECTED = [
  '/admin', '/admin/', '/admin/x', '/admin/pedidos', '/admin/pedidos/3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', '/admin/sin-permiso', '/admin/no-disponible',
  '/Admin', '/ADMIN', '/ADMIN/x', '/aDmIn/pedidos', // mayúsculas
  '/%61dmin', '/%61dmin/x', '/a%64min', '/ad%6Din/x', '/%41dmin', '/%41DMIN/x', '/%61%64%6d%69%6e', // codificación porcentual
  '//admin', '///admin/x', '/admin//x', '/admin///x/y', '//Admin//x', // barras repetidas
  '/%2Fadmin', '/%2fadmin/x', '/admin%2Fx', '/admin%2fpedidos', '/%2F%2Fadmin', // "/" codificada
  '/%E0%A4%A/admin', '/admin/%E0%A4%A', '/%', // codificación inválida: ante la duda, protegida
];
const PUBLIC = [
  '/', '', '/administracion', '/administracion/x', '/admins', '/admins/x', '/administrator', '/admin-x', '/admin.html', '/admin_x', '/adm', '/ad',
  '/micuenta', '/x/admin', '/relojes/admin', '/dev/admin-layout', '/nosotros', '/ingresar', '/bff/orders/admin', '/api/admin', '/auth/callback',
  '/%61dministracion', '/ADMINS',
];

describe('isProtectedPath con /admin', () => {
  test('los prefijos son los 3 de la tienda más /admin (lista cerrada)', () => {
    expect([...PROTECTED_PREFIXES].sort()).toEqual(['/admin', '/carrito', '/checkout', '/cuenta']);
  });

  test.each(PROTECTED)('protegida: %j', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  test.each(PUBLIC)('no protegida: %j', (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  test('regresión: lo que ya estaba protegido sigue protegido', () => {
    ['/cuenta', '/cuenta/x', '/carrito', '/checkout/pago', '/%63uenta'].forEach((p) => expect(isProtectedPath(p)).toBe(true));
  });

  test('un prefijo no protege por subcadena: /administracion y /admins quedan fuera (criterio de aceptación)', () => {
    expect(isProtectedPath('/administracion')).toBe(false);
    expect(isProtectedPath('/admins')).toBe(false);
  });

  test('la ruta tal como la normaliza URL (puntos y barras invertidas) no escapa de la guardia', () => {
    ['http://localhost/%2e/admin', 'http://localhost/x/../admin', 'http://localhost/admin/../admin/x', 'http://localhost/\\admin']
      .map((u) => new URL(u).pathname)
      .forEach((p) => expect(isProtectedPath(p), p).toBe(true));
  });
});

type Claims = { data: { claims: Record<string, unknown> | null } | null; error: Error | null };
let claims: () => Promise<Claims>;

async function run(path: string, init: { cookie?: string } = {}) {
  const { onRequest } = await import('../../src/middleware');
  const url = new URL(`http://localhost:4321${path}`);
  const request = new Request(url, { headers: init.cookie ? { cookie: init.cookie } : {} });
  const cookies = fakeCookies();
  const locals = {} as Record<string, unknown>;
  const next = vi.fn(async () => new Response('<html>admin</html>', { status: OK, headers: { 'content-type': 'text/html' } }));
  const res = (await (onRequest as unknown as (c: unknown, n: unknown) => Promise<Response>)({ request, cookies, url, locals, isPrerendered: false }, next)) as Response;
  return { res, next, locals };
}

beforeEach(() => {
  claims = async () => ({ data: { claims: { sub: 'user-1', email: 'cliente@example.com', exp: FAR_FUTURE } }, error: null });
  h.createServerClient.mockReset().mockImplementation(() => ({
    auth: {
      getClaims: vi.fn(() => claims()),
      getSession: vi.fn(async () => ({ data: { session: { access_token: BEARER_VALUE, expires_at: FAR_FUTURE_SESSION } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  }));
});

describe('middleware: /admin sin sesión', () => {
  test.each(['/admin', '/admin/x', '/admin/', '/Admin', '/ADMIN/x', '/%61dmin', '/%61dmin/x', '/admin//x', '//admin', '/admin/pedidos/1', '/admin/sin-permiso', '/admin/no-disponible'])(
    '%s → 302 a /ingresar?next=… con Cache-Control private, no-store; no llama a next()',
    async (path) => {
      const { res, next } = await run(`${path}?a=1`);
      expect(res.status).toBe(FOUND);
      const expected = new URL(`http://localhost:4321${path}?a=1`);
      expect(res.headers.get('location')).toBe(loginUrl(expected));
      expect(res.headers.get('cache-control')).toBe(NO_STORE);
      expect(next).not.toHaveBeenCalled();
      expect(await res.text()).toBe('');
    },
  );

  test('la redirección no filtra nada: sin cuerpo, sin Set-Cookie y sin crear cliente de Supabase', async () => {
    const { res } = await run('/admin/pedidos');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(h.createServerClient).not.toHaveBeenCalled();
  });

  test.each(['/administracion', '/admins', '/administrator/x'])('%s NO se protege (pasa a next)', async (path) => {
    const { res, next } = await run(path);
    expect(res.status).toBe(OK);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('cookie con claims inválidas, ausentes o con un getClaims que lanza → 302, nunca entra', async () => {
    const bad: (() => Promise<Claims>)[] = [
      async () => ({ data: null, error: new Error('invalid JWT') }),
      async () => ({ data: { claims: {} }, error: null }),
      async () => {
        throw new Error('fetch failed');
      },
    ];
    const results: (number | number[])[][] = [];
    await bad.reduce(async (prev, impl) => {
      await prev;
      claims = impl;
      const { res, next } = await run('/admin', { cookie: COOKIE });
      results.push([res.status, next.mock.calls.length]);
    }, Promise.resolve());
    expect(results).toEqual(bad.map(() => [FOUND, 0]));
  });
});

describe('middleware: /admin con sesión', () => {
  test('con sesión válida pasa a next() y la respuesta queda private, no-store (el rol lo decide cada página)', async () => {
    const { res, next, locals } = await run('/admin/pedidos', { cookie: COOKIE });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect((locals.session as { accessToken: string }).accessToken).toBe(BEARER_VALUE);
  });

  test('una respuesta pública de la página no pisa no-store en /admin', async () => {
    const { onRequest } = await import('../../src/middleware');
    const url = new URL('http://localhost:4321/admin/x');
    const next = async () => new Response('x', { headers: { 'cache-control': 'public, max-age=600' } });
    const res = (await (onRequest as unknown as (c: unknown, n: unknown) => Promise<Response>)(
      { request: new Request(url, { headers: { cookie: COOKIE } }), cookies: fakeCookies(), url, locals: {}, isPrerendered: false },
      next,
    )) as Response;
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });
});
