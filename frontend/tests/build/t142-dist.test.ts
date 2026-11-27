import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';
import { createQaUser, deleteQaUser, type QaUser } from '../../e2e/helpers/admin';
import { liveEnv } from '../helpers/supabase-live';

// T-142 · resultado de `npm run build` y servidor de producción: nada del backoffice ni de la API llega a dist/client (N-4), /dev/admin-layout no
// existe en producción, la guardia de /admin funciona sin configuración y un cliente recibe «Sin permiso» sin ninguna entrada del menú.
// Sin build previo se omite y el informe lo declara (no sustituye a la puerta `npm run build`).
const CLIENT = join(FRONTEND, 'dist', 'client');
const ENTRY = join(FRONTEND, 'dist', 'server', 'entry.mjs');
const built = existsSync(CLIENT) && existsSync(ENTRY);
const live = built ? liveEnv() : null;
const READY_MS = 25_000;
const POLL_MS = 200;
const TEST_TIMEOUT = 60_000;
const COOKIE = 'sb-127-auth-token=base64-AAAA';
const MENU_WORDS = ['Pedidos', 'Productos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría', 'Pronto'];
const NO_STORE = 'private, no-store';
const FOUND = 302;
const NOT_FOUND = 404;
const FORBIDDEN = 403;
const UNAVAILABLE = 503;
const SERVER_ERROR = 500;
const OK = 200;

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

async function start(env: Record<string, string | undefined>) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined));
  const child = spawn(process.execPath, [ENTRY], { env: { ...clean, HOST: '127.0.0.1', PORT: String(port) } as NodeJS.ProcessEnv, stdio: 'ignore' });
  const deadline = Date.now() + READY_MS;
  const probe = async (): Promise<void> => {
    if (await fetch(`${base}/nosotros`).then((r) => r.status === OK, () => false)) return;
    if (Date.now() > deadline) throw new Error('el servidor de producción no arrancó');
    await new Promise((r) => setTimeout(r, POLL_MS));
    return probe();
  };
  await probe();
  return { base, stop: () => void child.kill() };
}
const get = (base: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
const noConfig = { SUPABASE_ANON_KEY: undefined, SUPABASE_URL: undefined, API_BASE_URL: undefined };

describe.skipIf(!built)('dist/client: el backoffice no llega al navegador', () => {
  const files = built ? walk(CLIENT).filter((f) => /\.(html|js|mjs|css|json|map|txt|xml|svg|webmanifest)$/.test(f)) : [];

  test('ninguna ruta del backoffice se prerenderiza (todas son SSR con guardia)', () => {
    const rels = walk(CLIENT).map((f) => f.slice(CLIENT.length).replaceAll('\\', '/'));
    expect(rels.filter((r) => /(^|\/)admin(\/|$)|sin-permiso|no-disponible|admin-layout/i.test(r))).toEqual([]);
  });

  test.each([
    ['la URL base de la API y el prefijo /api/v1 (N-4)', /API_BASE_URL|api\/v1/],
    ['rutas de la API de administración', /orders\/admin|catalog\/admin|inventory\/admin|identity\/me/],
    ['el rol o el texto del backoffice en un paquete de cliente', /data-context=["']?backoffice[^>]*>[\s\S]{0,40}Pedidos/],
    ['Authorization / Bearer', /Authorization["']?\s*:\s*["']?Bearer/i],
  ])('ningún archivo contiene %s', (_name, pattern) => {
    expect(files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.slice(CLIENT.length))).toEqual([]);
  });

  test('los HTML estáticos de la tienda no declaran data-context', () => {
    const htmls = files.filter((f) => f.endsWith('.html'));
    expect(htmls.length).toBeGreaterThan(0);
    expect(htmls.filter((f) => readFileSync(f, 'utf8').includes('data-context')).map((f) => f.slice(CLIENT.length))).toEqual([]);
  });

  test('el CSS publicado trae el bloque del backoffice y la tienda conserva sus valores de :root', () => {
    const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(css).toMatch(/\[data-context=["']?backoffice["']?\]/);
    expect(css).toMatch(/--bg-surface-dark:\s*var\(--color-forest-deep\)/);
    expect(css).toMatch(/--bg-page:\s*var\(--color-ivory\)/);
  });
});

describe.skipIf(!built)('servidor de producción SIN configuración', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    srv = await start(noConfig);
  }, TEST_TIMEOUT);
  afterAll(() => srv?.stop());

  test.each(['/admin', '/admin/x', '/Admin', '/ADMIN/pedidos', '/%61dmin/x', '/admin//x', '/admin/sin-permiso', '/admin/no-disponible'])(
    '%s sin cookie → 302 a /ingresar?next=… con no-store (no necesita configuración)',
    async (path) => {
      const res = await get(srv.base, `${path}?a=1`);
      expect(res.status).toBe(FOUND);
      // El servidor de producción normaliza la ruta (decodifica %61, colapsa //): `next` puede diferir del pedido, pero siempre es una ruta interna.
      const location = res.headers.get('location') ?? '';
      expect(location.startsWith('/ingresar?next=')).toBe(true);
      const next = decodeURIComponent(location.slice('/ingresar?next='.length));
      expect(next.startsWith('/')).toBe(true);
      expect(next.startsWith('//')).toBe(false);
      expect(next.endsWith('?a=1')).toBe(true);
      expect(res.headers.get('cache-control')).toBe(NO_STORE);
      expect(await res.text()).toBe('');
    },
  );

  test.each(['/administracion', '/admins'])('%s NO se protege: 404', async (path) => {
    expect((await get(srv.base, path)).status).toBe(NOT_FOUND);
  });

  test('/dev/admin-layout no existe en producción (404), ni con cookie ni sin ella, y no pide configuración', async () => {
    const anon = await get(srv.base, '/dev/admin-layout');
    const withCookie = await get(srv.base, '/dev/admin-layout', { headers: { cookie: COOKIE } });
    expect([anon.status, withCookie.status]).toEqual([NOT_FOUND, NOT_FOUND]);
    expect(await anon.text()).not.toMatch(/Administración|Backoffice|Pedidos/);
  });

  test('/admin con una cookie de sesión y sin configuración → 500 genérico, sin nombres de variables ni trazas', async () => {
    const res = await get(srv.base, '/admin', { headers: { cookie: COOKIE } });
    expect(res.status).toBe(SERVER_ERROR);
    expect(await res.text()).not.toMatch(/SUPABASE|ANON|KEY|API_BASE|AuthConfigError|node_modules|\.ts:\d+|at \w+ \(/i);
  });

  test('/bff/orders/admin sigue en 404', async () => {
    expect((await get(srv.base, '/bff/orders/admin')).status).toBe(NOT_FOUND);
  });
});

describe.skipIf(!built || !live)('servidor de producción con Supabase y backend reales: un cliente recibe «Sin permiso» sin menú', () => {
  let srv: Awaited<ReturnType<typeof start>>;
  let user: QaUser;
  beforeAll(async () => {
    srv = await start({ SUPABASE_URL: live!.url, SUPABASE_ANON_KEY: live!.anon, API_BASE_URL: undefined });
    user = await createQaUser(live!, 'dist', 'customer'); // qa-t142-dist-*: cliente (no administrador); se borra al terminar
  }, TEST_TIMEOUT);
  afterAll(async () => {
    srv?.stop();
    await deleteQaUser(live!, user);
  });
  const cookie = (): string => user.cookie;

  test('/admin/sin-permiso → 403, no-store, h1 «No tienes permiso» y ninguna entrada del menú de administración ni dato de la cuenta', async () => {
    const res = await get(srv.base, '/admin/sin-permiso', { headers: { cookie: cookie() } });
    expect(res.status).toBe(FORBIDDEN);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('No tienes permiso');
    MENU_WORDS.forEach((w) => expect(html, w).not.toContain(w));
    [user.email, user.id, 'Authorization', 'api/v1', 'identity/me'].forEach((s) => expect(html, s).not.toContain(s));
    expect(html).toMatch(/data-context="backoffice"/);
    expect(html).toMatch(/name="robots"[^>]*noindex|noindex[^>]*name="robots"/);
    expect([...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]).filter((h) => h !== '/' && h !== '#contenido')).toEqual([]);
  });

  test('/admin/no-disponible → 503 con no-store y sin menú', async () => {
    const res = await get(srv.base, '/admin/no-disponible', { headers: { cookie: cookie() } });
    expect(res.status).toBe(UNAVAILABLE);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    MENU_WORDS.forEach((w) => expect(html, w).not.toContain(w));
  });

  test('una ruta de administración sin pantalla (aún) no devuelve datos: 404, no-store', async () => {
    const res = await get(srv.base, '/admin/pedidos', { headers: { cookie: cookie() } });
    expect([NOT_FOUND, FORBIDDEN]).toContain(res.status);
    expect(res.headers.get('cache-control') ?? '').toContain('no-store');
    expect(res.status).not.toBe(OK);
  });

  test('/bff/orders/admin con sesión → 404', async () => {
    expect((await get(srv.base, '/bff/orders/admin/x', { headers: { cookie: cookie() } })).status).toBe(NOT_FOUND);
  });
});
