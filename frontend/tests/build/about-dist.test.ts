import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';
import { parseHtml } from '../helpers/render';

// T-122 · resultado de `npm run build`: las tres rutas se prerenderizan (dist/client/<ruta>/index.html), llevan el orden de capas
// CSS antes de cualquier regla (fix T-132) y responden 200 con el servidor de producción (`node dist/server/entry.mjs`).
// Sin build previo se omite y el informe lo declara (no sustituye a la puerta `npm run build`).
const CLIENT = join(FRONTEND, 'dist', 'client');
const ENTRY = join(FRONTEND, 'dist', 'server', 'entry.mjs');
const built = existsSync(CLIENT) && existsSync(ENTRY);
const ROUTES = ['nosotros', 'privacidad', 'terminos'];
const OK = 200;
const ONE = 1;
const NONE = 0;
const READY_MS = 20_000;
const POLL_MS = 200;
const TEST_TIMEOUT = 40_000;
const LAYER_ORDER = '@layer reset, tokens, base, components, utilities;';
// Hoja o bloque de estilo, en orden de documento: "<style>a</style>" y '<link rel="stylesheet" href="/x.css">' casan; "<script>" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%3Clink%5B%5E%3E%5D*rel%3D%22stylesheet%22%5B%5E%3E%5D*href%3D%22(%5B%5E%22%5D%2B)%22%5B%5E%3E%5D*%3E%7C%3Cstyle%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fstyle%3E&flags=g
const SHEETS = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>|<style[^>]*>([\s\S]*?)<\/style>/g;
// Regla de capa con bloque: "@layer components{" casa; "@layer a, b;" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%40layer%5Cs%2B%5Cw%2B%5Cs*%5C%7B&flags=
const LAYER_BLOCK = /@layer\s+\w+\s*\{/;

const html = (route: string): string => readFileSync(join(CLIENT, route, 'index.html'), 'utf8');
/** CSS en orden de documento (los enlaces se resuelven contra dist/client). */
const sheets = (page: string): string[] =>
  [...page.matchAll(SHEETS)].map((m) => (m[ONE] ? readFileSync(join(CLIENT, m[ONE]), 'utf8') : m[2]));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(NONE, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

describe.skipIf(!built)('build · rutas prerenderizadas', () => {
  test.each(ROUTES)('/%s existe en dist/client como HTML estático con un h1 y el bloque de demostración', (route) => {
    const file = join(CLIENT, route, 'index.html');
    expect(existsSync(file)).toBe(true);
    const doc = parseHtml(html(route));
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    expect(doc.querySelectorAll('[data-demo-content]').length).toBeGreaterThanOrEqual(ONE);
    expect(doc.querySelector('main#contenido')).not.toBeNull();
  });

  test.each(ROUTES)('/%s: el orden de capas es lo primero que ve el navegador (antes de cualquier @layer con reglas) — T-132', (route) => {
    const css = sheets(html(route));
    const first = css.findIndex((c) => c.includes(LAYER_ORDER));
    const firstBlock = css.findIndex((c) => LAYER_BLOCK.test(c));
    expect(first, 'falta la declaración de orden de capas').toBeGreaterThanOrEqual(NONE);
    expect(firstBlock, 'no hay ninguna capa con reglas').toBeGreaterThanOrEqual(NONE);
    expect(first).toBeLessThanOrEqual(firstBlock);
    expect(css[first].trimStart().startsWith(LAYER_ORDER)).toBe(true);
  });

  test('/nosotros lleva el ancla #contacto y los enlaces tel: y mailto: en el HTML estático', () => {
    const doc = parseHtml(html('nosotros'));
    expect(doc.querySelectorAll('main #contacto').length).toBe(ONE);
    expect(doc.querySelector('main #contacto a[href^="tel:"]')).not.toBeNull();
    expect(doc.querySelector('main #contacto a[href^="mailto:"]')).not.toBeNull();
  });

  test.each(ROUTES)('/%s no filtra configuración del servidor al HTML', (route) => {
    ['API_BASE_URL', '127.0.0.1:8000', 'api/v1', 'SUPABASE'].forEach((n) => expect(html(route)).not.toContain(n));
  });
});

describe.skipIf(!built)('build · servidor de producción (node dist/server/entry.mjs)', () => {
  let child: ChildProcess;
  let base = '';

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
    const deadline = Date.now() + READY_MS;
    const probe = async (): Promise<void> => {
      const ready = await fetch(`${base}/nosotros`).then((r) => r.status === OK, () => false);
      if (ready) return;
      if (Date.now() > deadline) throw new Error('el servidor de producción no arrancó');
      await new Promise((r) => setTimeout(r, POLL_MS));
      return probe();
    };
    await probe();
  }, TEST_TIMEOUT);

  afterAll(() => {
    child?.kill();
  });

  test.each(ROUTES)('GET /%s responde 200 con HTML y un solo h1', async (route) => {
    const res = await fetch(`${base}/${route}`);
    expect(res.status).toBe(OK);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(parseHtml(await res.text()).querySelectorAll('h1').length).toBe(ONE);
  });
});
