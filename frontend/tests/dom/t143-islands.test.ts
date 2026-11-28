import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initConfirmDialog } from '../../src/islands/confirm-dialog';
import { initFormBusy } from '../../src/islands/form-busy';

// T-143 · islas `confirm-dialog` y `form-busy` con happy-dom (STATUS «T-143 › Resultado esperado y Pruebas obligatorias»).
// happy-dom no implementa Invoker Commands (`commandForElement` no existe): es justo el caso del RESPALDO de la isla.
const NONE = 0;
const ONE = 1;

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, NONE));
  await Promise.resolve();
};

describe('initConfirmDialog', () => {
  let showModal: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  // Marcado igual al que emite ConfirmDialog.astro (la integración con el componente real se prueba en t143-island-integration).
  const dialogHtml = (id: string, open = false): string =>
    `<dialog id="${id}" class="dialog" ${open ? 'open' : ''} aria-labelledby="${id}-t"><form method="post"><h2 id="${id}-t">Título</h2>` +
    `<button type="submit" formmethod="dialog">Volver</button><button type="submit">Confirmar</button></form></dialog>`;
  const triggerHtml = (id: string): string => `<button type="button" id="open-${id}" commandfor="${id}" command="show-modal">Abrir</button>`;
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  test('el <dialog> que llega con `open` se abre en modal (showModal) al iniciar', () => {
    document.body.innerHTML = dialogHtml('d', true);
    initConfirmDialog();
    expect(showModal).toHaveBeenCalledTimes(ONE);
    expect(el<HTMLDialogElement>('d').open).toBe(true);
  });

  test('un <dialog> cerrado NO se abre al iniciar (showModal solo con `open`)', () => {
    document.body.innerHTML = dialogHtml('d');
    initConfirmDialog();
    expect(showModal).not.toHaveBeenCalled();
    expect(el<HTMLDialogElement>('d').open).toBe(false);
  });

  test('respaldo: sin Invoker Commands, el clic en el disparador abre su diálogo con showModal', () => {
    document.body.innerHTML = dialogHtml('d') + triggerHtml('d');
    initConfirmDialog();
    el<HTMLButtonElement>('open-d').click();
    expect(showModal).toHaveBeenCalledTimes(ONE);
    expect(el<HTMLDialogElement>('d').open).toBe(true);
  });

  test('cada disparador abre SU diálogo y no el de al lado', () => {
    document.body.innerHTML = dialogHtml('a') + dialogHtml('b') + triggerHtml('a') + triggerHtml('b');
    initConfirmDialog();
    el<HTMLButtonElement>('open-b').click();
    expect(el<HTMLDialogElement>('b').open).toBe(true);
    expect(el<HTMLDialogElement>('a').open).toBe(false);
  });

  test('idempotente: iniciar dos o tres veces no duplica los manejadores (un clic = un showModal)', () => {
    document.body.innerHTML = dialogHtml('d') + triggerHtml('d');
    initConfirmDialog();
    initConfirmDialog();
    initConfirmDialog(document);
    el<HTMLButtonElement>('open-d').click();
    expect(showModal).toHaveBeenCalledTimes(ONE);
  });

  test('idempotente con `open`: iniciar dos veces solo llama una vez a showModal', () => {
    document.body.innerHTML = dialogHtml('d', true);
    initConfirmDialog();
    initConfirmDialog();
    expect(showModal).toHaveBeenCalledTimes(ONE);
    expect(el<HTMLDialogElement>('d').open).toBe(true);
  });

  test('un diálogo o disparador añadido después se atiende en la siguiente llamada', () => {
    document.body.innerHTML = dialogHtml('a') + triggerHtml('a');
    initConfirmDialog();
    document.body.insertAdjacentHTML('beforeend', dialogHtml('b') + triggerHtml('b'));
    initConfirmDialog();
    el<HTMLButtonElement>('open-b').click();
    expect(el<HTMLDialogElement>('b').open).toBe(true);
    el<HTMLButtonElement>('open-a').click();
    expect(el<HTMLDialogElement>('a').open).toBe(true);
  });

  test('con `root`, solo toca lo que hay dentro de él', () => {
    document.body.innerHTML = `<div id="inside">${dialogHtml('in', true)}</div><div id="outside">${dialogHtml('out', true)}</div>`;
    initConfirmDialog(el('inside'));
    expect(showModal).toHaveBeenCalledTimes(ONE);
    expect(el<HTMLDialogElement>('in').open).toBe(true);
  });

  test('no falla sin diálogos ni disparadores', () => {
    document.body.innerHTML = '<p>nada</p>';
    expect(() => initConfirmDialog()).not.toThrow();
  });

  test('un disparador que apunta a un id inexistente no lanza al pulsarlo', () => {
    document.body.innerHTML = triggerHtml('no-existe');
    initConfirmDialog();
    expect(() => el<HTMLButtonElement>('open-no-existe').click()).not.toThrow();
    expect(showModal).not.toHaveBeenCalled();
  });

  test('un disparador que apunta a algo que no es un <dialog> no lo abre ni lanza', () => {
    document.body.innerHTML = `<div id="x">hola</div>${triggerHtml('x')}`;
    initConfirmDialog();
    expect(() => el<HTMLButtonElement>('open-x').click()).not.toThrow();
    expect(showModal).not.toHaveBeenCalled();
  });

  test('pulsar el disparador con el diálogo ya abierto no lanza (showModal sobre un diálogo abierto es InvalidStateError)', () => {
    document.body.innerHTML = dialogHtml('d') + triggerHtml('d');
    initConfirmDialog();
    el<HTMLButtonElement>('open-d').click();
    expect(() => el<HTMLButtonElement>('open-d').click()).not.toThrow();
  });

  test('el disparador sin `command="show-modal"` no abre nada', () => {
    document.body.innerHTML = `${dialogHtml('d')}<button type="button" id="plain" commandfor="d">Otro</button>`;
    initConfirmDialog();
    el<HTMLButtonElement>('plain').click();
    expect(showModal).not.toHaveBeenCalled();
  });

  test('el diálogo no envía nada al abrirse: no se dispara ningún submit', () => {
    document.body.innerHTML = dialogHtml('d', true) + triggerHtml('d');
    const submit = vi.fn();
    document.addEventListener('submit', submit);
    initConfirmDialog();
    el<HTMLButtonElement>('open-d').click();
    document.removeEventListener('submit', submit);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('initFormBusy', () => {
  const added: ((e: Event) => void)[] = [];
  /** Escucha `submit` en `document` y lo retira al terminar la prueba (no se filtra a las siguientes). */
  const onSubmit = (fn: (e: Event) => void): void => {
    added.push(fn);
    document.addEventListener('submit', fn);
  };
  afterEach(() => {
    added.splice(NONE).forEach((fn) => document.removeEventListener('submit', fn));
    document.body.innerHTML = '';
  });

  const formHtml = (attrs = 'data-busy-on-submit'): string =>
    `<form id="f" method="post" ${attrs}><input name="title" value="x">` +
    `<button type="submit" id="save" name="intent" value="save">Guardar</button>` +
    `<button type="submit" id="draft" name="intent" value="draft">Borrador</button>` +
    `<button type="button" id="aux">Auxiliar</button></form>`;
  const form = (): HTMLFormElement => document.getElementById('f') as HTMLFormElement;
  const btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;
  /** Evita la navegación real de happy-dom después de que la isla ya miró el envío (no cambia lo que la isla ve). */
  const swallowNavigation = (): void => onSubmit((e) => e.preventDefault());

  test('al enviar: el formulario queda aria-busy="true" y el botón de envío en «cargando» y deshabilitado', async () => {
    document.body.innerHTML = formHtml();
    swallowNavigation();
    initFormBusy();
    btn('save').click();
    await flush();
    expect(form().getAttribute('aria-busy')).toBe('true');
    expect(btn('save').disabled).toBe(true);
    expect(btn('save').getAttribute('aria-busy')).toBe('true');
    expect(btn('save').hasAttribute('data-loading')).toBe(true);
  });

  test('el valor del botón viaja: aún no está deshabilitado cuando termina el despacho del evento (se aplica después)', async () => {
    document.body.innerHTML = formHtml();
    let sent: FormDataEntryValue | null = null;
    let disabledDuringDispatch: boolean | null = null;
    // El navegador construye el conjunto de datos al terminar de despachar `submit`: aquí, el último en escuchar (en `document`).
    onSubmit((e) => {
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement;
      disabledDuringDispatch = submitter.disabled;
      sent = new FormData(form(), submitter).get('intent');
      e.preventDefault();
    });
    initFormBusy();
    btn('draft').click();
    expect(disabledDuringDispatch).toBe(false);
    expect(sent).toBe('draft');
    await flush();
    expect(btn('draft').disabled).toBe(true);
  });

  test('con varios botones de envío, el que se pulsa es el que queda en «cargando»', async () => {
    document.body.innerHTML = formHtml();
    swallowNavigation();
    initFormBusy();
    btn('draft').click();
    await flush();
    expect(btn('draft').disabled).toBe(true);
    expect(btn('draft').getAttribute('aria-busy')).toBe('true');
    expect(btn('aux').disabled).toBe(false);
    expect(btn('aux').hasAttribute('data-loading')).toBe(false);
  });

  test('un envío sin botón identificado (Enter en un campo) deja el botón de envío del formulario en «cargando»', async () => {
    document.body.innerHTML = formHtml();
    swallowNavigation();
    initFormBusy();
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(form().getAttribute('aria-busy')).toBe('true');
    expect(btn('save').disabled).toBe(true);
    expect(btn('save').getAttribute('aria-busy')).toBe('true');
  });

  test('doble envío: tras el primero, el botón deshabilitado ya no puede volver a enviar', async () => {
    document.body.innerHTML = formHtml();
    const submit = vi.fn((e: Event) => e.preventDefault());
    onSubmit(submit);
    initFormBusy();
    btn('save').click();
    await flush();
    btn('save').click();
    await flush();
    expect(submit).toHaveBeenCalledTimes(ONE);
  });

  test('idempotente: iniciar varias veces aplica el estado una sola vez por envío', async () => {
    document.body.innerHTML = formHtml();
    swallowNavigation();
    const setAttribute = vi.spyOn(form(), 'setAttribute');
    initFormBusy();
    initFormBusy();
    initFormBusy(document);
    btn('save').click();
    await flush();
    const busyCalls = setAttribute.mock.calls.filter(([name]) => name === 'aria-busy');
    expect(busyCalls.length).toBe(ONE);
  });

  test('un formulario sin `data-busy-on-submit` no se toca', async () => {
    document.body.innerHTML = formHtml('');
    swallowNavigation();
    initFormBusy();
    btn('save').click();
    await flush();
    expect(form().hasAttribute('aria-busy')).toBe(false);
    expect(btn('save').disabled).toBe(false);
  });

  test('si otro manejador cancela el envío (validación propia), el formulario NO queda ocupado', async () => {
    document.body.innerHTML = formHtml();
    form().addEventListener('submit', (e) => e.preventDefault()); // antes de iniciar la isla: corre primero
    initFormBusy();
    btn('save').click();
    await flush();
    expect(form().hasAttribute('aria-busy')).toBe(false);
    expect(btn('save').disabled).toBe(false);
  });

  test('con `root`, solo atiende los formularios de dentro', async () => {
    document.body.innerHTML = `<div id="a">${formHtml().replace('id="f"', 'id="fa"')}</div><div id="b">${formHtml().replace('id="f"', 'id="fb"').replaceAll('id="save"', 'id="saveb"')}</div>`;
    swallowNavigation();
    initFormBusy(document.getElementById('a') as HTMLElement);
    (document.querySelector('#fb button[type="submit"]') as HTMLButtonElement).click();
    await flush();
    expect(document.getElementById('fb')?.hasAttribute('aria-busy')).toBe(false);
  });

  test('un formulario sin ningún botón de envío no falla', async () => {
    document.body.innerHTML = '<form id="f" data-busy-on-submit><input name="q"></form>';
    swallowNavigation();
    initFormBusy();
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(form().getAttribute('aria-busy')).toBe('true');
  });

  test('no falla sin formularios', () => {
    document.body.innerHTML = '<p>nada</p>';
    expect(() => initFormBusy()).not.toThrow();
  });

  test('un formulario añadido después se atiende en la siguiente llamada', async () => {
    document.body.innerHTML = '<p>nada</p>';
    swallowNavigation();
    initFormBusy();
    document.body.insertAdjacentHTML('beforeend', formHtml());
    initFormBusy();
    btn('save').click();
    await flush();
    expect(form().getAttribute('aria-busy')).toBe('true');
  });
});
