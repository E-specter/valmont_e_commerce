import { describe, expect, test } from 'vitest';
import Field from '../../src/components/ui/Field.astro';
import AuthForm from '../../src/components/auth/AuthForm.astro';
import PageTitle from '../../src/components/layout/PageTitle.astro';
import { contrast, customProperties, parseColor, read, resolveVar } from '../helpers/css';
import { renderAstro } from '../helpers/render';

// T-127 (correcciones) · prop aditiva `tone?: 'light' | 'dark'` (por defecto `light`) en PageTitle y Field.
// `dark` solo se aplica con tone="dark"; sin la prop, las vistas existentes no cambian.
const AA = 4.5;
const TOKENS = customProperties(read('src/styles/tokens.css'));
const color = (name: string) => parseColor(resolveVar(TOKENS, name));
const FOREST = color('--color-forest');
const PAGE_TITLE = 'src/components/layout/PageTitle.astro';
const FIELD = 'src/components/ui/Field.astro';
const DARK_TOKENS = ['--color-mint', '--text-on-dark', '--color-red-soft'];

const title = (props: Record<string, unknown> = {}): Promise<string> => renderAstro(PageTitle, { props: { title: 'Ingreso', kicker: 'Portal', description: 'Texto', ...props } });
const field = (props: Record<string, unknown> = {}): Promise<string> =>
  renderAstro(Field, { props: { id: 'correo', name: 'email', label: 'Correo', hint: 'Ayuda', error: 'Error', ...props } });

/** Bloques CSS `selector { cuerpo }` del <style> de un componente (sin comentarios; sin anidados: el estilo es plano dentro de @layer). */
function blocks(file: string): { selector: string; body: string }[] {
  const raw = read(file).split('<style>')[1];
  const css = raw.split('/*').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('*/') + 2))).join('');
  return css
    .split('}')
    .filter((chunk) => chunk.includes('{') && chunk.lastIndexOf('{') === chunk.indexOf('{'))
    .map((chunk) => ({ selector: chunk.split('{')[0].trim(), body: chunk.split('{')[1] }));
}

describe.each([
  ['PageTitle', title, PAGE_TITLE],
  ['Field', field, FIELD],
] as const)('%s · tone', (_name, render, file) => {
  test('sin tone, el HTML es idéntico a tone="light" (el valor por defecto es light)', async () => {
    expect(await render()).toBe(await render({ tone: 'light' }));
  });

  test('sin tone no aparece nada de "dark" en el HTML (las vistas existentes no cambian)', async () => {
    expect((await render()).toLowerCase()).not.toContain('dark');
  });

  test('tone="dark" cambia el marcado (hay un gancho para el estilo oscuro)', async () => {
    expect(await render({ tone: 'dark' })).not.toBe(await render());
  });

  test('los tokens de fondo oscuro (menta, marfil, rojo suave) solo se usan en reglas de tone="dark"', () => {
    const used = blocks(file).filter((b) => DARK_TOKENS.some((t) => b.body.includes(`var(${t})`)) && !b.selector.includes('dark'));
    // `--color-red-soft` y `--text-on-dark` pueden existir en reglas claras de otro origen: se listan para revisarlas.
    const offenders = used.filter((b) => b.body.includes('--color-mint') || b.body.includes('--text-on-dark') || b.body.includes('--color-red-soft'));
    expect(offenders.map((b) => b.selector)).toEqual([]);
  });

  test('no hay valores sueltos en las reglas oscuras (solo var(--token))', () => {
    const dark = blocks(file).filter((b) => b.selector.includes('dark'));
    expect(dark.length).toBeGreaterThan(0);
    dark.forEach((b) => expect(b.body).not.toContain('#'));
  });
});

describe('PageTitle · tone="dark" mantiene los textos', () => {
  test('mismo contenido y nivel de encabezado', async () => {
    const html = await title({ tone: 'dark' });
    ['Ingreso', 'Portal', 'Texto'].forEach((t) => expect(html).toContain(t));
    expect(html).toContain('<h1');
  });
});

describe('contraste (WCAG AA) de los colores de tone="dark" sobre forest', () => {
  test.each([
    ['kicker (menta)', '--color-mint'],
    ['título, descripción y ayuda (marfil)', '--text-on-dark'],
    ['error (rojo suave)', '--color-red-soft'],
  ])('%s ≥ 4,5:1', (_n, token) => {
    expect(contrast(color(token), FOREST)).toBeGreaterThanOrEqual(AA);
  });
});

describe('AuthForm usa tone="dark" (está sobre forest)', () => {
  const HOOK = 'data-tone="dark"';
  const FIELDS_IN_FORM = 2;

  test('el gancho oscuro existe en PageTitle y Field cuando se pide tone="dark"', async () => {
    expect(await title({ tone: 'dark' })).toContain(HOOK);
    expect(await field({ tone: 'dark' })).toContain(HOOK);
  });

  test('el AuthForm lo aplica al encabezado y a los dos campos (correo y contraseña)', async () => {
    const html = await renderAstro(AuthForm, { props: { mode: 'login' } });
    expect(html.split(HOOK).length - 1).toBe(1 + FIELDS_IN_FORM);
  });
});
