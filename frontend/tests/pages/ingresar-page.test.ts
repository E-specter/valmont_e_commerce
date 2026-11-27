import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Ingresar from '../../src/pages/ingresar.astro';
import { parseHtml } from '../helpers/render';
import { text } from '../helpers/ui';
import {
  BAD_REQUEST, FORBIDDEN, MSG, OK, RIGHT_PHRASE, SB, SEE_OTHER, SERVER_ERROR, SESSION_FAKE, TOO_MANY, UNAUTHORIZED, UNAVAILABLE, UNPROCESSABLE, WRONG_PHRASE, containsAny,
  type AuthErr,
} from '../helpers/t127';

// T-127 · ruta GET|POST /ingresar con la Container API y un cliente de Supabase simulado (sin red).
// Los nombres de los campos y del `next` se descubren del HTML del GET: la prueba no depende de cómo los llame el formulario.
const ORIGIN = 'http://localhost:4321';
const NO_STORE = 'private, no-store';
const EMAIL = 'ana.perez@example.com';
const GHOST_EMAIL = 'fantasma@example.com';
const ONE = 1;
const NONE = 0;
const RUNS = 5;
const MAX_DRIFT_MS = 150;
const LONG = 10_000;
const MAX_EMAIL = 320;
const HALF = 2;
const UNSUPPORTED_MEDIA = 415;
const LEAK_WORDS = ['SUPABASE', 'ANON_KEY', '.ts:', 'at supabase', 'stack', 'AuthConfigError'];
const HOSTILE_NEXT = ['//evil.com', '///evil.com', '/\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', 'cuenta', '', '%2F%2Fevil.com', 'data:text/html,x', 'http://localhost:4321@evil.com'];

type Result = { error: AuthErr | null; data: { session: unknown; user: unknown } };
type Fields = Partial<Record<'email' | 'password' | 'next', string>>;
type SignIn = (c: { email: string; password: string }) => Promise<Result>;

const TOKEN_FIELD = 'access_token';
const SESSION_VALUE = 'session-value-0001';
const okResult = (): Result => ({ error: null, data: { session: { [TOKEN_FIELD]: SESSION_VALUE }, user: { id: 'u-1' } } });
const failResult = (error: AuthErr): Result => ({ error, data: { session: null, user: null } });

function client(signIn: SignIn) {
  const signInWithPassword = vi.fn(signIn);
  return { auth: { signInWithPassword }, signInWithPassword };
}

async function render(init: { method?: string; query?: string; fields?: Record<string, string>; headers?: Record<string, string>; sb?: unknown; session?: unknown; body?: string }) {
  const method = init.method ?? 'GET';
  const url = `${ORIGIN}/ingresar${init.query ?? ''}`;
  const hasBody = method !== 'GET';
  const body = hasBody ? (init.body ?? new URLSearchParams(init.fields ?? {}).toString()) : undefined;
  const headers: Record<string, string> = { ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } : {}), ...init.headers };
  const request = new Request(url, { method, headers, body });
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Ingresar, { request, locals: { session: (init.session ?? null) as App.Locals['session'], supabase: init.sb as App.Locals['supabase'] }, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

/** Nombres reales de los campos, leídos del formulario que sirve el GET. */
let names: { email: string; password: string; next: string | null };
async function discoverNames(): Promise<void> {
  const { doc } = await render({ query: '?next=/carrito' });
  const email = doc.querySelector('input[autocomplete="email"]')?.getAttribute('name');
  const password = doc.querySelector('input[type="password"]')?.getAttribute('name');
  if (!email || !password) throw new Error('El formulario no expone los campos de correo y contraseña');
  names = { email, password, next: doc.querySelector('input[type="hidden"]')?.getAttribute('name') ?? null };
}

/** Cuerpo de formulario con los nombres reales; `next` va en el cuerpo (si el formulario lo lleva) y en la query. */
const fields = (f: Fields): Record<string, string> => ({
  ...(f.email !== undefined ? { [names.email]: f.email } : {}),
  ...(f.password !== undefined ? { [names.password]: f.password } : {}),
  ...(f.next !== undefined && names.next ? { [names.next]: f.next } : {}),
});
const post = (f: Fields, sb: unknown, extra: { query?: string; session?: unknown } = {}) =>
  render({ method: 'POST', fields: fields(f), query: extra.query ?? (f.next !== undefined ? `?next=${encodeURIComponent(f.next)}` : ''), sb, session: extra.session });

beforeEach(async () => {
  await discoverNames();
});
afterEach(() => vi.restoreAllMocks());

const alertText = (doc: Document): string => text(doc.querySelector('[role="alert"]'));
const emailValue = (doc: Document): string | null => doc.querySelector('input[autocomplete="email"]')?.getAttribute('value') ?? null;

describe('GET /ingresar', () => {
  test('200 con Cache-Control: private, no-store, un único h1 "Ingreso" y el formulario', async () => {
    const { res, doc } = await render({});
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1')).toLowerCase()).toBe('ingreso');
    expect(doc.querySelector('form[method="post" i]')).not.toBeNull();
  });

  test('no se indexa (noindex) y tiene título y un único <main>', async () => {
    const { doc } = await render({});
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(text(doc.querySelector('title')).length).toBeGreaterThan(NONE);
    expect(doc.querySelectorAll('main')).toHaveLength(ONE);
  });

  test('el arte es decorativo (aria-hidden) y trae el rótulo en español', async () => {
    const { doc } = await render({});
    const art = doc.querySelector('svg')?.closest('[aria-hidden="true"]');
    expect(art, 'falta el arte aria-hidden').not.toBeNull();
    expect(text(art).toLowerCase()).toContain('calibre valmont 2026');
  });

  test('sin errores no hay alertas; la contraseña no tiene value', async () => {
    const { doc } = await render({});
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
    expect(doc.querySelector('input[type="password"]')?.hasAttribute('value')).toBe(false);
  });

  test('no necesita Supabase: se sirve aunque falte la configuración (el cliente solo se toca al enviar)', async () => {
    const sb = new Proxy({}, { get: () => { throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24'); } });
    const { res } = await render({ sb });
    expect(res.status).toBe(OK);
  });

  test('las credenciales en la query de un GET no se usan ni se vuelven a pintar y no llaman a Supabase', async () => {
    const sb = client(async () => okResult());
    const { res, html } = await render({ query: `?${names.email}=${EMAIL}&${names.password}=${WRONG_PHRASE}`, sb });
    expect(res.status).toBe(OK);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(html).not.toContain(WRONG_PHRASE);
  });

  test.each(['PUT', 'DELETE', 'PATCH'])('%s con credenciales no inicia sesión', async (method) => {
    const sb = client(async () => okResult());
    const { res } = await render({ method, fields: fields({ email: EMAIL, password: RIGHT_PHRASE }), sb });
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(res.status).not.toBe(SEE_OTHER);
  });

  test('con next interno, el formulario y el enlace de registro lo conservan; con next hostil, no', async () => {
    const good = await render({ query: '?next=/carrito' });
    expect(good.html).toContain('carrito');
    const bad = await render({ query: '?next=//evil.com' });
    expect(bad.html).not.toContain('evil.com');
  });

  test('?error=confirmacion (lo deja /auth/callback) no rompe la página', async () => {
    const { res, doc } = await render({ query: '?error=confirmacion' });
    expect(res.status).toBe(OK);
    expect(doc.querySelector('form')).not.toBeNull();
  });
});

describe('POST /ingresar · éxito', () => {
  test('credenciales válidas → 303 a /cuenta (por defecto) y UNA llamada a signInWithPassword', async () => {
    const sb = client(async () => okResult());
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE }, sb);
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('location')).toBe('/cuenta');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(sb.signInWithPassword).toHaveBeenCalledTimes(ONE);
    expect(sb.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: RIGHT_PHRASE });
  });

  test('la contraseña llega tal cual (no se recorta ni se normaliza: los espacios cuentan)', async () => {
    const spaced = `  ${RIGHT_PHRASE} con espacios  `;
    const sb = client(async () => okResult());
    await post({ email: EMAIL, password: spaced }, sb);
    expect(sb.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: spaced });
  });

  test('el correo se recorta de espacios sobrantes', async () => {
    const sb = client(async () => okResult());
    const { res } = await post({ email: `  ${EMAIL}  `, password: RIGHT_PHRASE }, sb);
    expect(res.status).toBe(SEE_OTHER);
    expect(sb.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: RIGHT_PHRASE });
  });

  test.each(['/carrito', '/checkout', '/cuenta/pedidos', '/relojes?categoria=a&page=2'])('next interno %s → 303 a ese destino', async (next) => {
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE, next }, client(async () => okResult()));
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('location')).toBe(next);
  });

  test.each(HOSTILE_NEXT)('next hostil %j → 303 a /cuenta (nunca fuera del sitio)', async (next) => {
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE, next }, client(async () => okResult()));
    expect(res.status).toBe(SEE_OTHER);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('/cuenta');
    expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
  });

  test('next hostil solo en la query (sin campo en el cuerpo) tampoco escapa', async () => {
    const { res } = await render({ method: 'POST', query: '?next=//evil.com', fields: fields({ email: EMAIL, password: RIGHT_PHRASE }), sb: client(async () => okResult()) });
    expect(res.headers.get('location')).toBe('/cuenta');
  });
});

describe('POST /ingresar · validación (422 por campo)', () => {
  test.each([
    ['todo vacío', { email: '', password: '' }, ['email', 'password']],
    ['sin campos', {}, ['email', 'password']],
    ['correo vacío', { email: '', password: RIGHT_PHRASE }, ['email']],
    ['contraseña vacía', { email: EMAIL, password: '' }, ['password']],
    ['solo espacios en el correo', { email: '   ', password: RIGHT_PHRASE }, ['email']],
    ['correo sin arroba', { email: 'ana.perez', password: RIGHT_PHRASE }, ['email']],
    ['correo sin dominio', { email: 'ana@', password: RIGHT_PHRASE }, ['email']],
    ['correo sin usuario', { email: '@example.com', password: RIGHT_PHRASE }, ['email']],
    ['correo con espacios', { email: 'ana perez@example.com', password: RIGHT_PHRASE }, ['email']],
  ] as [string, Fields, ('email' | 'password')[]][])('%s → 422, error en el campo, resumen role="alert" y Supabase intacto', async (_n, f, bad) => {
    const sb = client(async () => okResult());
    const { res, doc } = await post(f, sb);
    expect(res.status).toBe(UNPROCESSABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(ONE);
    const invalid = (sel: string): boolean => doc.querySelector(sel)?.getAttribute('aria-invalid') === 'true';
    expect(invalid('input[autocomplete="email"]')).toBe(bad.includes('email'));
    expect(invalid('input[type="password"]')).toBe(bad.includes('password'));
  });

  test('con error de contraseña el correo escrito se conserva y la contraseña no se vuelve a pintar', async () => {
    const { doc, html } = await post({ email: EMAIL, password: '' }, client(async () => okResult()));
    expect(emailValue(doc)).toBe(EMAIL);
    expect(doc.querySelector('input[type="password"]')?.hasAttribute('value')).toBe(false);
    expect(html).not.toContain(WRONG_PHRASE);
  });

  test('con correo malformado, el correo escrito (hostil) se conserva escapado y la contraseña no se refleja', async () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const { doc, html } = await post({ email: hostile, password: WRONG_PHRASE }, client(async () => okResult()));
    expect(doc.querySelector('img')).toBeNull();
    expect(emailValue(doc)).toBe(hostile);
    expect(html).not.toContain(WRONG_PHRASE);
  });

  test('un correo enorme no revienta (sin 5xx) ni llega a Supabase con más de 320 caracteres', async () => {
    const sb = client(async () => failResult(SB.invalidCredentials()));
    const { res } = await post({ email: `${'a'.repeat(LONG)}@example.com`, password: WRONG_PHRASE }, sb);
    expect(res.status).toBeLessThan(SERVER_ERROR);
    sb.signInWithPassword.mock.calls.forEach(([c]) => expect(c.email.length).toBeLessThanOrEqual(MAX_EMAIL));
  });

  test('una contraseña enorme no revienta (sin 5xx) y no se refleja', async () => {
    const huge = 'p'.repeat(LONG);
    const { res, html } = await post({ email: EMAIL, password: huge }, client(async () => failResult(SB.invalidCredentials())));
    expect(res.status).toBeLessThan(SERVER_ERROR);
    expect(html).not.toContain(huge);
  });

  test('un cuerpo que no es un formulario (JSON) se rechaza sin 5xx ni trazas y sin llamar a Supabase', async () => {
    const sb = client(async () => okResult());
    // Un fallo no controlado (la Container lanza) equivale a un 500 del servidor real.
    const out = await render({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }), sb }).catch(() => ({ res: { status: SERVER_ERROR, headers: undefined }, html: '' }));
    const { res, html } = out;
    expect(res.status).toBe(UNSUPPORTED_MEDIA);
    expect(res.headers?.get('cache-control')).toBe(NO_STORE);
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('POST /ingresar · errores de Supabase', () => {
  test.each([
    ['contraseña errónea / correo inexistente (invalid_credentials)', SB.invalidCredentials(), UNAUTHORIZED, MSG.BAD_CREDENTIALS],
    ['correo sin confirmar', SB.notConfirmed(), FORBIDDEN, MSG.NOT_CONFIRMED],
    ['límite de intentos', SB.rateLimit(), TOO_MANY, MSG.RATE_LIMIT],
    ['red caída', SB.network(), UNAVAILABLE, ''],
    ['Supabase 5xx', SB.serverError(), UNAVAILABLE, ''],
  ] as [string, AuthErr, number, string][])('%s → %i con su mensaje, correo conservado, role="alert" y Cache-Control', async (_n, error, status, message) => {
    const { res, doc, html } = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult(error)));
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get('location')).toBeNull();
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(ONE);
    expect(alertText(doc)).toContain(message);
    expect(emailValue(doc)).toBe(EMAIL);
    expect(html).not.toContain(WRONG_PHRASE);
    expect(doc.querySelector('input[type="password"]')?.hasAttribute('value')).toBe(false);
  });

  test('503 ofrece "Reintentar"', async () => {
    const { doc } = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.network())));
    expect([...doc.querySelectorAll('a, button')].some((e) => text(e).toLowerCase().includes('reintentar'))).toBe(true);
  });

  test('signInWithPassword que LANZA (sin red) → 503 genérico, sin el texto del error ni la contraseña', async () => {
    const boom = client(async () => {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:54321 for ${EMAIL} with ${WRONG_PHRASE} at supabase.ts:24`);
    });
    const { res, html } = await post({ email: EMAIL, password: WRONG_PHRASE }, boom);
    expect(res.status).toBe(UNAVAILABLE);
    expect(containsAny(html, ['ECONNREFUSED', '54321', 'supabase.ts', WRONG_PHRASE])).toBe(false);
  });

  test('anti-enumeración: correo inexistente y contraseña errónea producen la MISMA respuesta (estado, cabeceras y HTML)', async () => {
    const wrongPw = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.invalidCredentials())));
    const noUser = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult({ ...SB.invalidCredentials(), message: 'User not found' })));
    expect(noUser.res.status).toBe(wrongPw.res.status);
    expect(noUser.html).toBe(wrongPw.html);
    expect(noUser.res.headers.get('cache-control')).toBe(wrongPw.res.headers.get('cache-control'));
  });

  test('anti-enumeración (2): ni siquiera un código "usuario no existe" cambia lo que ve el usuario', async () => {
    const base = await post({ email: GHOST_EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.invalidCredentials())));
    const odd = await post({ email: GHOST_EMAIL, password: WRONG_PHRASE }, client(async () => failResult({ code: 'user_not_found', status: BAD_REQUEST, name: 'AuthApiError' })));
    expect(odd.res.status).toBe(base.res.status);
    expect(alertText(odd.doc)).toBe(alertText(base.doc));
  });

  test('anti-enumeración (3): el mensaje 401 no menciona si el correo existe', async () => {
    const { doc } = await post({ email: GHOST_EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.invalidCredentials())));
    expect(containsAny(alertText(doc), ['no existe', 'no está registrado', 'no encontrado', GHOST_EMAIL])).toBe(false);
  });

  test('403 sin confirmar: el aviso no repite el correo ni da más pistas', async () => {
    const { doc } = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.notConfirmed())));
    expect(containsAny(alertText(doc), [EMAIL, '@', 'registrad'])).toBe(false);
  });

  test('tiempo comparable: la respuesta no depende de si el correo existe (mediana de cinco, con margen de 150 ms)', async () => {
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / HALF)];
    const time = async (sb: unknown): Promise<number> => {
      const t0 = performance.now();
      await post({ email: EMAIL, password: WRONG_PHRASE }, sb);
      return performance.now() - t0;
    };
    await time(client(async () => failResult(SB.invalidCredentials()))); // calienta
    const samples = async (): Promise<number> => median(await Promise.all(Array.from({ length: RUNS }, () => time(client(async () => failResult(SB.invalidCredentials()))))));
    const a = await samples();
    const b = await samples();
    expect(Math.abs(a - b)).toBeLessThan(MAX_DRIFT_MS);
  });
});

describe('POST /ingresar · la contraseña no se registra ni se devuelve', () => {
  function captureOutput(): () => string {
    const chunks: string[] = [];
    const push = (...args: unknown[]): void => void chunks.push(args.map(String).join(' '));
    (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(push));
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (chunks.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (chunks.push(String(c)), true));
    return () => chunks.join('\n');
  }

  test.each([
    ['éxito', async () => okResult()],
    ['credenciales erróneas', async () => failResult({ ...SB.invalidCredentials(), message: `bad ${WRONG_PHRASE}` })],
    ['sin confirmar', async () => failResult(SB.notConfirmed())],
    ['límite', async () => failResult(SB.rateLimit())],
    [
      'fallo que incluye la contraseña en su mensaje',
      async () => {
        throw new Error(`fallo con ${WRONG_PHRASE}`);
      },
    ],
  ] as [string, SignIn][])('%s: ni la respuesta ni la salida de consola contienen la contraseña', async (_n, signIn) => {
    const out = captureOutput();
    const { html, res } = await post({ email: EMAIL, password: WRONG_PHRASE }, client(signIn));
    expect(html).not.toContain(WRONG_PHRASE);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(WRONG_PHRASE);
    expect(out()).not.toContain(WRONG_PHRASE);
  });
});

describe('POST /ingresar · ya autenticado', () => {
  test('GET con sesión → redirige sin mostrar el formulario (a /cuenta por defecto)', async () => {
    const { res, html } = await render({ session: SESSION_FAKE, sb: client(async () => okResult()) });
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('location')).toBe('/cuenta');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(html).not.toContain('<form');
  });

  test('GET con sesión y next interno → a next; con next hostil → a /cuenta', async () => {
    const ok = await render({ session: SESSION_FAKE, query: '?next=/carrito' });
    expect(ok.res.headers.get('location')).toBe('/carrito');
    const bad = await render({ session: SESSION_FAKE, query: '?next=//evil.com' });
    expect(bad.res.headers.get('location')).toBe('/cuenta');
  });

  test('POST con sesión no vuelve a llamar a Supabase y redirige', async () => {
    const sb = client(async () => okResult());
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE }, sb, { session: SESSION_FAKE });
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('POST /ingresar · sin configuración de Supabase', () => {
  const broken = (): object => ({
    auth: new Proxy({}, { get: () => () => { throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24\n    at createSupabaseServer (supabase.ts:24:11)'); } }),
  });

  test('error genérico (503 o 500) sin nombres de variables, ficheros ni trazas, y sin redirigir', async () => {
    const { res, html } = await post({ email: EMAIL, password: RIGHT_PHRASE }, broken());
    expect([UNAVAILABLE, SERVER_ERROR]).toContain(res.status);
    expect(res.headers.get('location')).toBeNull();
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
    expect(html).not.toContain(RIGHT_PHRASE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test('si el propio getter de locals.supabase lanza, tampoco hay trazas', async () => {
    const sb = new Proxy({}, { get: () => { throw new Error('SUPABASE_ANON_KEY missing'); } });
    const { res, html } = await post({ email: EMAIL, password: RIGHT_PHRASE }, sb);
    expect([UNAVAILABLE, SERVER_ERROR]).toContain(res.status);
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
  });
});
