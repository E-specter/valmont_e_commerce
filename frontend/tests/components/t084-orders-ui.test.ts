import { describe, expect, test } from 'vitest';
import OrderFilters from '../../src/components/admin/OrderFilters.astro';
import OrdersTable from '../../src/components/admin/OrdersTable.astro';
import { ORDER_STATUSES, ORDER_STATUS_LABEL, orderPill } from '../../src/lib/admin/status';
import type { OrderStatus } from '../../src/lib/api/admin-orders';
import { formatDateTimeNumeric, formatMoney } from '../../src/lib/format';
import { text, ui } from '../helpers/ui';
import { fieldErrorText } from '../helpers/t129';
import {
  AT_LIMA, AT_UTC, HOSTILE, NIGHT_LIMA, NIGHT_UTC, ORDER_ID, OTHER_USER, PICKUP_TEXT, manyOrders, money, onePerStatus, summary,
} from '../helpers/t084';

// T-084 · Container API de OrderFilters y OrdersTable (firmas de STATUS ui §10.7 T-084). Sin red.
const NONE = 0;
const ONE = 1;
const THREE = 3;
const NINE = 9;
const MIN_COLUMNS = 7;
const WHOLE = 8_450_000;
const WITH_CENTS = 1_062_550;
const ONE_SOL = 100;
const FIVE_CENTS = 5;
const ACTION = '/admin/pedidos';
const STATUS_HREF = (s: OrderStatus | null): string => (s ? `/admin/pedidos?status=${s}&q=ana` : '/admin/pedidos?q=ana');
const FULL_BACK = 'created_from=2026-11-01&page=2&q=Ana&status=pagado';

const renderFilters = (p: {
  values?: { status?: OrderStatus; q?: string; created_from?: string; created_to?: string };
  errors?: { q?: string; created_from?: string; created_to?: string };
  action?: string;
  hrefForStatus?: (s: OrderStatus | null) => string;
}) => ui(OrderFilters, { values: {}, action: ACTION, hrefForStatus: STATUS_HREF, ...p });
const renderTable = (items = [summary()], backQuery = '') => ui(OrdersTable, { items, backQuery });

const input = (b: ParentNode, name: string): HTMLInputElement | null => b.querySelector(`input[name="${name}"]`);
const links = (b: ParentNode): HTMLAnchorElement[] => [...b.querySelectorAll('a')] as HTMLAnchorElement[];
const linkNamed = (b: ParentNode, label: string): HTMLAnchorElement | undefined => links(b).find((a) => text(a) === label);
const rows = (b: ParentNode): Element[] => [...b.querySelectorAll('tbody tr')];
const params = (href: string): URLSearchParams => new URL(href, 'http://x.test').searchParams;

/** Controles con nombre del formulario que viajarían al enviarlo (lo que el navegador manda sin JavaScript). */
function submitted(b: ParentNode): Record<string, string> {
  const form = b.querySelector('form');
  const out: Record<string, string> = {};
  form?.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    const i = el as HTMLInputElement;
    if (i.disabled) return;
    if ((i.type === 'checkbox' || i.type === 'radio') && !i.checked) return;
    if (i.value !== '') out[i.name] = i.value;
  });
  return out;
}

describe('OrderFilters · formulario GET que funciona sin JavaScript', () => {
  test('es un form method=get hacia la acción dada, sin cuerpo ni token oculto de otra cosa', async () => {
    const b = await renderFilters({});
    const form = b.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form?.getAttribute('action')).toBe(ACTION);
    expect(b.querySelector('form[method="post" i]')).toBeNull();
  });

  test('«Número o destinatario» es un input type=search name=q con su label', async () => {
    const b = await renderFilters({});
    const q = input(b, 'q');
    expect(q?.getAttribute('type')).toBe('search');
    const label = b.querySelector(`label[for="${q?.id}"]`);
    expect(text(label)).toContain('Número o destinatario');
  });

  test('«Desde» y «Hasta» son input type=date (created_from y created_to) con su label', async () => {
    const b = await renderFilters({});
    const pairs: [string, string][] = [['created_from', 'Desde'], ['created_to', 'Hasta']];
    pairs.forEach(([name, label]) => {
      const el = input(b, name);
      expect(el?.getAttribute('type'), name).toBe('date');
      expect(text(b.querySelector(`label[for="${el?.id}"]`)), name).toContain(label);
    });
  });

  test('los valores recibidos se conservan en los campos', async () => {
    const b = await renderFilters({ values: { q: 'Ana', created_from: '2026-11-01', created_to: '2026-11-27' } });
    expect(input(b, 'q')?.getAttribute('value')).toBe('Ana');
    expect(input(b, 'created_from')?.getAttribute('value')).toBe('2026-11-01');
    expect(input(b, 'created_to')?.getAttribute('value')).toBe('2026-11-27');
  });

  test('sin valores los campos salen vacíos', async () => {
    const sent = submitted(await renderFilters({}));
    expect(sent).toEqual({});
  });

  test('«Aplicar» es un botón de envío', async () => {
    const b = await renderFilters({});
    const apply = [...b.querySelectorAll('button')].find((x) => text(x).includes('Aplicar'));
    expect(apply).toBeDefined();
    expect(apply?.getAttribute('type')).not.toBe('button');
  });

  test('«Limpiar filtros» lleva a la página sin consulta', async () => {
    const b = await renderFilters({ values: { status: 'pagado', q: 'Ana' } });
    const clear = linkNamed(b, 'Limpiar filtros');
    expect(clear).toBeDefined();
    const target = new URL(clear?.getAttribute('href') ?? '', 'http://x.test');
    expect(target.pathname).toBe(ACTION);
    expect(target.search).toBe('');
  });

  test('con un estado activo, enviar el formulario lo conserva (status viaja en el envío)', async () => {
    const sent = submitted(await renderFilters({ values: { status: 'enviado', q: 'Ana' } }));
    expect(sent.status).toBe('enviado');
    expect(sent.q).toBe('Ana');
  });

  test('el formulario nunca envía `page` ni `page_size`: cambiar un filtro vuelve a la página 1', async () => {
    const sent = submitted(await renderFilters({ values: { status: 'pagado', q: 'x', created_from: '2026-11-01', created_to: '2026-11-02' } }));
    expect(Object.keys(sent)).not.toContain('page');
    expect(Object.keys(sent)).not.toContain('page_size');
  });

  test('valor hostil en q: se escapa, no inyecta elementos', async () => {
    const b = await renderFilters({ values: { q: HOSTILE } });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('img')).toBeNull();
    expect(input(b, 'q')?.getAttribute('value')).toBe(HOSTILE);
  });
});

describe('OrderFilters · chips de estado', () => {
  test('«Todos» y los 8 estados, en ese orden, como enlaces', async () => {
    const b = await renderFilters({});
    const chips = links(b).filter((a) => ['Todos', ...ORDER_STATUSES.map((s) => ORDER_STATUS_LABEL[s])].includes(text(a)));
    expect(chips.map((a) => text(a))).toEqual(['Todos', ...ORDER_STATUSES.map((s) => ORDER_STATUS_LABEL[s])]);
    expect(chips).toHaveLength(NINE);
  });

  test('cada chip apunta a lo que devuelve hrefForStatus (null para «Todos»)', async () => {
    const b = await renderFilters({});
    expect(linkNamed(b, 'Todos')?.getAttribute('href')).toBe(STATUS_HREF(null));
    ORDER_STATUSES.forEach((s) => expect(linkNamed(b, ORDER_STATUS_LABEL[s])?.getAttribute('href'), s).toBe(STATUS_HREF(s)));
  });

  test.each(ORDER_STATUSES)('con status=%s solo ese chip está activo (aria-current)', async (status) => {
    const b = await renderFilters({ values: { status } });
    const active = links(b).filter((a) => a.hasAttribute('aria-current') && a.getAttribute('aria-current') !== 'false');
    expect(active.map((a) => text(a))).toEqual([ORDER_STATUS_LABEL[status]]);
  });

  test('sin estado, «Todos» es el activo', async () => {
    const b = await renderFilters({});
    const active = links(b).filter((a) => a.hasAttribute('aria-current') && a.getAttribute('aria-current') !== 'false');
    expect(active.map((a) => text(a))).toEqual(['Todos']);
  });

  test('el chip activo se distingue por algo más que el color (atributo accesible, no solo estilo)', async () => {
    const b = await renderFilters({ values: { status: 'pagado' } });
    expect(linkNamed(b, 'Pagado')?.getAttribute('aria-current')).toBeTruthy();
    expect(linkNamed(b, 'Enviado')?.getAttribute('aria-current')).toBeNull();
  });
});

describe('OrderFilters · errores por campo (422 de q, fechas)', () => {
  test.each([
    ['q', 'La búsqueda no es válida.'],
    ['created_from', 'La fecha inicial no es válida.'],
    ['created_to', 'La fecha final no es válida.'],
  ])('error de %s: aria-invalid, mensaje enlazado por aria-describedby y visible', async (name, message) => {
    const b = await renderFilters({ errors: { [name]: message } });
    const el = input(b, name);
    expect(el?.getAttribute('aria-invalid')).toBe('true');
    expect(fieldErrorText(b, el as Element)).toContain(message);
  });

  test('sin errores ningún campo se marca inválido', async () => {
    const b = await renderFilters({});
    b.querySelectorAll('input').forEach((el) => expect(el.getAttribute('aria-invalid')).not.toBe('true'));
  });

  test('un error en un campo no marca los otros', async () => {
    const b = await renderFilters({ errors: { q: 'mal' } });
    expect(input(b, 'created_from')?.getAttribute('aria-invalid')).not.toBe('true');
    expect(input(b, 'created_to')?.getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('OrdersTable · estructura y accesibilidad', () => {
  test('una tabla con caption, encabezados de columna (th scope=col) no vacíos y una fila por pedido', async () => {
    const b = await renderTable(manyOrders(THREE));
    expect(b.querySelectorAll('table')).toHaveLength(ONE);
    expect(text(b.querySelector('caption'))).not.toBe('');
    const heads = [...b.querySelectorAll('thead th')];
    expect(heads.length).toBeGreaterThanOrEqual(MIN_COLUMNS);
    heads.forEach((th) => {
      expect(th.getAttribute('scope')).toBe('col');
      expect(text(th)).not.toBe('');
    });
    expect(rows(b)).toHaveLength(THREE);
  });

  test('cada fila tiene id="o-{id}" (el foco vuelve a ella desde el detalle)', async () => {
    const items = manyOrders(THREE);
    const b = await renderTable(items);
    expect(rows(b).map((r) => r.id)).toEqual(items.map((o) => `o-${o.id}`));
  });

  test('el enlace del número es el único elemento enfocable de la fila', async () => {
    const b = await renderTable([summary()]);
    const focusable = rows(b)[NONE].querySelectorAll('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(focusable).toHaveLength(ONE);
    expect(text(focusable[NONE])).toBe('VAL-000123');
  });

  test('el enlace del número va a /admin/pedidos/{id} y lleva la consulta actual en volver', async () => {
    const b = await renderTable([summary()], FULL_BACK);
    const a = rows(b)[NONE].querySelector('a') as HTMLAnchorElement;
    const url = new URL(a.getAttribute('href') ?? '', 'http://x.test');
    expect(url.pathname).toBe(`/admin/pedidos/${ORDER_ID}`);
    expect(url.searchParams.get('volver')).toBe(FULL_BACK);
  });

  test('con consulta vacía, volver no lleva nada (ni «undefined»)', async () => {
    const b = await renderTable([summary()], '');
    const a = rows(b)[NONE].querySelector('a') as HTMLAnchorElement;
    const url = new URL(a.getAttribute('href') ?? '', 'http://x.test');
    expect(url.pathname).toBe(`/admin/pedidos/${ORDER_ID}`);
    expect(url.searchParams.get('volver') ?? '').toBe('');
    expect(a.getAttribute('href')).not.toContain('undefined');
  });

  test('volver se codifica: los & y = de la consulta no parten el enlace', async () => {
    const b = await renderTable([summary()], FULL_BACK);
    const href = (rows(b)[NONE].querySelector('a') as HTMLAnchorElement).getAttribute('href') ?? '';
    expect([...params(href).keys()]).toEqual(['volver']);
  });

  test('desplazable y enfocable en ancho estrecho (DataTable)', async () => {
    const b = await renderTable([summary()]);
    const region = b.querySelector('[role="region"]');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(region?.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('OrdersTable · estados, importes y fechas', () => {
  test('los 8 estados se pintan con StatusPill: texto del estado y tono del contrato', async () => {
    const b = await renderTable(onePerStatus());
    const pills = [...b.querySelectorAll('.pill')];
    expect(pills.map((p) => text(p))).toEqual(ORDER_STATUSES.map((s) => ORDER_STATUS_LABEL[s]));
    ORDER_STATUSES.forEach((s, i) => expect(pills[i].getAttribute('data-tone'), s).toBe(orderPill(s).tone));
  });

  test('el estado nunca es solo color: cada pill lleva su texto', async () => {
    const b = await renderTable(onePerStatus());
    b.querySelectorAll('.pill').forEach((p) => expect(text(p).length).toBeGreaterThan(NONE));
  });

  test.each([
    [WHOLE, 'S/ 84,500'],
    [WITH_CENTS, 'S/ 10,625.50'],
    [ONE_SOL, 'S/ 1'],
    [FIVE_CENTS, 'S/ 0.05'],
  ])('el total %i céntimos se pinta con formatMoney (%s)', async (amount, shown) => {
    const b = await renderTable([summary({ total: money(amount) })]);
    const expected = formatMoney(money(amount));
    expect(expected.replaceAll(' ', ' ')).toBe(shown); // Intl separa «S/» con un espacio de no ruptura
    const cells = [...rows(b)[NONE].querySelectorAll('td')].map((c) => text(c));
    expect(cells).toContain(shown); // la celda del total es exactamente el importe
  });

  test('importe entero: sin ".00" fijo (D-B6 B)', async () => {
    const b = await renderTable([summary({ total: money(WHOLE) })]);
    expect(text(rows(b)[NONE])).not.toContain('.00');
  });

  test('«creado» sale como dd/mm/aaaa hh:mm en hora de Lima (UTC-5)', async () => {
    const b = await renderTable([summary({ created_at: AT_UTC })]);
    expect(formatDateTimeNumeric(AT_UTC)).toBe(AT_LIMA);
    expect(text(rows(b)[NONE])).toContain(AT_LIMA);
  });

  test('de madrugada en UTC sigue siendo el día anterior en Lima', async () => {
    const b = await renderTable([summary({ created_at: NIGHT_UTC })]);
    expect(text(rows(b)[NONE])).toContain(NIGHT_LIMA);
    expect(text(rows(b)[NONE])).not.toContain('10/03/2026');
  });

  test('las unidades (item_count) aparecen en la fila', async () => {
    const b = await renderTable([summary({ item_count: NINE })]);
    const cells = [...rows(b)[NONE].querySelectorAll('td')].map((c) => text(c));
    expect(cells).toContain(String(NINE));
  });

  test('destinatario y número son texto de la fila', async () => {
    const b = await renderTable([summary({ recipient_name: 'Lucía Fernández', number: 'VAL-000777' })]);
    const row = text(rows(b)[NONE]);
    expect(row).toContain('Lucía Fernández');
    expect(row).toContain('VAL-000777');
  });
});

describe('OrdersTable · distrito, recojo y «Vence»', () => {
  test('con distrito se pinta el distrito y no «Recojo en tienda»', async () => {
    const b = await renderTable([summary({ district: 'San Isidro' })]);
    expect(text(rows(b)[NONE])).toContain('San Isidro');
    expect(text(rows(b)[NONE])).not.toContain(PICKUP_TEXT);
  });

  test('district null → «Recojo en tienda» (H-B9)', async () => {
    const b = await renderTable([summary({ district: null })]);
    expect(text(rows(b)[NONE])).toContain(PICKUP_TEXT);
  });

  test('«Vence …» solo en pendiente_pago con expires_at, con la fecha de Lima', async () => {
    const expires = '2026-11-28T20:04:00Z';
    const b = await renderTable([summary({ status: 'pendiente_pago', expires_at: expires })]);
    const row = text(rows(b)[NONE]);
    expect(row).toContain('Vence');
    expect(row).toContain(formatDateTimeNumeric(expires));
    expect(row).toContain('28/11/2026 15:04');
  });

  test.each(ORDER_STATUSES.filter((s) => s !== 'pendiente_pago'))('%s no muestra «Vence» aunque llegue expires_at', async (status) => {
    const b = await renderTable([summary({ status, expires_at: '2026-11-28T20:04:00Z' })]);
    expect(text(rows(b)[NONE])).not.toContain('Vence');
  });

  test('pendiente_pago sin expires_at no muestra «Vence» ni «null»', async () => {
    const b = await renderTable([summary({ status: 'pendiente_pago', expires_at: null })]);
    const row = text(rows(b)[NONE]);
    expect(row).not.toContain('Vence');
    expect(row).not.toContain('null');
  });
});

describe('OrdersTable · texto del servidor y privacidad', () => {
  test('recipient_name hostil se pinta como texto: sin elementos ni scripts inyectados', async () => {
    const b = await renderTable([summary({ recipient_name: HOSTILE })]);
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('img')).toBeNull();
    expect(text(rows(b)[NONE])).toContain(HOSTILE);
  });

  test('number hostil tampoco inyecta HTML', async () => {
    const b = await renderTable([summary({ number: HOSTILE })]);
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('img')).toBeNull();
  });

  test('el user_id completo del cliente no se pinta en el listado (ni en atributos)', async () => {
    const b = await renderTable([summary({ user_id: OTHER_USER })]);
    expect(b.innerHTML).not.toContain(OTHER_USER);
  });

  test('sin set:html: el HTML del servidor no sobrevive como marcado', async () => {
    const b = await renderTable([summary({ recipient_name: '<b>negrita</b>' })]);
    expect(b.querySelector('tbody b')).toBeNull();
  });
});
