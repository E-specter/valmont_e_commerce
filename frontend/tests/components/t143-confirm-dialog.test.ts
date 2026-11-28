import { describe, expect, test } from 'vitest';
import ConfirmDialog from '../../src/components/ui/ConfirmDialog.astro';
import { hasMarker, markers, text, ui } from '../helpers/ui';

// T-143 · ConfirmDialog sobre <dialog> (STATUS «T-143 › Firmas públicas» y criterios de aceptación).
// Aquí, el marcado (Container API). Abrir con `command`, foco, Esc y retorno del foco: en el E2E y en la isla.
const NONE = 0;
const ONE = 1;
const HOSTILE = '<img id="pwn" src=x onerror=alert(1)>';

type Props = Record<string, unknown>;
const BASE = { id: 'cancel-order', title: 'Cancelar y reembolsar', confirmLabel: 'Cancelar pedido' };
const FIELDS = '<input type="hidden" name="to" value="cancelado"><label>Nota <input name="note"></label>';
const dialog = async (props: Props = {}, fields = FIELDS): Promise<{ body: HTMLElement; dlg: HTMLDialogElement; form: HTMLFormElement }> => {
  const body = await ui(ConfirmDialog, { ...BASE, ...props }, { default: fields });
  return { body, dlg: body.querySelector('dialog')!, form: body.querySelector('dialog form')! };
};
const submitters = (form: ParentNode): Element[] => [...form.querySelectorAll('button:not([type="button"]), input[type="submit"]')];
const confirmButton = (form: ParentNode): Element | undefined => submitters(form).find((b) => b.getAttribute('formmethod') !== 'dialog');
const cancelButton = (form: ParentNode): Element | undefined => submitters(form).find((b) => b.getAttribute('formmethod') === 'dialog');

describe('ConfirmDialog · estructura', () => {
  test('es un único <dialog> con el id recibido, cerrado por defecto', async () => {
    const { body, dlg } = await dialog();
    expect(body.querySelectorAll('dialog').length).toBe(ONE);
    expect(dlg.getAttribute('id')).toBe('cancel-order');
    expect(dlg.hasAttribute('open')).toBe(false);
  });

  test('open pinta el <dialog> con el atributo `open` (visible sin JavaScript)', async () => {
    expect((await dialog({ open: true })).dlg.hasAttribute('open')).toBe(true);
  });

  test('aria-labelledby apunta al título, que es un encabezado con el texto recibido', async () => {
    const { dlg } = await dialog();
    const heading = dlg.ownerDocument.getElementById(dlg.getAttribute('aria-labelledby') ?? '');
    expect(heading, 'aria-labelledby no resuelve').not.toBeNull();
    expect(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']).toContain(heading?.tagName);
    expect(text(heading)).toBe('Cancelar y reembolsar');
  });

  test('sin `description` no hay aria-describedby; con ella, apunta a un elemento con ese texto', async () => {
    expect((await dialog()).dlg.hasAttribute('aria-describedby')).toBe(false);
    const { dlg } = await dialog({ description: 'Se reembolsa el total de forma simulada.' });
    const desc = dlg.ownerDocument.getElementById(dlg.getAttribute('aria-describedby') ?? '');
    expect(text(desc)).toBe('Se reembolsa el total de forma simulada.');
  });

  test('NO usa role="alertdialog" ni aria-modal falso (el <dialog> modal ya lo comunica)', async () => {
    const { dlg } = await dialog();
    expect(dlg.getAttribute('role')).not.toBe('alertdialog');
    expect(dlg.getAttribute('aria-modal')).not.toBe('false');
  });

  test('los ids de título y descripción son únicos y derivados del id del diálogo (varios diálogos en una página no chocan)', async () => {
    const a = await dialog({ id: 'uno', description: 'A' });
    const b = await dialog({ id: 'dos', description: 'B' });
    const ids = (d: HTMLDialogElement): string[] => [d.getAttribute('aria-labelledby') ?? '', d.getAttribute('aria-describedby') ?? ''];
    expect(ids(a.dlg).filter((i) => ids(b.dlg).includes(i))).toEqual([]);
  });
});

describe('ConfirmDialog · formulario y botones', () => {
  test('el formulario es method="post" y contiene los campos del slot (incluidos los hidden)', async () => {
    const { form } = await dialog();
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.querySelector('input[type="hidden"][name="to"]')?.getAttribute('value')).toBe('cancelado');
    expect(form.querySelector('input[name="note"]')).not.toBeNull();
  });

  test('`action` se pasa al formulario; sin él, no hay atributo action (envía a la propia página)', async () => {
    expect((await dialog({ action: '/admin/pedidos/1/transicion' })).form.getAttribute('action')).toBe('/admin/pedidos/1/transicion');
    expect((await dialog()).form.hasAttribute('action')).toBe(false);
  });

  test('el botón de confirmar es el ÚNICO que envía: uno solo sin formmethod="dialog", con el texto recibido', async () => {
    const { form } = await dialog();
    const confirms = submitters(form).filter((b) => b.getAttribute('formmethod') !== 'dialog');
    expect(confirms.length).toBe(ONE);
    expect(text(confirms[NONE])).toBe('Cancelar pedido');
    expect(confirms[NONE].getAttribute('type')).toBe('submit');
  });

  test('el botón de cancelar cierra el diálogo sin enviar: formmethod="dialog"', async () => {
    const cancel = cancelButton((await dialog()).form);
    expect(cancel, 'sin botón de cancelar con formmethod="dialog"').toBeDefined();
    expect(text(cancel)).not.toBe('');
  });

  test('el botón de cancelar no viaja con nombre ni valor de campo (no añade datos al envío)', async () => {
    const cancel = cancelButton((await dialog()).form)!;
    expect(cancel.hasAttribute('name')).toBe(false);
  });

  test('cancelLabel cambia el texto de cancelar; por defecto hay un texto no vacío', async () => {
    expect(text(cancelButton((await dialog({ cancelLabel: 'Volver' })).form))).toBe('Volver');
    expect(text(cancelButton((await dialog()).form)).length).toBeGreaterThan(NONE);
  });

  test('cancelar va antes que confirmar en el DOM (el foco inicial y el orden de tabulación empiezan por la opción segura)', async () => {
    const { form } = await dialog({ tone: 'danger' });
    const buttons = submitters(form);
    expect(buttons.indexOf(cancelButton(form)!)).toBeLessThan(buttons.indexOf(confirmButton(form)!));
  });

  test('tone="danger" marca el botón de confirmar como peligro; "primary" no', async () => {
    const danger = confirmButton((await dialog({ tone: 'danger' })).form)!;
    const primary = confirmButton((await dialog({ tone: 'primary' })).form)!;
    expect(hasMarker(danger, 'danger')).toBe(true);
    expect(hasMarker(primary, 'danger')).toBe(false);
    expect(markers(danger)).not.toBe(markers(primary));
  });

  test('sin tone, el diálogo se pinta con un botón de confirmar válido (tono por defecto del paquete)', async () => {
    const { form } = await dialog();
    expect(confirmButton(form)).toBeDefined();
  });

  test('no hay botón de confirmar dentro de un formulario anidado ni más de un <form>', async () => {
    const { body } = await dialog();
    expect(body.querySelectorAll('form').length).toBe(ONE);
    expect(body.querySelector('form form')).toBeNull();
  });
});

describe('ConfirmDialog · seguridad', () => {
  test('título, descripción y etiquetas del servidor se escapan', async () => {
    const { body } = await dialog({ title: HOSTILE, description: HOSTILE, confirmLabel: HOSTILE, cancelLabel: HOSTILE });
    expect(body.querySelector('#pwn')).toBeNull();
  });

  test('el id hostil no rompe el atributo', async () => {
    const { body } = await dialog({ id: 'a" onclick="alert(1)' });
    expect(body.querySelector('[onclick]')).toBeNull();
  });

  test('el diálogo no incluye campos propios con datos (ni hidden de identidad ni importes): solo lo que pone el slot', async () => {
    const { form } = await dialog({}, '');
    expect(form.querySelectorAll('input, select, textarea').length).toBe(NONE);
  });
});
