import { describe, expect, test } from 'vitest';
import { read } from '../helpers/css';

// T-124 · reglas de código de los archivos nuevos del catálogo: RT-1 (solo tokens; los `select` nativos también),
// RT-2 (sin fetch en componentes), RT-5 (nada de `set:html`) y RT-7 (formatos solo por lib/format.ts).
const COMPONENTS = ['src/components/catalog/FilterBar.astro', 'src/components/catalog/ActiveFilters.astro', 'src/components/catalog/FeaturedBanner.astro'];
const PAGE = 'src/pages/relojes/index.astro';
const LIB = ['src/lib/catalog/query.ts', 'src/data/featured.ts'];
const ALL = [...COMPONENTS, PAGE, ...LIB];
const STYLED = [...COMPONENTS, PAGE];
const HEX_DIGITS = '0123456789abcdefABCDEF';
const MIN_HEX = 3;
const MAX_HEX = 8;
const styleOf = (src: string): string => src.split('<style').slice(1).join('<style');
/** Colores `#rgb`…`#rrggbbaa`: un `#` seguido de entre 3 y 8 dígitos hexadecimales. */
const hexLike = (src: string): string[] =>
  src
    .split('#')
    .slice(1)
    .map((rest) => {
      const digits = [...rest].findIndex((c) => !HEX_DIGITS.includes(c));
      return digits === -1 ? rest.length : digits;
    })
    .map((n, i, all) => (n >= MIN_HEX && n <= MAX_HEX ? `#${all[i]}` : ''))
    .filter(Boolean);
const COLOR_FUNCTIONS = ['rgb(', 'rgba(', 'hsl(', 'hsla(', 'hwb(', 'lab(', 'lch(', 'oklab(', 'oklch(', 'color('];

describe('T-124 · estilos (RT-1)', () => {
  test.each(STYLED)('%s: ningún #hex en su <style>', (file) => {
    expect(hexLike(styleOf(read(file)))).toEqual([]);
  });

  test.each(STYLED)('%s: ningún rgb(), hsl() ni otra función de color en su <style> (solo var(--token))', (file) => {
    const css = styleOf(read(file)).toLowerCase();
    expect(COLOR_FUNCTIONS.filter((fn) => css.includes(fn))).toEqual([]);
  });

  test('FilterBar: los select nativos solo usan tokens para color, fondo, borde y radio', () => {
    const css = styleOf(read('src/components/catalog/FilterBar.astro'));
    const select = css.split('\n    select {')[1]?.split('}')[0] ?? '';
    expect(select.length, 'no se encontró la regla de select').toBeGreaterThan(0);
    ['color', 'background', 'border', 'border-radius', 'font-family'].forEach((prop) => {
      const decl = select.split(';').find((d) => d.trim().startsWith(`${prop}:`));
      expect(decl, `select sin ${prop}`).toBeDefined();
      expect(decl).toContain('var(--');
    });
  });

  test.each(STYLED)('%s: sin font-family literal; el CSS va en @layer components', (file) => {
    const css = styleOf(read(file));
    css
      .split(';')
      .filter((d) => d.includes('font-family'))
      .forEach((d) => expect(d.includes('var(--font-')).toBe(true));
    expect(css.includes('@layer components')).toBe(true);
  });
});

describe('T-124 · seguridad y capas', () => {
  test.each(ALL)('%s: sin set:html, innerHTML ni console', (file) => {
    const src = read(file);
    expect(src.includes('set:html')).toBe(false);
    expect(src.includes('innerHTML')).toBe(false);
    expect(src.includes('console.')).toBe(false);
  });

  test.each([...COMPONENTS, ...LIB])('%s: sin fetch ni acceso directo a la API (RT-2)', (file) => {
    const src = read(file);
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('serverTransport')).toBe(false);
  });

  test.each(ALL)('%s: sin toFixed ni toLocaleString sueltos (RT-7)', (file) => {
    const src = read(file);
    expect(src.includes('toFixed')).toBe(false);
    expect(src.includes('toLocaleString')).toBe(false);
    expect(src.includes('Intl.NumberFormat')).toBe(false);
  });

  test('la página no declara scripts de cliente ni isla (sin JavaScript)', () => {
    const src = read(PAGE);
    expect(src.includes('<script')).toBe(false);
    expect(src.includes('client:')).toBe(false);
    COMPONENTS.forEach((c) => {
      expect(read(c).includes('<script')).toBe(false);
      expect(read(c).includes('client:')).toBe(false);
    });
  });

  test('la página es SSR (prerender = false) y no cachea errores', () => {
    const src = read(PAGE);
    expect(src.includes('export const prerender = false')).toBe(true);
    expect(src.includes('no-store')).toBe(true);
    expect(src.includes('stale-while-revalidate=60')).toBe(true);
  });

  test('la página no usa el token ni la sesión (catálogo público, sin datos por usuario)', () => {
    const src = read(PAGE);
    expect(src.includes('accessToken')).toBe(false);
    expect(src.includes('locals.session')).toBe(false);
  });

  test('query.ts no importa nada de servidor ni de la red', () => {
    const src = read('src/lib/catalog/query.ts');
    expect(src.includes('astro:env')).toBe(false);
    expect(src.includes('import.meta.env')).toBe(false);
    expect(src.includes('process.env')).toBe(false);
  });
});
