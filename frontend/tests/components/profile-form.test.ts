import { describe, expect, test } from 'vitest';
import ProfileForm from '../../src/components/account/ProfileForm.astro';
import { BIRTH, BIRTH_TEXT, SESSION_EMAIL, USER_ID, fieldErrorText } from '../helpers/t129';
import { describedBy, text, ui } from '../helpers/ui';

// T-129 · ProfileForm con la Container API (STATUS ui › T-129 › Firmas públicas, y D-045): perfil editable, fecha de nacimiento
// fijable una vez (campo editable o solo lectura según `birthDateLocked`), errores por campo y sin datos internos.
const ONE = 1;
const NONE = 0;
const NAME = 'Ana Torres';
const PHONE = '+51987654321';
const CORRECTION_HINT = 'Para corregirla, contacta con atención al cliente.';
const HOSTILE = '"><img src=x onerror=alert(1)>';

type Errors = { form?: string; full_name?: string; phone?: string; birth_date?: string };
const values = (over: Partial<Record<'full_name' | 'phone' | 'birth_date', string>> = {}) => ({ full_name: NAME, phone: PHONE, birth_date: '', ...over });
const form = (props: Record<string, unknown> = {}): Promise<HTMLElement> =>
  ui(ProfileForm, { values: values(), email: SESSION_EMAIL, birthDateLocked: false, ...props });
const q = <T extends Element>(body: ParentNode, sel: string): T => {
  const el = body.querySelector<T>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
};
const nameInput = (b: ParentNode): HTMLInputElement => q(b, 'input[name="full_name"]');
const phoneInput = (b: ParentNode): HTMLInputElement => q(b, 'input[name="phone"]');
const dateInput = (b: ParentNode): HTMLInputElement | null => b.querySelector('input[name="birth_date"]');

describe('ProfileForm · estructura (funciona sin JavaScript)', () => {
  test('es un <form method="post"> que envía a /cuenta (o a sí mismo) y tiene un único botón de envío', async () => {
    const body = await form();
    const f = q<HTMLFormElement>(body, 'form');
    expect(f.getAttribute('method')?.toLowerCase()).toBe('post');
    const action = f.getAttribute('action');
    expect(action === null || action === '' || action.split('?')[NONE] === '/cuenta').toBe(true);
    expect(body.querySelectorAll('button[type="submit"], input[type="submit"]')).toHaveLength(ONE);
  });

  test('nombre y teléfono con su valor, etiqueta asociada (for/id) y autocomplete WCAG 1.3.5 (name, tel)', async () => {
    const body = await form();
    expect(nameInput(body).value || nameInput(body).getAttribute('value')).toBe(NAME);
    expect(phoneInput(body).getAttribute('value')).toBe(PHONE);
    [nameInput(body), phoneInput(body)].forEach((el) => {
      const id = el.getAttribute('id');
      expect(id, 'falta id').toBeTruthy();
      expect(body.querySelector(`label[for="${id}"]`), `falta <label for="${id}">`).not.toBeNull();
    });
    expect(nameInput(body).getAttribute('autocomplete')).toBe('name');
    expect(phoneInput(body).getAttribute('autocomplete')).toBe('tel');
    expect(phoneInput(body).getAttribute('type')).toBe('tel');
  });

  test('el correo se muestra y es de solo lectura (readonly o disabled); no hay otro campo editable de correo', async () => {
    const body = await form();
    const emailFields = [...body.querySelectorAll<HTMLInputElement>('input[name="email"], input[type="email"]')];
    const shown = text(body).includes(SESSION_EMAIL) || emailFields.some((el) => el.getAttribute('value') === SESSION_EMAIL);
    expect(shown, 'el correo de la sesión no se muestra').toBe(true);
    emailFields.forEach((el) => expect(el.hasAttribute('readonly') || el.hasAttribute('disabled')).toBe(true));
  });

  test('con email null no falla ni pinta "null" o "undefined"', async () => {
    const body = await form({ email: null });
    expect(text(body)).not.toContain('null');
    expect(text(body)).not.toContain('undefined');
    expect(body.innerHTML).not.toContain('value="null"');
  });

  test('sin role ni user_id: ningún campo ni texto del formulario los lleva (aunque se pasen de más)', async () => {
    const body = await form({ role: 'admin', user_id: USER_ID, values: { ...values(), role: 'admin', user_id: USER_ID } });
    expect(body.querySelector('input[name="role"], input[name="user_id"], select[name="role"]')).toBeNull();
    expect(body.innerHTML).not.toContain(USER_ID);
    expect(text(body).toLowerCase()).not.toContain('admin');
  });

  test('el único campo oculto permitido no es role/user_id/email; no hay casillas ni selectores', async () => {
    const body = await form();
    [...body.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].forEach((el) => expect(['role', 'user_id', 'email']).not.toContain(el.name));
    expect(body.querySelectorAll('input[type="checkbox"], select')).toHaveLength(NONE);
  });

  test('un nombre con HTML se escapa (sin inyección)', async () => {
    const body = await form({ values: values({ full_name: HOSTILE }) });
    expect(body.querySelector('img')).toBeNull();
    expect(nameInput(body).getAttribute('value')).toBe(HOSTILE);
  });
});

describe('ProfileForm · fecha de nacimiento sin fijar (birthDateLocked = false)', () => {
  test('hay un <input type="date" name="birth_date"> editable con etiqueta "Fecha de nacimiento" y autocomplete bday', async () => {
    const body = await form();
    const input = dateInput(body);
    expect(input, 'falta el campo birth_date').not.toBeNull();
    expect(input?.getAttribute('type')).toBe('date');
    expect(input?.hasAttribute('readonly') || input?.hasAttribute('disabled')).toBe(false);
    const id = input?.getAttribute('id');
    expect(text(body.querySelector(`label[for="${id}"]`)).toLowerCase()).toContain('fecha de nacimiento');
    expect(input?.getAttribute('autocomplete')).toBe('bday');
  });

  test('conserva lo escrito (value) y no muestra el texto de solo lectura', async () => {
    const body = await form({ values: values({ birth_date: BIRTH }) });
    expect(dateInput(body)?.getAttribute('value')).toBe(BIRTH);
    expect(text(body)).not.toContain(CORRECTION_HINT);
  });

  test('vacío por defecto: sin value o value vacío', async () => {
    const value = dateInput(await form())?.getAttribute('value');
    expect(value === null || value === undefined || value === '').toBe(true);
  });
});

describe('ProfileForm · fecha de nacimiento fijada (birthDateLocked = true)', () => {
  const lockedForm = (over: Record<string, unknown> = {}) => form({ birthDateLocked: true, values: values({ birth_date: BIRTH }), ...over });

  test('se muestra como "17 de mayo de 1990" (formatDateOnly) y con "Para corregirla, contacta con atención al cliente."', async () => {
    const body = await lockedForm();
    const inFieldValues = [...body.querySelectorAll<HTMLInputElement>('input')].map((i) => i.getAttribute('value') ?? '');
    expect(text(body).includes(BIRTH_TEXT) || inFieldValues.includes(BIRTH_TEXT)).toBe(true);
    expect(text(body)).toContain(CORRECTION_HINT);
    expect(text(body).toLowerCase()).toContain('fecha de nacimiento');
  });

  test('no hay ningún campo editable de la fecha: ni type="date" ni un input birth_date sin readonly/disabled', async () => {
    const body = await lockedForm();
    expect(body.querySelector('input[type="date"]:not([readonly]):not([disabled])')).toBeNull();
    expect(body.querySelector('input[name="birth_date"]:not([readonly]):not([disabled])')).toBeNull();
  });

  test('sin zona horaria: la fecha del 1 de enero y del 31 de diciembre no se desplazan de día', async () => {
    const jan = await lockedForm({ values: values({ birth_date: '2000-01-01' }) });
    const dec = await lockedForm({ values: values({ birth_date: '1999-12-31' }) });
    expect(text(jan)).toContain('1 de enero de 2000');
    expect(text(dec)).toContain('31 de diciembre de 1999');
  });

  test('un error de fecha no se pinta cuando está fijada (no hay campo al que asociarlo)', async () => {
    const body = await lockedForm({ errors: { form: 'Revisa los campos marcados.' } satisfies Errors });
    expect(body.querySelector('input[type="date"]')).toBeNull();
    expect(body.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('ProfileForm · errores', () => {
  test.each([
    ['full_name', 'El nombre admite hasta 120 caracteres.'],
    ['phone', 'Escribe un teléfono válido.'],
    ['birth_date', 'Debes tener 18 años o más.'],
  ] as const)('error en %s → aria-invalid solo en ese campo y el texto asociado por aria-describedby', async (field, message) => {
    const body = await form({ errors: { [field]: message } satisfies Errors });
    const input = q<HTMLInputElement>(body, `input[name="${field}"]`);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(fieldErrorText(body, input)).toContain(message);
    ['full_name', 'phone', 'birth_date'].filter((f) => f !== field).forEach((other) => expect(body.querySelector(`input[name="${other}"]`)?.getAttribute('aria-invalid')).not.toBe('true'));
  });

  test('error de formulario → un aviso role="alert" con el texto; sin errores no hay alertas ni "Datos guardados"', async () => {
    const withError = await form({ errors: { form: 'La fecha de nacimiento ya está registrada y no se puede cambiar.' } });
    expect(text(withError.querySelector('[role="alert"]'))).toContain('La fecha de nacimiento ya está registrada');
    const clean = await form();
    expect(clean.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
    expect(text(clean)).not.toContain('Datos guardados');
  });

  test('error de campo sin texto de formulario: aparece un resumen role="alert" (el mismo patrón que el ingreso)', async () => {
    const body = await form({ errors: { phone: 'Escribe un teléfono válido.' } });
    expect(body.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(ONE);
  });

  test('los campos con error conservan lo escrito (value)', async () => {
    const body = await form({ values: values({ phone: 'abc', birth_date: BIRTH }), errors: { phone: 'Escribe un teléfono válido.' } });
    expect(phoneInput(body).getAttribute('value')).toBe('abc');
    expect(dateInput(body)?.getAttribute('value')).toBe(BIRTH);
  });

  test('el texto del error no repite la fecha ni el valor enviado salvo en el propio campo', async () => {
    const body = await form({ values: values({ birth_date: BIRTH }), errors: { birth_date: 'Debes tener 18 años o más.' } });
    expect(text(body)).not.toContain(BIRTH);
    const input = q<HTMLInputElement>(body, 'input[name="birth_date"]');
    describedBy(body, input).forEach((d) => expect(d.text).not.toContain(BIRTH));
  });
});

describe('ProfileForm · éxito', () => {
  test('saved → "Datos guardados" con role="status" (sin role="alert")', async () => {
    const body = await form({ saved: true });
    const status = [...body.querySelectorAll('[role="status"]')].find((el) => text(el).includes('Datos guardados'));
    expect(status, 'falta role="status" con "Datos guardados"').toBeDefined();
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
  });

  test('saved = false o ausente → no aparece "Datos guardados"', async () => {
    expect(text(await form({ saved: false }))).not.toContain('Datos guardados');
    expect(text(await form())).not.toContain('Datos guardados');
  });
});
