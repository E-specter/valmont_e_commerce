import { describe, expect, test } from 'vitest';
import Checkerboard from '../../src/components/ui/Checkerboard.astro';
import Icon from '../../src/components/ui/Icon.astro';
import Wordmark from '../../src/components/ui/Wordmark.astro';
import { read } from '../helpers/css';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-117 · Icon, Wordmark y Checkerboard (STATUS "T-117 › Firmas públicas") con la Container API.

// Lista cerrada de icons.ts (IconName).
const ICON_NAMES = [
  'search', 'heart', 'heart-off', 'shopping-bag', 'message-circle', 'user', 'x', 'send', 'check', 'check-circle',
  'x-circle', 'alert-triangle', 'info', 'lock', 'mail', 'eye', 'eye-off', 'clock', 'calendar', 'credit-card',
  'chevron-down', 'arrow-right', 'arrow-left', 'grid', 'list', 'menu', 'plus', 'minus',
] as const;

// Tamaños de la firma pública (Icon.size y Checkerboard.cell) y topes de nodos del damero.
const SIZE_S = 16;
const SIZE_M = 24;
const SIZE_DEFAULT_ICON = 20;
const SIZE_L = 32;
const ROWS_DOUBLE = 2;
const STROKE_MIN = 1.5;
const STROKE_MAX = 2;
const MAX_NODES_ONE_ROW = 2;
const MAX_NODES_TWO_ROWS = 4;

/** Atributos del <svg> raíz concatenados (sin los datos del trazo), para saber si el tamaño llega al elemento. */
const svgAttrs = (svg: Element): string =>
  [...svg.attributes].filter((a) => a.name !== 'd').map((a) => `${a.name}=${a.value}`).join(' ');

/** El marcado declara `prop` con alguno de `values`, como atributo (prop="v") o como estilo (prop: v). */
const declares = (html: string, prop: string, values: string[]): boolean =>
  values.some((v) => [`${prop}="${v}"`, `${prop}='${v}'`, `${prop}: ${v}`, `${prop}:${v}`].some((f) => html.includes(f)));

describe('Icon', () => {
  test.each(ICON_NAMES)('"%s" renderiza un <svg> con formas dibujadas', async (name) => {
    const svg = root(await ui(Icon, { name }));
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('path, circle, line, polyline, polygon, rect, ellipse'), `${name} sin trazos`).not.toBeNull();
    expect(svg.getAttribute('viewBox') ?? svg.getAttribute('viewbox')).toBeTruthy();
  });

  test('iconos distintos dibujan trazos distintos (no hay un comodín para todos)', async () => {
    const drawn = await Promise.all(ICON_NAMES.map(async (name) => (await ui(Icon, { name })).innerHTML));
    expect(new Set(drawn).size).toBe(ICON_NAMES.length);
  });

  test('sin label es decorativo: aria-hidden="true", sin role ni aria-label', async () => {
    const svg = root(await ui(Icon, { name: 'search' }));
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('aria-label')).toBe(false);
  });

  test('con label es significativo: role="img" y aria-label, sin aria-hidden', async () => {
    const svg = root(await ui(Icon, { name: 'lock', label: 'Pago seguro' }));
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Pago seguro');
    expect(svg.getAttribute('aria-hidden')).not.toBe('true');
  });

  test('el label se escapa (sin inyección de HTML)', async () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const body = await ui(Icon, { name: 'info', label: hostile });
    expect(body.querySelectorAll('img').length).toBe(0);
    expect(root(body).getAttribute('aria-label')).toBe(hostile);
  });

  test.each([SIZE_S, SIZE_DEFAULT_ICON, SIZE_L] as const)('size=%i llega al <svg>', async (size) => {
    const svg = root(await ui(Icon, { name: 'heart', size }));
    expect(svgAttrs(svg)).toContain(String(size));
  });

  test('tamaño por defecto 20 y los tamaños producen marcas distintas', async () => {
    const outer = async (props: Record<string, unknown>): Promise<string> => root(await ui(Icon, { name: 'heart', ...props })).outerHTML;
    const def = await outer({});
    expect(def).toContain(String(SIZE_DEFAULT_ICON));
    expect(await outer({ size: SIZE_DEFAULT_ICON })).toBe(def);
    expect(await outer({ size: SIZE_S })).not.toBe(def);
    expect(await outer({ size: SIZE_L })).not.toBe(def);
  });

  test('estilo del brief: trazo (sin relleno), terminal redondo y color heredado', async () => {
    // El estilo puede ir en el marcado (atributos del SVG) o en el <style> del componente.
    const html = (await ui(Icon, { name: 'check' })).innerHTML + read('src/components/ui/Icon.astro');
    expect(declares(html, 'stroke-linecap', ['round'])).toBe(true);
    expect(declares(html, 'fill', ['none'])).toBe(true);
    expect(declares(html, 'stroke', ['currentColor'])).toBe(true);
  });

  test('grosor efectivo del trazo al tamaño por defecto: entre 1,5 y 2 px (stroke-width × size / viewBox)', async () => {
    const svg = root(await ui(Icon, { name: 'check' }));
    const [, , box] = (svg.getAttribute('viewBox') ?? svg.getAttribute('viewbox') ?? '0 0 24 24').split(' ').map(Number);
    const width = Number(svg.getAttribute('stroke-width')) * (Number(svg.getAttribute('width')) / box);
    expect(width).toBeGreaterThanOrEqual(STROKE_MIN);
    expect(width).toBeLessThanOrEqual(STROKE_MAX);
  });

  test('sin scripts ni referencias externas dentro del SVG', async () => {
    const svg = root(await ui(Icon, { name: 'menu' }));
    expect(svg.querySelectorAll('script, foreignObject, foreignobject, use[href^="http"]').length).toBe(0);
  });
});

describe('Wordmark', () => {
  test('sin href: texto "Valmont" (las mayúsculas las pone el CSS), sin enlace', async () => {
    const body = await ui(Wordmark);
    expect(text(body)).toBe('Valmont');
    expect(body.querySelectorAll('a').length).toBe(0);
  });

  test('con href: un enlace a "/" con nombre accesible "Valmont, inicio"', async () => {
    const body = await ui(Wordmark, { href: '/' });
    const a = body.querySelector('a');
    expect(a, 'falta el <a>').not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/');
    expect(a!.getAttribute('aria-label') ?? text(a)).toBe('Valmont, inicio');
  });

  test('tone: ink por defecto, ivory distinto, y las dos marcas se distinguen', async () => {
    const def = root(await ui(Wordmark));
    const ink = root(await ui(Wordmark, { tone: 'ink' }));
    const ivory = root(await ui(Wordmark, { tone: 'ivory' }));
    expect(markers(def)).toBe(markers(ink));
    expect(hasMarker(ink, 'ink')).toBe(true);
    expect(hasMarker(ivory, 'ivory')).toBe(true);
    expect(markers(ink)).not.toBe(markers(ivory));
  });

  test('el nombre de marca es texto real, no una imagen ni un icono', async () => {
    const body = await ui(Wordmark, { tone: 'ivory' });
    expect(body.querySelectorAll('img, svg').length).toBe(0);
  });
});

describe('Checkerboard', () => {
  test('decorativo: aria-hidden="true" en la raíz, sin texto ni elementos enfocables', async () => {
    const body = await ui(Checkerboard);
    const el = root(body);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(text(el)).toBe('');
    expect(body.querySelectorAll('a, button, input, [tabindex]').length).toBe(0);
  });

  test('sin elementos por módulo: gradiente cónico repetido (el DOM no crece con las celdas)', async () => {
    const count = async (props: Record<string, unknown>): Promise<number> =>
      (await ui(Checkerboard, props)).querySelectorAll('*').length;
    expect(await count({})).toBeLessThanOrEqual(MAX_NODES_ONE_ROW);
    expect(await count({ rows: ROWS_DOUBLE })).toBeLessThanOrEqual(MAX_NODES_TWO_ROWS);
    expect(await count({ cell: SIZE_S })).toBe(await count({ cell: SIZE_L }));
  });

  test('palette: storefront por defecto; auth se distingue', async () => {
    const def = root(await ui(Checkerboard));
    const store = root(await ui(Checkerboard, { palette: 'storefront' }));
    const auth = root(await ui(Checkerboard, { palette: 'auth' }));
    expect(markers(def)).toBe(markers(store));
    expect(hasMarker(store, 'storefront')).toBe(true);
    expect(hasMarker(auth, 'auth')).toBe(true);
    expect(markers(store)).not.toBe(markers(auth));
  });

  test.each([SIZE_S, SIZE_M, SIZE_L] as const)('cell=%i llega al marcado; el valor por defecto es 24', async (cell) => {
    const body = await ui(Checkerboard, { cell });
    expect(body.innerHTML).toContain(String(cell));
    const def = await ui(Checkerboard);
    const explicitDefault = await ui(Checkerboard, { cell: SIZE_M });
    expect(def.innerHTML).toBe(explicitDefault.innerHTML);
  });

  test('rows=1 por defecto y rows=2 cambia el marcado', async () => {
    const one = (await ui(Checkerboard)).innerHTML;
    expect((await ui(Checkerboard, { rows: 1 })).innerHTML).toBe(one);
    expect((await ui(Checkerboard, { rows: ROWS_DOUBLE })).innerHTML).not.toBe(one);
  });
});
