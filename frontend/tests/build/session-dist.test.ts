import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';
import { cookieHeader, createUser, deleteUser, liveEnv, sessionCookies, signIn, tamperCookies, type LiveUser } from '../helpers/supabase-live';

// T-126 · resultado de `npm run build` y servidor de producción (`node dist/server/entry.mjs`):
//  - nada de la sesión ni de la configuración llega a dist/client (token, clave anónima, service_role, SDK de Supabase);
//  - sin SUPABASE_ANON_KEY el sitio público sigue y las rutas con sesión fallan con mensaje genérico (500);
//  - en producción la cookie lleva Secure; OPTIONS/HEAD → 405 y sin cabeceras CORS.
// Sin build previo se omite y el informe lo declara (no sustituye a la puerta `npm run build`).
const CLIENT = join(FRONTEND, 'dist', 'client');
const ENTRY = join(FRONTEND, 'dist', 'server', 'entry.mjs');
const built = existsSync(CLIENT) && existsSync(ENTRY);
const live = built ? liveEnv() : null;
const READY_MS = 25_000;
const POLL_MS = 200;
const TEST_TIMEOUT = 60_000;
const COOKIE_NAME = 'sb-127-auth-token';

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

async function start(env: Record<string, string | undefined>): Promise<{ base: string; origin: string; stop: () => void; child: ChildProcess }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined));
  const child = spawn(process.execPath, [ENTRY], { env: { ...clean, HOST: '127.0.0.1', PORT: String(port) } as NodeJS.ProcessEnv, stdio: 'ignore' });
  const deadline = Date.now() + READY_MS;
  const probe = async (): Promise<void> => {
    if (await fetch(`${base}/nosotros`).then((r) => r.status === 200, () => false)) return;
    if (Date.now() > deadline) throw new Error('el servidor de producción no arrancó');
    await new Promise((r) => setTimeout(r, POLL_MS));
    return probe();
  };
  await probe();
  // Sin `security.allowedDomains`, Astro ignora Host y X-Forwarded-*: `url.origin` es siempre http://localhost:<puerto>.
  return { base, origin: `http://localhost:${port}`, child, stop: () => void child.kill() };
}
const noKeyEnv = { SUPABASE_ANON_KEY: undefined, SUPABASE_URL: undefined, API_BASE_URL: undefined };
const get = (base: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
const setCookies = (r: Response): string[] => r.headers.getSetCookie();

describe.skipIf(!built)('dist/client: nada de la sesión llega al navegador', () => {
  const files = built ? walk(CLIENT).filter((f) => /\.(html|js|mjs|css|json|map|txt|xml|svg|webmanifest)$/.test(f)) : [];

  test('hay archivos que revisar', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each([
    ['un JWT (eyJ….….…)', /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]*/],
    ['service_role / SERVICE_ROLE_KEY / JWT_SECRET', /service[_-]?role|JWT_SECRET/i],
    ['claves nuevas de Supabase (sb_publishable_, sb_secret_)', /sb_publishable_|sb_secret_/],
    ['nombres de variables del servidor', /SUPABASE_ANON_KEY|SUPABASE_URL|API_BASE_URL/],
    ['el SDK de Supabase en el paquete de cliente (GoTrueClient, supabase-js)', /GoTrueClient|supabase-js|@supabase\/ssr|createServerClient/],
    ['la cookie de sesión (sb-…-auth-token)', /sb-[\w-]*-auth-token/],
    ['la URL del backend o de Supabase local', /127\.0\.0\.1:(8000|54321)|localhost:(8000|54321)/],
    ['la ruta del proxy con un token', /Authorization["']?\s*:\s*["']?Bearer/i],
    ['almacenamiento de tokens (localStorage/sessionStorage con "token")', /(local|session)Storage[^;\n]{0,80}(token|session)/i],
  ])('ningún archivo contiene %s', (_name, pattern) => {
    expect(files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.slice(CLIENT.length))).toEqual([]);
  });

  test.skipIf(!live)('ningún archivo contiene la clave anónima ni la service_role reales', () => {
    const secrets = [live!.anon, live!.service];
    expect(files.filter((f) => secrets.some((s) => readFileSync(f, 'utf8').includes(s))).map((f) => f.slice(CLIENT.length))).toEqual([]);
  });
});

describe.skipIf(!built)('servidor de producción SIN configuración de Supabase', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    srv = await start(noKeyEnv);
  }, TEST_TIMEOUT);
  afterAll(() => srv?.stop());

  test.each(['/', '/relojes', '/nosotros', '/privacidad', '/terminos', '/relojes/no-existe'])('%s no exige la clave: responde sin 5xx y sin Set-Cookie', async (path) => {
    const res = await get(srv.base, path);
    expect(res.status, path).toBeLessThan(500);
    expect(setCookies(res), path).toEqual([]);
  });

  test.each(['/', '/nosotros', '/relojes'])('%s con una cookie de sesión y sin configuración: el sitio público sigue', async (path) => {
    const res = await get(srv.base, path, { headers: { cookie: `${COOKIE_NAME}=base64-AAAA` } });
    expect(res.status).toBeLessThan(500);
  });

  test('ruta protegida sin cookie → 302 al ingreso (no necesita configuración)', async () => {
    const res = await get(srv.base, '/carrito?x=1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcarrito%3Fx%3D1');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('ruta protegida CON cookie y sin configuración → 500 genérico: sin nombres de variables ni trazas', async () => {
    const res = await get(srv.base, '/cuenta', { headers: { cookie: `${COOKIE_NAME}=base64-AAAA` } });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toMatch(/SUPABASE|ANON|KEY|API_BASE|AuthConfigError|node_modules|\.ts:\d+|at \w+ \(/i);
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });

  test('/bff/cart sin cookie → 401 (no hay sesión que validar)', async () => {
    expect((await get(srv.base, '/bff/cart')).status).toBe(401);
  });

  test.each([
    ['GET', '/bff/cart'],
    ['POST', '/salir'],
    ['GET', '/auth/callback?code=abc&next=/cuenta'],
  ])('%s %s con cookie sb-* y sin configuración → 500 genérico', async (method, path) => {
    const res = await get(srv.base, path, { method, headers: { cookie: `${COOKIE_NAME}=base64-AAAA`, origin: srv.origin } });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/SUPABASE|ANON|KEY|API_BASE|AuthConfigError|node_modules|\.ts:\d+|at \w+ \(/i);
  });

  test('/auth/callback y POST /salir sin configuración y sin cookie tampoco muestran trazas', async () => {
    const cb = await get(srv.base, '/auth/callback?code=abc');
    const out = await get(srv.base, '/salir', { method: 'POST', headers: { origin: srv.origin } });
    for (const res of [cb, out]) expect(await res.text()).not.toMatch(/SUPABASE|ANON|KEY|node_modules|\.ts:\d+|at \w+ \(/i);
  });
});

describe.skipIf(!built || !live)('servidor de producción con Supabase local real', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  let user: LiveUser;
  let access = '';
  let refresh = '';
  let cookies: { name: string; value: string }[] = [];

  beforeAll(async () => {
    srv = await start({ SUPABASE_URL: live!.url, SUPABASE_ANON_KEY: live!.anon, API_BASE_URL: undefined });
    user = await createUser(live!, 'prod');
    const s = await signIn(live!, user);
    access = s.access_token;
    refresh = s.refresh_token;
    cookies = await sessionCookies(live!, s);
  }, TEST_TIMEOUT);
  afterAll(async () => {
    srv?.stop();
    if (user) await deleteUser(live!, user);
  });

  test('con sesión /bff/cart → 200 y la respuesta no contiene el token', async () => {
    const res = await get(srv.base, '/bff/cart', { headers: { cookie: cookieHeader(cookies) } });
    expect(res.status).toBe(200);
    expect(setCookies(res)).toEqual([]);
    const text = await res.text();
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh);
  });

  test('al renovar una sesión caducada, la cookie sale con Secure, HttpOnly, SameSite=Lax y Path=/ (producción)', async () => {
    const fresh = await signIn(live!, user);
    const expired = tamperCookies(await sessionCookies(live!, fresh), { expires_at: Math.floor(Date.now() / 1000) - 600 });
    const res = await get(srv.base, '/relojes', { headers: { cookie: cookieHeader(expired) } });
    expect(res.status).toBe(200);
    const sc = setCookies(res).filter((c) => c.startsWith(COOKIE_NAME));
    expect(sc.length).toBeGreaterThan(0);
    sc.forEach((c) => {
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
      expect(c).toMatch(/;\s*Path=\/(;|$)/i);
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test.each(['OPTIONS', 'HEAD', 'PROPFIND', 'PURGE'])('%s /bff/cart → 405 sin cabeceras CORS', async (method) => {
    const res = await get(srv.base, '/bff/cart', { method, headers: { origin: srv.origin, cookie: cookieHeader(cookies) } });
    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('no hay CORS en ninguna respuesta del proxy ni de la guardia (un origen ajeno no puede leer)', async () => {
    for (const path of ['/bff/cart', '/bff/identity/me', '/carrito', '/salir']) {
      const res = await get(srv.base, path, { headers: { origin: 'https://evil.test', cookie: cookieHeader(cookies) } });
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });

  test('CSRF en producción: POST /bff y /salir con Origin ajeno → 403; el propio → pasa', async () => {
    const bad = await get(srv.base, '/bff/cart/items', { method: 'POST', body: '{}', headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie: cookieHeader(cookies) } });
    expect(bad.status).toBe(403);
    const badOut = await get(srv.base, '/salir', { method: 'POST', headers: { origin: 'https://evil.test', cookie: cookieHeader(cookies) } });
    expect(badOut.status).toBe(403);
    const ok = await get(srv.base, '/bff/cart/items', { method: 'POST', body: '{}', headers: { origin: srv.origin, 'content-type': 'application/json', cookie: cookieHeader(cookies) } });
    expect(ok.status).toBe(422);
  });

  test('POST /salir con Origin propio → 303 a "/" y cookies borradas con los mismos atributos de seguridad', async () => {
    const res = await get(srv.base, '/salir', { method: 'POST', headers: { origin: srv.origin, cookie: cookieHeader(cookies) } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const sc = setCookies(res);
    expect(sc.length).toBeGreaterThan(0);
    sc.forEach((c) => {
      expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      expect(c).toMatch(/;\s*Path=\/(;|$)/i);
    });
  });

  test('errores en producción: una cookie basura no produce 500 ni traza', async () => {
    const res = await get(srv.base, '/carrito', { headers: { cookie: `${COOKIE_NAME}=base64-%%%` } });
    expect(res.status).toBe(302);
    const bff = await get(srv.base, '/bff/cart', { headers: { cookie: `${COOKIE_NAME}=base64-%%%` } });
    expect(bff.status).toBe(401);
    expect(await bff.text()).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });
});
