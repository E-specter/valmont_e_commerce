import { describe, expect, test } from 'vitest';
import { read } from '../helpers/css';

// T-123 · reglas de código de los 6 archivos nuevos: RT-1 (solo tokens, `@layer components`), RT-2 (sin fetch),
// RT-5 (nada de `set:html`) y RN-09 (la tarjeta no calcula importes). Complementa a no-loose-values.test.ts, que recorre todo `src/`.
const FILES = [
  'src/components/ui/Breadcrumb.astro',
  'src/components/ui/Pagination.astro',
  'src/components/ui/DefinitionList.astro',
  'src/components/catalog/ProductCard.astro',
  'src/components/catalog/ProductGrid.astro',
  'src/components/catalog/spec-line.ts',
  'src/pages/dev/products.astro',
];
const STYLED = FILES.filter((f) => f.endsWith('.astro') && !f.startsWith('src/pages'));
const HEX_DIGITS = '0123456789abcdefABCDEF';
const MIN_HEX = 3;
const MAX_HEX = 8;
/** Colores `#rgb`, `#rrggbb` o `#rrggbbaa`: un `#` seguido de entre 3 y 8 dígitos hexadecimales. */
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
const styleOf = (src: string): string => src.split('<style').slice(1).join('<style');

describe('T-123 · estilos (RT-1)', () => {
  test.each(STYLED)('%s: ningún color #hex en su <style> (solo variables de tokens)', (file) => {
    expect(hexLike(styleOf(read(file)))).toEqual([]);
  });

  test.each(STYLED)('%s: sin font-family literal ni tamaños de letra en px', (file) => {
    const css = styleOf(read(file));
    css
      .split(';')
      .filter((d) => d.includes('font-family'))
      .forEach((d) => expect(d.includes('var(--font-')).toBe(true));
    css
      .split(';')
      .filter((d) => d.trim().startsWith('font-size') || d.includes('{ font-size') || d.includes('\n      font-size'))
      .forEach((d) => expect(d.includes('px')).toBe(false));
  });

  test.each(STYLED)('%s: el CSS va dentro de @layer components', (file) => {
    const css = styleOf(read(file));
    expect(css.length).toBeGreaterThan(0);
    expect(css.includes('@layer components')).toBe(true);
  });
});

describe('T-123 · seguridad y capas', () => {
  test.each(FILES)('%s: sin set:html, sin fetch ni acceso a la API', (file) => {
    const src = read(file);
    expect(src.includes('set:html')).toBe(false);
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('innerHTML')).toBe(false);
    expect(src.includes('console.')).toBe(false);
  });

  test.each(FILES)('%s: no usa toFixed ni toLocaleString sueltos (RT-7)', (file) => {
    const src = read(file);
    expect(src.includes('toFixed')).toBe(false);
    expect(src.includes('toLocaleString')).toBe(false);
    expect(src.includes('Intl.NumberFormat')).toBe(false);
  });

  test('RN-09: ProductCard no opera sobre importes: no lee .amount y los importes pasan a Price', () => {
    const src = read('src/components/catalog/ProductCard.astro');
    expect(src.includes('.amount')).toBe(false);
    expect(src.includes('formatMoney')).toBe(false);
    expect(src.includes('<Price')).toBe(true);
    expect(src.includes('<Availability')).toBe(true);
  });

  test('los componentes de T-123 no importan de lib/api salvo tipos (RT-2: solo props tipadas)', () => {
    const imports = FILES.flatMap((f) => read(f).split('\n').filter((l) => l.includes("from '") && l.includes('lib/api')).map((l) => `${f}: ${l.trim()}`));
    expect(imports.filter((l) => !l.includes('import type'))).toEqual([]);
  });

  test('sin badges inventados (D-041 P-2): ninguna cadena "Nuevo" ni "Edición limitada" en los componentes', () => {
    const src = ['src/components/catalog/ProductCard.astro', 'src/components/catalog/ProductGrid.astro'].map(read).join('\n').toLowerCase();
    expect(src.includes('edición limitada')).toBe(false);
    expect(src.includes('>nuevo<')).toBe(false);
  });

  test('/dev/products solo existe en desarrollo (404 fuera de DEV)', () => {
    const src = read('src/pages/dev/products.astro');
    expect(src.includes('import.meta.env.DEV')).toBe(true);
    expect(src.includes('404')).toBe(true);
  });
});
