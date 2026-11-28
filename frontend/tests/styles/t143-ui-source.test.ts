import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { customProperties, FRONTEND } from '../helpers/css';

// T-143 · reglas de código sobre lo entregado: RT-B5 (sin valores sueltos; la prueba general está en no-loose-values),
// RT-B6 (capas), RT-B9 (sin set:html), RT-B10 (movimiento reducido, foco) y la AUDITORÍA DE ROLES de `ui/`.
// Acepta un bloque `<style>…</style>` con su contenido ("<style>a{}</style>"); rechaza una etiqueta sin cierre ("<style>a{}").
// https://regex101.com/?regex=%3Cstyle%5B%5E%3E%5D%2A%3E%28%5B%5Cs%5CS%5D%2A%3F%29%3C%5C%2Fstyle%3E&flags=g
const STYLE_BLOCKS = /<style[^>]*>([\s\S]*?)<\/style>/g;
// Acepta el nombre de la variable en `var(--space-8)` → "--space-8"; rechaza una declaración "--space-8: 8px".
// https://regex101.com/?regex=var%5C%28%28--%5B%5Cw-%5D%2B%29&flags=g
const VAR_USE = /var\((--[\w-]+)/g;
// Acepta una declaración "--pill-bg: red" → "--pill-bg"; rechaza un uso "var(--pill-bg)".
// https://regex101.com/?regex=%28--%5B%5Cw-%5D%2B%29%5Cs%2A%3A&flags=g
const VAR_DECL = /(--[\w-]+)\s*:/g;
// Acepta "#FFD900" y "#fff"; rechaza "#id-de-ancla-largo" (letras fuera de a-f).
// https://regex101.com/?regex=%23%5B0-9A-Fa-f%5D%7B3%2C8%7D%5Cb&flags=g
const HEX_COLOR = /#[0-9A-Fa-f]{3,8}\b/;
// Acepta "rgb(0 0 0)" y "color-mix(in srgb)"; rechaza "var(--rgb-x)".
// https://regex101.com/?regex=%5Cb%28rgba%3F%7Chsla%3F%7Coklch%7Ccolor-mix%29%5C%28&flags=g
const COLOR_FN = /\b(rgba?|hsla?|oklch|color-mix)\(/;
// Acepta "font-size: 14px"; rechaza "font-size: var(--text-caption)".
// https://regex101.com/?regex=font-size%5Cs%2A%3A%5B%5E%3B%5D%2A%5Cd%5Cs%2Apx&flags=g
const FONT_PX = /font-size\s*:[^;]*\d\s*px/;
// Acepta "font-family: Arial"; rechaza "font-family: var(--font-ui)" e "inherit".
// https://regex101.com/?regex=font-family%5Cs%2A%3A%5Cs%2A%28%3F%21var%5C%28%7Cinherit%5Cb%29%5CS&flags=g
const FONT_FAMILY_LITERAL = /font-family\s*:\s*(?!var\(|inherit\b)\S/;
// Acepta "overflow-x: auto"; rechaza "overflow: hidden".
// https://regex101.com/?regex=overflow%28-x%29%3F%5Cs%2A%3A%5Cs%2A%28auto%7Cscroll%29&flags=g
const OVERFLOW_SCROLL = /overflow(-x)?\s*:\s*(auto|scroll)/;
// Acepta "transition: color 1s"; rechaza "transition-duration: 1s" y "animation-name".
// https://regex101.com/?regex=%5Cb%28animation%7Ctransition%29%5Cs%2A%3A&flags=g
const ANIMATES = /\b(animation|transition)\s*:/;
// Acepta "outline: none" y "outline: 0"; rechaza "outline: var(--focus-ring)".
// https://regex101.com/?regex=outline%5Cs%2A%3A%5Cs%2A%28none%7C0%29%5Cb&flags=g
const OUTLINE_OFF = /outline\s*:\s*(none|0)\b/;
const SRC = join(FRONTEND, 'src');
const BEFORE = join(FRONTEND, 'tests/helpers/fixtures/before-t143');
const NONE = 0;
const ONE = 1;
const CONTRACT_COUNT = 15;
const NEWLINE = '\n';
const NEW_COMPONENTS = [
  'src/components/ui/StatusPill.astro',
  'src/components/ui/DataTable.astro',
  'src/components/ui/Timeline.astro',
  'src/components/ui/ConfirmDialog.astro',
  'src/components/admin/KpiCard.astro',
];
const ISLANDS = ['src/islands/confirm-dialog.ts', 'src/islands/form-busy.ts'];
const read = (rel: string): string => readFileSync(join(FRONTEND, rel), 'utf8');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');
const css = (src: string): string => [...src.matchAll(STYLE_BLOCKS)].map((m) => m[1]).join(NEWLINE);
const varsUsed = (src: string): string[] => [...new Set([...src.matchAll(VAR_USE)].map((m) => m[1]))];
const varsDeclared = (src: string): string[] => [...src.matchAll(VAR_DECL)].map((m) => m[1]);
/** Pares `archivo → tokens --color-*` usados con `var()`. */
// Lo declarado bajo `:global([data-context=...])` es el re-tematizado del backoffice (lo que la auditoría busca): no cuenta como color directo de la tienda.
const BACKOFFICE_MARK = ':global([data-context';
const storeOnly = (source: string): string => {
  const start = source.indexOf(BACKOFFICE_MARK);
  if (start === -ONE) return source;
  const close = source.indexOf('}', source.indexOf('{', start));
  return storeOnly(source.slice(NONE, start) + source.slice(close + ONE));
};
const colorTokens = (src: string): string[] => [...new Set(varsUsed(storeOnly(css(src))).filter((v) => v.startsWith('--color-')))].sort();

// Tokens de STATUS §10.5 (3.5): los declara T-142 en tokens.css. T-143 puede usarlos aunque su rama aún no los traiga.
const CONTRACT_TOKENS = [
  '--color-forest-card', '--text-secondary-on-dark', '--bg-surface-raised', '--stroke-control-on-dark', '--stroke-soft-on-dark',
  '--size-sidebar', '--size-topbar', '--size-control-sm', '--size-control', '--size-th', '--size-row', '--size-row-lg',
  '--size-pill', '--content-max-bo', '--radius-dialog',
];

describe('RT-B5/RT-B6 · los archivos nuevos existen, usan @layer components y no tocan lib/server', () => {
  test.each([...NEW_COMPONENTS, ...ISLANDS])('%s existe', (f) => {
    expect(() => read(f)).not.toThrow();
  });

  test.each(NEW_COMPONENTS)('%s: cada <style> empieza por @layer components', (f) => {
    const blocks = [...read(f).matchAll(STYLE_BLOCKS)].map((m) => m[1].trim());
    expect(blocks.length).toBeGreaterThan(NONE);
    expect(blocks.filter((b) => !b.startsWith('@layer components'))).toEqual([]);
  });

  test('`components/**` e islas no importan de lib/server (grep vacío)', () => {
    const files = [...walk(join(SRC, 'components')), ...walk(join(SRC, 'islands'))];
    const offenders = files.filter((f) => (f.endsWith('.astro') || f.endsWith('.ts')) && readFileSync(f, 'utf8').includes('lib/server')).map(rel);
    expect(offenders).toEqual([]);
  });

  test('las islas no llaman a la API ni leen secretos: sin fetch, XMLHttpRequest, Authorization ni API_BASE_URL', () => {
    ISLANDS.forEach((f) => {
      const src = read(f);
      ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'Authorization', 'API_BASE_URL', 'localStorage', 'sessionStorage'].forEach((w) => expect(src, `${f}: ${w}`).not.toContain(w));
    });
  });

  test('sin colores ni tipografía sueltos en lo nuevo (#hex, rgb(), color-mix, px de fuente, font-family literal)', () => {
    NEW_COMPONENTS.forEach((f) => {
      const style = css(read(f));
      expect(style, f).not.toMatch(HEX_COLOR);
      expect(style, f).not.toMatch(COLOR_FN);
      expect(style, f).not.toMatch(FONT_PX);
      expect(style, f).not.toMatch(FONT_FAMILY_LITERAL);
    });
  });
});

describe('RT-B9 · texto del servidor como texto: sin set:html ni innerHTML', () => {
  test.each([...NEW_COMPONENTS, ...ISLANDS, 'src/components/ui/Button.astro', 'src/components/ui/Notice.astro'])('%s', (f) => {
    const src = read(f);
    ['set:html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'dangerouslySetInnerHTML', 'document.write'].forEach((w) => expect(src, `${f}: ${w}`).not.toContain(w));
  });
});

describe('RT-B10 · movimiento reducido y foco', () => {
  test.each(NEW_COMPONENTS)('%s: si anima, respeta prefers-reduced-motion', (f) => {
    const style = css(read(f));
    if (ANIMATES.test(style) || style.includes('@keyframes')) expect(style).toContain('prefers-reduced-motion');
  });

  test.each([...NEW_COMPONENTS, 'src/components/ui/Button.astro'])('%s: no quita el contorno de foco (outline: none/0)', (f) => {
    expect(css(read(f))).not.toMatch(OUTLINE_OFF);
  });
});

describe('tokens que usa lo nuevo: existen en tokens.css o en el contrato 3.5 de T-142', () => {
  const known = new Set([...customProperties(read('src/styles/tokens.css')).keys(), ...CONTRACT_TOKENS]);

  test.each([...NEW_COMPONENTS, 'src/components/ui/Button.astro', 'src/components/ui/Notice.astro'])('%s', (f) => {
    const style = css(read(f));
    const local = new Set(varsDeclared(style));
    const missing = varsUsed(style).filter((v) => !known.has(v) && !local.has(v));
    expect(missing, `tokens que no existen (pídelos a T-142): ${missing.join(', ')}`).toEqual([]);
  });

  test('el contrato 3.5 sigue valiendo lo mismo que el STATUS: 15 tokens', () => {
    expect(CONTRACT_TOKENS.length).toBe(CONTRACT_COUNT);
  });
});

describe('estilos de lo nuevo (criterios de aceptación)', () => {
  test('DataTable: cabecera --size-th sobre --bg-surface-dark, filas --size-row y --size-row-lg, divisor --stroke-soft, tabular-nums, desplazamiento en su región', () => {
    const style = css(read('src/components/ui/DataTable.astro'));
    ['--size-th', '--bg-surface-dark', '--size-row', '--size-row-lg', '--stroke-soft', 'tabular-nums'].forEach((t) => expect(style, t).toContain(t));
    expect(style).toMatch(OVERFLOW_SCROLL);
  });

  test('StatusPill: altura --size-pill y una regla por cada uno de los 7 tonos', () => {
    const style = css(read('src/components/ui/StatusPill.astro'));
    expect(style).toContain('--size-pill');
    ['pending', 'paid', 'active', 'transit', 'done', 'cancelled', 'neutral'].forEach((tone) => expect(style, `sin regla para ${tone}`).toContain(tone));
  });

  test('KpiCard: el estado pending usa borde discontinuo (no solo color)', () => {
    expect(css(read('src/components/admin/KpiCard.astro'))).toContain('dashed');
  });

  test('ConfirmDialog: radio --radius-dialog y fondo de ::backdrop', () => {
    const style = css(read('src/components/ui/ConfirmDialog.astro'));
    expect(style).toContain('--radius-dialog');
    expect(style).toContain('::backdrop');
  });
});

describe('AUDITORÍA DE ROLES · los ui/ existentes no usan más colores directos (--color-*) que en main d352052', () => {
  // Button y Notice cambian a propósito (variantes danger/ghost y contexto backoffice): los cubre el último test del bloque.
  const baseline = readdirSync(BEFORE).filter((n) => n.endsWith('.astro') && !['Button.astro', 'Notice.astro'].includes(n));

  test.each(baseline)('%s: sin nuevos --color-* respecto de main', (name) => {
    const before = new Set(colorTokens(readFileSync(join(BEFORE, name), 'utf8')));
    const now = colorTokens(read(`src/components/ui/${name}`));
    const added = now.filter((t) => !before.has(t));
    expect(added, `${name} usa colores directos nuevos: ${added.join(', ')}`).toEqual([]);
  });

  test('lo nuevo usa roles; los colores directos se limitan a la paleta que fija VIEWS §12.4 (tinta, amarillo, menta, marfil, ciruela, rojo)', () => {
    const ALLOWED = new Set(['--color-ink', '--color-yellow', '--color-mint', '--color-ivory', '--color-plum', '--color-red', '--color-red-strong', '--color-white']);
    const offenders = NEW_COMPONENTS.flatMap((f) => colorTokens(read(f)).filter((t) => !ALLOWED.has(t)).map((t) => `${f}: ${t}`));
    expect(offenders).toEqual([]);
  });

  test('Button y Notice (cambiados): sus colores directos nuevos, si los hay, son los de las variantes danger/ghost', () => {
    const ALLOWED = new Set(['--color-red', '--color-red-strong', '--color-ink', '--color-ivory', '--color-mint', '--color-forest', '--color-yellow', '--color-forest-mid', '--color-mint-soft', '--color-red-soft']);
    ['Button', 'Notice'].forEach((n) => {
      const before = new Set(colorTokens(readFileSync(join(BEFORE, `${n}.astro`), 'utf8')));
      const added = colorTokens(read(`src/components/ui/${n}.astro`)).filter((t) => !before.has(t));
      expect(added.filter((t) => !ALLOWED.has(t))).toEqual([]);
    });
  });
});
