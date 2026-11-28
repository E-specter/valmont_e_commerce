import { describe, expect, test } from 'vitest';
import Button from '../../src/components/ui/Button.astro';
import Notice from '../../src/components/ui/Notice.astro';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-143 · Button (variantes `danger` y `ghost`, tamaño `sm`) y Notice (slot `actions`). Container API.
// El paquete no fija CÓMO se expresa una variante (clase o atributo): se comprueba con `markers()` (como T-117).
const NONE = 0;
const ONE = 1;
const VARIANTS = ['primary', 'dark', 'secondary', 'mint', 'danger', 'ghost'] as const;
const SIZES = ['md', 'lg', 'sm'] as const;

type Props = Record<string, unknown>;
const button = async (props: Props = {}, label = 'Acción'): Promise<Element> => root(await ui(Button, props, { default: label }));

describe('Button · variantes y tamaño nuevos', () => {
  test.each(['danger', 'ghost'] as const)('variant="%s" se nombra en el marcado', async (variant) => {
    expect(hasMarker(await button({ variant }), variant)).toBe(true);
  });

  test('las 6 variantes producen marcas distintas entre sí', async () => {
    const all = await Promise.all(VARIANTS.map(async (variant) => markers(await button({ variant }))));
    expect(new Set(all).size).toBe(VARIANTS.length);
  });

  test('size="sm" se nombra en el marcado y es distinto de md y lg', async () => {
    const all = await Promise.all(SIZES.map(async (size) => markers(await button({ size }))));
    expect(hasMarker(await button({ size: 'sm' }), 'sm')).toBe(true);
    expect(new Set(all).size).toBe(SIZES.length);
  });

  test.each(['danger', 'ghost'] as const)('%s sigue siendo un <button type="button"> con su texto (nunca solo color)', async (variant) => {
    const el = await button({ variant }, 'Cancelar pedido');
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
    expect(text(el)).toBe('Cancelar pedido');
  });

  test('danger puede ser de envío y se deshabilita con `disabled`', async () => {
    const el = await button({ variant: 'danger', type: 'submit', disabled: true });
    expect(el.getAttribute('type')).toBe('submit');
    expect(el.hasAttribute('disabled')).toBe(true);
  });

  test('danger cargando: aria-busy, deshabilitado y texto "Cargando" para lectores', async () => {
    const el = await button({ variant: 'danger', loading: true, type: 'submit' });
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(text(el)).toContain('Cargando');
  });

  test('ghost como enlace: <a href>; deshabilitado pierde el href y marca aria-disabled', async () => {
    const live = await button({ variant: 'ghost', href: '/x' });
    expect(live.tagName).toBe('A');
    expect(live.getAttribute('href')).toBe('/x');
    const off = await button({ variant: 'ghost', href: '/x', disabled: true });
    expect(off.hasAttribute('href')).toBe(false);
    expect(off.getAttribute('aria-disabled')).toBe('true');
  });

  test('sm + danger se combinan: ambas marcas presentes', async () => {
    const el = await button({ variant: 'danger', size: 'sm' });
    expect(hasMarker(el, 'danger')).toBe(true);
    expect(hasMarker(el, 'sm')).toBe(true);
  });

  test('un aria-label hostil se escapa (no inyecta marcado)', async () => {
    const el = await button({ variant: 'danger', 'aria-label': '"><img src=x onerror=alert(1)>' });
    expect(el.ownerDocument.querySelector('img')).toBeNull();
  });
});

describe('Notice · slot nombrado `actions`', () => {
  const notice = async (props: Props = {}, slots: Record<string, string> = { default: 'Mensaje del aviso' }): Promise<Element> =>
    root(await ui(Notice, props, slots));

  test.each(['info', 'warning', 'error'] as const)('tone="%s" con acciones: las pinta dentro del aviso, después del mensaje', async (tone) => {
    const el = await notice({ tone }, { default: 'Mensaje del aviso', actions: '<a href="/r">Reintentar</a>' });
    const link = el.querySelector('a[href="/r"]');
    expect(link, 'sin la acción').not.toBeNull();
    expect(text(link)).toBe('Reintentar');
    // orden del DOM: primero el mensaje, luego la acción (orden de lectura y de tabulación)
    expect(text(el).indexOf('Mensaje del aviso')).toBeLessThan(text(el).indexOf('Reintentar'));
  });

  test('la acción no queda dentro del contenedor del mensaje (no se lee como parte del texto)', async () => {
    const el = await notice({ tone: 'error' }, { default: '<p>Mensaje del aviso</p>', actions: '<button type="button">Reintentar</button>' });
    const message = el.querySelector('p');
    expect(message?.closest('div')?.textContent ?? '').not.toContain('Reintentar');
  });

  test('conserva un único role (el de la raíz) aunque haya acciones', async () => {
    const body = await ui(Notice, { tone: 'error' }, { default: 'Falló', actions: '<button type="button">Reintentar</button>' });
    expect(body.querySelectorAll('[role="alert"], [role="status"]').length).toBe(ONE);
    expect(root(body).getAttribute('role')).toBe('alert');
  });

  test('sin el slot `actions` no hay contenedor vacío de acciones', async () => {
    const el = await notice({ tone: 'error' });
    expect(el.querySelectorAll('button, a, [class*="action"]').length).toBe(NONE);
  });

  test('admite varias acciones (primaria y secundaria) y conserva su orden', async () => {
    const el = await notice({ tone: 'warning' }, { default: 'Aviso', actions: '<a href="/a">Primera</a><a href="/b">Segunda</a>' });
    const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/a', '/b']);
  });

  test('el contenido de `actions` se inserta como marcado del slot, no como texto escapado; el texto de las props sí se escapa', async () => {
    const body = await ui(Notice, { tone: 'info', title: '<b id="pwn">t</b>' }, { default: 'x', actions: '<a href="/ok">Ok</a>' });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(body.querySelector('a[href="/ok"]')).not.toBeNull();
  });
});
