import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import Checkbox from '../../src/components/ui/Checkbox.astro';
import Field from '../../src/components/ui/Field.astro';
import CheckboxBefore from '../helpers/fixtures/before-t128/Checkbox.astro';
import FieldBefore from '../helpers/fixtures/before-t128/Field.astro';
import { FRONTEND } from '../helpers/css';
import { renderAstro } from '../helpers/render';
import { text, ui } from '../helpers/ui';

// T-128 · cambios aditivos en `ui/` (autorizados): Field admite `min`/`max` como texto y Checkbox gana `tone`.
// Regresión: sin las props nuevas el HTML es el de antes (los fixtures son copias de las versiones de main db1fbc3).
const ONE = 1;
const MAX_NUMBER = 12;
const MIN_NUMBER = 1;
const TODAY = '2026-11-27';
const HOSTILE = '"><img src=x onerror=alert(1)>';

// Quita lo que cambia entre dos archivos distintos aunque el marcado sea el mismo: el hash de ámbito de Astro y los <style>.
// Acepta ` data-astro-cid-abc123` y `astro-abc123`; rechaza `data-tone` (https://regex101.com/?regex=%20data-astro-cid-%5Cw%2B(%3D%22%5B%5E%22%5D*%22)%3F).
const CID_ATTR = / data-astro-cid-\w+(="[^"]*")?/g;
// Acepta la clase `astro-abc123` (con o sin espacio delante); rechaza `astro` suelto.
const CID_CLASS = /\s?astro-[a-z0-9]+/g;
// Acepta un bloque <style>…</style> completo (incluso con saltos de línea).
const STYLE_BLOCK = /<style[\s\S]*?<\/style>/g;
// Acepta el atributo ` data-tone="light"` del envoltorio de la casilla; es la única diferencia permitida.
const LIGHT_TONE = / data-tone="light"/;

const normalize = (html: string): string => html.replace(STYLE_BLOCK, '').replace(CID_ATTR, '').replace(CID_CLASS, '').replace(/\s+/g, ' ').trim();

type Props = Record<string, unknown>;
const render = (c: Parameters<typeof renderAstro>[0], props: Props, slots: Record<string, string> = {}): Promise<string> => renderAstro(c, { props, slots });

const FIELD_CASES: [string, Props][] = [
  ['solo lo obligatorio', { id: 'a', name: 'a', label: 'Etiqueta' }],
  ['correo con error y ayuda', { id: 'a', name: 'a', label: 'Correo', type: 'email', error: 'Mal', hint: 'Ayuda', required: true, value: 'x@example.com' }],
  ['límites numéricos', { id: 'a', name: 'a', label: 'Número', type: 'number', min: MIN_NUMBER, max: MAX_NUMBER, minlength: 3, maxlength: 9 }],
  ['tono oscuro con icono', { id: 'a', name: 'a', label: 'Contraseña', type: 'password', tone: 'dark', iconLeft: 'lock', autocomplete: 'new-password' }],
  ['fecha sin max', { id: 'a', name: 'a', label: 'Fecha', type: 'date' }],
];

const CHECKBOX_CASES: [string, Props][] = [
  ['con label', { id: 'c', name: 'c', label: 'Acepto' }],
  ['marcada y obligatoria', { id: 'c', name: 'c', label: 'Acepto', checked: true, required: true }],
  ['con error', { id: 'c', name: 'c', label: 'Acepto', error: 'Obligatorio' }],
  ['deshabilitada', { id: 'c', name: 'c', label: 'Acepto', disabled: true, value: 'v' }],
];

describe('regresión · Field sin las props nuevas produce el mismo HTML que antes', () => {
  test.each(FIELD_CASES)('%s', async (_n, props) => {
    expect(normalize(await render(Field, props))).toBe(normalize(await render(FieldBefore, props)));
  });

  test('con contenido en el slot `action` también', async () => {
    const props = { id: 'p', name: 'p', label: 'Contraseña', type: 'password' };
    const slots = { action: '<button type="button">ojo</button>' };
    expect(normalize(await render(Field, props, slots))).toBe(normalize(await render(FieldBefore, props, slots)));
  });
});

describe('regresión · Checkbox sin `tone` produce el mismo HTML que antes (salvo data-tone="light")', () => {
  test.each(CHECKBOX_CASES)('%s', async (_n, props) => {
    const now = normalize(await render(Checkbox, props));
    expect(now).toMatch(LIGHT_TONE);
    expect(now.replace(LIGHT_TONE, '')).toBe(normalize(await render(CheckboxBefore, props)));
  });

  test('con contenido en el slot (enlaces) también', async () => {
    const props = { id: 'c', name: 'c' };
    const slots = { default: 'Acepto los <a href="/terminos">términos</a>' };
    expect((normalize(await render(Checkbox, props, slots))).replace(LIGHT_TONE, '')).toBe(normalize(await render(CheckboxBefore, props, slots)));
  });

  test('`tone="light"` explícito es idéntico al valor por defecto', async () => {
    const props = { id: 'c', name: 'c', label: 'Acepto', error: 'Obligatorio' };
    expect(normalize(await render(Checkbox, { ...props, tone: 'light' }))).toBe(normalize(await render(Checkbox, props)));
  });

  test('sigue exigiendo `label` o contenido', async () => {
    await expect(render(Checkbox, { id: 'c', name: 'c' })).rejects.toThrow();
  });
});

describe('Field · `min` y `max` admiten texto (fecha) o número', () => {
  const attr = (body: ParentNode, name: string): string | null => body.querySelector('input')?.getAttribute(name) ?? null;
  const field = (props: Props) => ui(Field, { id: 'f', name: 'f', label: 'Fecha', ...props });

  test('max como fecha de hoy se pinta tal cual en un campo date', async () => {
    const body = await field({ type: 'date', max: TODAY });
    expect(attr(body, 'type')).toBe('date');
    expect(attr(body, 'max')).toBe(TODAY);
  });

  test('min como texto también', async () => {
    expect(attr(await field({ type: 'date', min: '1900-01-01' }), 'min')).toBe('1900-01-01');
  });

  test('los números siguen funcionando', async () => {
    const body = await field({ type: 'number', min: MIN_NUMBER, max: MAX_NUMBER });
    expect(attr(body, 'min')).toBe(String(MIN_NUMBER));
    expect(attr(body, 'max')).toBe(String(MAX_NUMBER));
  });

  test('un `max` hostil se escapa', async () => {
    const body = await field({ type: 'date', max: HOSTILE });
    expect(body.querySelector('img')).toBeNull();
    expect(attr(body, 'max')).toBe(HOSTILE);
  });

  test('sin max/min no hay atributo', async () => {
    const body = await field({ type: 'date' });
    expect(attr(body, 'max')).toBeNull();
    expect(attr(body, 'min')).toBeNull();
  });

  test('el tipo date se conserva con iconLeft="calendar" (icono decorativo)', async () => {
    const body = await field({ type: 'date', iconLeft: 'calendar' });
    expect(attr(body, 'type')).toBe('date');
    expect(body.querySelector('svg')).not.toBeNull();
    expect(body.querySelector('svg')?.closest('[aria-hidden="true"]') ?? body.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Checkbox · tone="dark" (casilla sobre forest)', () => {
  const box = (props: Props = {}, slots: Record<string, string> = {}) => ui(Checkbox, { id: 'c', name: 'c', label: 'Acepto', ...props }, slots);
  const wrapper = (body: ParentNode): Element => {
    const el = body.querySelector('.checkbox');
    if (!el) throw new Error('Sin envoltorio .checkbox');
    return el;
  };

  test('marca el envoltorio con data-tone="dark"; por defecto es light', async () => {
    expect(wrapper(await box({ tone: 'dark' })).getAttribute('data-tone')).toBe('dark');
    expect(wrapper(await box()).getAttribute('data-tone')).toBe('light');
  });

  test('el contenido accesible no cambia con el tono: mismo input, misma etiqueta, mismo error', async () => {
    const props = { error: 'Debes aceptar', required: true };
    const dark = await box({ ...props, tone: 'dark' });
    const light = await box(props);
    const strip = (b: ParentNode): string => normalize(b.querySelector('.checkbox')?.outerHTML ?? '').replace(/ data-tone="(dark|light)"/, '');
    expect(strip(dark)).toBe(strip(light));
  });

  test('en dark el error sigue ligado con aria-describedby y aria-invalid', async () => {
    const body = await box({ tone: 'dark', error: 'Debes aceptar' });
    const input = body.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const id = input.getAttribute('aria-describedby')!;
    expect(text(body.querySelector(`[id="${id}"]`))).toContain('Debes aceptar');
  });

  test('en dark admite enlaces en el slot y los conserva', async () => {
    const body = await box({ tone: 'dark', label: undefined }, { default: 'Acepto los <a href="/terminos">términos</a>' });
    expect(body.querySelector('a[href="/terminos"]')).not.toBeNull();
  });

  test('un valor de tono desconocido no rompe el render', async () => {
    const body = await box({ tone: 'neon' });
    expect(body.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  test('la hoja de estilos de dark usa solo tokens: texto marfil, borde menta, marca forest, error rojo suave', () => {
    const src = readFileSync(join(FRONTEND, 'src/components/ui/Checkbox.astro'), 'utf8');
    const dark = src.slice(src.indexOf("[data-tone='dark']"));
    expect(dark).toContain('var(--text-on-dark)');
    expect(dark).toContain('var(--color-mint)');
    expect(dark).toContain('var(--color-forest)');
    expect(dark).toContain('var(--color-red-soft)');
    expect(dark.slice(0, dark.indexOf('Deshabilitado'))).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  test('el borde de la casilla en dark es menta (≥ 3:1 sobre forest): la regla del input lo declara con el token', () => {
    const src = readFileSync(join(FRONTEND, 'src/components/ui/Checkbox.astro'), 'utf8');
    const open = src.indexOf(".checkbox[data-tone='dark'] input {");
    expect(open, 'falta la regla del input en dark').toBeGreaterThan(-1);
    const rule = src.slice(open, src.indexOf('}', open));
    expect(rule).toContain('border-color: var(--color-mint)');
  });

  test('los tokens que usa dark existen en tokens.css', () => {
    const css = readFileSync(join(FRONTEND, 'src/styles/tokens.css'), 'utf8');
    ['--text-on-dark', '--color-mint', '--color-forest', '--color-red-soft', '--color-forest-mid'].forEach((t) => expect(css).toContain(`${t}:`));
  });

  test('sigue siendo UNA casilla por componente', async () => {
    expect((await box({ tone: 'dark' })).querySelectorAll('input[type="checkbox"]')).toHaveLength(ONE);
  });
});
