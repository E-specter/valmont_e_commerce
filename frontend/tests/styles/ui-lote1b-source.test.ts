import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND, contrast, customProperties, over, parseColor, read, resolveVar } from '../helpers/css';

// T-118 · lote 1B de ui/. Pruebas de código fuente y de cálculo (no renderizan):
//  - RT-1/RT-2/RT-5/RT-7: reglas de estilo y de componente que el grep de T-116 no cubre. La prueba
//    `no-loose-values.test.ts` ya recorre todo `src/` y, por tanto, también estos archivos; NO se ha modificado.
//  - Sin sombras (BRIEF §4), tabular-nums en el precio, movimiento reducido en el esqueleto, rojo de texto,
//    formato solo en lib/format.ts, contraste de los pares usados (BRIEF §11) y la página /dev/ui-b.

const UI = 'src/components/ui';
const COMPONENTS = ['Card', 'Badge', 'Chip', 'Price', 'Availability', 'Notice', 'EmptyState', 'Skeleton'] as const;
const src = (name: string): string => read(`${UI}/${name}.astro`);
const compact = (s: string): string => [...s.toLowerCase()].filter((c) => c.trim() !== '').join('');
const hasAny = (source: string, options: string[]): boolean => options.some((o) => compact(source).includes(compact(o)));

const MIN_TEXT = 4.5; // WCAG 1.4.3
const MIN_NON_TEXT = 3; // WCAG 1.4.11
const NONE = 0;
const ONE = 1;

/** Declaraciones `prop: valor` cuya propiedad empieza por alguno de los prefijos (CSS de componentes, sin llaves). */
const declarations = (source: string, props: string[]): string[] =>
  source
    .replaceAll('{', ';')
    .replaceAll('}', ';')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => props.some((p) => d.startsWith(`${p}:`)));

/** Archivos `.astro` y `.ts` de `src/` (ruta relativa a `frontend/`). */
function walk(dir: string): string[] {
  return readdirSync(join(FRONTEND, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(FRONTEND, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

describe('T-118 · archivos del paquete', () => {
  test.each([
    ...COMPONENTS.map((c) => `${UI}/${c}.astro`),
    `${UI}/availability.ts`,
    'src/lib/format.ts',
    'src/pages/dev/ui-b.astro',
  ])('existe %s', (file) => {
    expect(existsSync(join(FRONTEND, file)), file).toBe(true);
  });

  test('lib/format.ts exporta formatMoney, formatDate y formatDateOnly', () => {
    const source = read('src/lib/format.ts');
    ['formatMoney', 'formatDate', 'formatDateOnly'].forEach((name) => expect(source, name).toContain(`export function ${name}`));
  });

  test('availability.ts exporta availabilityLabel', () => {
    expect(read(`${UI}/availability.ts`)).toContain('availabilityLabel');
  });

  test('sin dependencia nueva (RT-9)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const expected = ['@astrojs/node', 'astro'];
    expect(Object.keys(pkg.dependencies).sort()).toEqual(expected);
  });
});

describe('T-118 · RT-2 y seguridad (RT-5): componentes sin estado y sin HTML en bruto', () => {
  test.each(COMPONENTS)('%s declara sus Props tipadas (interface/type Props)', (name) => {
    const source = src(name);
    expect(source.includes('interface Props') || source.includes('type Props')).toBe(true);
  });

  test.each(COMPONENTS)('%s no usa set:html, innerHTML ni fetch', (name) => {
    const source = src(name);
    ['set:html', 'innerHTML', 'fetch(', 'dangerouslySetInnerHTML'].forEach((banned) => expect(source, `${name}: ${banned}`).not.toContain(banned));
  });

  test.each(['Notice', 'EmptyState'])('%s reutiliza Icon en vez de dibujar su propio <svg>', (name) => {
    const source = src(name);
    expect(source).toContain('Icon.astro');
    expect(source).not.toContain('<svg');
  });

  test.each(COMPONENTS)('%s tiene su propio <style> en @layer components', (name) => {
    const source = src(name);
    expect(source).toContain('<style');
    expect(compact(source)).toContain('@layercomponents{');
  });
});

describe('T-118 · RT-1 ampliado: movimiento, foco y superficies planas', () => {
  test.each(COMPONENTS)('%s: transiciones y animaciones con var(--dur-*) (o none), sin ms/s ni cubic-bezier literales', (name) => {
    const bad = declarations(src(name), ['transition', 'animation', 'transition-duration', 'animation-duration', 'transition-timing-function'])
      .filter((d) => !d.includes('var(--dur-') && !d.includes(': none') && !d.includes(':none') && !d.includes('var(--ease)') && !d.includes('animation-name'));
    // Un `animation: nombre var(--dur-x) var(--ease) infinite` es válido; el filtro solo rechaza duraciones literales.
    expect(bad).toEqual([]);
    expect(compact(src(name))).not.toContain('cubic-bezier(');
  });

  test.each(COMPONENTS)('%s no suprime el contorno de foco (outline: none / 0)', (name) => {
    const source = compact(src(name));
    expect(source).not.toContain('outline:none');
    expect(source).not.toContain('outline:0;');
    expect(source).not.toContain('outline:0}');
  });

  test.each(COMPONENTS)('%s solo usa variables declaradas en tokens.css (o definidas en el propio componente)', (name) => {
    const source = src(name);
    const tokens = customProperties(read('src/styles/tokens.css'));
    const used = source.split('var(--').slice(ONE).map((chunk) => `--${chunk.split(')')[NONE].split(',')[NONE].trim()}`);
    const local = source.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('--') && l.includes(':')).map((l) => l.split(':')[NONE].trim());
    // Variables locales: declaradas en el CSS del componente o fijadas desde el marcado (style={{ '--x': … }}).
    const fromMarkup = (v: string): boolean => source.includes(`'${v}'`) || source.includes(`"${v}"`) || source.includes(`${v}:`);
    const unknown = used.filter((v) => !tokens.has(v) && !local.includes(v) && !fromMarkup(v) && !v.startsWith('--f-'));
    expect(unknown).toEqual([]);
  });

  test.each(COMPONENTS)('%s no dibuja sombras (BRIEF §4: superficies planas con borde)', (name) => {
    const shadows = declarations(src(name), ['box-shadow', 'text-shadow', 'filter']).filter((d) => !compact(d).endsWith(':none') && !compact(d).endsWith(':0'));
    expect(shadows).toEqual([]);
    expect(compact(src(name))).not.toContain('drop-shadow(');
    expect(compact(src(name))).not.toContain('var(--shadow');
  });

  test.each(COMPONENTS)('%s nunca usa el rojo de Figma como color de texto (BRIEF §11: texto de error con --color-red-strong)', (name) => {
    const bad = declarations(src(name), ['color']).filter((d) => ['var(--color-red)', 'var(--state-error)'].includes(compact(d).replace('color:', '')));
    expect(bad).toEqual([]);
  });

  test.each(COMPONENTS)('%s no usa amarillo ni menta como color de texto (BRIEF §2: nunca sobre marfil)', (name) => {
    const bad = declarations(src(name), ['color']).filter((d) => ['var(--color-yellow)', 'var(--color-mint)'].includes(compact(d).replace('color:', '')));
    expect(bad).toEqual([]);
  });
});

describe('T-118 · criterios por componente (CSS)', () => {
  test('Price: cifras tabulares (font-variant-numeric: tabular-nums) y familia de títulos', () => {
    const source = src('Price');
    expect(hasAny(source, ['font-variant-numeric: tabular-nums'])).toBe(true);
    expect(source).toContain('var(--font-heading)');
  });

  test('Price: el original tachado usa <del> (no solo text-decoration)', () => {
    expect(src('Price')).toContain('<del');
  });

  test('Price: texto accesible "Precio original" y "Ahorras" en español', () => {
    const source = src('Price');
    expect(source).toContain('Precio original');
    expect(source).toContain('Ahorras');
  });

  test('Skeleton: se detiene con prefers-reduced-motion (animation: none dentro del @media)', () => {
    const source = compact(src('Skeleton'));
    expect(source).toContain('@media(prefers-reduced-motion:reduce)');
    const afterMedia = source.slice(source.indexOf('@media(prefers-reduced-motion:reduce)'));
    expect(afterMedia).toContain('animation:none');
  });

  test('Skeleton: aria-hidden en la raíz del componente', () => {
    expect(compact(src('Skeleton'))).toContain('aria-hidden="true"');
  });

  test('Skeleton: la animación usa la duración y el easing de los tokens', () => {
    const anim = declarations(src('Skeleton'), ['animation']).filter((d) => !d.includes(': none') && !d.includes(':none'));
    expect(anim.length).toBeGreaterThan(NONE);
    anim.forEach((d) => expect(d).toContain('var(--dur-'));
  });

  test('Notice: role="alert" para error y role="status" para el resto', () => {
    const source = src('Notice');
    expect(source).toContain('alert');
    expect(source).toContain('status');
    expect(compact(source)).toContain('role');
  });

  test('Notice: el texto de error usa --color-red-strong (no el rojo de Figma)', () => {
    expect(src('Notice')).toContain('var(--color-red-strong)');
  });

  test('Chip: el chip no interactivo declara aria-disabled', () => {
    const source = compact(src('Chip'));
    expect(source).toContain('aria-disabled');
  });

  test('Badge: usa la ciruela y el verde con texto blanco para los estados (BRIEF §7)', () => {
    const source = src('Badge');
    expect(hasAny(source, ['var(--color-plum)', 'var(--state-cancelled)'])).toBe(true);
    expect(hasAny(source, ['var(--color-forest)'])).toBe(true);
    expect(hasAny(source, ['var(--color-white)', 'var(--bg-surface)'])).toBe(true);
  });

  test('Availability: el punto es decorativo (aria-hidden) o un pseudo-elemento, y los 4 estados se nombran', () => {
    const source = src('Availability');
    expect(source.includes('aria-hidden') || source.includes('::before') || source.includes('::after')).toBe(true);
    ['in_stock', 'low_stock', 'out_of_stock', 'on_request'].forEach((state) => expect(read(`${UI}/availability.ts`) + source, state).toContain(state));
  });

  test('Availability: reutiliza availabilityLabel para el texto', () => {
    expect(src('Availability')).toContain('availabilityLabel');
  });
});

describe('T-118 · RT-7 y RN-09: el formato y los importes viven en lib/format.ts', () => {
  const sources = walk('src').filter((f) => (f.endsWith('.astro') || f.endsWith('.ts')) && f !== 'src/lib/format.ts');

  test('hay archivos de código que revisar (la prueba no es vacía)', () => {
    expect(sources.length).toBeGreaterThan(ONE);
  });

  test.each(['.toFixed(', '.toLocaleString(', 'Intl.NumberFormat', 'Intl.DateTimeFormat', 'toLocaleDateString', 'toLocaleTimeString'])(
    'ningún otro archivo de src/ usa %s',
    (banned) => {
      const offenders = sources.filter((f) => read(f).includes(banned));
      expect(offenders).toEqual([]);
    },
  );

  test('format.ts usa Intl con es-PE, la zona America/Lima y PEN', () => {
    const source = read('src/lib/format.ts');
    expect(source).toContain('Intl.');
    expect(source).toContain('es-PE');
    expect(source).toContain('America/Lima');
    expect(source).toContain('PEN');
  });

  test('format.ts no redondea por su cuenta: sin toFixed ni Math.round/ceil/floor sobre importes', () => {
    const source = read('src/lib/format.ts');
    ['.toFixed(', 'Math.round(', 'Math.ceil(', 'Math.floor('].forEach((banned) => expect(source, banned).not.toContain(banned));
  });

  test('Price formatea con lib/format y no hace aritmética sobre los importes', () => {
    const source = src('Price');
    expect(source).toContain('lib/format');
    expect(source).not.toContain('Math.');
    const arithmetic = source
      .split('.amount')
      .slice(ONE)
      .map((rest) => rest.trim()[NONE])
      .filter((next) => ['-', '+', '*', '/', '%'].includes(next));
    expect(arithmetic).toEqual([]);
  });

  test('ningún componente escribe el símbolo S/ ni importes: todo pasa por formatMoney', () => {
    COMPONENTS.forEach((name) => {
      const source = src(name);
      expect(source.includes("'S/") || source.includes('"S/') || source.includes('`S/'), name).toBe(false);
    });
  });
});

describe('T-118 · contraste de los pares usados (BRIEF §11, cálculo sobre tokens.css)', () => {
  const props = customProperties(read('src/styles/tokens.css'));
  const rgb = (name: string): ReturnType<typeof parseColor> => parseColor(resolveVar(props, name));
  const WHITE = '--color-white';

  test.each([
    ['Badge amarillo: ink sobre amarillo', '--color-ink', '--color-yellow'],
    ['Badge entregado: blanco sobre forest', WHITE, '--color-forest'],
    ['Badge cancelado: blanco sobre ciruela', WHITE, '--color-plum'],
    ['Badge outline: ink sobre blanco', '--color-ink', WHITE],
    ['Badge outline: ink sobre marfil', '--color-ink', '--color-ivory'],
    ['Badge/Chip menta: ink sobre menta', '--color-ink', '--color-mint'],
    ['Chip activo: marfil sobre forest', '--color-ivory', '--color-forest'],
    ['Chip rojo / aviso de error: red-strong sobre red-soft', '--color-red-strong', '--color-red-soft'],
    ['Aviso de error: red-strong sobre blanco', '--color-red-strong', WHITE],
    ['Card ink: marfil sobre ink', '--color-ivory', '--color-ink'],
    ['Card forest: marfil sobre forest', '--color-ivory', '--color-forest'],
    ['Texto secundario (descripciones, original tachado): slate sobre blanco', '--color-slate', WHITE],
    ['Texto secundario: slate sobre marfil', '--color-slate', '--color-ivory'],
  ])('%s ≥ 4,5:1', (_name, fg, bg) => {
    expect(contrast(rgb(fg), rgb(bg))).toBeGreaterThanOrEqual(MIN_TEXT);
  });

  test('el borde fuerte (forest) de la tarjeta se distingue de la superficie blanca (≥ 3:1)', () => {
    const border = over(rgb('--stroke-strong'), rgb(WHITE));
    expect(contrast(border, rgb(WHITE))).toBeGreaterThanOrEqual(MIN_NON_TEXT);
  });
});

describe('T-118 · /dev/ui-b (página de muestra, solo desarrollo)', () => {
  const page = (): string => read('src/pages/dev/ui-b.astro');

  test('no existe en producción: prerender=false y 404 fuera de DEV', () => {
    const source = page();
    expect(compact(source)).toContain('exportconstprerender=false');
    expect(source).toContain('import.meta.env.DEV');
    expect(source).toContain('404');
  });

  test('usa los 8 componentes (la página los muestra todos)', () => {
    const source = page();
    COMPONENTS.forEach((name) => expect(source, `ui-b no importa ${name}`).toContain(`${name}.astro`));
  });

  test('muestra los cuatro estados de disponibilidad, precio con y sin promoción y los dos roles de aviso', () => {
    const source = page();
    ['in_stock', 'low_stock', 'out_of_stock', 'on_request'].forEach((state) => expect(source, state).toContain(state));
    expect(source).toContain('originalPrice');
    expect(source).toContain('discountAmount');
    ['info', 'success', 'error', 'warning'].forEach((tone) => expect(source, `Notice ${tone}`).toContain(tone));
  });

  test('muestra el chip no interactivo (as="span") y el removible (removeHref)', () => {
    const source = compact(page());
    expect(source).toContain('as="span"');
    expect(source).toContain('removehref');
  });

  test('sin HTML en bruto', () => {
    expect(page()).not.toContain('set:html');
  });
});
