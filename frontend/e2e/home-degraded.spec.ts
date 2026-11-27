import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { openPage } from './helpers/ui-a';

// T-121 · degradación: servidor de producción (dist/server/entry.mjs, tras npm run build) con API_BASE_URL a un puerto cerrado (el backend "está caído") y sin SUPABASE_ANON_KEY.
// La portada debe responder 200 con el único botón a /relojes, sin avisos de error y sin trazas. Solo lectura.
// Un servidor por proyecto (desktop y mobile corren en paralelo): 4381 y 4382.
const BASE_PORT = Number(process.env.E2E_DEGRADED_PORT ?? '4381');
const portOf = (project: string): number => BASE_PORT + (project === 'mobile' ? 1 : 0);
const CLOSED_API = 'http://127.0.0.1:9'; // puerto de descarte: conexión rechazada
const BOOT_MS = 120_000;
const POLL_MS = 500;
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const OK = 200;
// Detalle técnico que no debe verse en la página: "ECONNREFUSED" casa; "Ver todos los relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=ECONNREFUSED%7Cfetch%20failed%7CTypeError%7CApiError%7C127%5C.0%5C.0%5C.1&flags=i
const LEAK = /ECONNREFUSED|fetch failed|TypeError|ApiError|127\.0\.0\.1/i;

let server: ChildProcess | undefined;
let origin = '';

test.describe.configure({ mode: 'serial', timeout: SLOW });

test.beforeAll(async () => {
  test.setTimeout(BOOT_MS + SLOW);
  const PORT = portOf(test.info().project.name);
  origin = `http://127.0.0.1:${String(PORT)}`;
  // astro dev admite un solo servidor por proyecto (el de Playwright), así que se usa el servidor de producción del adaptador (npm run build antes).
  const entry = join(process.cwd(), 'dist', 'server', 'entry.mjs');
  if (!existsSync(entry)) throw new Error('Falta dist/server/entry.mjs: ejecuta npm run build antes de este E2E.');
  // Sin SUPABASE_ANON_KEY (opcional hasta T-126) y con la API en un puerto cerrado.
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), API_BASE_URL: CLOSED_API };
  delete env.SUPABASE_ANON_KEY;
  server = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stdout?.resume();
  server.stderr?.resume();
  const deadline = Date.now() + BOOT_MS;
  const up = async (): Promise<boolean> => {
    try {
      return (await fetch(`${origin}/`)).status > NONE;
    } catch {
      return false;
    }
  };
  const wait = async (): Promise<void> => {
    if (await up()) return;
    if (Date.now() > deadline) throw new Error(`el servidor de producción no arrancó en ${String(PORT)}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    return wait();
  };
  await wait();
});

test.afterAll(() => {
  server?.kill();
});

test.describe('portada / con la API caída', () => {
  test('responde 200 con Cache-Control público y sin errores de servidor', async ({ page }) => {
    const res = await page.goto(`${origin}/`);
    expect(res?.status()).toBe(OK);
    expect(res?.headers()['cache-control']).toBe('public, max-age=60');
  });

  test('muestra un único botón "Ver todos los relojes" a /relojes, sin mosaicos, sin "Novedad" y sin avisos', async ({ page }) => {
    await openPage(page, `${origin}/`);
    const main = page.getByRole('main');
    const fallback = main.getByRole('link', { name: 'Ver todos los relojes' });
    await expect(fallback).toHaveCount(ONE);
    await expect(fallback).toHaveAttribute('href', '/relojes');
    await expect(main.locator('a[href^="/relojes?category="]')).toHaveCount(NONE);
    await expect(main.getByRole('navigation', { name: 'Colecciones' })).toHaveCount(NONE);
    await expect(main.locator('[aria-labelledby="featured-title"]')).toHaveCount(NONE);
    await expect(page.locator('[role="alert"]')).toHaveCount(NONE);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(ONE);
    expect(await page.content()).not.toMatch(LEAK);
  });

  test('sin accesibilidad rota en el modo degradado y el botón lleva al catálogo', async ({ page }) => {
    await openPage(page, `${origin}/`);
    await expectNoA11yViolations(page);
    await page.getByRole('main').getByRole('link', { name: 'Ver todos los relojes' }).click();
    await page.waitForURL('**/relojes');
    expect(new URL(page.url()).pathname).toBe('/relojes');
  });
});
