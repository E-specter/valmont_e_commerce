import { describe, expect, test } from 'vitest';
import DashboardAlerts from '../../src/components/admin/DashboardAlerts.astro';
import DashboardKpis from '../../src/components/admin/DashboardKpis.astro';
import DashboardOrders from '../../src/components/admin/DashboardOrders.astro';
import DashboardStock from '../../src/components/admin/DashboardStock.astro';
import type { Count, DashboardData } from '../../src/lib/admin/dashboard';
import { formatDateTimeNumeric, formatMoney } from '../../src/lib/format';
import { AT_LIMA, AT_UTC, HOSTILE, ORDER_ID, OTHER_USER, manyOrders, summary } from '../helpers/t084';
import { KPI_LABELS, TOTALS, errorKpis, kpi, kpiState, kpiValue, lowStockItems, money, ordersToPrepare, stockItem } from '../helpers/t145';
import { text, ui } from '../helpers/ui';

// T-145 · Container API de los cuatro componentes del panel (firmas de STATUS ui §10.7 T-145). Sin red.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const FIVE = 5;
const FOUR = 4;
const ZERO_TOTAL = 0;
const ORDERS_HREF = '/admin/pedidos?status=pagado';
const WHOLE_CENTS = 8_450_000;
const WITH_CENTS = 1_062_550;
const GARBAGE = ['NaN', 'undefined', 'null', '[object'];
const DIGITS = [...'0123456789'];
const PII_WORDS = ['teléfono', 'telefono', 'address_line', 'dirección', 'direccion'];
/** `formatMoney` usa espacio duro (U+00A0); `text()` lo normaliza a un espacio normal. */
const plain = (s: string): string => s.replaceAll(' ', ' ');
const noGarbage = (s: string): void => GARBAGE.forEach((g) => expect(s, g).not.toContain(g));
const BAD: Count = { ok: false };
const good = (total: number): Count => ({ ok: true, total });

const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  toPrepare: good(TOTALS.toPrepare),
  pendingPayment: good(TOTALS.pendingPayment),
  lowStock: good(TOTALS.lowStock),
  outOfStock: good(TOTALS.outOfStock),
  ordersToPrepare: ordersToPrepare(),
  lowStockItems: lowStockItems(),
  ...over,
});

const links = (b: ParentNode): HTMLAnchorElement[] => [...b.querySelectorAll('a')] as HTMLAnchorElement[];
const linkNamed = (b: ParentNode, label: string): HTMLAnchorElement | undefined => links(b).find((a) => text(a) === label);
const rows = (b: ParentNode): Element[] => [...b.querySelectorAll('tbody tr')];
const hasRetry = (b: ParentNode): boolean => [...b.querySelectorAll('a, button')].some((el) => text(el).toLowerCase().includes('reintentar'));
const SELF = (el: Element | undefined): string => new URL(el?.getAttribute('href') ?? '', 'http://x.test').pathname;

describe('DashboardKpis', () => {
  test('con datos: «Por preparar», «Pendientes de pago» y «Stock bajo» muestran el `total` de su listado, no el número de filas', async () => {
    const b = await ui(DashboardKpis, { data: data() });
    expect(kpiValue(b, KPI_LABELS.toPrepare)).toBe(String(TOTALS.toPrepare));
    expect(kpiValue(b, KPI_LABELS.pendingPayment)).toBe(String(TOTALS.pendingPayment));
    expect(kpiValue(b, KPI_LABELS.lowStock)).toBe(String(TOTALS.lowStock));
    [KPI_LABELS.toPrepare, KPI_LABELS.pendingPayment, KPI_LABELS.lowStock].forEach((l) => expect(kpiState(b, l), l).toBe('data'));
  });

  test('el total de agotados es visible en el panel de KPI o, si no, queda para las alertas (nunca se pierde ni se confunde con otro total)', async () => {
    const b = await ui(DashboardKpis, { data: data() });
    const shown = text(b).includes(String(TOTALS.outOfStock));
    if (shown) expect(kpiValue(b, KPI_LABELS.toPrepare)).not.toBe(String(TOTALS.outOfStock));
    expect(kpiValue(b, KPI_LABELS.lowStock)).toBe(String(TOTALS.lowStock));
  });

  test('total 0 se muestra como «0» y es un dato (no «No disponible»)', async () => {
    const b = await ui(DashboardKpis, { data: data({ toPrepare: good(ZERO_TOTAL), pendingPayment: good(ZERO_TOTAL), lowStock: good(ZERO_TOTAL) }) });
    [KPI_LABELS.toPrepare, KPI_LABELS.pendingPayment, KPI_LABELS.lowStock].forEach((l) => {
      expect(kpiValue(b, l), l).toBe('0');
      expect(kpiState(b, l), l).toBe('data');
    });
  });

  test('«Ventas del período» está en pending: «Sin contrato», borde discontinuo (data-state) y aria-label completo; sin valor ni enlace', async () => {
    const b = await ui(DashboardKpis, { data: data() });
    const sales = kpi(b, KPI_LABELS.sales);
    expect(sales, 'falta la tarjeta «Ventas del período»').toBeDefined();
    expect(sales?.getAttribute('data-state')).toBe('pending');
    expect(text(sales?.querySelector('.value'))).toBe('Sin contrato');
    expect(sales?.getAttribute('aria-label')).toBe(`${KPI_LABELS.sales}: Sin contrato`);
    expect(sales?.tagName.toLowerCase()).not.toBe('a');
  });

  test.each([
    ['toPrepare', KPI_LABELS.toPrepare],
    ['pendingPayment', KPI_LABELS.pendingPayment],
    ['lowStock', KPI_LABELS.lowStock],
  ] as const)('%s con { ok: false }: solo «%s» queda en «No disponible» (texto y aria-label) y las demás siguen con su total', async (field, label) => {
    const b = await ui(DashboardKpis, { data: data({ [field]: BAD }) });
    const broken = kpi(b, label);
    expect(broken?.getAttribute('data-state')).toBe('error');
    expect(text(broken?.querySelector('.value'))).toBe('No disponible');
    expect(broken?.getAttribute('aria-label')).toBe(`${label}: No disponible`);
    expect(errorKpis(b)).toHaveLength(ONE);
    const others = [KPI_LABELS.toPrepare, KPI_LABELS.pendingPayment, KPI_LABELS.lowStock].filter((l) => l !== label);
    others.forEach((l) => expect(kpiState(b, l), l).toBe('data'));
  });

  test('con las cuatro llamadas caídas: ninguna cifra y «Ventas del período» sigue pending', async () => {
    const b = await ui(DashboardKpis, { data: data({ toPrepare: BAD, pendingPayment: BAD, lowStock: BAD, outOfStock: BAD, ordersToPrepare: null, lowStockItems: null }) });
    [TOTALS.toPrepare, TOTALS.pendingPayment, TOTALS.lowStock].forEach((n) => expect(text(b)).not.toContain(String(n)));
    expect(kpiState(b, KPI_LABELS.sales)).toBe('pending');
    expect(errorKpis(b).length).toBeGreaterThanOrEqual(FOUR - ONE);
  });

  test('no inventa cifras: el HTML no contiene un total que no sea el recibido', async () => {
    const b = await ui(DashboardKpis, { data: data({ toPrepare: good(TOTALS.toPrepare) }) });
    noGarbage(text(b));
  });
});

describe('DashboardAlerts', () => {
  test('con agotados > 0: «N productos agotados» con el total real', async () => {
    const b = await ui(DashboardAlerts, { data: data() });
    expect(text(b)).toContain(`${TOTALS.outOfStock} productos agotados`);
  });

  // Decisión del Leader: «N productos con stock bajo» es válido; se exige el número y «con stock bajo» en la misma alerta.
  test('con stock bajo > 0: el total real y «con stock bajo» en la misma alerta', async () => {
    const b = await ui(DashboardAlerts, { data: data() });
    const alert = [...b.querySelectorAll('li')].find((li) => text(li).includes('con stock bajo'));
    expect(alert, 'falta la alerta de stock bajo').toBeDefined();
    expect(text(alert).startsWith(String(TOTALS.lowStock))).toBe(true);
  });

  test('N = 0: la alerta correspondiente no aparece', async () => {
    const onlyLow = await ui(DashboardAlerts, { data: data({ outOfStock: good(ZERO_TOTAL) }) });
    expect(text(onlyLow).toLowerCase()).not.toContain('agotad');
    expect(text(onlyLow)).toContain(String(TOTALS.lowStock));
    const onlyOut = await ui(DashboardAlerts, { data: data({ lowStock: good(ZERO_TOTAL) }) });
    expect(text(onlyOut)).not.toContain(String(TOTALS.lowStock));
    expect(text(onlyOut).toLowerCase()).not.toContain('stock bajo');
    expect(text(onlyOut)).toContain(`${TOTALS.outOfStock} productos agotados`);
  });

  test('todo en 0: no pinta ninguna alerta (ni caja vacía con rol de alerta)', async () => {
    const b = await ui(DashboardAlerts, { data: data({ outOfStock: good(ZERO_TOTAL), lowStock: good(ZERO_TOTAL) }) });
    expect(text(b)).toBe('');
    expect(b.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(NONE);
  });

  test('un Count caído ({ ok: false }) no inventa una alerta: no hay cifra ni «0 productos»', async () => {
    const b = await ui(DashboardAlerts, { data: data({ outOfStock: BAD, lowStock: BAD }) });
    DIGITS.forEach((d) => expect(text(b), d).not.toContain(d));
    noGarbage(text(b));
  });

  test('la alerta «pedidos vencen pronto» se omite (H-B2)', async () => {
    const b = await ui(DashboardAlerts, { data: data() });
    expect(text(b).toLowerCase()).not.toContain('vencen');
  });

  test('las alertas son texto (no solo color): cada una lleva su cifra y su frase', async () => {
    const b = await ui(DashboardAlerts, { data: data() });
    expect(text(b).length).toBeGreaterThan(NONE);
    expect(b.querySelectorAll('script')).toHaveLength(NONE);
  });
});

describe('DashboardOrders («Pedidos por preparar»)', () => {
  test('una fila por pedido, en el orden recibido, con número enlazado a /admin/pedidos/{id}', async () => {
    const items = ordersToPrepare();
    const b = await ui(DashboardOrders, { items });
    const r = rows(b);
    expect(r).toHaveLength(FIVE);
    r.forEach((row, i) => {
      const a = row.querySelector('a');
      expect(text(a)).toBe(items[i].number);
      expect(SELF(a ?? undefined)).toBe(`/admin/pedidos/${items[i].id}`);
    });
  });

  test('cada fila muestra destinatario, total con formatMoney y fecha con formatDateTimeNumeric (sin .00 fijo)', async () => {
    const o = summary({ total: money(WHOLE_CENTS), recipient_name: 'Ana Torres', created_at: AT_UTC });
    const b = await ui(DashboardOrders, { items: [o] });
    const row = text(rows(b)[NONE]);
    expect(row).toContain('Ana Torres');
    expect(row).toContain(plain(formatMoney(o.total)));
    expect(row).toContain('S/ 84,500');
    expect(row).not.toContain('.00');
    expect(row).toContain(formatDateTimeNumeric(o.created_at));
    expect(row).toContain(AT_LIMA);
  });

  test('el importe con céntimos se formatea con formatMoney (no se recalcula)', async () => {
    const o = summary({ total: money(WITH_CENTS) });
    const b = await ui(DashboardOrders, { items: [o] });
    expect(text(rows(b)[NONE])).toContain(plain(formatMoney(o.total)));
  });

  test('«Ver todos» lleva a /admin/pedidos?status=pagado', async () => {
    const b = await ui(DashboardOrders, { items: ordersToPrepare() });
    const all = links(b).find((a) => text(a).startsWith('Ver todos'));
    expect(all, 'falta el enlace «Ver todos…»').toBeDefined();
    expect(all?.getAttribute('href')).toBe(ORDERS_HREF);
  });

  test('una tabla con caption y encabezados con scope (reutiliza DataTable)', async () => {
    const b = await ui(DashboardOrders, { items: ordersToPrepare() });
    expect(b.querySelectorAll('table')).toHaveLength(ONE);
    expect(text(b.querySelector('caption')).length).toBeGreaterThan(NONE);
    expect(b.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(NONE);
  });

  test('vacío ([]): «Nada por preparar», sin tabla y sin error', async () => {
    const b = await ui(DashboardOrders, { items: [] });
    expect(text(b)).toContain('Nada por preparar');
    expect(b.querySelectorAll('table')).toHaveLength(NONE);
    expect(hasRetry(b)).toBe(false);
  });

  test('error (null): aviso con «Reintentar», sin tabla y sin «Nada por preparar» (no es lo mismo que vacío)', async () => {
    const b = await ui(DashboardOrders, { items: null });
    expect(hasRetry(b)).toBe(true);
    expect(b.querySelectorAll('table')).toHaveLength(NONE);
    expect(text(b)).not.toContain('Nada por preparar');
    noGarbage(text(b));
  });

  test('recipient_name hostil se pinta como texto: sin script ni elementos inyectados', async () => {
    const b = await ui(DashboardOrders, { items: [summary({ recipient_name: HOSTILE })] });
    expect(b.querySelector('tbody img, script:not([src])')).toBeNull();
    expect(text(rows(b)[NONE])).toContain(HOSTILE);
  });

  test('sin PII innecesaria: no pinta user_id, teléfono ni dirección', async () => {
    const b = await ui(DashboardOrders, { items: [summary({ user_id: OTHER_USER })] });
    expect(b.innerHTML).not.toContain(OTHER_USER);
    PII_WORDS.forEach((w) => expect(b.innerHTML.toLowerCase(), w).not.toContain(w));
  });

  test('el id del pedido se codifica en el enlace (no se interpola crudo)', async () => {
    const b = await ui(DashboardOrders, { items: [summary({ id: 'a/../b?x=1#y' })] });
    const href = rows(b)[NONE].querySelector('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/admin/pedidos/')).toBe(true);
    expect(href).not.toContain('/../');
    expect(href).not.toContain('#');
  });

  test('no renderiza más de lo recibido: 2 pedidos → 2 filas', async () => {
    const b = await ui(DashboardOrders, { items: manyOrders(TWO) });
    expect(rows(b)).toHaveLength(TWO);
  });

  test('el pedido de muestra enlaza al detalle por su id real', async () => {
    const b = await ui(DashboardOrders, { items: [summary()] });
    expect(SELF(rows(b)[NONE].querySelector('a') ?? undefined)).toBe(`/admin/pedidos/${ORDER_ID}`);
  });
});

describe('DashboardStock («Stock bajo»)', () => {
  test('una fila por producto, en el orden recibido, con nombre y disponibles; el nombre enlaza a /admin/productos/{product_id}', async () => {
    const items = lowStockItems();
    const b = await ui(DashboardStock, { items });
    const r = rows(b);
    expect(r).toHaveLength(FOUR);
    r.forEach((row, i) => {
      expect(text(row)).toContain(items[i].name);
      expect(text(row)).toContain(String(items[i].available));
      expect(SELF(row.querySelector('a') ?? undefined)).toBe(`/admin/productos/${items[i].product_id}`);
    });
  });

  test('muestra «Stock bajo» como título de la sección', async () => {
    const b = await ui(DashboardStock, { items: lowStockItems() });
    expect(text(b)).toContain('Stock bajo');
  });

  test('vacío ([]): «Sin productos con stock bajo», sin tabla ni error', async () => {
    const b = await ui(DashboardStock, { items: [] });
    expect(text(b)).toContain('Sin productos con stock bajo');
    expect(b.querySelectorAll('table')).toHaveLength(NONE);
    expect(hasRetry(b)).toBe(false);
  });

  test('error (null): «Reintentar», sin tabla y sin el texto de vacío', async () => {
    const b = await ui(DashboardStock, { items: null });
    expect(hasRetry(b)).toBe(true);
    expect(b.querySelectorAll('table')).toHaveLength(NONE);
    expect(text(b)).not.toContain('Sin productos con stock bajo');
  });

  test('un nombre hostil se pinta como texto', async () => {
    const b = await ui(DashboardStock, { items: [stockItem(NONE, { name: HOSTILE })] });
    expect(b.querySelector('tbody img, script:not([src])')).toBeNull();
    expect(text(rows(b)[NONE])).toContain(HOSTILE);
  });

  test('`available` 0 se muestra como «0» (no se oculta)', async () => {
    const b = await ui(DashboardStock, { items: [stockItem(NONE, { available: NONE, on_hand: NONE })] });
    expect([...rows(b)[NONE].querySelectorAll('td')].map((td) => text(td))).toContain('0');
  });

  test('el id del producto se codifica en el enlace', async () => {
    const b = await ui(DashboardStock, { items: [stockItem(NONE, { product_id: 'a/../b?x=1#y' })] });
    const href = rows(b)[NONE].querySelector('a')?.getAttribute('href') ?? '';
    expect(href.startsWith('/admin/productos/')).toBe(true);
    expect(href).not.toContain('/../');
    expect(href).not.toContain('#');
  });
});
