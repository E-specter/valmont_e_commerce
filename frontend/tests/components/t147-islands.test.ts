import { Window } from 'happy-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ProductForm from '../../src/components/admin/ProductForm.astro';
import SpecsEditor from '../../src/components/admin/SpecsEditor.astro';
import { initSpecsEditor } from '../../src/islands/specs-editor';
import { initUnsavedChanges } from '../../src/islands/unsaved-changes';
import { EMPTY_PRODUCT_VALUES, readProductForm } from '../../src/lib/admin/product-form';
import { renderAstro } from '../helpers/render';
import { CASE_MATERIALS, CATEGORIES, MOVEMENTS, formValues, serialize, toFormData } from '../helpers/t147';
import { text } from '../helpers/ui';

// T-147 · islas `specs-editor` y `unsaved-changes` sobre el marcado REAL de SpecsEditor y ProductForm (Container API), con happy-dom.
// Las islas usan los globales del navegador: se les presta una ventana de happy-dom mientras dura la prueba (como en T-143).
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const MAX_SPECS = 40;
const GLOBALS = ['document', 'window', 'FormData', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLSelectElement', 'Element', 'Node', 'Event'] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(html: string): Window {
  const win = new Window();
  win.document.body.innerHTML = html;
  GLOBALS.forEach((g) => vi.stubGlobal(g, (win as unknown as Record<string, unknown>)[g === 'window' ? 'window' : g]));
  return win;
}
const props = (over: Record<string, unknown> = {}) => ({
  mode: 'edit', values: formValues(), categories: CATEGORIES, movements: MOVEMENTS, caseMaterials: CASE_MATERIALS, ...over,
});
const formHtml = (over: Record<string, unknown> = {}) => renderAstro(ProductForm, { props: props(over) });
const fire = (win: Window, el: Element, type: string): void => {
  el.dispatchEvent(new win.Event(type, { bubbles: true }) as unknown as Event);
};
const type = (win: Window, el: Element, value: string): void => {
  (el as HTMLInputElement).value = value;
  fire(win, el, 'input');
};
const inputsOf = (root: ParentNode): HTMLInputElement[] => [...root.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
const byLabel = (root: ParentNode, word: string): HTMLButtonElement | undefined =>
  ([...root.querySelectorAll('button')] as HTMLButtonElement[]).find((b) => `${b.getAttribute('aria-label') ?? ''} ${text(b)}`.toLowerCase().includes(word));
const rowsOf = (root: ParentNode): number => inputsOf(root.querySelector('[data-specs-editor]') ?? root).length / TWO;
const warns = (win: Window): boolean => {
  const ev = new win.Event('beforeunload', { cancelable: true });
  win.dispatchEvent(ev);
  return ev.defaultPrevented || typeof (ev as unknown as { returnValue: unknown }).returnValue === 'string';
};

describe('isla specs-editor sobre SpecsEditor real', () => {
  const editor = (props: Record<string, unknown> = {}) => renderAstro(SpecsEditor, { props: { specs: [{ label: 'Calibre', value: 'VM-01' }], ...props } });

  test('al iniciar muestra «Agregar especificación» y los botones de quitar, que sin JavaScript no existen para el usuario', async () => {
    const win = mount(await editor());
    const add = byLabel(win.document as unknown as ParentNode, 'agregar especificación');
    expect(add, 'falta el botón «Agregar especificación»').toBeDefined();
    initSpecsEditor(win.document as unknown as ParentNode);
    expect(add?.hasAttribute('hidden')).toBe(false);
    expect(add?.disabled).toBe(false);
    const removes = ([...win.document.querySelectorAll('button')] as unknown as HTMLButtonElement[]).filter((b) => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('quitar'));
    expect(removes.length).toBeGreaterThanOrEqual(THREE);
    removes.forEach((b) => expect(b.hasAttribute('hidden')).toBe(false));
  });

  test('«Agregar especificación» añade una fila vacía con los mismos nombres, la enfoca y la anuncia', async () => {
    const win = mount(await editor());
    initSpecsEditor(win.document as unknown as ParentNode);
    const before = inputsOf(win.document as unknown as ParentNode);
    const names = before.slice(NONE, TWO).map((i) => i.getAttribute('name'));
    byLabel(win.document as unknown as ParentNode, 'agregar especificación')?.click();
    const after = inputsOf(win.document as unknown as ParentNode);
    expect(after).toHaveLength(before.length + TWO);
    const added = after.slice(-TWO);
    expect(added.map((i) => i.value)).toEqual(['', '']);
    expect(added.map((i) => i.getAttribute('name'))).toEqual(names);
    expect(win.document.activeElement).toBe(added[NONE]);
    const labels = after.map((i) => i.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(labels.length);
    expect(text(win.document.querySelector('[role="status"]') as unknown as Element).length).toBeGreaterThan(NONE);
  });

  test('lo escrito en la fila añadida llega a readProductForm como el último par, en orden', async () => {
    const win = mount(await editor());
    initSpecsEditor(win.document as unknown as ParentNode);
    byLabel(win.document as unknown as ParentNode, 'agregar especificación')?.click();
    const added = inputsOf(win.document as unknown as ParentNode).slice(-TWO);
    type(win, added[NONE], 'Cristal');
    type(win, added[ONE], 'Zafiro');
    const entries = serialize(win.document as unknown as ParentNode);
    expect(readProductForm(toFormData(entries)).specs).toEqual([{ label: 'Calibre', value: 'VM-01' }, { label: 'Cristal', value: 'Zafiro' }]);
  });

  test('el botón de quitar elimina solo esa fila y conserva el resto', async () => {
    const specs = [{ label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' }];
    const win = mount(await editor({ specs }));
    initSpecsEditor(win.document as unknown as ParentNode);
    const removes = ([...win.document.querySelectorAll('button')] as unknown as HTMLButtonElement[]).filter((b) => (b.getAttribute('aria-label') ?? '').toLowerCase().includes('quitar'));
    const before = rowsOf(win.document as unknown as ParentNode);
    removes[ONE].click();
    expect(rowsOf(win.document as unknown as ParentNode)).toBe(before - ONE);
    expect(readProductForm(toFormData(serialize(win.document as unknown as ParentNode))).specs).toEqual([{ label: 'A', value: '1' }, { label: 'C', value: '3' }]);
  });

  test('en el máximo ya no se pueden añadir filas', async () => {
    const win = mount(await editor({ specs: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }], max: THREE }));
    initSpecsEditor(win.document as unknown as ParentNode);
    expect(rowsOf(win.document as unknown as ParentNode)).toBe(THREE);
    const add = byLabel(win.document as unknown as ParentNode, 'agregar especificación') as HTMLButtonElement;
    add.click();
    expect(rowsOf(win.document as unknown as ParentNode)).toBe(THREE);
    expect(add.disabled).toBe(true);
  });

  test('es idempotente: iniciar dos veces no duplica el efecto de un clic', async () => {
    const win = mount(await editor());
    initSpecsEditor(win.document as unknown as ParentNode);
    initSpecsEditor(win.document as unknown as ParentNode);
    const before = rowsOf(win.document as unknown as ParentNode);
    byLabel(win.document as unknown as ParentNode, 'agregar especificación')?.click();
    expect(rowsOf(win.document as unknown as ParentNode)).toBe(before + ONE);
  });

  test('sin editor en la página no hace nada ni falla', () => {
    const win = mount('<main><p>nada</p></main>');
    expect(() => initSpecsEditor(win.document as unknown as ParentNode)).not.toThrow();
  });

  test('en ProductForm el contador «N de 40» se actualiza con las filas rellenas', async () => {
    const win = mount(await formHtml());
    initSpecsEditor(win.document as unknown as ParentNode);
    const counter = () => text(win.document.body as unknown as Element);
    expect(counter()).toContain(`${TWO} de ${MAX_SPECS}`);
    byLabel(win.document as unknown as ParentNode, 'agregar especificación')?.click();
    const added = inputsOf(win.document.querySelector('[data-specs-editor]') as unknown as ParentNode).slice(-TWO);
    type(win, added[NONE], 'Cristal');
    type(win, added[ONE], 'Zafiro');
    expect(counter()).toContain(`${THREE} de ${MAX_SPECS}`);
  });
});

describe('isla unsaved-changes sobre ProductForm real', () => {
  test('sin cambios no avisa al salir', async () => {
    const win = mount(await formHtml());
    initUnsavedChanges(win.document as unknown as ParentNode);
    expect(warns(win)).toBe(false);
  });

  test.each([
    ['escribir en el nombre', 'input[name="name"]', 'Otro nombre', 'input'],
    ['cambiar la categoría', 'select[name="category_id"]', 'deportivos-id', 'change'],
  ])('con cambios sin guardar avisa al salir: %s', async (_c, selector, value, evt) => {
    const win = mount(await formHtml());
    initUnsavedChanges(win.document as unknown as ParentNode);
    const el = win.document.querySelector(selector) as unknown as HTMLInputElement;
    if (el.tagName === 'SELECT') {
      const other = [...el.querySelectorAll('option')].find((o) => !o.hasAttribute('selected') && o.getAttribute('value')) as HTMLOptionElement;
      el.value = other.value;
    } else el.value = value;
    fire(win, el, evt);
    expect(warns(win)).toBe(true);
  });

  test('cambiar la política de venta (radio) también cuenta como cambio', async () => {
    const win = mount(await formHtml());
    initUnsavedChanges(win.document as unknown as ParentNode);
    const radio = win.document.querySelector('input[name="order_policy"][value="stock"]') as unknown as HTMLInputElement;
    radio.checked = true;
    fire(win, radio, 'change');
    expect(warns(win)).toBe(true);
  });

  test('al guardar (envío del formulario) no avisa aunque haya cambios', async () => {
    const win = mount(await formHtml());
    initUnsavedChanges(win.document as unknown as ParentNode);
    const name = win.document.querySelector('input[name="name"]') as unknown as HTMLInputElement;
    name.value = 'Otro nombre';
    fire(win, name, 'input');
    const form = win.document.querySelector('form#product-form') as unknown as HTMLFormElement;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(warns(win)).toBe(false);
  });

  test('es idempotente y no falla sin formulario', async () => {
    const win = mount(await formHtml({ values: { ...EMPTY_PRODUCT_VALUES }, mode: 'create' }));
    expect(() => {
      initUnsavedChanges(win.document as unknown as ParentNode);
      initUnsavedChanges(win.document as unknown as ParentNode);
    }).not.toThrow();
    expect(warns(win)).toBe(false);
    const empty = mount('<p>sin formulario</p>');
    expect(() => initUnsavedChanges(empty.document as unknown as ParentNode)).not.toThrow();
  });
});
