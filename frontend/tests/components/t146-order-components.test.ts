import { describe, expect, test } from 'vitest';
import OrderActions from '../../src/components/admin/OrderActions.astro';
import OrderDelivery from '../../src/components/admin/OrderDelivery.astro';
import OrderLines from '../../src/components/admin/OrderLines.astro';
import OrderSummaryCard from '../../src/components/admin/OrderSummaryCard.astro';
import { cancelCopy, transitionLabel } from '../../src/lib/admin/status';
import { formatDateTimeNumeric } from '../../src/lib/format';
import { describedBy, hasMarker, text, ui } from '../helpers/ui';
import { ALL_STATUSES, CUSTOMER_ID, LINE_PRICE, ORDER_ID, OTHER_USER_ID, SHIPPING_FEE, allowedFrom, flat, line, money, pickupDelivery, shippingDelivery, soles, type Modality } from '../helpers/t146';
import type { OrderStatus } from '../../src/lib/api/admin-orders';

// T-146 · componentes del detalle de pedido (Container API). Firmas: STATUS ui «T-146 › Firmas públicas».
// Aquí, el marcado: qué se pinta y qué viaja en cada formulario. La interacción real (diálogo, foco, Esc, doble envío) va en el E2E.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const SHORT_ID = 8;
const JUNK = ['null', 'undefined', 'NaN'];
const hasJunk = (t: string): boolean => JUNK.some((w) => t.includes(w));
const MAX_NOTE = 500;
const MAX_TEXT = 60;
const HOSTILE = '"><script id="pwn">window.__pwned=1</script><img src=x onerror=alert(1)>';
const FOREIGN_FIELDS = ['user_id', 'role', 'total', 'amount', 'price', 'status', 'can_transition_to', 'refund'];

type Props = Record<string, unknown>;
const actionsFor = (status: OrderStatus, method: Modality = 'shipping', over: Props = {}) =>
  ui(OrderActions, { orderId: ORDER_ID, status, canTransitionTo: allowedFrom(status, method), deliveryMethod: method, ...over });

/** Acciones visibles fuera del diálogo (botones de avance y el que abre la cancelación). */
const painted = (body: HTMLElement): Element[] => [...body.querySelectorAll('button, a')].filter((el) => !el.closest('dialog'));
const paintedLabels = (body: HTMLElement): string[] => painted(body).map((el) => text(el));
const formOf = (body: HTMLElement, label: string): HTMLFormElement | null => (painted(body).find((el) => text(el) === label)?.closest('form') as HTMLFormElement | null) ?? null;
const hidden = (form: ParentNode, name: string): string[] => [...form.querySelectorAll(`input[name="${name}"]`)].map((i) => i.getAttribute('value') ?? '');
const dialogOf = (body: HTMLElement): HTMLDialogElement | null => body.querySelector('dialog');
const noteField = (body: HTMLElement): HTMLElement | null => body.querySelector('dialog [name="note"]');
const fieldValue = (el: Element | null): string => (el?.tagName === 'TEXTAREA' ? (el.textContent ?? '') : (el?.getAttribute('value') ?? ''));

describe('OrderActions · solo lo que ofrece el servidor (D-B4)', () => {
  const MATRIX: { status: OrderStatus; method: Modality; labels: string[] }[] = [
    { status: 'pendiente_pago', method: 'shipping', labels: ['Cancelar pedido'] },
    { status: 'pagado', method: 'shipping', labels: ['Preparar pedido', 'Cancelar y reembolsar'] },
    { status: 'pagado', method: 'pickup', labels: ['Preparar pedido', 'Cancelar y reembolsar'] },
    { status: 'en_preparacion', method: 'shipping', labels: ['Marcar como enviado', 'Cancelar y reembolsar'] },
    { status: 'en_preparacion', method: 'pickup', labels: ['Marcar listo para recojo', 'Cancelar y reembolsar'] },
    { status: 'enviado', method: 'shipping', labels: ['Marcar como entregado'] },
    { status: 'listo_para_recojo', method: 'pickup', labels: ['Marcar como entregado'] },
    { status: 'entregado', method: 'shipping', labels: [] },
    { status: 'cancelado', method: 'shipping', labels: [] },
    { status: 'expirado', method: 'shipping', labels: [] },
  ];
  MATRIX.forEach(({ status, method, labels }) =>
    test(`${status} (${method}) pinta exactamente: ${labels.join(' · ') || 'nada'}`, async () => {
      expect(paintedLabels(await actionsFor(status, method))).toEqual(labels);
    }),
  );

  test('los 8 estados están cubiertos por la matriz', () => {
    expect(new Set(MATRIX.map((m) => m.status))).toEqual(new Set(ALL_STATUSES));
  });

  test('un pedido terminal no muestra formularios, botones ni diálogo', async () => {
    await Promise.all(
      (['entregado', 'cancelado', 'expirado'] as const).map(async (status) => {
        const body = await actionsFor(status);
        expect(body.querySelectorAll('form, button, dialog, input, textarea'), status).toHaveLength(NONE);
      }),
    );
  });

  test('la lista del servidor manda: pagado con solo «cancelado» no ofrece preparar', async () => {
    const body = await actionsFor('pagado', 'shipping', { canTransitionTo: ['cancelado'] });
    expect(paintedLabels(body)).toEqual(['Cancelar y reembolsar']);
  });

  test('nunca deduce: el estado no decide, `canTransitionTo` sí (un pagado con lista vacía no ofrece nada)', async () => {
    expect(painted(await actionsFor('pagado', 'shipping', { canTransitionTo: [] }))).toHaveLength(NONE);
  });

  test('un destino que el servidor ofrece se pinta aunque el estado "no lo permitiría" (la vista no recalcula)', async () => {
    const body = await actionsFor('entregado', 'shipping', { canTransitionTo: ['en_preparacion'] });
    expect(paintedLabels(body)).toEqual(['Preparar pedido']);
  });

  test('estados que no son destinos (pagado, expirado, pendiente_pago, desconocidos) se ignoran: ni botón ni `to`', async () => {
    const body = await actionsFor('pagado', 'shipping', { canTransitionTo: ['pagado', 'expirado', 'pendiente_pago', 'x', 'en_preparacion'] });
    expect(paintedLabels(body)).toEqual(['Preparar pedido']);
    expect(hidden(body, 'to')).toEqual(['en_preparacion']);
  });

  test('el orden es avance primero y cancelar al final, sin importar el de la lista', async () => {
    const body = await actionsFor('en_preparacion', 'shipping', { canTransitionTo: ['cancelado', 'enviado'] });
    expect(paintedLabels(body)).toEqual(['Marcar como enviado', 'Cancelar y reembolsar']);
  });

  test('las etiquetas salen de `transitionLabel` (misma fuente que el resto del backoffice)', async () => {
    const body = await actionsFor('pagado');
    expect(paintedLabels(body)).toEqual([transitionLabel('en_preparacion', 'pagado'), transitionLabel('cancelado', 'pagado')]);
  });
});

describe('OrderActions · formularios de avance', () => {
  test('cada avance es un <form method=post> con `_action=transition` y `to` oculto', async () => {
    const body = await actionsFor('pagado');
    const form = formOf(body, 'Preparar pedido');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(hidden(form!, '_action')).toEqual(['transition']);
    expect(hidden(form!, 'to')).toEqual(['en_preparacion']);
    expect(form!.querySelector('input[name="to"]')?.getAttribute('type')).toBe('hidden');
  });

  test('el botón de avance es de envío (type=submit) y es el único de su formulario', async () => {
    const form = formOf(await actionsFor('pagado'), 'Preparar pedido')!;
    expect(form.querySelectorAll('button')).toHaveLength(ONE);
    expect(form.querySelector('button')?.getAttribute('type')).toBe('submit');
  });

  test('el formulario no apunta a otro origen ni a otra ruta (action ausente o la propia página)', async () => {
    const form = formOf(await actionsFor('pagado'), 'Preparar pedido')!;
    const action = form.getAttribute('action');
    if (action !== null && action !== '') expect(action.startsWith(`/admin/pedidos/${ORDER_ID}`)).toBe(true);
  });

  test('los formularios llevan `data-busy-on-submit` (form-busy: un doble clic no envía dos veces)', async () => {
    const body = await actionsFor('en_preparacion');
    expect(formOf(body, 'Marcar como enviado')?.hasAttribute('data-busy-on-submit')).toBe(true);
    const pagado = await actionsFor('pagado');
    expect(formOf(pagado, 'Preparar pedido')?.hasAttribute('data-busy-on-submit')).toBe(true);
  });

  test('ningún formulario envía datos que decide el servidor (user_id, role, importes, estado…)', async () => {
    const cases = [['pagado', 'shipping'], ['en_preparacion', 'shipping'], ['en_preparacion', 'pickup'], ['enviado', 'shipping'], ['pendiente_pago', 'shipping']] as const;
    await Promise.all(
      cases.map(async ([status, method]) => {
        const body = await actionsFor(status, method);
        FOREIGN_FIELDS.forEach((f) => expect(body.querySelector(`[name="${f}"]`), `${status}/${f}`).toBeNull());
      }),
    );
  });

  test('«Marcar como enviado» pide transportista y código de seguimiento, opcionales y con tope de 60', async () => {
    const form = formOf(await actionsFor('en_preparacion'), 'Marcar como enviado')!;
    ['carrier', 'tracking_code'].forEach((name) => {
      const input = form.querySelector(`[name="${name}"]`);
      expect(input, name).not.toBeNull();
      expect(input?.hasAttribute('required'), `${name} es opcional`).toBe(false);
      expect(input?.getAttribute('maxlength')).toBe(String(MAX_TEXT));
      const id = input?.getAttribute('id') ?? '';
      expect(text(form.querySelector(`label[for="${id}"]`)), `${name} tiene etiqueta`).not.toBe('');
    });
    expect(hidden(form, 'to')).toEqual(['enviado']);
  });

  test('los demás avances no piden transportista ni seguimiento', async () => {
    const cases = [['pagado', 'shipping', 'Preparar pedido'], ['en_preparacion', 'pickup', 'Marcar listo para recojo'], ['enviado', 'shipping', 'Marcar como entregado']] as const;
    await Promise.all(
      cases.map(async ([status, method, label]) => {
        const form = formOf(await actionsFor(status, method), label)!;
        expect(form.querySelector('[name="carrier"], [name="tracking_code"]'), label).toBeNull();
      }),
    );
  });

  test('los valores escritos se conservan en transportista y seguimiento', async () => {
    const body = await actionsFor('en_preparacion', 'shipping', { values: { carrier: 'Olva Courier', tracking_code: 'OL-998877' } });
    expect(body.querySelector('[name="carrier"]')?.getAttribute('value')).toBe('Olva Courier');
    expect(body.querySelector('[name="tracking_code"]')?.getAttribute('value')).toBe('OL-998877');
  });

  test('un valor hostil se escapa: no crea elementos y el atributo conserva el texto', async () => {
    const body = await actionsFor('en_preparacion', 'shipping', { values: { carrier: HOSTILE } });
    expect(body.querySelector('#pwn, img[onerror]')).toBeNull();
    expect(body.querySelector('[name="carrier"]')?.getAttribute('value')).toBe(HOSTILE);
  });

  test('error de transportista y de seguimiento: junto a su campo, con aria-invalid y aria-describedby', async () => {
    const body = await actionsFor('en_preparacion', 'shipping', { errors: { carrier: 'El transportista no es válido.', tracking_code: 'El código no es válido.' } });
    const carrier = body.querySelector('[name="carrier"]')!;
    const tracking = body.querySelector('[name="tracking_code"]')!;
    expect(carrier.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, carrier).map((d) => d.text)).toContain('El transportista no es válido.');
    expect(tracking.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, tracking).map((d) => d.text)).toContain('El código no es válido.');
  });

  test('sin errores, los campos no se marcan inválidos', async () => {
    const body = await actionsFor('en_preparacion');
    expect(body.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  test('`errors.form` es un mensaje de formulario con role=alert (no depende de un campo)', async () => {
    const body = await actionsFor('pagado', 'shipping', { errors: { form: 'El estado del pedido cambió.' } });
    expect(text(body.querySelector('[role="alert"]'))).toContain('El estado del pedido cambió.');
  });

  test('sin errores no hay role=alert', async () => {
    expect(body_alerts(await actionsFor('pagado'))).toHaveLength(NONE);
  });
});

const body_alerts = (body: ParentNode): Element[] => [...body.querySelectorAll('[role="alert"]')];

describe('OrderActions · «Cancelar y reembolsar» (diálogo)', () => {
  test('hay un único <dialog>, cerrado por defecto, y un botón que lo abre por Invoker Commands', async () => {
    const body = await actionsFor('pagado');
    const dialogs = body.querySelectorAll('dialog');
    expect(dialogs).toHaveLength(ONE);
    expect(dialogs[NONE].hasAttribute('open')).toBe(false);
    const trigger = painted(body).find((el) => text(el) === 'Cancelar y reembolsar')!;
    expect(trigger.getAttribute('command')).toBe('show-modal');
    expect(trigger.getAttribute('commandfor')).toBe(dialogs[NONE].getAttribute('id'));
    expect(trigger.getAttribute('type')).toBe('button');
  });

  test('el botón que abre la cancelación es de peligro (no solo color: lleva texto) y está fuera de los formularios de avance', async () => {
    const trigger = painted(await actionsFor('pagado')).find((el) => text(el) === 'Cancelar y reembolsar')!;
    expect(hasMarker(trigger, 'danger')).toBe(true);
    expect(trigger.closest('form')).toBeNull();
  });

  const COPY: OrderStatus[] = ['pendiente_pago', 'pagado', 'en_preparacion'];
  COPY.forEach((status) =>
    test(`el texto del diálogo sale de cancelCopy('${status}')`, async () => {
      const body = await actionsFor(status);
      const dlg = dialogOf(body)!;
      const copy = cancelCopy(status);
      const title = body.ownerDocument.getElementById(dlg.getAttribute('aria-labelledby') ?? '');
      expect(text(title)).toBe(copy.title);
      expect(flat(text(dlg))).toContain(flat(copy.body));
      const confirm = [...dlg.querySelectorAll('button')].find((b) => b.getAttribute('formmethod') !== 'dialog');
      expect(text(confirm)).toBe(copy.confirm);
    }),
  );

  test('pagado y en preparación hablan del reembolso del total y de que no se repone el stock; pendiente de pago, de liberar reservas', async () => {
    const paid = flat(text(dialogOf(await actionsFor('pagado'))));
    expect(paid).toContain('reembolsará');
    expect(paid).toContain('stock');
    const pending = flat(text(dialogOf(await actionsFor('pendiente_pago'))));
    expect(pending).toContain('reservas');
    expect(pending).not.toContain('reembolsará');
  });

  test('el diálogo es accesible: nombre (aria-labelledby), descripción y botón «Cancelar» que solo cierra (formmethod=dialog)', async () => {
    const body = await actionsFor('pagado');
    const dlg = dialogOf(body)!;
    expect(dlg.getAttribute('aria-labelledby')).toBeTruthy();
    expect(body.ownerDocument.getElementById(dlg.getAttribute('aria-describedby') ?? '')).not.toBeNull();
    const close = [...dlg.querySelectorAll('button')].find((b) => b.getAttribute('formmethod') === 'dialog');
    expect(text(close), 'el botón que cierra tiene texto').not.toBe('');
    expect(text(close)).not.toBe(cancelCopy('pagado').confirm);
  });

  test('el formulario del diálogo envía `_action=transition`, `to=cancelado` y `note`', async () => {
    const dlg = dialogOf(await actionsFor('pagado'))!;
    const form = dlg.querySelector('form')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(hidden(form, '_action')).toEqual(['transition']);
    expect(hidden(form, 'to')).toEqual(['cancelado']);
    expect(form.querySelector('[name="note"]')).not.toBeNull();
  });

  test('el motivo es obligatorio (required), con tope de 500 y etiqueta propia', async () => {
    const body = await actionsFor('pagado');
    const note = noteField(body)!;
    expect(note.hasAttribute('required')).toBe(true);
    expect(note.getAttribute('maxlength')).toBe(String(MAX_NOTE));
    const id = note.getAttribute('id') ?? '';
    expect(text(body.querySelector(`label[for="${id}"]`))).not.toBe('');
  });

  test('con `cancelOpen` el <dialog> llega con `open` (visible aunque no haya JavaScript)', async () => {
    expect(dialogOf(await actionsFor('pagado', 'shipping', { cancelOpen: true }))!.hasAttribute('open')).toBe(true);
  });

  test('error de motivo: junto al campo, con aria-invalid, aria-describedby y el diálogo abierto', async () => {
    const body = await actionsFor('pagado', 'shipping', { cancelOpen: true, errors: { note: 'Escribe el motivo de la cancelación.' } });
    const note = noteField(body)!;
    expect(dialogOf(body)!.hasAttribute('open')).toBe(true);
    expect(note.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, note).map((d) => d.text)).toContain('Escribe el motivo de la cancelación.');
  });

  test('el motivo escrito se conserva tras un error', async () => {
    const body = await actionsFor('pagado', 'shipping', { cancelOpen: true, values: { note: 'Pieza dañada en taller' }, errors: { note: 'El texto es demasiado largo.' } });
    expect(fieldValue(noteField(body))).toBe('Pieza dañada en taller');
  });

  test('un motivo hostil se muestra como texto: no crea elementos', async () => {
    const body = await actionsFor('pagado', 'shipping', { cancelOpen: true, values: { note: `</textarea>${HOSTILE}` } });
    expect(body.querySelector('#pwn, img[onerror]')).toBeNull();
    expect(fieldValue(noteField(body))).toBe(`</textarea>${HOSTILE}`);
  });

  test('el pedido en preparación también se cancela con reembolso (misma etiqueta)', async () => {
    const body = await actionsFor('en_preparacion', 'pickup');
    expect(paintedLabels(body)).toContain('Cancelar y reembolsar');
    expect(dialogOf(body)).not.toBeNull();
  });

  test('sin cancelación ofrecida no hay diálogo (enviado, entregado…)', async () => {
    await Promise.all((['enviado', 'entregado', 'cancelado', 'expirado'] as const).map(async (s) => expect(dialogOf(await actionsFor(s)), s).toBeNull()));
  });
});

describe('OrderLines', () => {
  const lines = (...ls: ReturnType<typeof line>[]) => ui(OrderLines, { lines: ls });
  const rows = (body: HTMLElement): Element[] => [...body.querySelectorAll('tbody tr')];

  test('una fila por línea, dentro de una tabla con título accesible y filas altas (80)', async () => {
    const body = await lines(line(), line({ sku: 'DEMO-001', name: 'Demo Alba 38' }));
    expect(rows(body)).toHaveLength(TWO);
    expect(body.querySelector('table')?.getAttribute('data-density')).toBe('lg');
    expect(body.querySelector('[role="region"][aria-label]')).not.toBeNull();
  });

  test('cada fila muestra nombre, SKU, cantidad, precio unitario y total de línea con formatMoney', async () => {
    const body = await lines(line({ quantity: TWO, unit_price: money(LINE_PRICE), line_total: money(LINE_PRICE * TWO) }));
    const row = flat(text(rows(body)[NONE]));
    expect(row).toContain('Demo Gaviota 42');
    expect(row).toContain('DEMO-007');
    expect([...rows(body)[NONE].querySelectorAll('td')].map((td) => flat(text(td)))).toContain(String(TWO));
    expect(row).toContain(soles(LINE_PRICE));
    expect(row).toContain(soles(LINE_PRICE * TWO));
    expect(row).toContain('S/ 84,500');
  });

  test('los importes salen del servidor tal cual: no se recalculan (total de línea incoherente se respeta)', async () => {
    const odd = 123_450;
    const body = await lines(line({ quantity: THREE, unit_price: money(LINE_PRICE), line_total: money(odd) }));
    expect(flat(text(body))).toContain(soles(odd));
  });

  test('con imagen: <img> con su src y alt', async () => {
    const img = (await lines(line())).querySelector('img');
    expect(img?.getAttribute('src')).toBe('http://img.test/gaviota.webp');
    expect(img?.getAttribute('alt')).toBe('Gaviota vista frontal');
  });

  test('sin imagen (image: null) la fila no se rompe: sin <img>, con nombre y totales', async () => {
    const body = await lines(line({ image: null }));
    expect(body.querySelector('img')).toBeNull();
    expect(rows(body)).toHaveLength(ONE);
    expect(flat(text(body))).toContain('Demo Gaviota 42');
    expect(hasJunk(flat(text(body)))).toBe(false);
  });

  test('nombre y SKU hostiles se muestran como texto', async () => {
    const body = await lines(line({ name: `<script id="pwn">1</script>${HOSTILE}`, sku: '<b id="pwn">X</b>' }));
    expect(body.querySelector('#pwn, img[onerror], b')).toBeNull();
    expect(text(body)).toContain('<script id="pwn">1</script>');
  });
});

describe('OrderDelivery', () => {
  const view = (delivery = shippingDelivery(), userId = OTHER_USER_ID) => ui(OrderDelivery, { delivery, userId });

  test('envío: destinatario, teléfono y dirección completa salen de `delivery`', async () => {
    const t = flat(text(await view()));
    ['Lucía Fernández', '+51987654321', 'Miraflores', 'Av. Larco 1234, piso 5', 'Frente al parque Kennedy'].forEach((part) => expect(t).toContain(part));
  });

  test('la cuenta se muestra con el id abreviado (8 primeros), nunca completo', async () => {
    const body = await view();
    expect(flat(text(body))).toContain(OTHER_USER_ID.slice(NONE, SHORT_ID));
    expect(body.innerHTML).not.toContain(OTHER_USER_ID);
  });

  test('un user_id sin forma de UUID se abrevia igual y no rompe', async () => {
    const t = flat(text(await view(shippingDelivery(), 'abc')));
    expect(hasJunk(t)).toBe(false);
  });

  test('recojo: tienda (nombre, dirección y horario) y «Recojo en tienda»; sin dirección de envío', async () => {
    const t = flat(text(await view(pickupDelivery())));
    ['Recojo en tienda', 'Boutique Valmont San Isidro', 'Calle Las Begonias 415', 'Lun-Sáb 10:00-19:00', 'Mateo Quispe', '+51911222333'].forEach((part) => expect(t).toContain(part));
    expect(hasJunk(t)).toBe(false);
  });

  test('envío: transportista y seguimiento solo si existen', async () => {
    const without = flat(text(await view()));
    expect(without).not.toContain('Olva');
    const withIt = flat(text(await view(shippingDelivery({ carrier: 'Olva Courier', tracking_code: 'OL-998877', shipped_at: '2026-11-27T21:00:00Z' }))));
    expect(withIt).toContain('Olva Courier');
    expect(withIt).toContain('OL-998877');
  });

  test('datos nulos (referencia, departamento) no se pintan como "null" ni como filas vacías', async () => {
    const body = await view(shippingDelivery({ reference: null, department: null, province: null }));
    expect(hasJunk(flat(text(body)))).toBe(false);
    expect([...body.querySelectorAll('dd')].every((dd) => text(dd) !== '')).toBe(true);
  });

  test('es una lista de definiciones (dl/dt/dd) con términos no vacíos', async () => {
    const body = await view();
    expect(body.querySelector('dl')).not.toBeNull();
    const terms = [...body.querySelectorAll('dt')].map(text);
    expect(terms.length).toBeGreaterThan(NONE);
    expect(terms.every((t) => t !== '')).toBe(true);
  });

  test('datos hostiles del cliente se muestran como texto', async () => {
    const body = await view(shippingDelivery({ recipient_name: `<script id="pwn">1</script>`, address_line: HOSTILE, reference: '<b id="pwn">x</b>' }));
    expect(body.querySelector('#pwn, img[onerror], b')).toBeNull();
  });

  test('no se pinta el identificador de cuenta del cliente del historial ni otros ids (solo el abreviado)', async () => {
    expect((await view()).innerHTML).not.toContain(CUSTOMER_ID);
  });
});

describe('OrderSummaryCard', () => {
  const card = (over: Props = {}) =>
    ui(OrderSummaryCard, { subtotal: money(LINE_PRICE), shipping: money(SHIPPING_FEE), total: money(LINE_PRICE + SHIPPING_FEE), refund: null, paidAt: '2026-11-27T20:01:00Z', ...over });

  test('subtotal, envío y total con formatMoney', async () => {
    const t = flat(text(await card()));
    expect(t).toContain(soles(LINE_PRICE));
    expect(t).toContain(soles(SHIPPING_FEE));
    expect(t).toContain(soles(LINE_PRICE + SHIPPING_FEE));
    expect(t).toContain('S/ 84,500');
    ['Subtotal', 'Envío', 'Total'].forEach((label) => expect(t, label).toContain(label));
  });

  test('el total es el del servidor: no se suma en el cliente', async () => {
    const odd = 999_900;
    const t = flat(text(await card({ total: money(odd) })));
    expect(t).toContain(soles(odd));
    expect(t).not.toContain(soles(LINE_PRICE + SHIPPING_FEE));
  });

  test('sin reembolso no aparece el bloque «Reembolso»', async () => {
    expect(flat(text(await card()))).not.toContain('Reembolso');
  });

  test('con reembolso: monto (formatMoney) y fecha en hora de Lima', async () => {
    const at = '2026-11-28T03:30:00Z'; // 27/11/2026 22:30 en Lima (UTC−5)
    const t = flat(text(await card({ refund: { amount: money(LINE_PRICE + SHIPPING_FEE), at } })));
    expect(t).toContain('Reembolso');
    expect(t).toContain(soles(LINE_PRICE + SHIPPING_FEE));
    expect(t).toContain(formatDateTimeNumeric(at));
    expect(t).toContain('27/11/2026 22:30');
  });

  test('con o sin fecha de pago no se pinta "null" ni se rompe', async () => {
    // La fecha de pago la pinta la cabecera de la página (ver pruebas de página); la tarjeta solo no debe romperse con paidAt nulo.
    expect(hasJunk(flat(text(await card())))).toBe(false);
    const t = flat(text(await card({ paidAt: null })));
    expect(hasJunk(t)).toBe(false);
  });
});
