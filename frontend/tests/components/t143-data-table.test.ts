import { describe, expect, test } from 'vitest';
import DataTable from '../../src/components/ui/DataTable.astro';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-143 · DataTable (STATUS «T-143 › Firmas públicas»): `<table>` real con `<caption>`, `scope="col"`, región desplazable y enfocable.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const MANY_COLUMNS = 14;
const CAPTION = 'Pedidos recientes';
const WIDTH = '7rem';
const COLUMNS = [
  { key: 'number', header: 'Pedido' },
  { key: 'total', header: 'Total', align: 'end' },
  { key: 'actions', header: 'Acciones', hideHeader: true, width: WIDTH },
] as const;
const ROWS = '<tr><td>VAL-000123</td><td>S/ 84,500</td><td><a href="/p/1">Ver</a></td></tr><tr><td>VAL-000124</td><td>S/ 12,000</td><td><a href="/p/2">Ver</a></td></tr>';

type Props = Record<string, unknown>;
const table = (props: Props = {}, rows = ROWS): Promise<HTMLElement> => ui(DataTable, { columns: COLUMNS, caption: CAPTION, ...props }, { default: rows });
const ths = (body: ParentNode): Element[] => [...body.querySelectorAll('thead th')];

describe('DataTable · estructura semántica', () => {
  test('es una única <table> real: sin role presentation/none ni tablas anidadas', async () => {
    const body = await table();
    expect(body.querySelectorAll('table').length).toBe(ONE);
    expect(body.querySelectorAll('[role="presentation"], [role="none"], [role="grid"]').length).toBe(NONE);
    expect(body.querySelector('table table')).toBeNull();
  });

  test('<caption> es el primer hijo de la tabla y trae el texto recibido', async () => {
    const t = (await table()).querySelector('table')!;
    expect(t.firstElementChild?.tagName).toBe('CAPTION');
    expect(text(t.querySelector('caption'))).toBe(CAPTION);
  });

  test('el caption está oculto a la vista pero presente para lectores (clase sr-only, no display:none ni hidden)', async () => {
    const cap = (await table()).querySelector('caption')!;
    const hiddenByAttr = cap.hasAttribute('hidden') || cap.getAttribute('aria-hidden') === 'true';
    expect(hiddenByAttr, 'el caption se quita del árbol de accesibilidad').toBe(false);
    expect(cap.classList.contains('sr-only') || cap.querySelector('.sr-only') !== null, 'sin clase sr-only').toBe(true);
  });

  test('cabecera: un <th scope="col"> por columna, en orden, dentro de <thead> y ningún <td> en la cabecera', async () => {
    const body = await table();
    const heads = ths(body);
    expect(heads.length).toBe(COLUMNS.length);
    expect(heads.map((h) => h.getAttribute('scope'))).toEqual(['col', 'col', 'col']);
    expect(heads.map((h) => text(h))).toEqual(['Pedido', 'Total', 'Acciones']);
    expect(body.querySelectorAll('thead td').length).toBe(NONE);
    expect(body.querySelectorAll('thead').length).toBe(ONE);
  });

  test('hideHeader: la cabecera sigue en el DOM y en el árbol de accesibilidad (solo se oculta a la vista)', async () => {
    const th = ths(await table())[TWO];
    expect(text(th)).toBe('Acciones');
    expect(th.hasAttribute('hidden')).toBe(false);
    expect(th.getAttribute('aria-hidden')).not.toBe('true');
    expect(th.classList.contains('sr-only') || th.querySelector('.sr-only') !== null, 'sin ocultación visual (sr-only)').toBe(true);
  });

  test('las filas del slot caen en <tbody>, intactas y en su orden', async () => {
    const body = await table();
    const rows = [...body.querySelectorAll('tbody tr')];
    expect(rows.length).toBe(TWO);
    expect(text(rows[0])).toContain('VAL-000123');
    expect(rows[ONE].querySelector('a')?.getAttribute('href')).toBe('/p/2');
    expect(body.querySelectorAll('thead tr').length).toBe(ONE);
  });

  test('sin filas: sigue la cabecera y el <tbody> no tiene filas (el estado vacío lo pinta la página)', async () => {
    const body = await table({}, '');
    expect(ths(body).length).toBe(COLUMNS.length);
    expect(body.querySelectorAll('tbody tr').length).toBe(NONE);
  });

  test('una sola columna también funciona', async () => {
    const body = await ui(DataTable, { columns: [{ key: 'a', header: 'Solo' }], caption: 'Una' }, { default: '<tr><td>x</td></tr>' });
    expect(ths(body).length).toBe(ONE);
    expect(ths(body)[NONE].getAttribute('scope')).toBe('col');
  });

  test('con muchas columnas hay una <th scope="col"> por cada una', async () => {
    const many = Array.from({ length: MANY_COLUMNS }, (_, i) => ({ key: `c${String(i)}`, header: `Col ${String(i)}` }));
    const body = await ui(DataTable, { columns: many, caption: 'Ancha' });
    expect(ths(body).length).toBe(many.length);
  });
});

describe('DataTable · región desplazable y enfocable', () => {
  test('la tabla va dentro de un contenedor con tabindex="0", role="region" y nombre accesible', async () => {
    const t = (await table()).querySelector('table')!;
    const region = t.closest('[tabindex]');
    expect(region, 'sin región enfocable').not.toBeNull();
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(region?.getAttribute('role')).toBe('region');
    const labelled = region?.getAttribute('aria-labelledby');
    const name = region?.getAttribute('aria-label') ?? text(labelled ? region?.ownerDocument.getElementById(labelled) : null);
    expect(name, 'la región no tiene nombre').not.toBe('');
  });

  test('la tabla en sí no es enfocable (el foco va a la región, no a cada celda)', async () => {
    const t = (await table()).querySelector('table')!;
    expect(t.hasAttribute('tabindex')).toBe(false);
  });
});

describe('DataTable · alineación, ancho y densidad', () => {
  test('align="end" marca la cabecera; sin align (start) no lleva la marca de fin', async () => {
    const heads = ths(await table());
    expect(hasMarker(heads[ONE], 'end')).toBe(true);
    expect(hasMarker(heads[NONE], 'end')).toBe(false);
  });

  test.each(['start', 'end', 'center'] as const)('align="%s" se distingue en el marcado', async (align) => {
    const all = await Promise.all(
      (['start', 'end', 'center'] as const).map(async (a) => markers(ths(await table({ columns: [{ key: 'a', header: 'A', align: a }] }))[NONE])),
    );
    expect(new Set(all).size).toBe(THREE);
    expect(hasMarker(ths(await table({ columns: [{ key: 'a', header: 'A', align }] }))[NONE], align)).toBe(true);
  });

  test('width se aplica a la columna (valor tal cual en el marcado)', async () => {
    const html = (await table()).innerHTML;
    expect(html).toContain(WIDTH);
  });

  test('density: md por defecto; lg se distingue (en la tabla o en su región) y md explícito es idéntico al defecto', async () => {
    // La densidad puede vivir en la región o en la <table>: se comparan las marcas de ambas.
    const all = async (props: Props): Promise<string> => {
      const body = await table(props);
      return `${markers(root(body))} | ${markers(body.querySelector('table')!)}`;
    };
    const md = await all({});
    expect(await all({ density: 'md' })).toBe(md);
    expect(await all({ density: 'lg' })).not.toBe(md);
  });
});

describe('DataTable · seguridad', () => {
  const HOSTILE = '<img id="pwn" src=x onerror=alert(1)>';

  test('cabeceras y caption del servidor se escapan', async () => {
    const body = await ui(DataTable, { columns: [{ key: 'a', header: HOSTILE }], caption: HOSTILE });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(text(body.querySelector('caption'))).toBe(HOSTILE);
    expect(text(body.querySelector('th'))).toBe(HOSTILE);
  });

  test('un width hostil no abre el atributo style ni inyecta marcado', async () => {
    const body = await ui(DataTable, { columns: [{ key: 'a', header: 'A', width: '1px" onmouseover="alert(1)' }], caption: 'x' });
    expect(body.querySelector('[onmouseover]')).toBeNull();
  });
});
