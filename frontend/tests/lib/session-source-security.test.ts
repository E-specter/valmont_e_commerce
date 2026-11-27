import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// T-126 · seguridad como prueba de código fuente (RNF02, D-013): el token y la clave no llegan al cliente, no hay almacenamiento
// del navegador ni `PUBLIC_*`, la `service_role` no existe en el frontend ni en el script de revisión.
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(FRONTEND, 'src');
const ROOT = join(FRONTEND, '..');
const read = (f: string) => readFileSync(f, 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const rel = (f: string) => relative(FRONTEND, f).replaceAll('\\', '/');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SOURCES = walk(SRC).filter((f) => /\.(ts|js|mjs|astro|css)$/.test(f));
const SESSION_FILES = ['src/middleware.ts', 'src/lib/server/supabase.ts', 'src/lib/server/session.ts', 'src/lib/server/guard.ts', 'src/pages/bff/[...path].ts', 'src/pages/auth/callback.ts', 'src/pages/salir.ts', 'src/lib/api/browser.ts'];
const CLIENT_SIDE = SOURCES.filter((f) => /src[\\/](islands|components|layouts)[\\/]/.test(f) || /lib[\\/]api[\\/]browser\.ts$/.test(f));

describe('el navegador no guarda ni lee la sesión', () => {
  test('ningún archivo de src/ usa localStorage, sessionStorage, indexedDB ni document.cookie', () => {
    const bad = SOURCES.filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(code(read(f)))).map(rel);
    expect(bad).toEqual([]);
  });

  test('ninguna variable PUBLIC_* en src/, astro.config.mjs ni .env.example', () => {
    const files = [...SOURCES, join(FRONTEND, 'astro.config.mjs')];
    expect(files.filter((f) => /PUBLIC_/.test(code(read(f)))).map(rel)).toEqual([]);
    expect(read(join(FRONTEND, '.env.example')).replace(/^\s*#.*$/gm, '')).not.toMatch(/PUBLIC_/);
  });

  test('import.meta.env no se usa para claves o URLs de Supabase', () => {
    const bad = SOURCES.filter((f) => /import\.meta\.env\.(PUBLIC_|SUPABASE|API_BASE)/.test(code(read(f)))).map(rel);
    expect(bad).toEqual([]);
  });
});

describe('el código de cliente no toca la sesión', () => {
  test('islas, componentes, layouts y browser.ts no importan Supabase, lib/server ni astro:env', () => {
    const bad = CLIENT_SIDE.filter((f) => /@supabase|lib\/server|\.\.\/server\/|astro:env|astro:middleware/.test(code(read(f)))).map(rel);
    expect(bad).toEqual([]);
  });

  test('ningún componente, isla ni layout nombra el token (accessToken, access_token, Authorization, Bearer)', () => {
    const bad = CLIENT_SIDE.filter((f) => /accessToken|access_token|Authorization|Bearer|locals\.session/.test(code(read(f)))).map(rel);
    expect(bad).toEqual([]);
  });

  test('las páginas .astro no serializan locals ni la sesión al HTML (set:html, define:vars, JSON.stringify de locals)', () => {
    const pages = SOURCES.filter((f) => /\.astro$/.test(f));
    const bad = pages.filter((f) => /define:vars[^>]*(session|locals)|JSON\.stringify\(\s*(Astro\.)?locals|set:html=\{[^}]*(session|locals)/.test(code(read(f)))).map(rel);
    expect(bad).toEqual([]);
  });
});

describe('los secretos viven solo donde deben', () => {
  test('SUPABASE_ANON_KEY solo se lee en lib/server/supabase.ts (más el esquema de astro.config.mjs)', () => {
    const users = SOURCES.filter((f) => code(read(f)).includes('SUPABASE_ANON_KEY')).map(rel);
    expect(users).toEqual(['src/lib/server/supabase.ts']);
  });

  test('@supabase/ssr y @supabase/supabase-js solo en lib/server/ (y tipos en env.d.ts)', () => {
    const users = SOURCES.filter((f) => /@supabase\//.test(code(read(f)))).map(rel).sort();
    expect(users).toEqual(['src/env.d.ts', 'src/lib/server/session.ts', 'src/lib/server/supabase.ts']);
  });

  test('ninguna service_role ni JWT secret en el frontend, su configuración, .env.example ni review-up.sh', () => {
    const files = [...SOURCES, join(FRONTEND, 'astro.config.mjs'), join(FRONTEND, '.env.example'), join(FRONTEND, 'package.json'), join(ROOT, 'scripts', 'review-up.sh')];
    // Los comentarios del script (# …) pueden nombrarla para prohibirla; solo cuenta el código.
    const live = (f: string) => (f.endsWith('.sh') ? read(f).replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '') : read(f));
    const bad = files.filter((f) => /service[_-]?role|SERVICE_ROLE|JWT_SECRET|jwt_secret/i.test(live(f))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(bad).toEqual([]);
  });

  test('sin claves ni JWT escritos en el código (eyJ…, sb_publishable_, sb_secret_)', () => {
    const bad = SOURCES.filter((f) => /eyJ[A-Za-z0-9_-]{10,}|sb_publishable_|sb_secret_/.test(read(f))).map(rel);
    expect(bad).toEqual([]);
  });

  test('.env.example: nombres sin valores', () => {
    const lines = read(join(FRONTEND, '.env.example')).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(lines.sort()).toEqual(['API_BASE_URL=', 'SUPABASE_ANON_KEY=', 'SUPABASE_URL=']);
  });

  test('review-up.sh solo vuelca ANON_KEY/PUBLISHABLE_KEY y API_URL a frontend/.env, nunca imprime la salida de supabase status', () => {
    const sh = read(join(ROOT, 'scripts', 'review-up.sh'));
    const writes = sh.split('\n').filter((l) => />\s*frontend\/\.env/.test(l));
    expect(writes.length).toBeGreaterThan(0);
    writes.forEach((l) => expect(l).toMatch(/SUPABASE_URL=%s.*SUPABASE_ANON_KEY=%s.*API_BASE_URL=/));
    expect(sh).not.toMatch(/\bval\s+(SERVICE|SECRET|JWT|S3)/);
    expect(sh).not.toMatch(/echo\s+["']?\$\{?(st|anon)\b|printf[^\n]*\$\{?st\b[^\n]*(?<!\|)\n?(?=.*>&2)/);
    expect(sh).toMatch(/\[ ! -f frontend\/\.env \]/); // no sobrescribe un .env existente
  });
});

describe('el proxy y las rutas de sesión', () => {
  test.each(SESSION_FILES)('%s: sin console.* ni debugger (no se registran tokens ni cookies)', (f) => {
    expect(code(read(join(FRONTEND, f)))).not.toMatch(/\bconsole\.\w+|\bdebugger\b/);
  });

  test('el proxy no usa serverTransport ni reenvía la cabecera Cookie/Set-Cookie/Host/X-Forwarded', () => {
    const c = code(read(join(SRC, 'pages/bff/[...path].ts')));
    expect(c).not.toMatch(/request\.headers\s*\)|new Headers\(\s*request|\.\.\.\s*request\.headers|Object\.fromEntries\(\s*request\.headers/);
    expect(c).not.toMatch(/['"]set-cookie['"]|upstream\.headers\)|\.\.\.\s*upstream\.headers/i);
    expect(c).toMatch(/redirect:\s*['"]manual['"]/);
    expect(c).toMatch(/prerender\s*=\s*false/);
  });

  test.each(['src/pages/bff/[...path].ts', 'src/pages/auth/callback.ts', 'src/pages/salir.ts'])('%s: prerender = false (nunca estático)', (f) => {
    expect(code(read(join(FRONTEND, f)))).toMatch(/export const prerender\s*=\s*false/);
  });

  test('el único fetch( del servidor hacia el backend desde pages/ es el del proxy, con destino fijo API_BASE_URL', () => {
    const pages = walk(join(SRC, 'pages')).filter((f) => /\.(ts|astro)$/.test(f));
    const withFetch = pages.filter((f) => /\bfetch\s*\(/.test(code(read(f)))).map(rel);
    expect(withFetch).toEqual(['src/pages/bff/[...path].ts']);
    expect(code(read(join(SRC, 'pages/bff/[...path].ts')))).toMatch(/API_BASE_URL/);
  });

  test('la configuración no habilita CORS ni desactiva checkOrigin', () => {
    const cfg = read(join(FRONTEND, 'astro.config.mjs'));
    expect(cfg).not.toMatch(/checkOrigin\s*:\s*false/);
    expect(cfg).not.toMatch(/Access-Control-Allow/i);
    expect(SOURCES.filter((f) => /Access-Control-Allow/i.test(read(f))).map(rel)).toEqual([]);
  });
});
