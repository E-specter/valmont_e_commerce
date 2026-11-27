import { describe, expect, test } from 'vitest';
import RegisterForm from '../../src/components/auth/RegisterForm.astro';
import { SERVICE_UNAVAILABLE_MESSAGE } from '../../src/lib/auth-messages';
import { PRIVACY_VERSION } from '../../src/lib/site';
import { containsAny } from '../helpers/t127';
import { ADULT_BIRTH, FAKE_EMAIL, FAKE_NAME, FAKE_PHRASE, OTHER_PHRASE } from '../helpers/t128';
import { describedBy, text, ui } from '../helpers/ui';

// T-128 + T-131 · RegisterForm con la Container API (STATUS ui › T-128 › Firmas públicas, ampliadas por D-045).
const HOSTILE = '"><img src=x onerror=alert(1)>';
const ONE = 1;
const NONE = 0;
const PAIR = 2;
const NAME_MAX = '120';
const EMAIL_MAX = '320';
const TODAY = '2026-11-27';
const MSG_MIN = 'Mínimo 6 caracteres';
const MSG_NO_MATCH = 'No coinciden';

type Errors = Partial<Record<'form' | 'full_name' | 'email' | 'password' | 'password_confirm' | 'accept_terms' | 'birth_date', string>>;
type Values = Partial<Record<'full_name' | 'email' | 'birth_date', string>>;
const form = (props: { values?: Values; errors?: Errors; next?: string } = {}): Promise<HTMLElement> => ui(RegisterForm, props);

const q = <T extends Element>(body: ParentNode, sel: string): T => {
  const el = body.querySelector<T>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
};
const nameInput = (b: ParentNode): HTMLInputElement => q(b, 'input[autocomplete="name"]');
const emailInput = (b: ParentNode): HTMLInputElement => q(b, 'input[autocomplete="email"]');
const passwords = (b: ParentNode): HTMLInputElement[] => [...b.querySelectorAll<HTMLInputElement>('input[type="password"]')];
const birthInput = (b: ParentNode): HTMLInputElement => q(b, 'input[type="date"]');
const terms = (b: ParentNode): HTMLInputElement => q(b, 'input[type="checkbox"]');
const controls = (b: ParentNode): HTMLInputElement[] => [nameInput(b), emailInput(b), ...passwords(b), birthInput(b), terms(b)];
const invalid = (el: Element): boolean => el.getAttribute('aria-invalid') === 'true';
const required = (el: Element): boolean => el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

describe('RegisterForm · estructura (funciona sin JavaScript)', () => {
  test('es un <form method="post"> que envía a la propia página (/registro o sin action)', async () => {
    const f = q<HTMLFormElement>(await form(), 'form');
    expect(f.getAttribute('method')?.toLowerCase()).toBe('post');
    const action = f.getAttribute('action');
    expect(action === null || action === '' || action.split('?')[NONE] === '/registro').toBe(true);
  });

  test('un único botón de envío', async () => {
    const submits = [...(await form()).querySelectorAll('button[type="submit"], input[type="submit"]')];
    expect(submits).toHaveLength(ONE);
    expect(text(submits[NONE]).toLowerCase()).toMatch(/crear cuenta|registrar/);
  });

  test('seis controles: nombre, correo, dos contraseñas, fecha de nacimiento y casilla', async () => {
    const body = await form();
    expect(controls(body)).toHaveLength(6);
    expect(passwords(body)).toHaveLength(PAIR);
    expect(body.querySelectorAll('input:not([type="hidden"])')).toHaveLength(6);
  });

  test('cada control tiene nombre de campo, id y <label for> asociada', async () => {
    const body = await form();
    controls(body).forEach((el) => {
      expect(el.getAttribute('name')?.length).toBeGreaterThan(NONE);
      const id = el.getAttribute('id');
      expect(id, 'falta id').toBeTruthy();
      expect(body.querySelector(`label[for="${id}"]`), `falta <label for="${id}">`).not.toBeNull();
    });
  });

  test('los nombres de campo son los del contrato: full_name, email, password, password_confirm, birth_date, accept_terms', async () => {
    const body = await form();
    expect(controls(body).map((c) => c.getAttribute('name')).sort()).toEqual(['accept_terms', 'birth_date', 'email', 'full_name', 'password', 'password_confirm']);
  });

  test('todos los controles son obligatorios', async () => {
    const body = await form();
    controls(body).forEach((el) => expect(required(el), el.getAttribute('name') ?? '').toBe(true));
  });

  test('"Ingresar" enlaza a /ingresar; con next, lo conserva codificado', async () => {
    const plain = await form();
    expect([...plain.querySelectorAll('a')].some((a) => a.getAttribute('href')?.startsWith('/ingresar'))).toBe(true);
    const withNext = await form({ next: '/carrito?a=1&b=2' });
    const href = [...withNext.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').find((h) => h.startsWith('/ingresar'))!;
    expect(new URL(href, 'http://x.test').searchParams.get('next')).toBe('/carrito?a=1&b=2');
  });

  test('con next, el formulario lo reenvía (campo oculto o query de la acción)', async () => {
    const f = q<HTMLFormElement>(await form({ next: '/carrito' }), 'form');
    const carried = f.querySelector<HTMLInputElement>('input[type="hidden"]')?.value ?? new URL(f.getAttribute('action') ?? '/', 'http://x.test').searchParams.get('next');
    expect(carried).toBe('/carrito');
  });

  test('sin next no hay campo oculto', async () => {
    expect((await form()).querySelectorAll('input[type="hidden"]')).toHaveLength(NONE);
  });
});

describe('RegisterForm · campos y autocompletado', () => {
  test('nombre: text, autocomplete=name, maxlength 120', async () => {
    const el = nameInput(await form());
    expect(el.getAttribute('type')).toBe('text');
    expect(el.getAttribute('maxlength')).toBe(NAME_MAX);
  });

  test('correo: type=email, autocomplete=email, maxlength 320', async () => {
    const el = emailInput(await form());
    expect(el.getAttribute('type')).toBe('email');
    expect(el.getAttribute('maxlength')).toBe(EMAIL_MAX);
  });

  test('las dos contraseñas usan autocomplete="new-password"', async () => {
    passwords(await form()).forEach((el) => expect(el.getAttribute('autocomplete')).toBe('new-password'));
  });

  test('la primera contraseña declara el mínimo de 6 (minlength)', async () => {
    expect(passwords(await form())[NONE].getAttribute('minlength')).toBe('6');
  });

  test('la fecha: type="date", autocomplete="bday", obligatoria', async () => {
    const el = birthInput(await form());
    expect(el.getAttribute('type')).toBe('date');
    expect(el.getAttribute('autocomplete')).toBe('bday');
    expect(required(el)).toBe(true);
  });

  test('la etiqueta de la fecha dice "nacimiento" y el formulario avisa de los 18 años sin necesidad de error', async () => {
    const body = await form();
    const id = birthInput(body).getAttribute('id')!;
    expect(text(q(body, `label[for="${id}"]`)).toLowerCase()).toContain('nacimiento');
    expect(text(body)).toMatch(/18 años/);
  });

  test('la fecha escrita se conserva; sin fecha previa el campo está vacío', async () => {
    expect(birthInput(await form({ values: { birth_date: ADULT_BIRTH } })).getAttribute('value')).toBe(ADULT_BIRTH);
    const v = birthInput(await form()).getAttribute('value');
    expect(v === null || v === '').toBe(true);
  });

  test('el nombre y el correo escritos se conservan', async () => {
    const body = await form({ values: { full_name: FAKE_NAME, email: FAKE_EMAIL } });
    expect(nameInput(body).getAttribute('value')).toBe(FAKE_NAME);
    expect(emailInput(body).getAttribute('value')).toBe(FAKE_EMAIL);
  });

  test('valores hostiles se escapan: no crean elementos ni rompen atributos', async () => {
    const body = await form({ values: { full_name: HOSTILE, email: HOSTILE, birth_date: HOSTILE } });
    expect(body.querySelector('img')).toBeNull();
    expect(nameInput(body).getAttribute('value')).toBe(HOSTILE);
    expect(emailInput(body).getAttribute('value')).toBe(HOSTILE);
  });

  test('el icono del campo de fecha es decorativo', async () => {
    const box = birthInput(await form()).parentElement!;
    const svg = box.querySelector('svg');
    if (svg) expect(svg.closest('[aria-hidden="true"]') ?? svg.getAttribute('aria-hidden')).toBeTruthy();
  });
});

describe('RegisterForm · las contraseñas NUNCA se vuelven a pintar', () => {
  test.each([
    ['sin errores', {}],
    ['con errores de contraseña', { password: MSG_MIN, password_confirm: MSG_NO_MATCH }],
    ['con todos los errores', { form: 'x', full_name: 'a', email: 'b', password: 'c', password_confirm: 'd', accept_terms: 'e', birth_date: 'f' }],
  ] as [string, Errors][])('sin atributo value (%s)', async (_n, errors) => {
    // `values` con contraseñas colgadas (fuera del contrato): tampoco deben reflejarse.
    const body = await ui(RegisterForm, { values: { full_name: FAKE_NAME, email: FAKE_EMAIL, password: FAKE_PHRASE, password_confirm: OTHER_PHRASE }, errors });
    passwords(body).forEach((el) => expect(el.hasAttribute('value')).toBe(false));
    expect(body.innerHTML).not.toContain(FAKE_PHRASE);
    expect(body.innerHTML).not.toContain(OTHER_PHRASE);
    expect(body.innerHTML.toLowerCase()).not.toContain('data-value');
  });
});

describe('RegisterForm · ojo de la contraseña (única isla con JavaScript)', () => {
  test('hay un botón "Mostrar contraseña" por cada campo, type=button y aria-pressed=false', async () => {
    const body = await form();
    const eyes = [...body.querySelectorAll<HTMLButtonElement>('button[aria-label="Mostrar contraseña"]')];
    expect(eyes).toHaveLength(PAIR);
    eyes.forEach((eye) => {
      expect(eye.getAttribute('type')).toBe('button');
      expect(eye.getAttribute('aria-pressed')).toBe('false');
    });
  });

  test('cada ojo controla SU contraseña (aria-controls = id del input de su misma caja)', async () => {
    const body = await form();
    passwords(body).forEach((input) => {
      const eye = input.parentElement!.querySelector('button[aria-label="Mostrar contraseña"]');
      expect(eye?.getAttribute('aria-controls')).toBe(input.getAttribute('id'));
    });
  });

  test('es el único botón con aria-pressed (la casilla no es un botón)', async () => {
    expect((await form()).querySelectorAll('button[aria-pressed]')).toHaveLength(PAIR);
  });

  test('el script de la página no toca la fecha de nacimiento (dato personal)', async () => {
    const html = (await form({ values: { birth_date: ADULT_BIRTH } })).innerHTML;
    const scripts = [...html.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[NONE]).join('\n');
    expect(scripts).not.toMatch(/birth|bday|nacimiento/i);
  });
});

describe('RegisterForm · consentimiento (casilla y enlaces legales)', () => {
  test('la casilla enlaza a /terminos y /privacidad y cita la versión de la política', async () => {
    const body = await form();
    const label = q(body, `label[for="${terms(body).getAttribute('id')}"]`);
    expect(label.querySelector('a[href="/terminos"]'), 'falta /terminos').not.toBeNull();
    expect(label.querySelector('a[href="/privacidad"]'), 'falta /privacidad').not.toBeNull();
    expect(text(label)).toContain(PRIVACY_VERSION);
  });

  test('la casilla llega desmarcada (el consentimiento es explícito)', async () => {
    expect(terms(await form()).hasAttribute('checked')).toBe(false);
  });

  test('el nombre del valor de la casilla es el de un formulario normal (`on` o `true`) y no un dato personal', async () => {
    expect(terms(await form()).getAttribute('value') ?? 'on').toMatch(/^(on|true|1)$/);
  });

  test('error de la casilla: aria-invalid y descrito por el mensaje', async () => {
    const body = await form({ errors: { accept_terms: 'Debes aceptar' } });
    expect(invalid(terms(body))).toBe(true);
    expect(describedBy(body, terms(body)).map((d) => d.text).join(' ')).toContain('Debes aceptar');
  });
});

describe('RegisterForm · errores por campo y resumen', () => {
  test('sin errores no hay role="alert" ni aria-invalid', async () => {
    const body = await form();
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
    expect(body.querySelectorAll('[aria-invalid="true"]')).toHaveLength(NONE);
  });

  test.each([
    ['full_name', 'Ingresa tu nombre completo', nameInput],
    ['email', 'Ingresa un correo válido', emailInput],
    ['password', 'Mínimo 6 caracteres', (b: ParentNode) => passwords(b)[NONE]],
    ['password_confirm', 'Las contraseñas no coinciden', (b: ParentNode) => passwords(b)[ONE]],
    ['birth_date', 'Debes tener 18 años o más', birthInput],
  ] as [keyof Errors, string, (b: ParentNode) => HTMLInputElement][])('error de %s: solo ese campo es inválido y su mensaje lo describe', async (key, msg, pick) => {
    const body = await form({ errors: { [key]: msg } });
    const target = pick(body);
    expect(invalid(target)).toBe(true);
    expect(describedBy(body, target).map((d) => d.text).join(' ')).toContain(msg);
    controls(body).filter((c) => c !== target).forEach((c) => expect(invalid(c), c.getAttribute('name') ?? '').toBe(false));
  });

  test('un error de campo activa UN resumen role="alert" enfocable (tabindex=-1)', async () => {
    const body = await form({ errors: { form: 'Revisa los campos marcados.', birth_date: 'Debes tener 18 años o más' } });
    const alerts = body.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(ONE);
    const target = alerts[NONE].getAttribute('tabindex') !== null ? alerts[NONE] : alerts[NONE].querySelector('[tabindex]');
    expect(target?.getAttribute('tabindex')).toBe('-1');
  });

  test('errors.form → Notice de error con el mensaje', async () => {
    const body = await form({ errors: { form: 'Demasiados intentos; espera un momento' } });
    expect(text(q(body, '[role="alert"]'))).toContain('Demasiados intentos');
  });

  test('el error de la fecha no repite el valor escrito (ni siquiera cuando se devuelve la fecha al campo)', async () => {
    const body = await form({ values: { birth_date: TODAY }, errors: { birth_date: 'Debes tener 18 años o más' } });
    const messages = [...body.querySelectorAll('[role="alert"], .error')].map((e) => text(e)).join(' ');
    expect(messages).not.toContain(TODAY);
  });

  test('mensajes hostiles se escapan en el resumen y en cada campo', async () => {
    const body = await form({ errors: { form: HOSTILE, full_name: HOSTILE, email: HOSTILE, password: HOSTILE, password_confirm: HOSTILE, accept_terms: HOSTILE, birth_date: HOSTILE } });
    expect(body.querySelector('img')).toBeNull();
  });

  test('un error de servicio (503) ofrece "Reintentar" como enlace a /registro', async () => {
    const body = await form({ next: '/carrito', errors: { form: SERVICE_UNAVAILABLE_MESSAGE } });
    const retry = [...body.querySelectorAll('a')].find((a) => text(a).toLowerCase().includes('reintentar'));
    expect(retry, 'falta "Reintentar"').toBeTruthy();
    expect(retry!.getAttribute('href')!.startsWith('/registro')).toBe(true);
  });

  test('otros errores de formulario no ofrecen "Reintentar"', async () => {
    const body = await form({ errors: { form: 'Demasiados intentos; espera un momento' } });
    expect([...body.querySelectorAll('a')].some((a) => text(a).toLowerCase().includes('reintentar'))).toBe(false);
  });
});

describe('RegisterForm · texto de la interfaz', () => {
  test('en español: sin textos en inglés habituales ni "Recuérdame"', async () => {
    const t = text(await form());
    expect(containsAny(t, ['Sign up', 'Register', 'Password', 'Birth', 'Remember me', 'recuérdame'])).toBe(false);
  });

  test('un único h1 en el componente (el título del formulario) o ninguno: nunca dos', async () => {
    expect((await form()).querySelectorAll('h1').length).toBeLessThanOrEqual(ONE);
  });
});
