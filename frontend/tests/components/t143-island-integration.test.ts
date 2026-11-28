import { Window } from 'happy-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ConfirmDialog from '../../src/components/ui/ConfirmDialog.astro';
import { initConfirmDialog } from '../../src/islands/confirm-dialog';
import { renderAstro } from '../helpers/render';

// T-143 · integración: el marcado REAL de ConfirmDialog (Container API) funciona con las islas reales.
// Las islas usan los globales del navegador: se les presta una ventana de happy-dom mientras dura la prueba.
const ONE = 1;
const TRIGGER = '<button type="button" id="open" commandfor="cancel-order" command="show-modal">Cancelar pedido</button>';

async function mount(props: Record<string, unknown>, extra = ''): Promise<{ win: Window; dlg: HTMLDialogElement }> {
  const html = await renderAstro(ConfirmDialog, {
    props: { id: 'cancel-order', title: 'Cancelar y reembolsar', confirmLabel: 'Cancelar pedido', ...props },
    slots: { default: '<input type="hidden" name="to" value="cancelado">' },
  });
  const win = new Window();
  win.document.body.innerHTML = `${extra}${html}`;
  vi.stubGlobal('document', win.document);
  vi.stubGlobal('HTMLDialogElement', win.HTMLDialogElement);
  vi.stubGlobal('HTMLButtonElement', win.HTMLButtonElement);
  vi.stubGlobal('HTMLFormElement', win.HTMLFormElement);
  return { win, dlg: win.document.getElementById('cancel-order') as unknown as HTMLDialogElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConfirmDialog real + isla confirm-dialog', () => {
  test('con `open` el componente real sale abierto y la isla lo deja en modal (showModal)', async () => {
    const { win, dlg } = await mount({ open: true });
    const spy = vi.spyOn(win.HTMLDialogElement.prototype, 'showModal');
    expect(dlg.hasAttribute('open')).toBe(true);
    initConfirmDialog();
    expect(spy).toHaveBeenCalledTimes(ONE);
    expect(dlg.open).toBe(true);
  });

  test('cerrado: la isla no lo abre', async () => {
    const { win, dlg } = await mount({});
    const spy = vi.spyOn(win.HTMLDialogElement.prototype, 'showModal');
    initConfirmDialog();
    expect(spy).not.toHaveBeenCalled();
    expect(dlg.open).toBe(false);
  });

  test('el disparador con `commandfor` abre el diálogo real (respaldo)', async () => {
    const { win, dlg } = await mount({}, TRIGGER);
    initConfirmDialog();
    (win.document.getElementById('open') as unknown as HTMLButtonElement).click();
    expect(dlg.open).toBe(true);
  });

  test('idempotente sobre el marcado real', async () => {
    const { win } = await mount({ open: true }, TRIGGER);
    const spy = vi.spyOn(win.HTMLDialogElement.prototype, 'showModal');
    initConfirmDialog();
    initConfirmDialog();
    expect(spy).toHaveBeenCalledTimes(ONE);
  });
});
