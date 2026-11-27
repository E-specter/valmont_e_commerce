import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import config from '../../astro.config.mjs';
import { FRONTEND, read } from '../helpers/css';

// T-116 · esquema de entorno (STATUS §3.2), fuentes (D-042, BRIEF §3) y activos de marca.
type Field = { type: string; context: string; access: string; default?: string };
type Font = { name: string; cssVariable: string; weights: (string | number)[]; styles?: string[]; subsets?: string[]; fallbacks?: string[] };
const cfg = config as unknown as { env?: { schema?: Record<string, Field> }; fonts?: Font[] };

describe('env.schema (astro.config.mjs)', () => {
  const schema = cfg.env?.schema ?? {};

  test('exactamente las tres variables de servidor, todas secretas y ninguna PUBLIC_*', () => {
    expect(Object.keys(schema).sort()).toEqual(['API_BASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_URL']);
    for (const [name, f] of Object.entries(schema)) {
      expect(f.context, name).toBe('server');
      expect(f.access, name).toBe('secret');
    }
  });

  test('valores por defecto: API y Supabase locales; la clave anónima NO tiene valor por defecto', () => {
    expect(schema.API_BASE_URL.default).toBe('http://127.0.0.1:8000');
    expect(schema.SUPABASE_URL.default).toBe('http://127.0.0.1:54321');
    expect(schema.SUPABASE_ANON_KEY.default).toBeUndefined();
  });

  test('.env.example: los tres nombres y ningún valor', () => {
    const lines = read('.env.example')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.sort()).toEqual(['API_BASE_URL=', 'SUPABASE_ANON_KEY=', 'SUPABASE_URL=']);
  });

  test('sin PUBLIC_ en el código ni en la configuración', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const hits = [...walk(join(FRONTEND, 'src')), join(FRONTEND, 'astro.config.mjs')].filter((f) =>
      /PUBLIC_[A-Z]/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  test('.env no versionado y sin claves en el repo (patrón de la puerta de secretos)', () => {
    const ignore = readFileSync(join(FRONTEND, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.env$/m);
  });
});

describe('fuentes (D-042: API de fuentes de Astro, proveedor Google, alojadas en el sitio)', () => {
  const fonts = cfg.fonts ?? [];
  const byName = (n: string): Font | undefined => fonts.find((f) => f.name === n);

  test('exactamente cuatro familias', () => {
    expect(fonts.map((f) => f.name).sort()).toEqual(['Geist', 'Jaro', 'Phudu', 'Staatliches']);
  });

  test.each([
    ['Jaro', '--f-jaro', '400'],
    ['Phudu', '--f-phudu', '600 700'],
    ['Staatliches', '--f-staatliches', '400'],
    ['Geist', '--f-geist', '400 700'],
  ])('%s: cssVariable %s y pesos "%s"', (name, cssVariable, weights) => {
    const f = byName(name)!;
    expect(f.cssVariable).toBe(cssVariable);
    expect(f.weights.map(String)).toEqual([weights]);
  });

  test('subconjunto latin, estilo normal y fallback con familia genérica', () => {
    for (const f of fonts) {
      expect(f.subsets, f.name).toEqual(['latin']);
      expect(f.styles ?? ['normal'], f.name).toEqual(['normal']);
      expect(f.fallbacks?.some((x) => ['sans-serif', 'serif', 'system-ui'].includes(x)), f.name).toBe(true);
    }
  });

  test('ninguna referencia a Google en CSS, layouts ni páginas (el navegador no contacta a terceros)', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const hits = walk(join(FRONTEND, 'src'))
      .filter((f) => /\.(astro|css|ts)$/.test(f))
      .filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  test('BaseLayout emite el componente <Font> de las cuatro familias', () => {
    const base = read('src/layouts/BaseLayout.astro');
    for (const v of ['--f-jaro', '--f-phudu', '--f-staatliches', '--f-geist']) expect(base, v).toContain(`cssVariable="${v}"`);
  });
});

describe('activos de marca', () => {
  test.each(['public/brand/symbol.svg', 'public/favicon.svg'])('%s existe, es SVG y es inerte', (rel) => {
    const p = join(FRONTEND, rel);
    expect(existsSync(p), `${rel} no existe`).toBe(true);
    const svg = readFileSync(p, 'utf8');
    expect(svg).toMatch(/<svg[\s>]/);
    // Sin scripts, manejadores, objetos externos ni referencias remotas.
    expect(svg).not.toMatch(/<script|<foreignObject|\son\w+\s*=|javascript:/i);
    expect(svg).not.toMatch(/(href|src)\s*=\s*["']\s*https?:/i);
  });
});
