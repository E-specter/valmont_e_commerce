import { describe, expect, test } from 'vitest';
import { clampArgs, contrast, customProperties, over, parseColor, read, resolveVar, toPx } from '../helpers/css';

// T-116 · BRIEF §13 y §2 (variables), §3 (escala), §11 (contraste). Se lee `src/styles/tokens.css` tal como se entrega.
const props = customProperties(read('src/styles/tokens.css'));
const value = (name: string): string => resolveVar(props, name);
const color = (name: string) => parseColor(value(name));
// Sin mayúsculas, sin ceros a la izquierda de los decimales y con la coma pegada: compara forma, no formato.
const norm = (v: string): string =>
  v
    .toLowerCase()
    .replace(/\b0\./g, '.')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

describe('tokens.css · BRIEF §13 literales', () => {
  const literal: Record<string, string> = {
    // color §2
    '--color-ink': '#0F0F0F', '--color-forest': '#002312', '--color-forest-deep': '#001A0B',
    '--color-forest-mid': '#003E1F', '--color-mint': '#B3EFB2', '--color-mint-soft': '#D5FFD9',
    '--color-yellow': '#FFD900', '--color-ivory': '#FFFDE4', '--color-white': '#FFFFFF',
    '--color-slate': '#5B645D', '--color-red': '#FF4D4D', '--color-red-soft': '#FFF1F1',
    '--color-plum': '#7D5470', '--color-red-strong': '#B3261E',
    // espaciado §4
    '--space-4': '4px', '--space-8': '8px', '--space-12': '12px', '--space-16': '16px', '--space-24': '24px',
    '--space-32': '32px', '--space-48': '48px', '--space-64': '64px', '--space-80': '80px',
    // forma §4
    '--radius-xs': '2px', '--radius-sm': '4px', '--radius-md': '8px', '--radius-lg': '16px', '--radius-pill': '999px',
    // movimiento §5
    '--dur-state': '150ms', '--dur-appear': '250ms', '--dur-page': '400ms', '--ease': 'cubic-bezier(.2, 0, 0, 1)',
    // contenedores §6
    '--container-max': '1280px', '--gutter-desktop': '12px', '--gutter-mobile': '8px',
    // sombra §4
    '--shadow-overlay': '0 8px 24px rgb(0 18 9 / .18)',
  };

  test.each(Object.entries(literal))('%s = %s', (name, expected) => {
    expect(props.has(name), `${name} sin declarar`).toBe(true);
    expect(norm(value(name))).toBe(norm(expected));
  });
});

describe('tokens.css · roles semánticos (BRIEF §2)', () => {
  const sameColor = (name: string, hex: string): void => {
    expect(props.has(name), `${name} sin declarar`).toBe(true);
    expect(color(name)).toEqual(parseColor(hex));
  };

  test('fondos, texto y estado resuelven a la paleta', () => {
    sameColor('--bg-page', '#FFFDE4');
    sameColor('--bg-inverse', '#002312');
    sameColor('--bg-surface', '#FFFFFF');
    sameColor('--bg-surface-dark', '#001A0B');
    sameColor('--text-primary', '#0F0F0F');
    sameColor('--text-secondary', '#5B645D');
    sameColor('--text-on-dark', '#FFFDE4');
    sameColor('--text-accent', '#FFD900');
    sameColor('--state-active', '#FFD900');
    sameColor('--state-success', '#B3EFB2');
    sameColor('--state-error', '#FF4D4D');
    sameColor('--state-cancelled', '#7D5470');
    sameColor('--stroke-strong', '#002312');
  });

  test.each([
    ['--stroke-default', 'rgb(0 35 18 / .33)'],
    ['--stroke-soft', 'rgb(0 35 18 / .2)'],
    ['--stroke-control', 'rgb(0 35 18 / .6)'],
    ['--stroke-on-dark', 'rgb(179 239 178 / .33)'],
  ])('%s = %s', (name, expected) => {
    expect(props.has(name), `${name} sin declarar`).toBe(true);
    expect(color(name)).toEqual(parseColor(expected));
  });

  test('foco, sombra y margen de página existen', () => {
    for (const n of ['--focus-ring', '--shadow-overlay', '--page-margin']) expect(props.has(n), n).toBe(true);
  });
});

describe('tokens.css · familias (BRIEF §3, D-042)', () => {
  test.each([
    ['--font-brand', '--f-jaro'],
    ['--font-heading', '--f-phudu'],
    ['--font-editorial', '--f-staatliches'],
    ['--font-ui', '--f-geist'],
  ])('%s se mapea a var(%s) (la emite el componente <Font> de Astro)', (name, cssVar) => {
    expect(props.get(name)).toContain(`var(${cssVar}`);
  });
});

describe('tokens.css · escala tipográfica (BRIEF §3)', () => {
  // [Mobile, Desktop] en px
  const scale: Record<string, [number, number]> = {
    display: [54, 128], h1: [42, 60], h2: [32, 42], h3: [24, 30],
    'body-editorial': [18, 20], 'body-ui': [15, 16], caption: [12, 14],
  };

  test.each(Object.entries(scale))('--text-%s: clamp() de %s px', (key, [mobile, desktop]) => {
    const [min, , max] = clampArgs(props.get(`--text-${key}`) ?? '');
    expect(toPx(min)).toBe(mobile);
    expect(toPx(max)).toBe(desktop);
  });

  test.each(Object.keys(scale))('--leading-%s está declarado y es positivo', (key) => {
    const v = props.get(`--leading-${key}`);
    expect(v, `--leading-${key} sin declarar`).toBeDefined();
    expect(parseFloat(v!)).toBeGreaterThan(0);
  });
});

describe('tokens.css · margen de página (BRIEF §6)', () => {
  test('30 px editorial y 60 px transaccional, con clamp desde 16 px', () => {
    const margins = [...props.keys()].filter((n) => n.startsWith('--page-margin'));
    const resolved = margins.map((n) => value(n));
    expect(margins).toContain('--page-margin');
    expect(resolved.length).toBeGreaterThanOrEqual(3); // --page-margin y sus dos variantes
    expect(resolved.some((v) => /\b30px\b/.test(v))).toBe(true);
    expect(resolved.some((v) => /\b60px\b/.test(v))).toBe(true);
    expect(resolved.every((v) => v.startsWith('clamp(') && /\b16px\b/.test(v))).toBe(true);
  });
});

describe('tokens.css · contraste (BRIEF §11, WCAG 2.2 AA)', () => {
  const white = '--color-white';
  // [texto, fondo, ratio de BRIEF §11, umbral]
  const text: [string, string, number, number][] = [
    ['--color-ink', '--color-ivory', 18.64, 4.5],
    ['--color-forest', '--color-ivory', 16.35, 4.5],
    ['--color-forest-mid', '--color-ivory', 11.95, 4.5],
    ['--color-slate', '--color-ivory', 5.96, 4.5],
    ['--color-slate', white, 6.13, 4.5],
    ['--color-ivory', '--color-forest', 16.35, 4.5],
    ['--color-mint', '--color-forest', 12.73, 4.5],
    ['--color-yellow', '--color-forest', 12.15, 4.5],
    ['--color-ink', '--color-yellow', 13.85, 4.5],
    ['--color-forest', '--color-yellow', 12.15, 4.5],
    ['--color-forest', '--color-mint', 12.73, 4.5],
    ['--color-forest-mid', '--color-mint', 9.31, 4.5],
    [white, '--color-plum', 6.22, 4.5],
    ['--color-yellow', '--color-forest-mid', 8.88, 4.5],
    // el rojo de Figma solo sirve sobre fondos oscuros
    ['--color-red', '--color-forest', 5.14, 4.5],
    ['--color-red', '--color-forest-deep', 5.57, 4.5],
    // PROPUESTA de §11: texto y borde de error sobre claro
    ['--color-red-strong', '--color-ivory', 6.36, 4.5],
    ['--color-red-strong', white, 6.54, 4.5],
    ['--color-red-strong', '--color-red-soft', 5.95, 4.5],
  ];

  test.each(text)('%s sobre %s ≈ %s:1 y ≥ %s', (fg, bg, expected, threshold) => {
    const ratio = contrast(color(fg), color(bg));
    expect(ratio).toBeGreaterThanOrEqual(threshold);
    expect(ratio).toBeCloseTo(expected, 1);
  });

  test('--stroke-control cumple ≥ 3:1 como límite de control sobre blanco y marfil (WCAG 1.4.11)', () => {
    for (const bg of [white, '--color-ivory']) {
      const flat = over(color('--stroke-control'), color(bg));
      expect(contrast(flat, color(bg))).toBeGreaterThanOrEqual(3);
    }
    // sobre blanco §11 mide 4,53:1
    expect(contrast(over(color('--stroke-control'), color(white)), color(white))).toBeCloseTo(4.53, 1);
  });

  test('regresión: el borde decorativo (--stroke-default) NO sirve de límite de control', () => {
    const flat = over(color('--stroke-default'), color(white));
    expect(contrast(flat, color(white))).toBeLessThan(3);
  });

  test('los pares que fallan siguen fallando: amarillo, menta y rojo sobre marfil nunca son texto', () => {
    expect(contrast(color('--color-yellow'), color('--color-ivory'))).toBeLessThan(4.5);
    expect(contrast(color('--color-mint'), color('--color-ivory'))).toBeLessThan(3);
    expect(contrast(color('--color-red'), color('--color-ivory'))).toBeLessThan(4.5);
  });
});
