import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND, contrast, customProperties, over, parseColor, read, resolveVar } from '../helpers/css';

// T-117 · lote 1A de ui/. Pruebas de código fuente y de cálculo (no renderizan):
//  - RT-1/RT-2: reglas de estilo y de componente que el grep de T-116 no cubre (la prueba de `no-loose-values.test.ts`
//    ya recorre solo todo `src/` y, por tanto, también estos archivos nuevos; NO se ha modificado).
//  - Estados (criterio 1), reutilización de Icon, contraste de los pares usados (BRIEF §11) y página /dev/ui-a.

const UI = 'src/components/ui';
const COMPONENTS = ['Icon', 'Wordmark', 'Checkerboard', 'Button', 'IconButton', 'TextLink', 'Field', 'Checkbox'] as const;
const WITH_STYLE = COMPONENTS.filter((c) => c !== 'Icon');
const src = (name: string): string => read(`${UI}/${name}.astro`);
const compact = (s: string): string => [...s.toLowerCase()].filter((c) => c.trim() !== '').join('');
const hasAny = (source: string, options: string[]): boolean => options.some((o) => compact(source).includes(compact(o)));

const MIN_TEXT = 4.5; // WCAG 1.4.3
const MIN_NON_TEXT = 3; // WCAG 1.4.11
const EXPECTED_ICON_COUNT = 28;

const ICONS = [
  'search', 'heart', 'heart-off', 'shopping-bag', 'message-circle', 'user', 'x', 'send', 'check', 'check-circle',
  'x-circle', 'alert-triangle', 'info', 'lock', 'mail', 'eye', 'eye-off', 'clock', 'calendar', 'credit-card',
  'chevron-down', 'arrow-right', 'arrow-left', 'grid', 'list', 'menu', 'plus', 'minus',
];

describe('T-117 · archivos del paquete', () => {
  test.each([...COMPONENTS.map((c) => `${UI}/${c}.astro`), `${UI}/icons.ts`, 'src/pages/dev/ui-a.astro'])('existe %s', (file) => {
    expect(existsSync(join(FRONTEND, file)), file).toBe(true);
  });

  test('icons.ts nombra los 28 iconos de la firma (IconName)', () => {
    const source = read(`${UI}/icons.ts`);
    expect(ICONS.length).toBe(EXPECTED_ICON_COUNT);
    const missing = ICONS.filter((n) => ![`'${n}'`, `"${n}"`, `${n}:`].some((form) => source.includes(form)));
    expect(missing).toEqual([]);
  });

  test('sin dependencia de iconos nueva (BRIEF §8: SVG propios, sin lucide)', () => {
    expect(read('package.json')).not.toContain('lucide');
    expect(COMPONENTS.map(src).join('\n') + read(`${UI}/icons.ts`)).not.toContain('lucide');
  });
});

describe('T-117 · RT-2 y seguridad (RT-5): componentes sin estado y sin HTML en bruto', () => {
  test.each(COMPONENTS)('%s declara sus Props tipadas (interface/type Props)', (name) => {
    const source = src(name);
    expect(source.includes('interface Props') || source.includes('type Props')).toBe(true);
  });

  test.each(COMPONENTS)('%s no usa set:html, innerHTML ni fetch', (name) => {
    const source = src(name);
    ['set:html', 'innerHTML', 'fetch(', 'dangerouslySetInnerHTML'].forEach((banned) => expect(source, `${name}: ${banned}`).not.toContain(banned));
  });

  test.each(['Button', 'IconButton', 'TextLink', 'Field'])('%s reutiliza Icon en vez de dibujar su propio <svg>', (name) => {
    const source = src(name);
    expect(source).not.toContain('<svg');
  });

  test.each(['Button', 'IconButton', 'TextLink', 'Field'])('%s importa Icon.astro cuando muestra iconos', (name) => {
    expect(src(name)).toContain('Icon.astro');
  });

  test.each(WITH_STYLE)('%s tiene su propio <style> en @layer components', (name) => {
    const source = src(name);
    expect(source).toContain('<style');
    expect(compact(source)).toContain('@layercomponents{');
  });
});

describe('T-117 · RT-1 ampliado: movimiento y foco sin valores sueltos', () => {
  /** Declaraciones `prop: valor` (de primer nivel de línea) cuya propiedad empieza por alguno de los prefijos. */
  const declarations = (source: string, props: string[]): string[] =>
    source
      .replaceAll('{', ';')
      .replaceAll('}', ';')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => props.some((p) => d.startsWith(`${p}:`)));

  test.each(WITH_STYLE)('%s: transiciones y animaciones con var(--dur-*) (o none), sin ms/s ni cubic-bezier literales', (name) => {
    const bad = declarations(src(name), ['transition', 'animation', 'transition-duration', 'animation-duration', 'transition-timing-function'])
      .filter((d) => !d.includes('var(--dur-') && !d.includes(': none') && !d.includes(':none') && !d.includes('var(--ease)'));
    expect(bad).toEqual([]);
    expect(compact(src(name))).not.toContain('cubic-bezier(');
  });

  test.each(WITH_STYLE)('%s no suprime el contorno de foco (outline: none / 0)', (name) => {
    const source = compact(src(name));
    expect(source).not.toContain('outline:none');
    expect(source).not.toContain('outline:0;');
    expect(source).not.toContain('outline:0}');
  });

  test.each(WITH_STYLE)('%s solo usa variables declaradas en tokens.css (o definidas en el propio componente)', (name) => {
    const source = src(name);
    const tokens = customProperties(read('src/styles/tokens.css'));
    const used = source.split('var(--').slice(1).map((chunk) => `--${chunk.split(')')[0].split(',')[0].trim()}`);
    const local = source.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('--') && l.includes(':')).map((l) => l.split(':')[0].trim());
    // `--f-*` las emite <Font> de Astro; `--_*` y los definidos en el propio componente son locales.
    const unknown = used.filter((v) => !tokens.has(v) && !local.includes(v) && !v.startsWith('--f-'));
    expect(unknown).toEqual([]);
  });
});

describe('T-117 · criterio 1: cada interactivo declara sus estados en CSS', () => {
  test('Button: hover, activo, deshabilitado, cargando, píldora y mayúsculas por CSS', () => {
    const source = src('Button');
    expect(hasAny(source, [':hover'])).toBe(true);
    expect(hasAny(source, [':active'])).toBe(true);
    expect(hasAny(source, [':disabled', '[disabled]', '[aria-disabled'])).toBe(true);
    expect(hasAny(source, ['[aria-busy', '[data-loading', '.loading', 'is-loading', '.spinner'])).toBe(true);
    expect(hasAny(source, ['var(--radius-pill)'])).toBe(true);
    expect(hasAny(source, ['text-transform: uppercase'])).toBe(true);
  });

  test('IconButton: hover, activo, deshabilitado y pulsado (aria-pressed)', () => {
    const source = src('IconButton');
    expect(hasAny(source, [':hover'])).toBe(true);
    expect(hasAny(source, [':active'])).toBe(true);
    expect(hasAny(source, [':disabled', '[disabled]', '[aria-disabled'])).toBe(true);
    expect(hasAny(source, ['[aria-pressed'])).toBe(true);
  });

  test('TextLink: hover y activo', () => {
    const source = src('TextLink');
    expect(hasAny(source, [':hover'])).toBe(true);
    expect(hasAny(source, [':active'])).toBe(true);
  });

  test('Field: foco, deshabilitado, error, solo lectura; borde --stroke-control y texto de error --color-red-strong', () => {
    const source = src('Field');
    expect(hasAny(source, [':focus', ':focus-within', ':focus-visible'])).toBe(true);
    expect(hasAny(source, [':disabled', '[disabled]'])).toBe(true);
    expect(hasAny(source, ['[aria-invalid', '.error', 'data-invalid', 'is-error'])).toBe(true);
    expect(hasAny(source, [':read-only', '[readonly]'])).toBe(true);
    expect(source).toContain('var(--stroke-control)');
    expect(source).toContain('var(--color-red-strong)');
    expect(source).not.toContain('var(--color-red)');
    expect(source).not.toContain('var(--state-error)');
  });

  test('Checkbox: marcada, deshabilitada, foco; borde de control', () => {
    const source = src('Checkbox');
    expect(hasAny(source, [':checked'])).toBe(true);
    expect(hasAny(source, [':disabled', '[disabled]', '[data-disabled', '[aria-disabled'])).toBe(true);
    expect(hasAny(source, [':focus-visible', ':focus-within', ':has(:focus-visible)'])).toBe(true);
    // Borde de la casilla: cualquier token con >= 3:1 (se comprueba más abajo en 'contraste').
    expect(hasAny(source, ['var(--stroke-control)', 'var(--stroke-strong)', 'var(--color-forest)'])).toBe(true);
  });
});

describe('T-117 · marca (BRIEF §1, §12)', () => {
  test('Wordmark: mayúsculas por CSS y familia de marca (Jaro); el texto del código no está en mayúsculas', () => {
    const source = src('Wordmark');
    expect(hasAny(source, ['text-transform: uppercase'])).toBe(true);
    expect(source).toContain('var(--font-brand)');
    expect(source).not.toContain('VALMONT');
  });

  test('Checkerboard: gradiente cónico repetido con los tokens de las dos paletas', () => {
    const source = src('Checkerboard');
    expect(source).toContain('conic-gradient');
    ['--color-ink', '--color-ivory', '--color-forest', '--color-mint'].forEach((token) => expect(source, token).toContain(`var(${token})`));
    expect(compact(source)).not.toContain('box-shadow');
  });
});

describe('T-117 · contraste de los pares usados (BRIEF §11, cálculo sobre tokens.css)', () => {
  const props = customProperties(read('src/styles/tokens.css'));
  const rgb = (name: string): ReturnType<typeof parseColor> => parseColor(resolveVar(props, name));
  const WHITE = '--color-white';

  test.each([
    ['Button primary: ink sobre yellow', '--color-ink', '--color-yellow'],
    ['Button dark: ivory sobre forest', '--color-ivory', '--color-forest'],
    ['Button secondary / TextLink ink: ink sobre ivory', '--color-ink', '--color-ivory'],
    ['Button mint: ink sobre mint (BRIEF §12.2)', '--color-ink', '--color-mint'],
    ['TextLink forest sobre ivory', '--color-forest', '--color-ivory'],
    ['TextLink ivory sobre forest', '--color-ivory', '--color-forest'],
    ['Error de Field sobre blanco', '--color-red-strong', WHITE],
    ['Error de Field sobre ivory', '--color-red-strong', '--color-ivory'],
    ['Error de Field sobre red-soft', '--color-red-strong', '--color-red-soft'],
    ['Ayuda (hint) sobre blanco: slate', '--color-slate', WHITE],
    ['Etiqueta e iconos sobre blanco: ink', '--color-ink', WHITE],
  ])('%s ≥ 4,5:1', (_name, fg, bg) => {
    expect(contrast(rgb(fg), rgb(bg))).toBeGreaterThanOrEqual(MIN_TEXT);
  });

  test.each([
    ['sobre blanco', WHITE],
    ['sobre ivory', '--color-ivory'],
  ])('borde de control (--stroke-control) %s ≥ 3:1 (WCAG 1.4.11)', (_name, bg) => {
    const border = over(rgb('--stroke-control'), rgb(bg));
    expect(contrast(border, rgb(bg))).toBeGreaterThanOrEqual(MIN_NON_TEXT);
  });

  test.each([
    ['borde de error red-strong sobre blanco', '--color-red-strong', WHITE],
    ['foco ink sobre ivory', '--color-ink', '--color-ivory'],
    ['foco ink sobre yellow (botón primary)', '--color-ink', '--color-yellow'],
    ['foco yellow sobre forest (superficies oscuras)', '--color-yellow', '--color-forest'],
    ['marca mint sobre forest (casilla marcada)', '--color-mint', '--color-forest'],
  ])('%s ≥ 3:1', (_name, fg, bg) => {
    expect(contrast(rgb(fg), rgb(bg))).toBeGreaterThanOrEqual(MIN_NON_TEXT);
  });

  test('el foco por defecto es ink sobre claro y pasa a amarillo en .on-dark (tokens.css)', () => {
    const css = compact(read('src/styles/tokens.css'));
    expect(css).toContain('--focus-color:var(--color-ink)');
    expect(css).toContain('.on-dark{--focus-color:var(--color-yellow)');
  });
});

describe('T-117 · /dev/ui-a (página de muestra, solo desarrollo)', () => {
  const page = (): string => read('src/pages/dev/ui-a.astro');

  test('no existe en producción: prerender=false y 404 fuera de DEV', () => {
    const source = page();
    expect(compact(source)).toContain('exportconstprerender=false');
    expect(source).toContain('import.meta.env.DEV');
    expect(source).toContain('404');
  });

  test('usa los 8 componentes (la página los muestra todos)', () => {
    const source = page();
    COMPONENTS.forEach((name) => expect(source, `ui-a no importa ${name}`).toContain(`${name}.astro`));
  });

  test('sin HTML en bruto ni valores sueltos propios (usa tokens)', () => {
    const source = page();
    expect(source).not.toContain('set:html');
  });
});
