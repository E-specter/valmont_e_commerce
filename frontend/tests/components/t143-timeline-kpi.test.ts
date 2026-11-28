import { describe, expect, test } from 'vitest';
import KpiCard from '../../src/components/admin/KpiCard.astro';
import Timeline from '../../src/components/ui/Timeline.astro';
import { markers, root, text, ui } from '../helpers/ui';

// T-143 · Timeline (historial en orden) y KpiCard (data, pending «Sin contrato», error «No disponible»).
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const HOSTILE = '<img id="pwn" src=x onerror=alert(1)>';

type Item = { title: string; at: string; note?: string | null; actor?: string; current?: boolean };
const ITEMS: Item[] = [
  { title: 'Pedido creado', at: '27/11/2026 15:04', actor: 'Cliente' },
  { title: 'Pagado', at: '27/11/2026 15:06', actor: 'Sistema' },
  { title: 'En preparación', at: '27/11/2026 16:10', note: 'Embalaje con caja de regalo', actor: 'Administrador', current: true },
];
const timeline = (props: Record<string, unknown> = {}): Promise<HTMLElement> => ui(Timeline, { label: 'Historial del pedido', items: ITEMS, ...props });
const entries = (body: ParentNode): Element[] => [...body.querySelectorAll('li')];

describe('Timeline', () => {
  test('es una lista ordenada con nombre accesible (label)', async () => {
    const body = await timeline();
    const list = body.querySelector('ol');
    expect(list, 'sin <ol>').not.toBeNull();
    const name = list?.getAttribute('aria-label') ?? text(body.ownerDocument.getElementById(list?.getAttribute('aria-labelledby') ?? ''));
    expect(name).toBe('Historial del pedido');
  });

  test('una <li> por evento, en el orden recibido, con título y fecha ya formateada tal cual', async () => {
    const lis = entries(await timeline());
    expect(lis.length).toBe(THREE);
    expect(lis.map((li) => ITEMS.findIndex((it) => text(li).includes(it.title)))).toEqual([NONE, ONE, TWO]);
    expect(text(lis[NONE])).toContain('27/11/2026 15:04');
    expect(text(lis[TWO])).toContain('27/11/2026 16:10');
  });

  test('no reformatea ni interpreta `at` (llega ya formateada)', async () => {
    const lis = entries(await timeline({ items: [{ title: 'T', at: 'hoy a las tres' }] }));
    expect(text(lis[NONE])).toContain('hoy a las tres');
  });

  test('la nota y el actor se pintan cuando existen', async () => {
    const last = entries(await timeline())[TWO];
    expect(text(last)).toContain('Embalaje con caja de regalo');
    expect(text(last)).toContain('Administrador');
  });

  test('sin nota (undefined o null) no se pinta nada de más: el texto del evento es solo título, fecha y actor', async () => {
    const withNull = text(entries(await timeline({ items: [{ title: 'Pagado', at: '1', note: null, actor: 'Sistema' }] }))[NONE]);
    const without = text(entries(await timeline({ items: [{ title: 'Pagado', at: '1', actor: 'Sistema' }] }))[NONE]);
    expect(withNull).toBe(without);
    expect(withNull).not.toContain('null');
    expect(withNull).not.toContain('undefined');
  });

  test('sin actor no aparece «undefined»', async () => {
    const body = await timeline({ items: [{ title: 'Pagado', at: '1' }] });
    expect(text(body)).not.toContain('undefined');
  });

  test('el nodo actual no se distingue solo por color: aria-current o texto para lectores, solo en él', async () => {
    const lis = entries(await timeline());
    const currentMarks = lis.map((li) => li.hasAttribute('aria-current') || li.querySelector('[aria-current], .sr-only') !== null);
    expect(currentMarks).toEqual([false, false, true]);
  });

  test('sin item actual ninguno lleva aria-current', async () => {
    const body = await timeline({ items: ITEMS.map((it) => ({ ...it, current: false })) });
    expect(body.querySelectorAll('[aria-current]').length).toBe(NONE);
  });

  test('el marcador del evento es decorativo (aria-hidden) y no añade texto', async () => {
    const li = entries(await timeline())[NONE];
    const marks = li.querySelectorAll('[aria-hidden="true"]');
    expect(marks.length).toBeGreaterThan(NONE);
    marks.forEach((m) => expect(text(m)).toBe(''));
  });

  test('lista vacía: sigue siendo una <ol> sin <li> y no falla', async () => {
    const body = await timeline({ items: [] });
    expect(entries(body).length).toBe(NONE);
  });

  test('texto del servidor (título, nota, actor) se escapa: nunca se interpreta como marcado', async () => {
    const body = await timeline({ items: [{ title: HOSTILE, at: '1', note: HOSTILE, actor: HOSTILE }] });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(text(body)).toContain('<img id="pwn"');
  });
});

describe('KpiCard', () => {
  const card = async (props: Record<string, unknown>): Promise<HTMLElement> => ui(KpiCard, props);
  const labelledWith = (body: ParentNode, ...words: string[]): boolean =>
    [...body.querySelectorAll('[aria-label]')].some((el) => words.every((w) => (el.getAttribute('aria-label') ?? '').includes(w)));

  test('data (por defecto): muestra etiqueta, valor y pista', async () => {
    const body = await card({ label: 'Pedidos por preparar', value: '12', hint: 'Pagados sin enviar' });
    expect(text(body)).toContain('Pedidos por preparar');
    expect(text(body)).toContain('12');
    expect(text(body)).toContain('Pagados sin enviar');
    expect(text(body)).not.toContain('Sin contrato');
    expect(text(body)).not.toContain('No disponible');
  });

  test('state="data" explícito es idéntico al valor por defecto', async () => {
    const props = { label: 'Ventas', value: 'S/ 84,500' };
    expect(markers(root(await card({ ...props, state: 'data' })))).toBe(markers(root(await card(props))));
  });

  test('pending: texto visible «Sin contrato» y aria-label completo (etiqueta + «Sin contrato»)', async () => {
    const body = await card({ label: 'Ingresos del mes', state: 'pending' });
    expect(text(body)).toContain('Sin contrato');
    expect(labelledWith(body, 'Ingresos del mes', 'Sin contrato'), 'sin aria-label completo').toBe(true);
  });

  test('pending no pinta el valor aunque se reciba', async () => {
    const body = await card({ label: 'Ingresos del mes', value: 'S/ 999', state: 'pending' });
    expect(text(body)).not.toContain('S/ 999');
  });

  test('pending se distingue de data en el marcado (borde discontinuo por CSS) y no solo por color', async () => {
    const data = markers(root(await card({ label: 'A', value: '1' })));
    const pending = markers(root(await card({ label: 'A', state: 'pending' })));
    expect(pending).not.toBe(data);
  });

  test('error: ofrece el texto «No disponible» y no pinta el valor', async () => {
    const body = await card({ label: 'Pedidos por preparar', value: '12', state: 'error' });
    expect(text(body)).toContain('No disponible');
    expect(text(body)).not.toContain('12');
  });

  test('error: el estado llega a lectores de pantalla (texto o aria-label con «No disponible»)', async () => {
    const body = await card({ label: 'Pedidos por preparar', state: 'error' });
    expect(text(body).includes('No disponible') || labelledWith(body, 'No disponible')).toBe(true);
  });

  test('los 3 estados producen marcas distintas', async () => {
    const all = await Promise.all((['data', 'pending', 'error'] as const).map(async (state) => markers(root(await card({ label: 'A', value: '1', state })))));
    expect(new Set(all).size).toBe(THREE);
  });

  test('con href la tarjeta es un enlace; sin href no hay enlace', async () => {
    const linked = await card({ label: 'Pedidos', value: '3', href: '/admin/pedidos' });
    expect(linked.querySelector('a')?.getAttribute('href')).toBe('/admin/pedidos');
    expect((await card({ label: 'Pedidos', value: '3' })).querySelectorAll('a').length).toBe(NONE);
  });

  test('el enlace no duplica el nombre: un solo <a> y con texto accesible', async () => {
    const body = await card({ label: 'Pedidos', value: '3', href: '/admin/pedidos' });
    expect(body.querySelectorAll('a').length).toBe(ONE);
    expect(text(body.querySelector('a')) !== '' || (body.querySelector('a')?.getAttribute('aria-label') ?? '') !== '').toBe(true);
  });

  test('texto del servidor (etiqueta, valor, pista) se escapa', async () => {
    const body = await card({ label: HOSTILE, value: HOSTILE, hint: HOSTILE });
    expect(body.querySelector('#pwn')).toBeNull();
  });
});
