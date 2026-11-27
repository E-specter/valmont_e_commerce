import { describe, expect, test } from 'vitest';
import { contextBlockCount, contextProperties, contrast, customProperties, over, parseColor, read, resolveVar, toPx } from '../helpers/css';

// T-142 · contrato 3.5 (STATUS ui §10.5): tokens nuevos de `:root`, bloque `[data-context="backoffice"]` (solo reasigna roles),
// contraste de los pares de VIEWS §12.7 calculado sobre los tokens declarados y valores de la tienda intactos.
const css = read('src/styles/tokens.css');
const store = customProperties(css); // `:root` y `.on-dark`: la tienda (sin los bloques de contexto)
const bo = contextProperties(css, 'backoffice');
const merged = new Map([...store, ...bo]); // lo que ve un elemento dentro del contexto
const inStore = (name: string): string => resolveVar(store, name);
const inBo = (name: string): string => resolveVar(merged, name);
const colorIn = (name: string) => parseColor(inBo(name));
const colorOf = (value: string) => parseColor(value);
const norm = (v: string): string => v.toLowerCase().replace(/\b0\./g, '.').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();

const ONE = 1;
const DECIMALS = 1;
const MIN_TEXT = 4.5;
const MIN_NON_TEXT = 3;

describe('3.5 · tokens nuevos (valores literales en :root)', () => {
  const literal: Record<string, string> = {
    '--color-forest-card': '#002c18',
    '--text-secondary-on-dark': '#ebd394',
    '--stroke-control-on-dark': 'rgb(179 239 178 / 0.5)',
    '--stroke-soft-on-dark': 'rgb(179 239 178 / 0.2)',
    '--size-sidebar': '260px',
    '--size-topbar': '72px',
    '--size-control-sm': '40px',
    '--size-control': '44px',
    '--size-th': '44px',
    '--size-row': '56px',
    '--size-row-lg': '80px',
    '--size-pill': '24px',
    '--content-max-bo': '1180px',
    '--radius-dialog': '12px',
  };

  test.each(Object.entries(literal))('%s = %s', (name, expected) => {
    expect(store.has(name), `${name} sin declarar en :root`).toBe(true);
    expect(norm(inStore(name))).toBe(norm(expected));
  });

  test('--bg-surface-raised es el verde medio (var(--color-forest-mid))', () => {
    expect(store.get('--bg-surface-raised')).toBe('var(--color-forest-mid)');
    expect(inStore('--bg-surface-raised')).toBe(inStore('--color-forest-mid'));
  });

  test('--radius-dialog (12px) no pisa --radius-lg (16px) de la tienda', () => {
    expect(toPx(inStore('--radius-lg'))).toBe(16);
    expect(toPx(inStore('--radius-dialog'))).toBe(12);
  });

  test('los tokens nuevos se declaran en la tienda (:root), no solo en el contexto: los componentes los usan igual en cualquier contexto', () => {
    [...Object.keys(literal), '--bg-surface-raised'].forEach((name) => expect(bo.has(name), `${name} en el bloque de contexto`).toBe(false));
  });

  test('el ancho útil del contenido: 1180 menos 2 × 32 de relleno = 1116', () => {
    expect(toPx(inStore('--content-max-bo')) - 2 * toPx(inStore('--space-32'))).toBe(1116);
  });
});

describe('3.5 · bloque [data-context="backoffice"]', () => {
  const ROLES = {
    '--bg-page': 'var(--color-forest)',
    '--bg-surface': 'var(--color-forest-card)',
    '--text-primary': 'var(--color-ivory)',
    '--text-secondary': 'var(--text-secondary-on-dark)',
    '--stroke-default': 'var(--stroke-on-dark)',
    '--stroke-soft': 'var(--stroke-soft-on-dark)',
    '--stroke-control': 'var(--stroke-control-on-dark)',
    '--stroke-strong': 'var(--color-mint)',
    '--focus-color': 'var(--color-yellow)',
    '--color-red-strong': 'var(--color-red)',
  } as const;

  test('hay exactamente un bloque con ese selector', () => {
    expect(contextBlockCount(css, 'backoffice')).toBe(ONE);
  });

  test.each(Object.entries(ROLES))('reasigna %s = %s', (name, expected) => {
    expect(bo.get(name)).toBe(expected);
  });

  // `--focus-ring` es un token compuesto (`2px solid var(--focus-color)`): se resuelve donde se declara, así que hay que recomponerlo en el contexto.
  const COMPOSED = { '--focus-ring': '2px solid var(--focus-color)' } as const;

  test('reasigna solo esos 10 roles más los tokens compuestos que dependen de ellos (lista cerrada)', () => {
    expect([...bo.keys()].sort()).toEqual([...Object.keys(ROLES), ...Object.keys(COMPOSED)].sort());
  });

  test.each(Object.entries(COMPOSED))('recompone %s = %s', (name, expected) => {
    expect(norm(bo.get(name) ?? '')).toBe(norm(expected));
  });

  // Genérico: ningún token de :root que dependa (directa o transitivamente) de un rol reasignado puede quedarse con el valor de :root.
  const dependsOn = (name: string, targets: Set<string>, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const refs = [...(store.get(name) ?? '').matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]); // "2px solid var(--focus-color)" → ["--focus-color"]
    return refs.some((r) => targets.has(r) || dependsOn(r, targets, seen));
  };

  test('ningún token compuesto de :root que dependa de un rol reasignado se queda sin redeclarar en el bloque de contexto', () => {
    const reassigned = new Set(Object.keys(ROLES));
    const stale = [...store.keys()].filter((n) => !reassigned.has(n) && !bo.has(n) && dependsOn(n, reassigned));
    expect(stale).toEqual([]);
  });

  test('regresión: el anillo de foco del contexto es amarillo y supera 3:1 sobre todos los fondos oscuros (no tinta a 1,1:1)', () => {
    const ringColor = parseColor(inBo('--focus-ring').split(' ').pop() ?? '');
    expect(ringColor).toEqual(parseColor('#ffd900'));
    ['--bg-page', '--bg-surface', '--bg-surface-dark', '--bg-surface-raised'].forEach((bg) =>
      expect(contrast(ringColor, colorIn(bg)), bg).toBeGreaterThanOrEqual(MIN_NON_TEXT),
    );
    const ink = parseColor('#0f0f0f');
    expect(contrast(ink, colorIn('--bg-page'))).toBeLessThan(MIN_NON_TEXT); // la tinta fallaría: la prueba no es vacía
  });

  test('el anillo de foco de la tienda no cambia: 2px solid tinta en :root', () => {
    expect(norm(store.get('--focus-ring') ?? '')).toBe(norm('2px solid var(--focus-color)'));
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/:root\s*\{[^}]*--focus-color:\s*var\(--color-ink\)/);
    expect(bo.get('--focus-ring')).toBeDefined();
    expect(contextProperties(css, 'store').size).toBe(0);
  });

  test('declara color-scheme: dark', () => {
    const block = /\[data-context\s*=\s*['"]backoffice['"]\]\s*\{([^{}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
    expect(block).toMatch(/color-scheme\s*:\s*dark\s*;/);
  });

  test('sin literales de color ni !important dentro del bloque (solo var() de tokens; RT-1)', () => {
    const block = /\[data-context\s*=\s*['"]backoffice['"]\]\s*\{([^{}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|!important/i);
  });

  test('el bloque va después de :root: a igual especificidad (ambos sobre <html>) gana el contexto', () => {
    expect(css.indexOf('data-context')).toBeGreaterThan(css.indexOf(':root {'));
  });

  test('los roles de fondo y texto cambian de verdad (marfil sobre verde, no marfil sobre marfil)', () => {
    expect(inBo('--bg-page')).toBe(inStore('--color-forest'));
    expect(inBo('--text-primary')).toBe(inStore('--color-ivory'));
    expect(contrast(colorIn('--text-primary'), colorIn('--bg-page'))).toBeGreaterThan(MIN_TEXT);
  });
});

describe('3.5 · la tienda queda idéntica (valores de :root y de los roles fuera del contexto)', () => {
  const STORE: Record<string, string> = {
    '--bg-page': '#fffde4',
    '--bg-inverse': '#002312',
    '--bg-surface': '#ffffff',
    '--bg-surface-dark': '#001a0b', // el BRIEF §14 lo llama igual al #002C18; se resolvió con nombres nuevos y este NO cambia
    '--text-primary': '#0f0f0f',
    '--text-secondary': '#5b645d',
    '--text-on-dark': '#fffde4',
    '--color-red-strong': '#b3261e',
    '--stroke-strong': '#002312',
    '--color-forest': '#002312',
    '--color-forest-deep': '#001a0b',
    '--color-forest-mid': '#003e1f',
    '--color-mint': '#b3efb2',
    '--color-yellow': '#ffd900',
    '--color-ivory': '#fffde4',
    '--color-red': '#ff4d4d',
  };

  test.each(Object.entries(STORE))('%s sigue en %s', (name, hex) => {
    expect(colorOf(inStore(name))).toEqual(parseColor(hex));
  });

  test.each([
    ['--stroke-default', 'rgb(0 35 18 / 0.33)'],
    ['--stroke-soft', 'rgb(0 35 18 / 0.2)'],
    ['--stroke-control', 'rgb(0 35 18 / 0.6)'],
    ['--stroke-on-dark', 'rgb(179 239 178 / 0.33)'],
  ])('%s sigue en %s', (name, expected) => {
    expect(colorOf(inStore(name))).toEqual(parseColor(expected));
  });

  test('--bg-surface-dark (sidebar, barra superior, cabecera de tabla) es forest-deep, no el verde de tarjeta', () => {
    expect(inStore('--bg-surface-dark')).toBe(inStore('--color-forest-deep'));
    expect(colorOf(inStore('--bg-surface-dark'))).not.toEqual(colorOf(inStore('--color-forest-card')));
    expect(bo.has('--bg-surface-dark')).toBe(false);
  });

  test('la clase .on-dark conserva el foco amarillo (lo usan las superficies oscuras de la tienda)', () => {
    // El mapa guarda la última declaración (.on-dark); `:root` sigue declarando ink.
    expect(css).toMatch(/--focus-color:\s*var\(--color-ink\)\s*;/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/\.on-dark\s*\{\s*--focus-color\s*:\s*var\(--color-yellow\)\s*;\s*\}/);
  });
});

describe('contraste de VIEWS §12.7 (WCAG 2.2 AA) con los tokens declarados, dentro del contexto', () => {
  // [texto, fondo, ratio medido en §12.7]
  const TEXT: [string, string, number][] = [
    ['--text-primary', '--bg-surface', 14.87], // marfil / tarjeta
    ['--text-primary', '--bg-page', 16.35], // marfil / fondo
    ['--color-mint', '--bg-page', 12.73],
    ['--color-mint', '--bg-surface', 11.58],
    ['--color-mint', '--bg-surface-dark', 13.8], // menta / cabecera de tabla
    ['--text-secondary', '--bg-surface', 10.4], // gris dorado / tarjeta
    ['--color-yellow', '--bg-surface', 11.05],
    ['--color-ink', '--color-yellow', 13.85],
    ['--color-ink', '--color-mint', 14.52],
    ['--color-ink', '--color-ivory', 18.64],
    ['--color-ivory', '--color-plum', 6.05], // pill «Cancelado»
    ['--color-mint', '--bg-surface-raised', 9.31],
    ['--color-yellow', '--bg-surface-raised', 8.88],
    ['--color-red-strong', '--bg-surface', 4.67], // texto de error: rojo claro sobre tarjeta
    ['--color-red-strong', '--bg-page', 5.14],
    ['--color-yellow', '--bg-page', 12.15], // foco
  ];

  test.each(TEXT)('%s sobre %s ≈ %s:1 (y ≥ 4,5)', (fg, bg, expected) => {
    const ratio = contrast(colorIn(fg), colorIn(bg));
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT);
    expect(ratio).toBeCloseTo(expected, DECIMALS);
  });

  // Los pares que se usan en el marco (AdminLayout) sin cifra en §12.7: deben cumplir AA igualmente.
  test.each([
    ['--text-primary', '--bg-surface-dark'], // texto del sidebar y de la barra superior
    ['--text-secondary', '--bg-surface-dark'], // «Pronto» y módulos deshabilitados sobre el sidebar
    ['--text-secondary', '--bg-page'],
    ['--text-primary', '--bg-surface-raised'], // nav activo
    ['--color-mint', '--bg-surface-dark'], // «Ver tienda»
  ])('par del marco %s sobre %s ≥ 4,5', (fg, bg) => {
    expect(contrast(colorIn(fg), colorIn(bg))).toBeGreaterThanOrEqual(MIN_TEXT);
  });

  test('borde de control (menta al 50 %) ≥ 3:1 y entre 4,00 y 4,30 sobre tarjeta, fondo y forest-deep (WCAG 1.4.11)', () => {
    ['--bg-surface', '--bg-page', '--bg-surface-dark'].forEach((bgName) => {
      const bg = colorIn(bgName);
      const flat = over(colorIn('--stroke-control'), bg);
      const ratio = contrast(flat, bg);
      expect(ratio, bgName).toBeGreaterThanOrEqual(MIN_NON_TEXT);
      expect(ratio, bgName).toBeGreaterThanOrEqual(3.95);
      expect(ratio, bgName).toBeLessThanOrEqual(4.35);
    });
  });

  test('los bordes decorativos (33 % y 20 %) NO sirven de límite de control: quedan bajo 3:1', () => {
    const bg = colorIn('--bg-surface');
    expect(contrast(over(colorIn('--stroke-default'), bg), bg)).toBeLessThan(MIN_NON_TEXT);
    expect(contrast(over(colorIn('--stroke-soft'), bg), bg)).toBeLessThan(MIN_NON_TEXT);
  });

  test('el foco amarillo supera 3:1 sobre todos los fondos del marco', () => {
    ['--bg-page', '--bg-surface', '--bg-surface-dark', '--bg-surface-raised'].forEach((bg) =>
      expect(contrast(colorIn('--focus-color'), colorIn(bg)), bg).toBeGreaterThanOrEqual(MIN_NON_TEXT),
    );
  });

  test('la comprobación no es vacía: el rojo de la tienda (#B3261E) sobre la tarjeta oscura NO llegaría a AA', () => {
    const storeRed = colorOf(inStore('--color-red-strong'));
    expect(contrast(storeRed, colorIn('--bg-surface'))).toBeLessThan(MIN_TEXT);
  });
});
