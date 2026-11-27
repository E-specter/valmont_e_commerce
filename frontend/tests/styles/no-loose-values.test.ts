import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND, read } from '../helpers/css';

// T-116 · RT-1: solo variables de tokens.css; cero `#hex`, `px` de tipografía ni `font-family` sueltos;
// el <style> de cada componente va dentro de `@layer components`.
const SRC = join(FRONTEND, 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(SRC).filter((f) => /\.(astro|css)$/.test(f));
const nonTokens = files.filter((f) => f !== TOKENS);
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');

/** Líneas `archivo:n: texto` de los archivos que casan con `re`. */
function offenders(list: string[], re: RegExp): string[] {
  return list.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, i) => (re.test(line) ? [`${rel(f)}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe('RT-1 · valores sueltos', () => {
  test('hay archivos que revisar (la prueba no es vacía)', () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain(TOKENS);
  });

  test('colores hexadecimales: solo tokens.css (criterio de aceptación, mismo patrón que el grep)', () => {
    expect(offenders(nonTokens, /#[0-9A-Fa-f]{3,8}\b/)).toEqual([]);
    expect(offenders([TOKENS], /#[0-9A-Fa-f]{6}\b/).length).toBeGreaterThanOrEqual(14);
  });

  test('colores sueltos con rgb()/hsl()/oklch() o nombres CSS fuera de tokens.css', () => {
    expect(offenders(nonTokens, /\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/)).toEqual([]);
  });

  test('font-family solo con var(...) o inherit (nunca un nombre de familia literal)', () => {
    expect(offenders(nonTokens, /font-family\s*:\s*(?!var\(|inherit\b)\S/)).toEqual([]);
  });

  test('font-size sin px sueltos', () => {
    expect(offenders(nonTokens, /font-size\s*:[^;]*\d\s*px/)).toEqual([]);
  });

  test('sin tamaños de tipografía en rem/em/pt sueltos (tamaños de tokens.css)', () => {
    expect(offenders(nonTokens, /font-size\s*:\s*[\d.]+(rem|em|pt)\b/)).toEqual([]);
  });

  test('sin estilos en línea con color, fuente o tamaño en .astro', () => {
    expect(offenders(nonTokens.filter((f) => f.endsWith('.astro')), /style=["'{][^>]*(color|font-|background)[^>]*(#|rgb|px)/)).toEqual([]);
  });
});

describe('RT-1 · <style> de componentes dentro de @layer components', () => {
  const components = nonTokens.filter(
    (f) => f.endsWith('.astro') && /[\\/](layouts|components)[\\/]/.test(f),
  );

  test.each(components.map((f) => [rel(f), f]))('%s', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1].trim());
    // Cada bloque <style> empieza por @layer components (o declara solo @layer en su interior).
    expect(styles.filter((s) => !/^@layer\s+components\s*\{/.test(s))).toEqual([]);
  });
});

describe('global.css · orden de capas y base (RT-4, RT-1)', () => {
  const css = read('src/styles/global.css');

  test('primera regla: @layer reset, tokens, base, components, utilities;', () => {
    const first = css.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(';')[0].replace(/\s+/g, ' ');
    expect(first).toBe('@layer reset, tokens, base, components, utilities');
  });

  test.each([
    ['.sr-only', /\.sr-only\b/],
    ['[hidden]', /\[hidden\]/],
    [':focus-visible con --focus-ring', /:focus-visible[^{]*\{[^}]*var\(--focus-ring\)/],
    ['prefers-reduced-motion: reduce', /@media\s*\(prefers-reduced-motion:\s*reduce\)/],
    ['box-sizing', /box-sizing\s*:\s*border-box/],
    ['tipografía base con --font-ui', /font-family\s*:\s*var\(--font-ui\)/],
  ])('contiene %s', (_n, re) => {
    expect(css).toMatch(re);
  });

  test('importa tokens.css (los tokens llegan a todas las páginas)', () => {
    expect(css).toMatch(/tokens\.css/);
  });
});
