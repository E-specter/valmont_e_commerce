import { describe, expect, test } from 'vitest';
import EmptyState from '../../src/components/ui/EmptyState.astro';
import Notice from '../../src/components/ui/Notice.astro';
import Skeleton from '../../src/components/ui/Skeleton.astro';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-118 · Notice, EmptyState y Skeleton (STATUS "T-118 › Firmas públicas") con la Container API.
// El paquete no fija el nombre de las clases: las variantes se comprueban con `markers()` (clases, data-*, style).

const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FIVE = 5;
const TOTAL_TONES = 4;
const TOTAL_VARIANTS = 3;
const INJECTION = '<img id="pwn" src="x" onerror="alert(1)">';
const BOLD_INJECTION = '<b id="pwn">hola</b>';

// ------------------------------------------------------------------------------------------------ Notice

describe('Notice', () => {
  const TONES = ['info', 'success', 'error', 'warning'] as const;
  const notice = async (props: Record<string, unknown> = {}, slots: Record<string, string> = { default: 'Mensaje' }): Promise<HTMLElement> =>
    ui(Notice, props, slots);

  test('error usa role="alert"', async () => {
    expect(root(await notice({ tone: 'error' })).getAttribute('role')).toBe('alert');
  });

  test.each(['info', 'success', 'warning'] as const)('%s usa role="status"', async (tone) => {
    expect(root(await notice({ tone })).getAttribute('role')).toBe('status');
  });

  test('el tono por defecto es info: role="status"', async () => {
    const el = root(await notice());
    expect(el.getAttribute('role')).toBe('status');
    expect(markers(el)).toBe(markers(root(await notice({ tone: 'info' }))));
  });

  test('solo un role en el aviso: el de la raíz (sin roles anidados que dupliquen el anuncio)', async () => {
    const body = await notice({ tone: 'error', title: 'No pudimos cargar' });
    expect(body.querySelectorAll('[role="alert"], [role="status"]').length).toBe(ONE);
  });

  test.each(TONES)('tone="%s" lleva un icono decorativo (aria-hidden) y texto: no solo color', async (tone) => {
    const el = root(await notice({ tone, title: 'Título' }, { default: 'Detalle del aviso' }));
    const svg = el.querySelector('svg');
    expect(svg, `${tone} sin icono`).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(text(el)).toContain('Detalle del aviso');
  });

  test.each(TONES)('tone="%s" se nombra en el marcado', async (tone) => {
    expect(hasMarker(root(await notice({ tone })), tone)).toBe(true);
  });

  test('los 4 tonos producen marcas distintas', async () => {
    const all = await Promise.all(TONES.map(async (tone) => markers(root(await notice({ tone })))));
    expect(all.length).toBe(TOTAL_TONES);
    expect(new Set(all).size).toBe(TOTAL_TONES);
  });

  test('muestra el título y el contenido del slot default', async () => {
    const el = root(await notice({ title: 'Pago pendiente' }, { default: 'Tienes 30 minutos para pagar.' }));
    expect(text(el)).toContain('Pago pendiente');
    expect(text(el)).toContain('Tienes 30 minutos para pagar.');
  });

  test('sin título no deja un título vacío (ningún encabezado)', async () => {
    const body = await notice();
    expect(body.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(NONE);
    expect(text(root(body))).toBe('Mensaje');
  });

  test('el slot actions se proyecta (p. ej. el enlace de reintento) dentro del aviso', async () => {
    const body = await notice({ tone: 'error' }, { default: 'Falló', actions: '<a href="/relojes">Reintentar</a>' });
    const link = root(body).querySelector('a[href="/relojes"]');
    expect(link).not.toBeNull();
    expect(text(link)).toBe('Reintentar');
  });

  test('sin slot actions no hay enlaces ni botones', async () => {
    expect((await notice()).querySelectorAll('a, button').length).toBe(NONE);
  });

  test('escribe texto, no HTML, en la propiedad title (RT-5: el aviso puede venir del servidor)', async () => {
    const body = await notice({ title: BOLD_INJECTION });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(text(body)).toContain(BOLD_INJECTION);
  });

  test('un título con una etiqueta de imagen y un manejador de eventos queda inerte', async () => {
    const body = await notice({ title: INJECTION });
    expect(body.querySelector('img')).toBeNull();
    expect(body.innerHTML).not.toContain('<img');
  });
});

// ------------------------------------------------------------------------------------------------ EmptyState

describe('EmptyState', () => {
  const empty = async (props: Record<string, unknown> = {}, slots: Record<string, string> = {}): Promise<HTMLElement> =>
    ui(EmptyState, { title: 'No encontramos relojes', ...props }, slots);

  test('el título es un h2 por defecto', async () => {
    const body = await empty();
    const heading = body.querySelector('h2');
    expect(heading).not.toBeNull();
    expect(text(heading)).toBe('No encontramos relojes');
  });

  test.each([TWO, THREE, FIVE - ONE] as const)('headingLevel=%i produce un <h%i>', async (level) => {
    const body = await empty({ headingLevel: level });
    expect(text(body.querySelector(`h${level}`))).toBe('No encontramos relojes');
    expect(body.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(ONE);
  });

  test.each([TWO, THREE, FIVE - ONE] as const)('nunca produce un h1 (headingLevel=%i): un solo h1 por página lo pone la vista', async (level) => {
    expect((await empty({ headingLevel: level })).querySelectorAll('h1').length).toBe(NONE);
  });

  test('muestra la descripción cuando se da', async () => {
    const body = await empty({ description: 'Prueba con otros filtros.' });
    expect(text(body)).toContain('Prueba con otros filtros.');
  });

  test('sin descripción no deja un párrafo vacío', async () => {
    const body = await empty();
    const emptyParagraphs = [...body.querySelectorAll('p')].filter((p) => text(p) === '');
    expect(emptyParagraphs).toEqual([]);
    expect(text(body)).toBe('No encontramos relojes');
  });

  test('con icon pinta un icono decorativo (aria-hidden); sin icon, ninguno', async () => {
    const withIcon = await empty({ icon: 'search' });
    const svg = withIcon.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect((await empty()).querySelectorAll('svg').length).toBe(NONE);
  });

  test('el slot action se proyecta tal cual (botón o enlace de salida)', async () => {
    const body = await empty({}, { action: '<a id="salida" href="/relojes">Ver todos los relojes</a>' });
    expect(text(body.querySelector('a#salida'))).toBe('Ver todos los relojes');
  });

  test('sin slot action no hay enlaces ni botones', async () => {
    expect((await empty()).querySelectorAll('a, button').length).toBe(NONE);
  });

  test('escribe texto, no HTML, en title y description', async () => {
    const body = await empty({ title: BOLD_INJECTION, description: INJECTION });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
    expect(text(body)).toContain(BOLD_INJECTION);
  });

  test('título y descripción no se escriben en mayúsculas en el HTML', async () => {
    const body = await empty({ description: 'Prueba con otros filtros.' });
    expect(text(body)).not.toBe(text(body).toUpperCase());
  });
});

// ------------------------------------------------------------------------------------------------ Skeleton

describe('Skeleton', () => {
  const VARIANTS = ['line', 'block', 'card'] as const;
  const skeleton = async (props: Record<string, unknown> = {}): Promise<HTMLElement> => ui(Skeleton, props);
  /** Hojas del esqueleto: los trazos de texto o bloques que se pintan; la raíz si no tiene hijos. */
  const parts = (el: Element): Element[] => {
    const leaves = [...el.querySelectorAll('*')].filter((e) => e.children.length === NONE);
    return leaves.length === NONE ? [el] : leaves;
  };

  test.each(VARIANTS)('variant="%s" es aria-hidden="true" (se oculta a lectores de pantalla)', async (variant) => {
    expect(root(await skeleton({ variant })).getAttribute('aria-hidden')).toBe('true');
  });

  test('por defecto (sin props) también es aria-hidden', async () => {
    expect(root(await skeleton()).getAttribute('aria-hidden')).toBe('true');
  });

  test('no contiene texto ni elementos interactivos ni role', async () => {
    const body = await skeleton({ variant: 'card' });
    expect(text(root(body))).toBe('');
    expect(body.querySelectorAll('a, button, input, [tabindex]').length).toBe(NONE);
    expect(root(body).hasAttribute('role')).toBe(false);
  });

  test('el defecto es variant="line"', async () => {
    expect(markers(root(await skeleton()))).toBe(markers(root(await skeleton({ variant: 'line' }))));
  });

  test.each(VARIANTS)('variant="%s" lo nombra', async (variant) => {
    expect(hasMarker(root(await skeleton({ variant })), variant)).toBe(true);
  });

  test('las tres variantes producen marcas distintas', async () => {
    const all = await Promise.all(VARIANTS.map(async (variant) => markers(root(await skeleton({ variant })))));
    expect(new Set(all).size).toBe(TOTAL_VARIANTS);
  });

  test('lines=1 (defecto) pinta un trazo; lines=3 pinta tres', async () => {
    expect(parts(root(await skeleton())).length).toBe(ONE);
    expect(parts(root(await skeleton({ lines: THREE }))).length).toBe(THREE);
    expect(parts(root(await skeleton({ lines: TWO }))).length).toBe(TWO);
  });

  test('width y height llegan al elemento como medidas (estilo en línea o variable)', async () => {
    const body = await skeleton({ variant: 'block', width: '60%', height: '120px' });
    const html = body.innerHTML;
    expect(html).toContain('60%');
    expect(html).toContain('120px');
  });

  test('sin width ni height no se escribe ninguna medida', async () => {
    const html = (await skeleton({ variant: 'block' })).innerHTML;
    expect(html).not.toContain('60%');
    expect(html).not.toContain('120px');
  });
});
