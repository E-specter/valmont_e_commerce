import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';

// T-128 + T-131 · seguridad como prueba de código fuente: la fecha de nacimiento es un dato personal (RNF10, Ley 29733).
// No se registra, no va en URLs, no se guarda en el navegador y no toca el código compartido de sesión.
const SRC = join(FRONTEND, 'src');
const read = (f: string): string => readFileSync(join(FRONTEND, f), 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');
// Quita comentarios de bloque y de línea para no confundir una explicación con código.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|[^:])\/\/.*$/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const code = (s: string): string => s.replace(BLOCK_COMMENT, '').replace(HTML_COMMENT, '').replace(LINE_COMMENT, '$1');
const SOURCES = walk(SRC).filter((f) => /\.(ts|js|mjs|astro)$/.test(f));

const REGISTER_FILES = ['src/pages/registro.astro', 'src/components/auth/RegisterForm.astro', 'src/lib/server/register.ts', 'src/pages/auth/callback.ts'];
// Código de sesión y de cliente que nunca debe mencionar la fecha.
const NEVER_BIRTH = SOURCES.filter((f) => /src[\\/](islands|layouts|middleware\.ts)|lib[\\/]server[\\/](session|supabase|guard)\.ts|pages[\\/](bff|salir)/.test(f));

describe('la fecha de nacimiento no se registra ni viaja por URL', () => {
  test.each(REGISTER_FILES)('%s existe y no escribe en consola (console.*)', (f) => {
    expect(code(read(f))).not.toMatch(/console\s*\./);
  });

  test.each(REGISTER_FILES)('%s no interpola la fecha en una URL ni en una query', (f) => {
    const src = code(read(f));
    expect(src).not.toMatch(/\$\{[^}]*birth[^}]*\}/i);
    expect(src).not.toMatch(/[?&]birth_date=/);
    expect(src).not.toMatch(/searchParams\.(set|append)\(\s*['"]birth/);
  });

  test.each(REGISTER_FILES)('%s no usa almacenamiento del navegador ni cookies manuales', (f) => {
    expect(code(read(f))).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/);
  });

  test('el script de cliente de RegisterForm no menciona la fecha', () => {
    const src = read('src/components/auth/RegisterForm.astro');
    const scripts = [...src.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0]).join('\n');
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts).not.toMatch(/birth|bday|nacimiento/i);
  });

  test('ningún archivo de sesión, isla, layout, BFF ni /salir menciona birth_date', () => {
    expect(NEVER_BIRTH.length).toBeGreaterThan(0);
    expect(NEVER_BIRTH.filter((f) => /birth_date|birthDate|birth-date/i.test(code(readFileSync(f, 'utf8')))).map(rel)).toEqual([]);
  });

  test('solo los archivos del registro y del callback (y los tipos de identity) manejan birth_date', () => {
    const allowed = new Set([...REGISTER_FILES, 'src/lib/api/identity.ts'].map((f) => f.replaceAll('\\', '/')));
    const users = SOURCES.filter((f) => /birth_date|birthDate/.test(code(readFileSync(f, 'utf8')))).map(rel);
    expect(users.filter((f) => !allowed.has(f) && !/components\/ui\/Field\.astro$/.test(f))).toEqual([]);
  });
});

describe('el formulario de registro', () => {
  test('registro.astro: Origin propio, Cache-Control no-store, formData con 415 y sin redirección con Astro.redirect (descarta cabeceras)', () => {
    const src = code(read('src/pages/registro.astro'));
    expect(src).toMatch(/origin/i);
    expect(src).toContain('403');
    expect(src).toContain('415');
    expect(src).toMatch(/private, no-store/);
    expect(src).not.toMatch(/Astro\.redirect\(/);
  });

  test('registro.astro: la versión de la política sale de PRIVACY_VERSION, no del formulario', () => {
    const src = code(read('src/pages/registro.astro'));
    expect(src).toContain('PRIVACY_VERSION');
    expect(src).not.toMatch(/str\(\s*['"]accept_privacy_version/);
  });

  test('registro.astro: la validación de la fecha corre ANTES de signUp (el menor nunca llega a Auth)', () => {
    const src = code(read('src/pages/registro.astro'));
    const validate = src.indexOf('validateRegister(');
    const signUp = src.indexOf('.signUp(');
    expect(validate).toBeGreaterThan(-1);
    expect(signUp).toBeGreaterThan(validate);
  });

  test('registro.astro: la fecha usada para comprobar la edad es la de Lima del servidor (limaToday), no la del cliente', () => {
    const src = code(read('src/pages/registro.astro'));
    expect(src).toContain('limaToday');
    expect(src).not.toMatch(/str\(\s*['"]today/);
  });

  test('RegisterForm no usa set:html ni define:vars', () => {
    expect(code(read('src/components/auth/RegisterForm.astro'))).not.toMatch(/set:html|define:vars/);
  });

  test('register.ts es puro: no importa Supabase, astro:env ni lib/api', () => {
    expect(code(read('src/lib/server/register.ts'))).not.toMatch(/@supabase|astro:env|lib\/api|from ['"]astro/);
  });

  test('callback.ts: la fecha sale de user_metadata validada por formato y se borra con updateUser', () => {
    const src = code(read('src/pages/auth/callback.ts'));
    expect(src).toMatch(/updateUser\(\s*\{\s*data:\s*\{\s*birth_date:\s*null\s*\}\s*\}\s*\)/);
    expect(src).not.toMatch(/JSON\.stringify\(\s*meta\s*\)/);
  });
});
