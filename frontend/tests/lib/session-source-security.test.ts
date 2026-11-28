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

// T-150 · review-up.sh lee la service_role en memoria para crear el administrador local y se la pasa SOLO al proceso hijo.
// La regla revisa el código del script (sin comentarios): (a) el bloque que genera frontend/.env no la menciona ni escribe la clave
// secreta; (b) ningún echo/printf/cat/tee ni redirección a archivo usa la variable; (c) no se exporta y se hace unset después.
const REVIEW_SCRIPT = join(ROOT, 'scripts', 'review-up.sh');
const NOT_FOUND = -1;
const FORBIDDEN_IN_ENV_BLOCK = ['SERVICE_ROLE', 'service_role', 'SECRET_KEY', 'sb_secret', 'JWT_SECRET'];
const PRINTERS = ['echo', 'printf', 'cat', 'tee', 'dd'];
const SAFE_REDIRECTS = ['2>/dev/null', '>/dev/null', '>&2', '2>&1'];

/** El código del script: sin líneas de comentario ni comentarios al final de una línea. */
const shellCode = (script: string): string[] =>
  script.split('\n').map((l) => l.replace('\r', '')).filter((l) => !l.trimStart().startsWith('#')).map((l) => (l.includes(' # ') ? l.slice(0, l.indexOf(' # ')) : l));

/** Nombre de la variable que recibe la clave: la línea `x="$(… SERVICE_ROLE_KEY …)"`. */
function secretVariable(script: string): string | undefined {
  const line = shellCode(script).find((l) => l.includes('SERVICE_ROLE_KEY') && l.includes('$(') && l.includes('='));
  return line?.trimStart().replace('export ', '').split('=')[0];
}

/** Comandos sueltos de una línea (separados por &&, ||, ; o |): así `cmd "$sr" || echo "aviso"` no confunde dos comandos. */
const commands = (line: string): string[] => line.replaceAll('&&', '\n').replaceAll('||', '\n').replaceAll(';', '\n').replaceAll('|', '\n').split('\n');
const hasRef = (cmd: string, v: string): boolean => cmd.includes(`$${v}`) || cmd.includes(`\${${v}}`);
const words = (cmd: string): string[] => cmd.replaceAll('(', ' ').replaceAll(')', ' ').split(' ').filter(Boolean);

function reviewScriptViolations(script: string): string[] {
  const lines = shellCode(script);
  const v = secretVariable(script);
  if (!v) return ['no se encontró la variable que recibe la service_role (¿cambió el script?)'];
  const out: string[] = [];
  // (a) bloque que genera frontend/.env: desde `if [ ! -f frontend/.env ]` hasta su `fi`
  const start = lines.findIndex((l) => l.includes('-f frontend/.env'));
  const end = start === NOT_FOUND ? NOT_FOUND : lines.findIndex((l, i) => i > start && l.trim() === 'fi');
  if (start === NOT_FOUND || end === NOT_FOUND) out.push('no se encontró el bloque que genera frontend/.env');
  else {
    const block = lines.slice(start, end + 1);
    block.filter((l) => hasRef(l, v) || FORBIDDEN_IN_ENV_BLOCK.some((w) => l.includes(w))).forEach((l) => out.push(`(a) el bloque de frontend/.env menciona la clave: ${l.trim()}`));
  }
  lines.forEach((line) => {
    // frontend/.env como destino en cualquier parte del script, con la variable o la clave
    if (line.includes('frontend/.env') && (hasRef(line, v) || FORBIDDEN_IN_ENV_BLOCK.some((w) => line.includes(w)))) out.push(`(a) escribe la clave en frontend/.env: ${line.trim()}`);
    commands(line).forEach((cmd) => {
      if (!hasRef(cmd, v)) return;
      const clean = SAFE_REDIRECTS.reduce((acc, s) => acc.replaceAll(s, ' '), cmd);
      // (b) imprimir o redirigir a un archivo
      if (words(clean).some((w) => PRINTERS.includes(w)) || clean.includes('>') || clean.includes('<<<')) out.push(`(b) imprime o escribe la variable: ${cmd.trim()}`);
    });
    // (c) exportar
    if (words(line).includes('export') && (hasRef(line, v) || words(line).some((w) => w === v || w.startsWith(`${v}=`)))) out.push(`(c) exporta la variable: ${line.trim()}`);
  });
  const assigned = lines.findIndex((l) => l.trimStart().startsWith(`${v}=`));
  const unsetAt = lines.findIndex((l, i) => i > assigned && words(l).includes('unset') && words(l).includes(v));
  if (unsetAt === NOT_FOUND) out.push(`(c) falta «unset ${v}» después de la asignación`);
  return out;
}

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

  test('ninguna service_role ni JWT secret en el frontend ni en su configuración, ni variables PUBLIC_* con ellas (T-150 la usa solo en el script, ver abajo)', () => {
    const files = [...SOURCES, join(FRONTEND, 'astro.config.mjs'), join(FRONTEND, '.env.example'), join(FRONTEND, 'package.json')];
    const bad = files.filter((f) => /service[_-]?role|SERVICE_ROLE|JWT_SECRET|jwt_secret/i.test(read(f))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
    expect(bad).toEqual([]);
    const publicSecrets = [...SOURCES, join(FRONTEND, '.env.example')].filter((f) => /PUBLIC_\w*(SERVICE|SECRET)/i.test(read(f))).map(rel);
    expect(publicSecrets).toEqual([]);
  });

  test('review-up.sh (T-150): la service_role solo viaja al proceso hijo; nunca se escribe, se imprime ni se exporta, y se hace unset', () => {
    expect(reviewScriptViolations(read(REVIEW_SCRIPT))).toEqual([]);
  });

  describe('la regla de review-up.sh detecta los usos prohibidos (casos negativos sobre copias del script)', () => {
    const real = read(REVIEW_SCRIPT);
    const BEFORE_UNSET = 'unset st anon';
    const withLine = (line: string): string => real.replace(BEFORE_UNSET, `${line}\n  ${BEFORE_UNSET}`);

    test('el script real está limpio y la regla ve la variable que contiene la clave', () => {
      expect(secretVariable(real)).toBe('sr');
      expect(real).toContain(BEFORE_UNSET);
    });

    test.each([
      ['escribe la service_role en frontend/.env con printf', `printf 'SUPABASE_SERVICE_ROLE_KEY=%s\\n' "$sr" >>frontend/.env`],
      ['escribe la service_role en frontend/.env con echo y ${}', 'echo "SUPABASE_SERVICE_ROLE_KEY=${sr}" >> frontend/.env'],
      ['la añade a frontend/.env con tee', 'echo "$sr" | tee -a frontend/.env'],
      ['escribe la clave secreta de Supabase en el bloque de .env', 'echo "SUPABASE_SECRET_KEY=abc" >> frontend/.env'],
    ])('falla si el script %s', (_name, line) => {
      expect(reviewScriptViolations(withLine(line)).length).toBeGreaterThan(0);
    });

    test('falla si imprime la clave (echo, printf o cat)', () => {
      ['echo "$sr"', 'printf "%s" "$sr"', 'cat <<< "$sr"'].forEach((line) => expect(reviewScriptViolations(`${real}\n${line}\n`).length, line).toBeGreaterThan(0));
    });

    test('falla si la exporta o si no hace unset', () => {
      expect(reviewScriptViolations(real.replace('sr="$(', 'export sr="$(')).length).toBeGreaterThan(0);
      expect(reviewScriptViolations(`${real}\nexport sr\n`).length).toBeGreaterThan(0);
      expect(reviewScriptViolations(real.replace('unset sr', ': ')).length).toBeGreaterThan(0);
    });

    test('los comentarios que la nombran no cuentan; el código sí', () => {
      expect(reviewScriptViolations(`${real}\n# printf "%s" "$sr" >> frontend/.env  (comentario)\n`)).toEqual([]);
    });
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
