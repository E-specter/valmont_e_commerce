import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { containsAny } from '../helpers/t127';

// T-129 · seguridad de la cuenta como prueba de código fuente (RNF02, RNF10, D-013, identity R9): la fecha de nacimiento y el
// perfil no se registran ni se guardan en el navegador, y el cliente no maneja identificadores ni roles.
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['src/pages/cuenta/index.astro', 'src/components/account/ProfileForm.astro', 'src/lib/api/identity.ts'];
const read = (f: string): string => readFileSync(join(FRONTEND, f), 'utf8');
const LOGGING = ['console.log', 'console.info', 'console.warn', 'console.error', 'console.debug', 'console.dir', 'console.trace'];
const BROWSER_STORAGE = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'];
const SECRETS = ['service_role', 'SERVICE_ROLE', 'PUBLIC_', 'createClient', "from '@supabase"];

describe('archivos de T-129 en los lugares del paquete', () => {
  test.each(FILES)('%s existe', (f) => expect(existsSync(join(FRONTEND, f))).toBe(true));
});

describe('la cuenta no registra datos ni guarda estado en el navegador', () => {
  test.each(FILES)('%s: sin console.* (la fecha de nacimiento y el perfil no se registran)', (f) => {
    expect(containsAny(read(f), LOGGING)).toBe(false);
  });

  test.each(FILES)('%s: sin localStorage, sessionStorage, indexedDB ni document.cookie', (f) => {
    expect(containsAny(read(f), BROWSER_STORAGE)).toBe(false);
  });

  test.each(FILES)('%s: sin set:html, sin claves ni clientes de Supabase propios', (f) => {
    expect(containsAny(read(f), ['set:html', ...SECRETS])).toBe(false);
  });

  test('el formulario y la ruta no cargan JavaScript de cliente (funciona sin JS) ni hacen fetch desde el navegador', () => {
    ['src/pages/cuenta/index.astro', 'src/components/account/ProfileForm.astro'].forEach((f) => {
      const src = read(f);
      expect(src.includes('<script'), `${f} añade un <script>`).toBe(false);
      expect(containsAny(src, ['XMLHttpRequest', 'sendBeacon', 'fetch('])).toBe(false);
    });
  });
});

describe('cuenta/index.astro', () => {
  const src = (): string => read('src/pages/cuenta/index.astro');

  test('SSR (prerender = false) y Cache-Control: private, no-store', () => {
    expect(src()).toContain('prerender = false');
    expect(src()).toContain('private, no-store');
  });

  test('habla con la API solo con el transporte de la sesión (apiFor) y no con un id recibido', () => {
    expect(src()).toContain('apiFor');
    expect(containsAny(src(), ['params.id', 'searchParams.get(\'user', 'searchParams.get("user', 'searchParams.get(\'id', 'searchParams.get("id'])).toBe(false);
  });

  test('comprueba el Origin de las escrituras y responde 415 a un cuerpo que no es formulario', () => {
    expect(src()).toContain("headers.get('origin')");
    expect(src()).toContain('url.origin');
    expect(src()).toContain('415');
  });

  test('ante un 401 del backend cierra la sesión local (endSession) antes de redirigir, como /bff', () => {
    expect(src()).toContain('endSession');
  });

  test('"Cerrar sesión" es un formulario POST a /salir y no un enlace', () => {
    expect(src()).toContain('action="/salir"');
    expect(src().includes('href="/salir"')).toBe(false);
  });
});

describe('ProfileForm.astro e identity.ts', () => {
  test('el formulario no tiene campos role ni user_id', () => {
    const src = read('src/components/account/ProfileForm.astro');
    expect(containsAny(src, ['name="role"', 'name="user_id"'])).toBe(false);
  });

  test('la fecha solo se formatea con formatDateOnly (sin new Date(...) que la desplace por zona horaria)', () => {
    const src = read('src/components/account/ProfileForm.astro');
    expect(src).toContain('formatDateOnly');
    expect(src.includes('new Date(')).toBe(false);
  });

  test('identity.ts no hace red por su cuenta: usa el Transport recibido (no importa astro:env ni fetch)', () => {
    const src = read('src/lib/api/identity.ts');
    expect(containsAny(src, ['fetch(', 'astro:env', 'XMLHttpRequest'])).toBe(false);
    expect(src).toContain('/identity/me');
  });
});
