import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// T-120 · seguridad como prueba de código fuente (RT-5, contrato 3.1 y "Seguridad" del paquete).
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(FRONTEND, 'src');
const API = join(SRC, 'lib/api');
const FILES = ['http.ts', 'server.ts', 'catalog.ts'];
const read = (f: string) => readFileSync(f, 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const rel = (f: string) => relative(FRONTEND, f).replaceAll('\\', '/');
// Quita comentarios para no dar falsos positivos con la documentación.
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('API_BASE_URL y secretos', () => {
  const allSrc = walk(SRC).filter((f) => /\.(ts|tsx|js|mjs|astro|svelte|vue|jsx)$/.test(f));

  // T-126 (desviación aceptada por el Leader): el proxy `/bff` fija su destino con API_BASE_URL (contrato 3.3).
  test('API_BASE_URL solo se importa de astro:env/server y solo en server.ts y en el proxy /bff', () => {
    const users = allSrc.filter((f) => code(read(f)).includes('API_BASE_URL')).map(rel);
    expect(users).toEqual(['src/lib/api/server.ts', 'src/pages/bff/[...path].ts']);
    expect(code(read(join(API, 'server.ts')))).toMatch(/import\s*\{[^}]*\bAPI_BASE_URL\b[^}]*\}\s*from\s*['"]astro:env\/server['"]/);
  });

  test('el transporte no lee el entorno por otras vías (import.meta.env, process.env, astro:env/client)', () => {
    for (const f of FILES) {
      const c = code(read(join(API, f)));
      expect(c, f).not.toMatch(/import\.meta\.env|process\.env|astro:env\/client/);
    }
  });

  test('sin variables PUBLIC_* en lib/api ni en la configuración', () => {
    for (const f of [...FILES.map((n) => join(API, n)), join(FRONTEND, 'astro.config.mjs'), join(FRONTEND, '.env.example')]) {
      // .env.example usa comentarios con #: se ignoran.
      expect(code(read(f)).replace(/^s*#.*$/gm, ''), rel(f)).not.toMatch(/PUBLIC_/);
    }
  });

  test('sin URL del backend ni claves escritas en el código (127.0.0.1:8000, localhost:8000, eyJ…)', () => {
    for (const f of FILES) {
      const c = code(read(join(API, f)));
      expect(c, f).not.toMatch(/127\.0\.0\.1|localhost|:8000|eyJ[A-Za-z0-9_-]{10,}/);
    }
  });
});

describe('no se registra nada', () => {
  test.each(FILES)('%s: sin console.* ni debugger', (f) => {
    const c = code(read(join(API, f)));
    expect(c).not.toMatch(/\bconsole\s*\./);
    expect(c).not.toMatch(/\bdebugger\b/);
  });
});

describe('sin precios, totales ni ids de usuario en la API del cliente', () => {
  test.each(FILES)('%s: ningún identificador de usuario ni de importe como campo o parámetro', (f) => {
    const c = code(read(join(API, f)));
    expect(c).not.toMatch(/\b(user_?id|customer_?id|userId|customerId)\b/i);
    // Los importes solo aparecen como TIPOS de respuesta (Money, original_price, discount_amount), nunca como entradas.
    expect(c).not.toMatch(/\b(subtotal|unit_price|grand_total|total_amount)\b/i);
  });

  test('server.ts y http.ts no tienen una cabecera ni un campo de identidad: la identidad sale del token', () => {
    for (const f of ['http.ts', 'server.ts']) {
      expect(code(read(join(API, f))), f).not.toMatch(/x-user|x-customer|user[_-]?id/i);
    }
  });
});

describe('server.ts no llega al navegador', () => {
  const importsServer = (s: string) => /from\s*['"][^'"]*\/api\/server(\.ts)?['"]|from\s*['"]\.\/server(\.ts)?['"]|import\(\s*['"][^'"]*\/api\/server/.test(s);

  test('http.ts y catalog.ts no dependen del servidor (valen en islas): sin astro:* ni ./server', () => {
    for (const f of ['http.ts', 'catalog.ts']) {
      const c = code(read(join(API, f)));
      expect(c, f).not.toMatch(/astro:|from\s*['"]\.\/server/);
    }
  });

  test('ningún archivo de cliente (isla, script o lib/api/browser) importa server.ts', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const text = read(f);
      if (f.endsWith('.astro')) {
        // Solo el frontmatter (entre las dos primeras líneas ---) es de servidor; lo demás, <script>, es de cliente.
        const m = text.match(/^---\r?\n[\s\S]*?\r?\n---/);
        const rest = m ? text.slice(m[0].length) : text;
        if (importsServer(rest)) offenders.push(`${rel(f)} (fuera del frontmatter)`);
      } else if (/\.(tsx|jsx|svelte|vue)$/.test(f)) {
        if (importsServer(text)) offenders.push(rel(f));
      } else if (f.endsWith('.ts') || f.endsWith('.js')) {
        // En .ts solo pueden importarlo módulos de servidor: lib/server, middleware, endpoints en pages/ y el propio lib/api.
        const r = rel(f);
        const serverSide = /^frontend\/src\/(lib\/server\/|middleware|pages\/.*\.ts$)|^src\/(lib\/server\/|middleware|pages\/.*\.ts$)/.test(r);
        if (importsServer(text) && !serverSide && r !== 'src/lib/api/server.ts') offenders.push(r);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('lib/api/browser.ts (cuando exista, T-126) no importa server.ts ni astro:env', () => {
    const f = join(API, 'browser.ts');
    if (!walk(API).includes(f)) return;
    expect(code(read(f))).not.toMatch(/astro:env|\.\/server|api\/server/);
  });

  test('server.ts es el único módulo con acceso a astro:env/server dentro de lib/api', () => {
    const users = walk(API).filter((f) => /astro:env\/server/.test(code(read(f)))).map(rel);
    expect(users).toEqual(['src/lib/api/server.ts']);
  });
});

describe('un único punto de acceso a la API', () => {
  // T-126: `browser.ts` (contrato 3.3) es el transporte de las islas hacia /bff.
  test('fetch( solo aparece en server.ts y browser.ts dentro de lib/api', () => {
    const users = walk(API).filter((f) => /\bfetch\s*\(/.test(code(read(f)))).map(rel);
    expect(users).toEqual(['src/lib/api/browser.ts', 'src/lib/api/server.ts']);
  });

  test('el transporte no reintenta ni hace bucles de reintento', () => {
    const c = code(read(join(API, 'server.ts')));
    expect(c.match(/\bfetch\s*\(/g)?.length).toBe(1);
    expect(c).not.toMatch(/\b(retry|retries|attempt)\b/i);
  });
});
