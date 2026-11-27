import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { containsAny } from '../helpers/t127';

// T-127 · seguridad del ingreso como prueba de código fuente (RNF02, RNF07, D-013): el cliente no toca la sesión ni registra datos.
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'src/pages/ingresar.astro',
  'src/components/auth/AuthForm.astro',
  'src/components/auth/AuthSplit.astro',
  'src/components/auth/WatchmakerArtwork.astro',
  'src/islands/password-toggle.ts',
  'src/lib/server/auth-errors.ts',
];
const read = (f: string): string => readFileSync(join(FRONTEND, f), 'utf8');
const CLIENT_CODE = ['src/islands/password-toggle.ts'];
const LOGGING = ['console.log', 'console.info', 'console.warn', 'console.error', 'console.debug', 'console.dir'];
const BROWSER_STORAGE = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'];
const NETWORK_IN_CLIENT = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'import('];
const SUPABASE_IN_CLIENT = ['@supabase', 'lib/server', 'astro:env', 'SUPABASE'];

describe('archivos de T-127 existen en los lugares del paquete', () => {
  test.each(FILES)('%s', (f) => expect(existsSync(join(FRONTEND, f))).toBe(true));
});

describe('ingresar.astro', () => {
  test('SSR (prerender = false) y Cache-Control: private, no-store', () => {
    const src = read('src/pages/ingresar.astro');
    expect(src).toContain('prerender = false');
    expect(src).toContain('private, no-store');
  });

  test('valida el destino con safeNext y no refleja la contraseña ni usa set:html', () => {
    const src = read('src/pages/ingresar.astro');
    expect(src).toContain('safeNext');
    expect(src).not.toContain('set:html');
  });

  test('el POST usa el cliente del servidor (locals.supabase) y no importa Supabase directamente', () => {
    const src = read('src/pages/ingresar.astro');
    expect(src).toContain('locals.supabase');
    expect(containsAny(src, ['createClient', "from '@supabase", 'service_role', 'SERVICE_ROLE'])).toBe(false);
  });
});

describe('nada del ingreso registra datos ni guarda estado en el navegador', () => {
  test.each(FILES)('%s: sin console.* (la contraseña y el correo no se registran)', (f) => {
    expect(containsAny(read(f), LOGGING)).toBe(false);
  });

  test.each(FILES)('%s: sin localStorage, sessionStorage, indexedDB ni document.cookie', (f) => {
    expect(containsAny(read(f), BROWSER_STORAGE)).toBe(false);
  });

  test.each(FILES)('%s: sin PUBLIC_* ni set:html', (f) => {
    expect(containsAny(read(f), ['PUBLIC_', 'set:html'])).toBe(false);
  });
});

describe('la isla password-toggle es TypeScript puro', () => {
  test.each(CLIENT_CODE)('%s no hace red ni importa Supabase, servidor o entorno', (f) => {
    const src = read(f);
    expect(containsAny(src, NETWORK_IN_CLIENT)).toBe(false);
    expect(containsAny(src, SUPABASE_IN_CLIENT)).toBe(false);
  });

  test('la isla exporta initPasswordToggle', () => {
    expect(read('src/islands/password-toggle.ts')).toContain('export function initPasswordToggle');
  });
});

describe('AuthForm', () => {
  test('el campo de contraseña no recibe `value` en el código (H-18 y "la contraseña nunca se vuelve a pintar")', () => {
    const src = read('src/components/auth/AuthForm.astro');
    const start = src.indexOf('type="password"');
    const end = src.indexOf('</Field>', start);
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, end).includes('value=')).toBe(false);
  });

  test('no incluye "Recuérdame" ni "¿Olvidaste tu contraseña?" (H-18: RF01.04 es POSTERIOR)', () => {
    expect(containsAny(read('src/components/auth/AuthForm.astro'), ['recuérdame', 'olvidaste', 'remember'])).toBe(false);
  });
});
