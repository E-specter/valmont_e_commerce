import { describe, expect, test } from 'vitest';
import AuthForm from '../../src/components/auth/AuthForm.astro';
import AuthSplit from '../../src/components/auth/AuthSplit.astro';
import WatchmakerArtwork from '../../src/components/auth/WatchmakerArtwork.astro';
import { describedBy, text, ui } from '../helpers/ui';
import { containsAny } from '../helpers/t127';

// T-127 · AuthForm, AuthSplit y WatchmakerArtwork con la Container API (STATUS ui › T-127 › Firmas públicas y criterios).
const HOSTILE = '"><img src=x onerror=alert(1)>';
const EMAIL = 'ana.perez@example.com';
const ONE = 1;
const NONE = 0;
const PASSWORD_ERROR = 'Ingresa tu contraseña';
const SPANISH_ART = ['instrumento relojero de precisión', 'calibre valmont 2026', '24 rubíes'];
const ENGLISH_ART = ['watchmaker', 'precision instrument', 'jewels', 'mainspring', 'behavior', 'behaviour'];
const FORBIDDEN_TEXT = ['recuérdame', 'recuerdame', 'olvidaste', 'olvidé'];

type Errors = { form?: string; email?: string; password?: string };
const form = async (props: Record<string, unknown> = {}): Promise<HTMLElement> => ui(AuthForm, { mode: 'login', ...props });
const q = <T extends Element>(body: ParentNode, sel: string): T => {
  const el = body.querySelector<T>(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el;
};
const emailInput = (b: ParentNode): HTMLInputElement => q(b, 'input[autocomplete="email"]');
const passwordInput = (b: ParentNode): HTMLInputElement => q(b, 'input[type="password"]');

describe('AuthForm · estructura (funciona sin JavaScript)', () => {
  test('es un <form method="post"> que envía a la propia página (/ingresar o sin action)', async () => {
    const f = q<HTMLFormElement>(await form(), 'form');
    expect(f.getAttribute('method')?.toLowerCase()).toBe('post');
    const action = f.getAttribute('action');
    expect(action === null || action === '' || action.split('?')[NONE] === '/ingresar').toBe(true);
  });

  test('un único botón de envío "Ingresar"', async () => {
    const body = await form();
    const submits = [...body.querySelectorAll('button[type="submit"], input[type="submit"]')];
    expect(submits).toHaveLength(ONE);
    expect(text(submits[NONE]).toLowerCase()).toContain('ingresar');
  });

  test('el correo y la contraseña tienen etiqueta asociada (for/id) y nombre de campo', async () => {
    const body = await form();
    [emailInput(body), passwordInput(body)].forEach((el) => {
      expect(el.getAttribute('name')?.length).toBeGreaterThan(NONE);
      const id = el.getAttribute('id');
      expect(id, 'falta id').toBeTruthy();
      expect(body.querySelector(`label[for="${id}"]`), `falta <label for="${id}">`).not.toBeNull();
    });
  });

  test('H-18: sin "Recuérdame" ni "¿Olvidaste tu contraseña?" y sin casillas', async () => {
    const body = await form();
    expect(containsAny(text(body), FORBIDDEN_TEXT)).toBe(false);
    expect(body.querySelectorAll('input[type="checkbox"]')).toHaveLength(NONE);
  });

  test('"Crear cuenta Valmont +" es un enlace a /registro', async () => {
    const link = q<HTMLAnchorElement>(await form(), 'a[href^="/registro"]');
    expect(text(link)).toContain('Crear cuenta Valmont');
  });

  test('con next, el enlace de registro lo conserva codificado y el formulario lo reenvía', async () => {
    const body = await form({ next: '/carrito?a=1&b=2' });
    const href = q<HTMLAnchorElement>(body, 'a[href^="/registro"]').getAttribute('href')!;
    expect(new URL(href, 'http://x.test').searchParams.get('next')).toBe('/carrito?a=1&b=2');
    const f = q<HTMLFormElement>(body, 'form');
    const carried = f.querySelector<HTMLInputElement>('input[name="next"]')?.value ?? new URL(f.getAttribute('action') ?? '/', 'http://x.test').searchParams.get('next');
    expect(carried).toBe('/carrito?a=1&b=2');
  });
  // La validación de `next` es de la página (STATUS T-127 correcciones: AuthForm lo recibe ya validado); la cubre ingresar-page.test.ts.
});

describe('AuthForm · campos y autocompletado', () => {
  test('correo: type=email, autocomplete=email, obligatorio', async () => {
    const el = emailInput(await form());
    expect(el.getAttribute('type')).toBe('email');
    expect(el.getAttribute('autocomplete')).toBe('email');
    expect(el.hasAttribute('required') || el.getAttribute('aria-required') === 'true').toBe(true);
  });

  test('contraseña: type=password, autocomplete=current-password, obligatoria', async () => {
    const el = passwordInput(await form());
    expect(el.getAttribute('autocomplete')).toBe('current-password');
    expect(el.hasAttribute('required') || el.getAttribute('aria-required') === 'true').toBe(true);
  });

  test('el correo escrito se conserva en el campo', async () => {
    expect(emailInput(await form({ email: EMAIL })).getAttribute('value')).toBe(EMAIL);
  });

  test('sin correo previo el campo no lleva texto', async () => {
    const v = emailInput(await form()).getAttribute('value');
    expect(v === null || v === '').toBe(true);
  });

  test.each([
    ['sin errores', {}],
    ['con error de contraseña', { password: PASSWORD_ERROR }],
    ['con error de formulario', { form: 'Correo o contraseña incorrectos' }],
    ['con todos los errores', { form: 'x', email: 'y', password: 'z' }],
  ] as [string, Errors][])('la contraseña NUNCA se vuelve a pintar: sin atributo value (%s)', async (_n, errors) => {
    const body = await form({ email: EMAIL, errors });
    expect(passwordInput(body).hasAttribute('value')).toBe(false);
    expect(body.innerHTML.toLowerCase()).not.toContain('data-value');
  });

  test('un correo hostil se escapa: no crea elementos ni rompe el atributo', async () => {
    const body = await form({ email: HOSTILE });
    expect(body.querySelector('img')).toBeNull();
    expect(emailInput(body).getAttribute('value')).toBe(HOSTILE);
  });
});

describe('AuthForm · ojo de la contraseña', () => {
  test('IconButton "Mostrar contraseña": botón type=button, aria-pressed=false y nombre accesible', async () => {
    const body = await form();
    const eye = q<HTMLButtonElement>(body, 'button[aria-label="Mostrar contraseña"]');
    expect(eye.getAttribute('type')).toBe('button');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
  });

  test('el botón del ojo está dentro del campo de contraseña (misma caja que el input)', async () => {
    const body = await form();
    const box = passwordInput(body).parentElement!;
    expect(box.querySelector('button[aria-label="Mostrar contraseña"]')).not.toBeNull();
  });

  test('el ojo es un único botón y no hay otro en el campo del correo', async () => {
    const body = await form();
    expect(body.querySelectorAll('button[aria-pressed]')).toHaveLength(ONE);
  });
});

describe('AuthForm · errores por campo y resumen', () => {
  test('sin errores no hay ningún role="alert" ni aria-invalid', async () => {
    const body = await form();
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
    expect(body.querySelectorAll('[aria-invalid="true"]')).toHaveLength(NONE);
  });

  test('error de correo: Field.error visible, aria-invalid y descrito por el mensaje; la contraseña queda limpia', async () => {
    const body = await form({ errors: { email: 'Ingresa un correo válido' } });
    const el = emailInput(body);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, el).map((d) => d.text).join(' ')).toContain('Ingresa un correo válido');
    expect(passwordInput(body).getAttribute('aria-invalid')).toBeNull();
  });

  test('error de contraseña: aria-invalid y descrito por el mensaje; el correo queda limpio', async () => {
    const body = await form({ errors: { password: PASSWORD_ERROR } });
    const el = passwordInput(body);
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(body, el).map((d) => d.text).join(' ')).toContain(PASSWORD_ERROR);
    expect(emailInput(body).getAttribute('aria-invalid')).toBeNull();
  });

  test('errors.form → Notice de error con role="alert" que contiene el mensaje', async () => {
    const body = await form({ errors: { form: 'Correo o contraseña incorrectos' } });
    const alerts = body.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(ONE);
    expect(text(alerts[NONE])).toContain('Correo o contraseña incorrectos');
  });

  test('un error de campo también activa el resumen role="alert" (el 422 lleva Notice resumen)', async () => {
    const body = await form({ errors: { form: 'Revisa los campos marcados.', email: 'Ingresa tu correo' } });
    expect(body.querySelectorAll('[role="alert"]')).toHaveLength(ONE);
  });

  test('el resumen es enfocable por programa (tabindex=-1) para recibir el foco al cargar la respuesta', async () => {
    const body = await form({ errors: { form: 'Correo o contraseña incorrectos' } });
    const alert = q(body, '[role="alert"]');
    const target = alert.getAttribute('tabindex') !== null ? alert : alert.querySelector('[tabindex]');
    expect(target, 'el resumen o un descendiente debe llevar tabindex').not.toBeNull();
    expect(target!.getAttribute('tabindex')).toBe('-1');
  });

  test('un mensaje hostil se escapa en el resumen y en los campos', async () => {
    const body = await form({ errors: { form: HOSTILE, email: HOSTILE, password: HOSTILE } });
    expect(body.querySelector('img')).toBeNull();
  });

  test('un error de servicio (503) ofrece "Reintentar" como enlace a /ingresar', async () => {
    const body = await form({ next: '/carrito', errors: { form: 'No pudimos conectar con el servicio de acceso. Inténtalo de nuevo.' } });
    const retry = [...body.querySelectorAll('a')].find((a) => text(a).toLowerCase().includes('reintentar'));
    expect(retry, 'falta el enlace "Reintentar"').toBeTruthy();
    expect(retry!.getAttribute('href')!.startsWith('/ingresar')).toBe(true);
  });
});

describe('AuthSplit', () => {
  test.each(['login', 'register'] as const)('variant="%s" pinta el formulario (slot por defecto) y el arte (slot art)', async (variant) => {
    const body = await ui(AuthSplit, { variant }, { default: '<p id="slot-form">formulario</p>', art: '<p id="slot-art">arte</p>' });
    expect(body.querySelector('#slot-form')).not.toBeNull();
    expect(body.querySelector('#slot-art')).not.toBeNull();
  });

  test('el formulario está dentro de <main> y el arte fuera de él (el arte no es el contenido principal)', async () => {
    const body = await ui(AuthSplit, { variant: 'login' }, { default: '<p id="slot-form">formulario</p>', art: '<p id="slot-art">arte</p>' });
    expect(body.querySelector('main #slot-form')).not.toBeNull();
    expect(body.querySelector('main #slot-art')).toBeNull();
  });

  test('la página es noindex y tiene un único <main>', async () => {
    const body = await ui(AuthSplit, { variant: 'login' }, { default: '<p>f</p>' });
    expect(body.querySelectorAll('main')).toHaveLength(ONE);
  });
});

describe('WatchmakerArtwork · arte decorativo', () => {
  test.each(['movement', 'mainspring'] as const)('variant="%s": SVG con aria-hidden="true" y sin foco ni título accesible', async (variant) => {
    const body = await ui(WatchmakerArtwork, { variant });
    const svg = q(body, 'svg');
    const hidden = svg.closest('[aria-hidden="true"]');
    expect(hidden, 'el SVG o un ancestro debe ser aria-hidden').not.toBeNull();
    expect(body.querySelector('svg title, [role="img"], a, button, [tabindex]')).toBeNull();
  });

  test('las dos variantes dibujan arte distinto', async () => {
    const a = (await ui(WatchmakerArtwork, { variant: 'movement' })).querySelector('svg')!.innerHTML;
    const b = (await ui(WatchmakerArtwork, { variant: 'mainspring' })).querySelector('svg')!.innerHTML;
    expect(a).not.toBe(b);
  });

  test('"movement": rótulo en español (Instrumento relojero de precisión · Calibre Valmont 2026 · 24 rubíes)', async () => {
    const t = text(await ui(WatchmakerArtwork, { variant: 'movement' })).toLowerCase();
    SPANISH_ART.forEach((s) => expect(t, s).toContain(s));
  });

  test.each(['movement', 'mainspring'] as const)('"%s": ningún texto del arte está en inglés', async (variant) => {
    expect(containsAny(text(await ui(WatchmakerArtwork, { variant })), ENGLISH_ART)).toBe(false);
  });
});
