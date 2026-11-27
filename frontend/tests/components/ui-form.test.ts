import { describe, expect, test } from 'vitest';
import Checkbox from '../../src/components/ui/Checkbox.astro';
import Field from '../../src/components/ui/Field.astro';
import { describedBy, text, ui } from '../helpers/ui';

// T-117 · Field y Checkbox (STATUS "T-117 › Firmas públicas") con la Container API.

const HOSTILE = '"><img src=x onerror=alert(1)>';
const LIMITS = { minlength: 3, maxlength: 9, min: 1, max: 12 } as const;
const PAIR = 2;
const FIELD_TYPES = ['text', 'email', 'password', 'tel', 'date', 'search', 'number'] as const;

const field = async (props: Record<string, unknown> = {}, slots: Record<string, string> = {}): Promise<HTMLElement> =>
  ui(Field, { id: 'correo', name: 'email', label: 'Correo electrónico', ...props }, slots);

const input = (body: ParentNode): Element => {
  const el = body.querySelector('input');
  if (!el) throw new Error('El Field no renderizó un <input>');
  return el;
};

describe('Field · etiqueta y entrada', () => {
  test('label asociada por for/id con el input', async () => {
    const body = await field();
    const el = input(body);
    expect(el.getAttribute('id')).toBe('correo');
    expect(el.getAttribute('name')).toBe('email');
    const label = body.querySelector('label[for="correo"]');
    expect(label, 'falta <label for="correo">').not.toBeNull();
    expect(text(label)).toContain('Correo electrónico');
  });

  test('el id del input es único en el fragmento (ni la ayuda ni el error lo repiten)', async () => {
    const body = await field({ hint: 'Usaremos este correo para avisarte', error: 'Correo no válido' });
    const ids = [...body.querySelectorAll('[id]')].map((e) => e.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i === 'correo').length).toBe(1);
  });

  test('type es text por defecto', async () => {
    expect(input(await field()).getAttribute('type')).toBe('text');
  });

  test.each(FIELD_TYPES)('type="%s" se respeta', async (type) => {
    expect(input(await field({ type })).getAttribute('type')).toBe(type);
  });

  test('value, placeholder, autocomplete e inputmode llegan al input', async () => {
    const el = input(await field({ value: 'ana@example.com', placeholder: 'tu@correo.com', autocomplete: 'email', inputmode: 'email' }));
    expect(el.getAttribute('value')).toBe('ana@example.com');
    expect(el.getAttribute('placeholder')).toBe('tu@correo.com');
    expect(el.getAttribute('autocomplete')).toBe('email');
    expect(el.getAttribute('inputmode')).toBe('email');
  });

  test('restricciones de validación nativa: minlength, maxlength, min, max y pattern', async () => {
    const el = input(await field({ type: 'number', ...LIMITS, pattern: '[0-9]+' }));
    expect(el.getAttribute('minlength')).toBe('3');
    expect(el.getAttribute('maxlength')).toBe('9');
    expect(el.getAttribute('min')).toBe('1');
    expect(el.getAttribute('max')).toBe('12');
    expect(el.getAttribute('pattern')).toBe('[0-9]+');
  });

  test('sin las props opcionales no emite atributos vacíos', async () => {
    const el = input(await field());
    ['value', 'placeholder', 'autocomplete', 'inputmode', 'minlength', 'maxlength', 'min', 'max', 'pattern'].forEach((a) =>
      expect(el.hasAttribute(a), `atributo ${a} presente sin pedirlo`).toBe(false),
    );
  });

  test('required, disabled y readonly ponen el atributo; sin ellos no aparece', async () => {
    const on = input(await field({ required: true, disabled: true, readonly: true }));
    expect(on.hasAttribute('required')).toBe(true);
    expect(on.hasAttribute('disabled')).toBe(true);
    expect(on.hasAttribute('readonly')).toBe(true);
    const off = input(await field());
    expect(off.hasAttribute('required')).toBe(false);
    expect(off.hasAttribute('disabled')).toBe(false);
    expect(off.hasAttribute('readonly')).toBe(false);
  });

  test('el placeholder no sustituye a la etiqueta: la etiqueta existe aunque haya placeholder', async () => {
    const body = await field({ placeholder: 'tu@correo.com' });
    expect(body.querySelector('label[for="correo"]')).not.toBeNull();
  });
});

describe('Field · error y ayuda (aria-invalid, aria-describedby)', () => {
  test('sin error ni ayuda: ni aria-invalid ni aria-describedby', async () => {
    const el = input(await field());
    expect(el.getAttribute('aria-invalid')).not.toBe('true');
    expect(el.hasAttribute('aria-describedby')).toBe(false);
  });

  test('con error: aria-invalid="true" y aria-describedby apunta al texto del mensaje', async () => {
    const body = await field({ error: 'Ingresa un correo válido' });
    const el = input(body);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    const refs = describedBy(body, el);
    expect(refs.length).toBe(1);
    expect(refs[0].text).toContain('Ingresa un correo válido');
    expect(refs[0].id).not.toBe('correo');
  });

  test('el error lleva icono (no solo color) y no se confunde con la etiqueta', async () => {
    const body = await field({ error: 'Ingresa un correo válido' });
    const svg = body.querySelector('svg');
    expect(svg, 'el error debe llevar un icono').not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(text(body.querySelector('label'))).not.toContain('Ingresa un correo válido');
  });

  test('con hint: aria-describedby apunta a la ayuda y el campo no está inválido', async () => {
    const body = await field({ hint: 'Mínimo 8 caracteres' });
    const el = input(body);
    const refs = describedBy(body, el);
    expect(refs.map((r) => r.text)).toEqual(['Mínimo 8 caracteres']);
    expect(el.getAttribute('aria-invalid')).not.toBe('true');
    expect(body.querySelectorAll('svg').length).toBe(0);
  });

  test('con hint y error a la vez: aria-describedby los enlaza a ambos', async () => {
    const body = await field({ hint: 'Mínimo 8 caracteres', error: 'Demasiado corta' });
    const el = input(body);
    const texts = describedBy(body, el).map((r) => r.text);
    expect(texts.length).toBe(PAIR);
    expect(texts.join('|')).toContain('Mínimo 8 caracteres');
    expect(texts.join('|')).toContain('Demasiado corta');
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  test('dos campos con ids distintos no comparten ids de mensaje (aria-describedby no se cruza)', async () => {
    const aBody = await field({ id: 'a', name: 'a', error: 'Error A' });
    const a = describedBy(aBody, input(aBody));
    const bBody = await field({ id: 'b', name: 'b', error: 'Error B' });
    const b = describedBy(bBody, input(bBody));
    expect(a.map((r) => r.id)).not.toEqual(b.map((r) => r.id));
  });

  test('error y hint se escapan (sin inyección de HTML)', async () => {
    const body = await field({ error: HOSTILE, hint: HOSTILE });
    expect(body.querySelectorAll('img').length).toBe(0);
    expect(text(body)).toContain(HOSTILE);
  });

  test('label, value y placeholder se escapan en el marcado', async () => {
    const body = await field({ label: HOSTILE, value: HOSTILE, placeholder: HOSTILE });
    expect(body.querySelectorAll('img').length).toBe(0);
    expect(input(body).getAttribute('value')).toBe(HOSTILE);
    expect(input(body).getAttribute('placeholder')).toBe(HOSTILE);
  });
});

describe('Field · icono y acción', () => {
  test('iconLeft pinta un icono decorativo antes del input', async () => {
    const body = await field({ iconLeft: 'mail' });
    const svg = body.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(body.innerHTML.indexOf('<svg')).toBeLessThan(body.innerHTML.indexOf('<input'));
  });

  test('sin iconLeft, error ni acción no hay ningún SVG', async () => {
    expect((await field()).querySelectorAll('svg').length).toBe(0);
  });

  test('slot action se pinta después del input (botón del ojo, etc.)', async () => {
    const body = await field({ type: 'password' }, { action: '<button type="button" id="ojo" aria-label="Mostrar contraseña">ojo</button>' });
    expect(body.querySelector('#ojo')).not.toBeNull();
    expect(body.innerHTML.indexOf('<input')).toBeLessThan(body.innerHTML.indexOf('id="ojo"'));
  });

  test('sin slot action no hay botones', async () => {
    expect((await field()).querySelectorAll('button').length).toBe(0);
  });
});

describe('Checkbox', () => {
  const checkbox = async (props: Record<string, unknown> = {}, slots: Record<string, string> = {}): Promise<HTMLElement> =>
    ui(Checkbox, { id: 'terminos', name: 'terms', label: 'Acepto los términos', ...props }, slots);

  test('es un input type="checkbox" con id y name, y su etiqueta asociada por for/id', async () => {
    const body = await checkbox();
    const el = input(body);
    expect(el.getAttribute('type')).toBe('checkbox');
    expect(el.getAttribute('id')).toBe('terminos');
    expect(el.getAttribute('name')).toBe('terms');
    const label = body.querySelector('label[for="terminos"]');
    expect(label, 'falta <label for="terminos">').not.toBeNull();
    expect(text(label)).toBe('Acepto los términos');
  });

  test('o la etiqueta envuelve al input (clic en el texto alterna la casilla)', async () => {
    const body = await checkbox();
    const el = input(body);
    const byFor = body.querySelector('label[for="terminos"]') !== null;
    const wrapped = el.closest('label') !== null;
    expect(byFor || wrapped).toBe(true);
  });

  test('value por defecto "on" (o sin atributo) y value propio se respeta', async () => {
    const value = input(await checkbox()).getAttribute('value');
    expect(value === null || value === 'on').toBe(true);
    expect(input(await checkbox({ value: 'si' })).getAttribute('value')).toBe('si');
  });

  test('checked, required y disabled ponen el atributo; sin ellos no aparece', async () => {
    const on = input(await checkbox({ checked: true, required: true, disabled: true }));
    expect(on.hasAttribute('checked')).toBe(true);
    expect(on.hasAttribute('required')).toBe(true);
    expect(on.hasAttribute('disabled')).toBe(true);
    const off = input(await checkbox());
    expect(off.hasAttribute('checked')).toBe(false);
    expect(off.hasAttribute('required')).toBe(false);
    expect(off.hasAttribute('disabled')).toBe(false);
  });

  test('slot default sustituye a label y admite enlaces en la etiqueta', async () => {
    const body = await checkbox(
      { label: 'Texto que no debe verse' },
      { default: 'Acepto los <a href="/terminos">términos</a> y la <a href="/privacidad">privacidad</a>' },
    );
    const label = body.querySelector('label');
    expect(label?.querySelectorAll('a').length).toBe(PAIR);
    expect(text(body)).not.toContain('Texto que no debe verse');
    expect(text(label)).toContain('Acepto los términos y la privacidad');
  });

  test('sin label ni slot el control no tendría nombre accesible: renderizar es un error', async () => {
    await expect(ui(Checkbox, { id: 'sin-nombre', name: 'x' })).rejects.toThrow();
  });

  test('con error: aria-invalid="true" y aria-describedby apunta al mensaje, con icono', async () => {
    const body = await checkbox({ error: 'Debes aceptar los términos' });
    const el = input(body);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    const refs = describedBy(body, el);
    expect(refs.map((r) => r.text).join('|')).toContain('Debes aceptar los términos');
    expect(body.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  test('sin error: sin aria-invalid ni aria-describedby', async () => {
    const el = input(await checkbox());
    expect(el.getAttribute('aria-invalid')).not.toBe('true');
    expect(el.hasAttribute('aria-describedby')).toBe(false);
  });

  test('label y error se escapan (sin inyección de HTML)', async () => {
    const body = await checkbox({ label: HOSTILE, error: HOSTILE });
    expect(body.querySelectorAll('img').length).toBe(0);
  });
});
