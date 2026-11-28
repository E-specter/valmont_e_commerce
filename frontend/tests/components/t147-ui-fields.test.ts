import { describe, expect, test } from 'vitest';
import RadioGroup from '../../src/components/ui/RadioGroup.astro';
import Select from '../../src/components/ui/Select.astro';
import Textarea from '../../src/components/ui/Textarea.astro';
import { describedBy, text, ui } from '../helpers/ui';

// T-147 · `ui/Select`, `ui/Textarea` y `ui/RadioGroup` (STATUS ui «T-147 › Firmas públicas») con la Container API: estados, errores y ARIA.
// El contraste en los dos contextos (tienda y backoffice) se mide en el E2E (necesita estilos calculados).
const NONE = 0;
const ONE = 1;
const TWO = 2;
const SIX = 6;
const MAX_LEN = 5000;
const HOSTILE = '"><img src=x onerror=alert(1)><script>window.__pwned=1</script>';
const OPTIONS = [
  { value: 'automatic', label: 'Automático' },
  { value: 'manual', label: 'Manual' },
  { value: 'quartz', label: 'Cuarzo' },
];
const POLICIES = [
  { value: 'stock', label: 'Solo con stock' },
  { value: 'made_to_order', label: 'Siempre bajo pedido', hint: 'Se fabrica tras el pago' },
  { value: 'backorder', label: 'Con stock y, agotado, bajo pedido' },
];

const select = (props: Record<string, unknown> = {}) => ui(Select, { id: 'pf-mov', name: 'movement_code', label: 'Movimiento', options: OPTIONS, ...props });
const textarea = (props: Record<string, unknown> = {}) => ui(Textarea, { id: 'pf-desc', name: 'description', label: 'Descripción', ...props });
const radios = (props: Record<string, unknown> = {}) => ui(RadioGroup, { name: 'order_policy', legend: 'Política de venta', options: POLICIES, ...props });
const sel = (b: ParentNode) => b.querySelector('select') as HTMLSelectElement;
const optionsOf = (b: ParentNode) => [...b.querySelectorAll('option')];
const inputs = (b: ParentNode) => [...b.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
const noDangerousNodes = (b: ParentNode) => expect(b.querySelectorAll('script, img')).toHaveLength(NONE);
const idsUnique = (b: ParentNode) => {
  const ids = [...b.querySelectorAll('[id]')].map((e) => e.getAttribute('id'));
  expect(new Set(ids).size).toBe(ids.length);
};

describe('Select', () => {
  test('<label for> asociada a <select id name> y una opción por elemento de `options`', async () => {
    const body = await select();
    expect(sel(body).getAttribute('id')).toBe('pf-mov');
    expect(sel(body).getAttribute('name')).toBe('movement_code');
    expect(text(body.querySelector('label[for="pf-mov"]'))).toContain('Movimiento');
    expect(optionsOf(body).map((o) => [o.getAttribute('value'), text(o)])).toEqual(OPTIONS.map((o) => [o.value, o.label]));
  });

  test('la opción cuyo valor coincide con `value` sale seleccionada y solo esa', async () => {
    const body = await select({ value: 'manual' });
    expect(optionsOf(body).filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value'))).toEqual(['manual']);
  });

  test('con `placeholder`: primera opción de valor vacío, seleccionada si no hay valor, y no si lo hay', async () => {
    const empty = await select({ placeholder: 'Sin especificar' });
    const first = optionsOf(empty)[NONE];
    expect([first.getAttribute('value'), text(first)]).toEqual(['', 'Sin especificar']);
    expect(first.hasAttribute('selected')).toBe(true);
    expect(optionsOf(empty).filter((o) => o.hasAttribute('selected'))).toHaveLength(ONE);
    const filled = await select({ placeholder: 'Sin especificar', value: 'quartz' });
    expect(optionsOf(filled)[NONE].hasAttribute('selected')).toBe(false);
    expect(optionsOf(filled).filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value'))).toEqual(['quartz']);
  });

  test('sin `placeholder` no hay opción vacía añadida', async () => {
    expect(optionsOf(await select())).toHaveLength(OPTIONS.length);
  });

  test('un valor que no está en las opciones no selecciona ninguna opción real', async () => {
    const body = await select({ value: 'no-existe', placeholder: 'Elige' });
    expect(optionsOf(body).filter((o) => o.hasAttribute('selected') && o.getAttribute('value') !== '')).toHaveLength(NONE);
  });

  test('sin opciones: renderiza un <select> vacío sin romper', async () => {
    const body = await select({ options: [] });
    expect(optionsOf(body)).toHaveLength(NONE);
    expect(sel(body)).not.toBeNull();
  });

  test('required: atributo `required` y asterisco decorativo (aria-hidden) en la etiqueta', async () => {
    const body = await select({ required: true });
    expect(sel(body).hasAttribute('required')).toBe(true);
    expect(body.querySelector('label [aria-hidden="true"]')).not.toBeNull();
    expect((await select()).querySelector('select')?.hasAttribute('required')).toBe(false);
  });

  test('disabled', async () => {
    expect(sel(await select({ disabled: true })).hasAttribute('disabled')).toBe(true);
  });

  test('error: aria-invalid="true" y aria-describedby apunta al texto del error', async () => {
    const body = await select({ error: 'Elige una categoría' });
    expect(sel(body).getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, sel(body)).map((d) => d.text)).toContain('Elige una categoría');
    expect(sel(await select()).hasAttribute('aria-invalid')).toBe(false);
    expect(sel(await select()).hasAttribute('aria-describedby')).toBe(false);
  });

  test('ayuda y error a la vez: ambos referenciados; ids únicos', async () => {
    const body = await select({ hint: 'Solo categorías activas', error: 'Obligatorio' });
    const texts = describedBy(body, sel(body)).map((d) => d.text);
    expect(texts).toHaveLength(TWO);
    expect(texts.join(' ')).toContain('Solo categorías activas');
    expect(texts.join(' ')).toContain('Obligatorio');
    idsUnique(body);
  });

  test('los iconos son decorativos (aria-hidden)', async () => {
    const svgs = [...(await select({ error: 'x' })).querySelectorAll('svg')];
    expect(svgs.length).toBeGreaterThan(NONE);
    svgs.forEach((s) => expect(s.getAttribute('aria-hidden')).toBe('true'));
  });

  test('textos hostiles (etiqueta, opciones, error, ayuda, valor) se escapan', async () => {
    const body = await select({ label: HOSTILE, options: [{ value: HOSTILE, label: HOSTILE }], value: HOSTILE, error: HOSTILE, hint: HOSTILE });
    noDangerousNodes(body);
    expect(optionsOf(body)[NONE].getAttribute('value')).toBe(HOSTILE);
    expect(text(optionsOf(body)[NONE])).toBe(HOSTILE);
  });
});

describe('Textarea', () => {
  test('<label for> asociada a <textarea id name>; el valor es su contenido', async () => {
    const body = await textarea({ value: 'Línea 1\nLínea 2' });
    const ta = body.querySelector('textarea') as HTMLTextAreaElement;
    expect([ta.getAttribute('id'), ta.getAttribute('name')]).toEqual(['pf-desc', 'description']);
    expect(text(body.querySelector('label[for="pf-desc"]'))).toContain('Descripción');
    expect(ta.textContent).toBe('Línea 1\nLínea 2');
  });

  test('sin valor: vacío', async () => {
    expect((await textarea()).querySelector('textarea')?.textContent ?? '').toBe('');
  });

  test('rows y maxlength llegan al control; required con asterisco decorativo', async () => {
    const ta = (await textarea({ rows: SIX, maxlength: MAX_LEN, required: true })).querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.getAttribute('rows')).toBe(String(SIX));
    expect(ta.getAttribute('maxlength')).toBe(String(MAX_LEN));
    expect(ta.hasAttribute('required')).toBe(true);
  });

  test('error: aria-invalid y aria-describedby con ayuda y error', async () => {
    const body = await textarea({ error: 'Texto demasiado largo', hint: 'Hasta 5000 caracteres' });
    const ta = body.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    const texts = describedBy(body, ta).map((d) => d.text).join(' ');
    expect(texts).toContain('Texto demasiado largo');
    expect(texts).toContain('Hasta 5000 caracteres');
    idsUnique(body);
  });

  test('un valor que intenta cerrar el <textarea> y abrir un <script> se escapa', async () => {
    const attack = '</textarea><script>window.__pwned=1</script><b>x</b>';
    const body = await textarea({ value: attack });
    noDangerousNodes(body);
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('textarea')?.textContent).toBe(attack);
  });

  test('etiqueta, ayuda y error hostiles se escapan', async () => {
    noDangerousNodes(await textarea({ label: HOSTILE, hint: HOSTILE, error: HOSTILE }));
  });
});

describe('RadioGroup', () => {
  test('<fieldset> con <legend> como primer hijo y un radio por opción, todos con el mismo name', async () => {
    const body = await radios();
    const fs = body.querySelector('fieldset') as HTMLFieldSetElement;
    expect(fs).not.toBeNull();
    expect(fs.firstElementChild?.tagName).toBe('LEGEND');
    expect(text(fs.querySelector('legend'))).toContain('Política de venta');
    expect(inputs(body).map((i) => [i.getAttribute('name'), i.getAttribute('value')])).toEqual(POLICIES.map((p) => ['order_policy', p.value]));
  });

  test('cada radio tiene etiqueta asociada con el texto de su opción', async () => {
    const body = await radios();
    inputs(body).forEach((input, i) => {
      const label = input.closest('label') ?? (input.id ? body.querySelector(`label[for="${input.id}"]`) : null);
      expect(label, `radio ${i}`).not.toBeNull();
      expect(text(label)).toContain(POLICIES[i].label);
    });
  });

  test('la ayuda de una opción se muestra con su etiqueta', async () => {
    const body = await radios();
    expect(text(body)).toContain('Se fabrica tras el pago');
  });

  test('`value` marca exactamente un radio; sin valor o con uno desconocido no hay ninguno marcado', async () => {
    expect(inputs(await radios({ value: 'made_to_order' })).filter((i) => i.hasAttribute('checked')).map((i) => i.value)).toEqual(['made_to_order']);
    expect(inputs(await radios()).filter((i) => i.hasAttribute('checked'))).toHaveLength(NONE);
    expect(inputs(await radios({ value: 'otra' })).filter((i) => i.hasAttribute('checked'))).toHaveLength(NONE);
  });

  test('required: la agrupación exige elegir (al menos un radio `required`) y la leyenda lleva asterisco decorativo', async () => {
    const body = await radios({ required: true });
    expect(inputs(body).some((i) => i.hasAttribute('required'))).toBe(true);
    expect(body.querySelector('legend [aria-hidden="true"]')).not.toBeNull();
    expect(inputs(await radios()).some((i) => i.hasAttribute('required'))).toBe(false);
  });

  test('error: el texto está dentro del grupo y lo referencia aria-describedby (del fieldset o de los radios)', async () => {
    const body = await radios({ error: 'Elige una política' });
    const fs = body.querySelector('fieldset') as HTMLFieldSetElement;
    expect(text(fs)).toContain('Elige una política');
    const refs = [fs, ...inputs(body)].flatMap((el) => describedBy(body, el).map((d) => d.text));
    expect(refs.join(' ')).toContain('Elige una política');
    expect(text(await radios())).not.toContain('Elige una política');
    idsUnique(body);
  });

  test('los iconos del error son decorativos (aria-hidden)', async () => {
    (await radios({ error: 'x' })).querySelectorAll('svg').forEach((s) => expect(s.getAttribute('aria-hidden')).toBe('true'));
  });

  test('leyenda, etiquetas, ayudas, valores y error hostiles se escapan', async () => {
    const body = await radios({ legend: HOSTILE, error: HOSTILE, options: [{ value: HOSTILE, label: HOSTILE, hint: HOSTILE }], value: HOSTILE });
    noDangerousNodes(body);
    expect(inputs(body)[NONE].getAttribute('value')).toBe(HOSTILE);
  });
});
