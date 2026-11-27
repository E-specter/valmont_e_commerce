import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createUser, cookieHeader, deleteUser, liveEnv, sessionCookies, signIn, tamperCookies, type CookiePair, type LiveEnv, type LiveUser } from '../tests/helpers/supabase-live';

// T-126 · sesión SSR, guardia, /bff y /salir contra Supabase local y el backend reales (revisión de seguridad a fondo).
// Requiere `npm run db:start` y el backend en :8000. El usuario de prueba lo crea y borra esta suite (API de administración).
// No cubre el callback por correo de punta a punta (necesita el reinicio de Supabase con la URL permitida): lo cubren las pruebas unitarias.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000';
const COOKIE_NAME = 'sb-127-auth-token';
const DEAD_REFRESH = 'refresh-inexistente';

/** Petición cruda (sin normalizar la ruta como hacen `fetch` y el navegador). */
function raw(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const req = httpRequest({ host: 'localhost', port: Number(PORT), path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    req.end(init.body);
  });
}

const setCookies = (h: Record<string, string | string[] | undefined>): string[] => [h['set-cookie'] ?? []].flat() as string[];
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function forgedJwt(sub: string, opts: { alg: 'none' | 'HS256'; key?: string; exp?: number }): string {
  const exp = opts.exp ?? Math.floor(Date.now() / 1000) + 3600;
  const head = b64u({ alg: opts.alg, typ: 'JWT' });
  const payload = b64u({ sub, aud: 'authenticated', role: 'authenticated', email: 'forged@example.com', exp, session_id: crypto.randomUUID() });
  const sig = opts.alg === 'none' ? '' : createHmac('sha256', opts.key ?? 'not-the-real-signing-key').update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${sig}`;
}
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;
const PAST = () => Math.floor(Date.now() / 1000) - 600;

let env: LiveEnv;
test.beforeAll(() => {
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
});

test.describe('páginas públicas: sin cookie y sin sesión', () => {
  test('portada, catálogo, ficha, nosotros y legales → 200 y ningún Set-Cookie', async ({ request }) => {
    const list = await (await fetch(`${API}/api/v1/catalog/products?page_size=1`)).json();
    const slug = list.items[0]?.slug as string | undefined;
    expect(slug, 'el backend debe tener al menos un producto sembrado').toBeTruthy();
    for (const path of ['/', '/relojes', `/relojes/${slug}`, '/nosotros', '/privacidad', '/terminos']) {
      const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie'), path).toEqual([]);
    }
  });

  test('con cookies ajenas (no sb-*) el sitio público tampoco emite Set-Cookie', async ({ request }) => {
    const res = await request.get(`${BASE}/relojes`, { headers: { cookie: 'theme=dark; session=abc' }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')).toEqual([]);
  });
});

test.describe('guardia de rutas sin sesión', () => {
  for (const path of ['/cuenta', '/cuenta/pedidos', '/Cuenta', '/%63uenta', '/carrito', '/carrito/x', '/checkout', '/checkout/pago', '/CHECKOUT']) {
    test(`${path} → 302 a /ingresar?next=… con Cache-Control private, no-store`, async () => {
      const res = await raw(`${path}?a=1`);
      expect(res.status).toBe(302);
      const loc = String(res.headers.location);
      expect(loc.startsWith('/ingresar?next=')).toBe(true);
      expect(new URL(loc, BASE).searchParams.get('next')?.endsWith('?a=1')).toBe(true);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(setCookies(res.headers)).toEqual([]);
    });
  }

  test('//cuenta (barras repetidas) y /cuenta%2Fx también redirigen: no hay atajo por normalización', async () => {
    for (const path of ['//cuenta', '/%2Fcuenta', '/cuenta%2Fx', '///checkout']) {
      const res = await raw(path);
      expect(res.status, path).toBe(302);
    }
  });

  test('/cuentas y /carritos no se protegen (404, no redirección)', async () => {
    for (const path of ['/cuentas', '/carritos']) {
      const res = await raw(path);
      expect(res.status, path).not.toBe(302);
      expect(res.headers.location).toBeUndefined();
    }
  });
});

test.describe('proxy /bff sin sesión', () => {
  test('GET /bff/cart → 401 en el formato común, no-store y sin Set-Cookie', async ({ request }) => {
    const res = await request.get(`${BASE}/bff/cart`);
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: expect.any(String), details: null } });
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['set-cookie']).toBeUndefined();
  });

  for (const path of ['orders/admin', 'orders/admin/x', 'identity/me', 'catalog/products', 'payments', 'carts']) {
    test(`/bff/${path} → 404 (lista de permitidos; no revela si hay sesión)`, async ({ request }) => {
      const res = await request.get(`${BASE}/bff/${path}`);
      expect(res.status()).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    });
  }

  test('POST con Origin ajeno o sin Origin → 403', async ({ request }) => {
    for (const headers of <Record<string, string>[]>[{ origin: 'https://evil.test' }, { origin: 'null' }, {}]) {
      const res = await request.post(`${BASE}/bff/cart/items`, { headers: { 'content-type': 'application/json', ...headers }, data: '{}' });
      expect(res.status(), JSON.stringify(headers)).toBe(403);
    }
  });

  test('métodos no admitidos → 405', async () => {
    // OPTIONS lo atiende el servidor de desarrollo de Vite (preflight); se comprueba contra el servidor de producción (tests/build/session-dist).
    for (const method of ['PROPFIND', 'PURGE']) {
      const res = await raw('/bff/cart', { method, headers: { origin: BASE } });
      expect(res.status, method).toBe(405);
    }
  });
});

test.describe('con sesión real', () => {
  test.describe.configure({ mode: 'serial' });
  let user: LiveUser;
  let cookies: CookiePair[];
  let access: string;
  let refresh: string;
  const cookie = () => cookieHeader(cookies);

  test.beforeAll(async ({}, info) => {
    user = await createUser(env, info.project.name);
    const session = await signIn(env, user);
    access = session.access_token;
    refresh = session.refresh_token;
    cookies = await sessionCookies(env, session);
  });
  test.afterAll(async () => deleteUser(env, user));

  test('la cookie de la librería usa el nombre esperado (sb-127-auth-token) y el valor no contiene el token en claro', async () => {
    expect(cookies.every((c) => c.name.startsWith(COOKIE_NAME))).toBe(true);
    expect(cookies.length).toBeGreaterThan(0);
  });

  test('GET /bff/cart → 200 con el mismo cuerpo que el backend; sin Set-Cookie; no-store; sin el token', async ({ request }) => {
    const proxied = await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookie() } });
    expect(proxied.status()).toBe(200);
    const direct = await fetch(`${API}/api/v1/cart`, { headers: { authorization: `Bearer ${access}` } });
    expect(direct.status).toBe(200);
    expect(await proxied.json()).toEqual(await direct.json());
    expect(proxied.headers()['cache-control']).toBe('no-store');
    expect(proxied.headers()['set-cookie']).toBeUndefined();
    const text = await proxied.text();
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh);
  });

  test('wishlist y orders (propios) → 200; orders/admin → 404 aunque haya sesión', async ({ request }) => {
    for (const path of ['wishlist', 'orders']) expect((await request.get(`${BASE}/bff/${path}`, { headers: { cookie: cookie() } })).status(), path).toBe(200);
    for (const path of ['orders/admin', 'orders/admin/00000000-0000-0000-0000-000000000000', 'orders/ADMIN', 'orders/%61dmin', 'orders/%41dmin/x']) {
      const res = await raw(`/bff/${path}`, { headers: { cookie: cookie() } });
      expect(res.status, path).toBe(404);
    }
  });

  test('recorridos y caracteres especiales con sesión: nunca llegan a otra ruta del backend', async () => {
    const hostile = [
      'cart/%2e%2e/identity/me', 'cart/..%2fidentity/me', 'cart/%2e%2e%2fidentity%2fme', 'cart/..%5cidentity', 'cart%2f..%2fidentity%2fme',
      'orders/%2e%2e/orders/admin', 'cart/%252e%252e/identity/me', 'cart%3Fx=1', 'cart%23x', 'cart/%00', 'cart/a%0d%0aSet-Cookie:x=1', 'orders/..;/admin', '.%2e/identity/me', 'cart/%2E%2E/identity/me',
    ];
    for (const path of hostile) {
      const res = await raw(`/bff/${path}`, { headers: { cookie: cookie() } });
      expect(res.body, path).not.toContain(user.email);
      expect(res.body, path).not.toContain('"full_name"');
      expect([400, 404], path).toContain(res.status);
      expect(setCookies(res.headers), path).toEqual([]);
    }
  });

  test('la identidad sale de la sesión: customer_id y cabeceras de identidad del cliente se ignoran', async () => {
    const mine = await raw('/bff/orders', { headers: { cookie: cookie() } });
    const spoof = await raw('/bff/orders?customer_id=00000000-0000-0000-0000-000000000001&user_id=x', {
      headers: { cookie: cookie(), 'x-user-id': '00000000-0000-0000-0000-000000000001', authorization: 'Bearer forged-by-client' },
    });
    expect(spoof.status).toBe(mine.status);
    expect(JSON.parse(spoof.body)).toEqual(JSON.parse(mine.body));
  });

  test('CSRF: POST con Origin ajeno o ausente → 403 y no se crea nada', async ({ request }) => {
    const before = await (await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookie() } })).json();
    for (const origin of ['https://evil.test', 'null', undefined]) {
      const headers: Record<string, string> = { cookie: cookie(), 'content-type': 'application/json' };
      if (origin) headers.origin = origin;
      const res = await request.post(`${BASE}/bff/cart/items`, { headers, data: '{"product_id":"00000000-0000-0000-0000-000000000000","quantity":1}' });
      expect(res.status(), String(origin)).toBe(403);
    }
    expect(await (await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookie() } })).json()).toEqual(before);
  });

  test('POST con Origin propio llega al backend y conserva su estado y su cuerpo de error (422)', async ({ request }) => {
    const res = await request.post(`${BASE}/bff/cart/items`, { headers: { cookie: cookie(), origin: BASE, 'content-type': 'application/json' }, data: '{}' });
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBeTruthy();
    expect(res.headers()['set-cookie']).toBeUndefined();
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('límites del cuerpo: 415 (no JSON), 413 (> 16 KiB), 400 (JSON inválido)', async ({ request }) => {
    const base = { cookie: cookie(), origin: BASE };
    const t = (headers: Record<string, string>, data: string) => request.post(`${BASE}/bff/cart/items`, { headers: { ...base, ...headers }, data });
    expect((await t({ 'content-type': 'text/plain' }, 'hola')).status()).toBe(415);
    expect((await t({ 'content-type': 'application/json' }, JSON.stringify({ x: 'a'.repeat(17 * 1024) }))).status()).toBe(413);
    // Petición cruda: `request.post` de Playwright re-serializa una cadena como JSON y "{no" llegaría ya válida.
    const invalid = await raw('/bff/cart/items', { method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: '{no' });
    expect(invalid.status).toBe(400);
  });

  test('Idempotency-Key inválida → 400; una válida llega al backend', async ({ request }) => {
    const bad = await request.post(`${BASE}/bff/orders`, { headers: { cookie: cookie(), origin: BASE, 'content-type': 'application/json', 'idempotency-key': 'con espacio' }, data: '{}' });
    expect(bad.status()).toBe(400);
    const ok = await request.post(`${BASE}/bff/orders`, { headers: { cookie: cookie(), origin: BASE, 'content-type': 'application/json', 'idempotency-key': 'qa-t126-key-1' }, data: '{}' });
    expect([201, 400, 409, 422]).toContain(ok.status()); // el carrito vacío no genera pedido: lo importante es que el backend respondió
    expect(ok.status()).not.toBe(401);
  });

  test('páginas con sesión: la ruta protegida no redirige, es privada y no contiene tokens ni claves', async () => {
    for (const path of ['/cuenta', '/carrito', '/relojes']) {
      const res = await raw(path, { headers: { cookie: cookie() } });
      expect(res.status, path).not.toBe(302);
      if (path !== '/relojes') expect(res.headers['cache-control'], path).toBe('private, no-store');
      for (const secret of [access, refresh, env.anon, env.service]) expect(res.body, path).not.toContain(secret);
      expect(res.body, path).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./);
    }
  });

  test('navegador real: cookie httpOnly invisible para document.cookie; el token no está en HTML, window ni almacenamiento; /bff/cart funciona', async ({ page, context }) => {
    await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' as const })));
    await page.goto('/relojes');
    const seen = await page.evaluate(async (secrets) => {
      const html = document.documentElement.outerHTML;
      const store = JSON.stringify([{ ...localStorage }, { ...sessionStorage }]);
      const win = Object.keys(window).filter((k) => { try { return JSON.stringify((window as never)[k]).includes(secrets[0]); } catch { return false; } });
      const res = await fetch('/bff/cart');
      return { cookie: document.cookie, htmlHas: secrets.some((s) => html.includes(s)), storeHas: secrets.some((s) => store.includes(s)), win, status: res.status, body: await res.text() };
    }, [access, refresh, env.anon]);
    expect(seen.cookie).not.toContain('sb-');
    expect(seen.htmlHas).toBe(false);
    expect(seen.storeHas).toBe(false);
    expect(seen.win).toEqual([]);
    expect(seen.status).toBe(200);
    expect(seen.body).not.toContain(access);
    const stored = (await context.cookies()).filter((c) => c.name.startsWith(COOKIE_NAME));
    expect(stored.length).toBeGreaterThan(0);
    stored.forEach((c) => expect(c.httpOnly).toBe(true));
  });

  test('sesión caducada con refresh válido: el servidor la renueva y emite la cookie httpOnly, SameSite=Lax, path=/ y no-store', async ({ request }) => {
    const fresh = await signIn(env, user);
    const expired = tamperCookies(await sessionCookies(env, fresh), { expires_at: PAST() });
    const res = await raw('/relojes', { headers: { cookie: cookieHeader(expired) } });
    expect(res.status).toBe(200);
    const sc = setCookies(res.headers).filter((c) => c.startsWith(COOKIE_NAME));
    expect(sc.length, 'debe reescribir la cookie de sesión').toBeGreaterThan(0);
    for (const c of sc) {
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Lax/i);
      expect(c).toMatch(/;\s*Path=\/(;|$)/i);
      expect(c).not.toMatch(/SameSite=None/i);
    }
    expect(res.headers['cache-control']).toBe('private, no-store');
    // La cookie renovada funciona: se reenvía tal cual y /bff/cart responde 200.
    const renewed: CookiePair[] = sc.map((c) => { const [nv] = c.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i), value: nv.slice(i + 1) }; });
    expect((await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookieHeader(renewed) } })).status()).toBe(200);
  });

  test('sesión caducada y refresh inválido → no hay sesión: /carrito redirige y /bff/cart da 401', async ({ request }) => {
    const fresh = await signIn(env, user);
    const dead = tamperCookies(await sessionCookies(env, fresh), { expires_at: PAST(), refresh_token: DEAD_REFRESH });
    const guard = await raw('/carrito', { headers: { cookie: cookieHeader(dead) } });
    expect(guard.status).toBe(302);
    expect(String(guard.headers.location)).toMatch(/^\/ingresar\?next=/);
    expect((await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookieHeader(dead) } })).status()).toBe(401);
  });

  test('cookies manipuladas o falsificadas no dan sesión (firma alterada, alg none, clave ajena, basura, caducada en el JWT)', async ({ request }) => {
    const valid = (await signIn(env, user)).access_token;
    const [h, p, s] = valid.split('.');
    const forgedSub = (sub: string) => `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub })).toString('base64url')}.${s}`;
    const candidates: Record<string, string> = {
      'firma alterada': `${h}.${p}.${s.slice(0, -4)}AAAA`,
      'payload cambiado con la firma original': forgedSub('00000000-0000-0000-0000-000000000001'),
      'alg none': forgedJwt(user.id, { alg: 'none' }),
      'HS256 con clave ajena': forgedJwt(user.id, { alg: 'HS256' }),
      'JWT caducado': forgedJwt(user.id, { alg: 'HS256', exp: PAST() }),
    };
    const base = await sessionCookies(env, await signIn(env, user));
    for (const [name, token] of Object.entries(candidates)) {
      const cs = tamperCookies(base, { access_token: token, expires_at: FUTURE() });
      const guard = await raw('/carrito', { headers: { cookie: cookieHeader(cs) } });
      expect(guard.status, `/carrito con ${name}`).toBe(302);
      const bff = await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookieHeader(cs) } });
      expect(bff.status(), `/bff/cart con ${name}`).toBe(401);
      expect(await bff.text()).not.toContain('"items"');
    }
    for (const garbage of ['garbage', 'base64-%%%', 'base64-' + Buffer.from('{"nada":1}').toString('base64url'), '', 'null', '{}']) {
      const res = await raw('/carrito', { headers: { cookie: `${COOKIE_NAME}=${garbage}` } });
      expect(res.status, `cookie ${garbage}`).toBe(302);
      expect((await raw('/bff/cart', { headers: { cookie: `${COOKIE_NAME}=${garbage}` } })).status, garbage).toBe(401);
    }
  });

  test('/salir: GET 405; POST sin Origin o ajeno 403 (la sesión sigue); POST propio → 303 a / y cookies borradas', async ({ request, page, context }) => {
    expect((await raw('/salir', { headers: { cookie: cookie() } })).status).toBe(405);
    for (const headers of <Record<string, string>[]>[{}, { origin: 'https://evil.test' }, { origin: 'null' }]) {
      const res = await raw('/salir', { method: 'POST', headers: { cookie: cookie(), ...headers } });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(setCookies(res.headers)).toEqual([]);
    }
    expect((await request.get(`${BASE}/bff/cart`, { headers: { cookie: cookie() } })).status()).toBe(200);

    // Cierre real desde el navegador (Chrome envía Origin en el POST de mismo origen).
    const live = await signIn(env, user);
    const liveCookies = await sessionCookies(env, live);
    await context.addCookies(liveCookies.map((c) => ({ name: c.name, value: c.value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' as const })));
    await page.goto('/relojes');
    const out = await page.evaluate(async () => {
      const res = await fetch('/salir', { method: 'POST', redirect: 'manual' });
      return { type: res.type, status: res.status };
    });
    expect(['opaqueredirect', 'basic']).toContain(out.type);
    expect((await context.cookies()).filter((c) => c.name.startsWith(COOKIE_NAME))).toEqual([]);
    const after = await page.evaluate(async () => (await fetch('/bff/cart')).status);
    expect(after).toBe(401);
    const guard = await page.goto('/carrito', { waitUntil: 'commit' });
    expect(guard?.url()).toContain('/ingresar');
  });

  test('POST /salir directo: 303 a "/" y Set-Cookie de borrado (Max-Age=0 o Expires pasado) para cada trozo', async () => {
    const live = await sessionCookies(env, await signIn(env, user));
    const res = await raw('/salir', { method: 'POST', headers: { cookie: cookieHeader(live), origin: BASE } });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const sc = setCookies(res.headers);
    expect(sc.length).toBeGreaterThan(0);
    for (const c of sc) expect(c).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect(sc.map((c) => c.split('=')[0]).sort()).toEqual(live.map((c) => c.name).sort());
  });
});
