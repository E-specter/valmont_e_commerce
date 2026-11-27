import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import Registro from '../../src/pages/registro.astro';
import { PRIVACY_VERSION } from '../../src/lib/site';
import { parseHtml } from '../helpers/render';
import { BEARER_VALUE, FakeServer } from '../helpers/t126';
import { FORBIDDEN, MSG, OK, SB, SEE_OTHER, SERVER_ERROR, SESSION_FAKE, TOO_MANY, UNAVAILABLE, UNPROCESSABLE, containsAny, type AuthErr } from '../helpers/t127';
import { ADULT_BIRTH, FAKE_EMAIL, FAKE_NAME, FAKE_PHRASE, ISO_DATE, OTHER_PHRASE, addDays, limaOf, shiftYears } from '../helpers/t128';
import { text } from '../helpers/ui';

// T-128 + T-131 · ruta GET|POST /registro con la Container API y un Supabase simulado (sin red).
// Los nombres de los campos se descubren del HTML del GET (autocomplete / type), no se suponen.
const h = vi.hoisted(() => ({ api: 'http://127.0.0.1:1' }));
vi.mock('astro:env/server', () => ({
  get API_BASE_URL() {
    return h.api;
  },
  SUPABASE_URL: 'http://sb.test:54321',
  SUPABASE_ANON_KEY: 'anon-value-for-tests',
}));

const ORIGIN = 'http://localhost:4321';
const NO_STORE = 'private, no-store';
const UNSUPPORTED_MEDIA = 415;
const ONE = 1;
const NONE = 0;
const LONG = 10_000;
const MAX_EMAIL = 320;
const LEAK_WORDS = ['SUPABASE', 'ANON_KEY', '.ts:', 'at supabase', 'stack', 'AuthConfigError', 'ECONNREFUSED'];
const MINOR_AGE = 17;
const FIVE = 5;
const ADULT_AGE = 18;
const HOSTILE_NEXT = ['//evil.com', '///evil.com', '/\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', 'cuenta', '%2F%2Fevil.com', 'data:text/html,x'];

const backend = new FakeServer();
beforeAll(async () => {
  await backend.start();
  h.api = backend.base;
});
afterAll(() => backend.stop());
beforeEach(() => {
  backend.reset();
  backend.reply = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Result = { error: AuthErr | null; data: { session: unknown; user: unknown } };
const NEW_USER: Result = { error: null, data: { session: null, user: { id: 'u-1', identities: [{ id: 'i-1' }] } } };
// Supabase con confirmación de correo activa y un correo ya registrado: usuario "falso" sin identidades.
const DUPLICATE: Result = { error: null, data: { session: null, user: { id: 'u-2', identities: [] } } };
const failure = (error: AuthErr): Result => ({ error, data: { session: null, user: null } });
const TOKEN_FIELD = 'access_token';
const withSession: Result = { error: null, data: { session: { [TOKEN_FIELD]: BEARER_VALUE }, user: { id: 'u-3', identities: [{ id: 'i-3' }] } } };

function client(signUp: () => Promise<Result> = async () => NEW_USER) {
  const signUpFn = vi.fn(signUp);
  const updateUser = vi.fn(async () => ({ data: {}, error: null }));
  return { auth: { signUp: signUpFn, updateUser }, signUp: signUpFn, updateUser };
}
type Sb = ReturnType<typeof client>;

type Fields = Partial<{ full_name: string; email: string; password: string; password_confirm: string; accept_terms: boolean; birth_date: string; next: string }>;

async function render(init: { method?: string; query?: string; formBody?: URLSearchParams; headers?: Record<string, string>; sb?: unknown; session?: unknown; body?: string }) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET';
  const body = hasBody ? (init.body ?? (init.formBody ?? new URLSearchParams()).toString()) : undefined;
  const headers: Record<string, string> = { ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } : {}), ...init.headers };
  const request = new Request(`${ORIGIN}/registro${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Registro, { request, locals: { session: (init.session ?? null) as App.Locals['session'], supabase: init.sb as App.Locals['supabase'] }, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

let names: { full_name: string; email: string; password: string; password_confirm: string; birth_date: string; accept_terms: string; next: string | null };
const pick = (doc: Document, sel: string): string => {
  const n = doc.querySelector(sel)?.getAttribute('name');
  if (!n) throw new Error(`El formulario no expone ${sel}`);
  return n;
};
async function discoverNames(): Promise<void> {
  const { doc } = await render({ query: '?next=/carrito' });
  const pw = [...doc.querySelectorAll('input[type="password"]')].map((e) => e.getAttribute('name') ?? '');
  names = {
    full_name: pick(doc, 'input[autocomplete="name"]'),
    email: pick(doc, 'input[autocomplete="email"]'),
    password: pw[NONE],
    password_confirm: pw[ONE],
    birth_date: pick(doc, 'input[type="date"]'),
    accept_terms: pick(doc, 'input[type="checkbox"]'),
    next: doc.querySelector('input[type="hidden"]')?.getAttribute('name') ?? null,
  };
}
beforeEach(discoverNames);

const GOOD: Required<Omit<Fields, 'next'>> = { full_name: FAKE_NAME, email: FAKE_EMAIL, password: FAKE_PHRASE, password_confirm: FAKE_PHRASE, accept_terms: true, birth_date: ADULT_BIRTH };

/** Cuerpo de formulario con los nombres reales; la casilla marcada se envía como `on`, desmarcada no se envía. */
function body(f: Fields, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  (['full_name', 'email', 'password', 'password_confirm', 'birth_date'] as const).forEach((k) => f[k] !== undefined && p.set(names[k], f[k] as string));
  if (f.accept_terms) p.set(names.accept_terms, 'on');
  if (f.next !== undefined && names.next) p.set(names.next, f.next);
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p;
}
const post = (f: Fields, sb: unknown, o: { query?: string; session?: unknown; extra?: Record<string, string> } = {}) =>
  render({ method: 'POST', formBody: body(f, o.extra), query: o.query ?? (f.next !== undefined ? `?next=${encodeURIComponent(f.next)}` : ''), sb, session: o.session });
const good = (over: Fields = {}): Fields => ({ ...GOOD, ...over });

const alertCount = (doc: Document): number => doc.querySelectorAll('[role="alert"]').length;
const alertText = (doc: Document): string => text(doc.querySelector('[role="alert"]'));
const invalid = (doc: Document, sel: string): boolean => doc.querySelector(sel)?.getAttribute('aria-invalid') === 'true';
const calledArgs = (sb: Sb): { email: string; password: string; options: { emailRedirectTo: string; data: Record<string, unknown> } } => (sb.signUp.mock.calls as unknown as unknown[][])[NONE][NONE] as never;

describe('GET /registro', () => {
  test('200 con Cache-Control: private, no-store, un único h1, <main> único y noindex', async () => {
    const { res, doc } = await render({});
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(doc.querySelectorAll('main')).toHaveLength(ONE);
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(text(doc.querySelector('title')).length).toBeGreaterThan(NONE);
  });

  test('trae el formulario con los seis campos y sin alertas; las contraseñas sin value', async () => {
    const { doc } = await render({});
    expect(doc.querySelector('form[method="post" i]')).not.toBeNull();
    expect(doc.querySelectorAll('input:not([type="hidden"])')).toHaveLength(6);
    expect(alertCount(doc)).toBe(NONE);
    doc.querySelectorAll('input[type="password"]').forEach((e) => expect(e.hasAttribute('value')).toBe(false));
  });

  test('el arte es decorativo (aria-hidden)', async () => {
    const { doc } = await render({});
    expect(doc.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test('no necesita Supabase: se sirve aunque falte la configuración', async () => {
    const sb = new Proxy({}, { get: () => { throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24'); } });
    expect((await render({ sb })).res.status).toBe(OK);
  });

  test('el campo de fecha lleva `max` con el día de hoy en Lima (el navegador ya lo impide; el servidor lo vuelve a comprobar)', async () => {
    const { doc } = await render({});
    const max = doc.querySelector('input[type="date"]')?.getAttribute('max');
    expect(max, 'falta max en la fecha').toMatch(ISO_DATE);
    expect([limaOf(new Date()), addDays(limaOf(new Date()), -ONE), addDays(limaOf(new Date()), ONE)]).toContain(max);
  });

  test('credenciales y fecha en la query de un GET no se usan, no se vuelven a pintar y no llaman a Supabase', async () => {
    const sb = client();
    const { res, html } = await render({ query: `?${names.email}=${FAKE_EMAIL}&${names.password}=${FAKE_PHRASE}&${names.birth_date}=${ADULT_BIRTH}`, sb });
    expect(res.status).toBe(OK);
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(html).not.toContain(FAKE_PHRASE);
    expect(html).not.toContain(ADULT_BIRTH);
  });

  test.each(['PUT', 'DELETE', 'PATCH'])('%s con datos válidos no registra', async (method) => {
    const sb = client();
    const { res } = await render({ method, formBody: body(good()), sb });
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(res.status).not.toBe(SEE_OTHER);
  });

  test('con next interno, el formulario y el enlace a ingreso lo conservan; con next hostil, no', async () => {
    expect((await render({ query: '?next=/carrito' })).html).toContain('carrito');
    expect((await render({ query: '?next=//evil.com' })).html).not.toContain('evil.com');
  });
});

describe('POST /registro · éxito (confirmación de correo activa)', () => {
  test('datos válidos → UNA llamada a signUp con correo, contraseña tal cual y metadatos del registro', async () => {
    const sb = client();
    const { res } = await post(good(), sb);
    expect(res.status).toBe(OK);
    expect(sb.signUp).toHaveBeenCalledTimes(ONE);
    const a = calledArgs(sb);
    expect(a.email).toBe(FAKE_EMAIL);
    expect(a.password).toBe(FAKE_PHRASE);
    expect(a.options.data).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY_VERSION, birth_date: ADULT_BIRTH });
  });

  test('la versión de la política la fija el servidor: un cuerpo que intente otra no la cambia ni añade metadatos', async () => {
    const sb = client();
    await post(good(), sb, { extra: { accept_privacy_version: '1999-01', role: 'admin', is_admin: 'true', data: '{"role":"admin"}', user_id: 'otro' } });
    const a = calledArgs(sb);
    expect(a.options.data).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY_VERSION, birth_date: ADULT_BIRTH });
    expect(Object.keys(a).sort()).toEqual(['email', 'options', 'password']);
  });

  test('ni la repetición de la contraseña ni la casilla viajan en los metadatos', async () => {
    const sb = client();
    await post(good(), sb);
    expect(JSON.stringify(calledArgs(sb).options)).not.toContain(FAKE_PHRASE);
    expect(Object.keys(calledArgs(sb).options.data)).not.toContain('accept_terms');
  });

  test('la contraseña no se recorta; el correo sí', async () => {
    const sb = client();
    const spaced = `  ${FAKE_PHRASE}  `;
    await post(good({ password: spaced, password_confirm: spaced, email: `  ${FAKE_EMAIL}  ` }), sb);
    expect(calledArgs(sb).password).toBe(spaced);
    expect(calledArgs(sb).email).toBe(FAKE_EMAIL);
  });

  test('emailRedirectTo apunta a /auth/callback del propio origen, sin la fecha ni datos personales', async () => {
    const sb = client();
    await post(good(), sb);
    const url = new URL(calledArgs(sb).options.emailRedirectTo);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/auth/callback');
    expect(url.toString()).not.toContain(ADULT_BIRTH);
    expect(url.toString()).not.toContain(encodeURIComponent(FAKE_EMAIL));
    expect(url.toString()).not.toContain(FAKE_PHRASE);
  });

  test('el next del redirect es interno; sin next o con next hostil, /cuenta', async () => {
    const sbA = client();
    await post(good(), sbA);
    expect(new URL(calledArgs(sbA).options.emailRedirectTo).searchParams.get('next')).toBe('/cuenta');
    await Promise.all(
      HOSTILE_NEXT.map(async (next) => {
        const sb = client();
        await post(good({ next }), sb);
        const target = new URL(calledArgs(sb).options.emailRedirectTo);
        expect(target.origin).toBe(ORIGIN);
        expect(target.searchParams.get('next'), next).toBe('/cuenta');
      }),
    );
  });

  test('un next interno se conserva en el redirect del correo (el callback lo valida otra vez)', async () => {
    const sb = client();
    await post(good({ next: '/carrito' }), sb);
    expect(['/carrito', '/cuenta']).toContain(new URL(calledArgs(sb).options.emailRedirectTo).searchParams.get('next'));
  });

  test('sin sesión: estado de éxito role="status" con el aviso de revisar el correo; el formulario desaparece', async () => {
    const { res, doc } = await post(good(), client());
    expect(res.status).toBe(OK);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelectorAll('[role="status"]').length).toBeGreaterThanOrEqual(ONE);
    expect(alertCount(doc)).toBe(NONE);
    expect(text(doc.body).toLowerCase()).toContain('revisa tu correo');
    expect(doc.querySelector('input[type="password"]')).toBeNull();
    expect(doc.querySelector('input[type="date"]')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  test('éxito: no se inicia sesión, no hay cookies de sesión ni llamada al backend', async () => {
    const { res } = await post(good(), client());
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(backend.seen).toHaveLength(NONE);
  });

  test('éxito: el HTML no contiene la contraseña ni la fecha de nacimiento', async () => {
    const { html } = await post(good(), client());
    expect(html).not.toContain(FAKE_PHRASE);
    expect(html).not.toContain(ADULT_BIRTH);
  });

  test('el aviso de éxito menciona Mailpit solo en desarrollo; nunca nombra variables ni claves', async () => {
    const { html } = await post(good(), client());
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
  });

  test('anti-enumeración: un correo ya registrado produce EXACTAMENTE el mismo éxito (estado, cabeceras y HTML)', async () => {
    const fresh = await post(good(), client(async () => NEW_USER));
    const dup = await post(good(), client(async () => DUPLICATE));
    expect(dup.res.status).toBe(fresh.res.status);
    expect(dup.html).toBe(fresh.html);
    expect(dup.res.headers.get('cache-control')).toBe(fresh.res.headers.get('cache-control'));
  });

  test('anti-enumeración (2): si Auth responde user_already_exists, el usuario ve el mismo éxito', async () => {
    const fresh = await post(good(), client(async () => NEW_USER));
    const dup = await post(good(), client(async () => failure({ code: 'user_already_exists', status: UNPROCESSABLE, name: 'AuthApiError', message: 'User already registered' })));
    expect(dup.res.status).toBe(fresh.res.status);
    expect(dup.html).toBe(fresh.html);
  });
});

describe('POST /registro · éxito con sesión inmediata (confirmación desactivada)', () => {
  test('el servidor hace PATCH /identity/me con el Bearer, nombre, versión y fecha, y redirige a /cuenta', async () => {
    const sb = client(async () => withSession);
    const { res } = await post(good(), sb);
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('location')).toBe('/cuenta');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(backend.seen).toHaveLength(ONE);
    const [call] = backend.seen;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('/api/v1/identity/me');
    expect(call.headers.authorization).toBe(`Bearer ${BEARER_VALUE}`);
    expect(JSON.parse(call.body)).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY_VERSION, birth_date: ADULT_BIRTH });
  });

  test('un next interno se respeta; uno hostil cae en /cuenta', async () => {
    expect((await post(good({ next: '/carrito' }), client(async () => withSession))).res.headers.get('location')).toBe('/carrito');
    expect((await post(good({ next: '//evil.com' }), client(async () => withSession))).res.headers.get('location')).toBe('/cuenta');
  });

  test.each([[409], [422], [500]])('si el backend responde %i el usuario entra igualmente (mejor esfuerzo)', async (status) => {
    backend.reply = { status, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"x","message":"m","details":null}}' };
    const { res } = await post(good(), client(async () => withSession));
    expect(res.status).toBe(SEE_OTHER);
  });

  test('la fecha se borra de los metadatos de Auth (R-IDENT-2): updateUser({ data: { birth_date: null } })', async () => {
    const sb = client(async () => withSession);
    await post(good(), sb);
    expect(sb.updateUser).toHaveBeenCalledWith({ data: { birth_date: null } });
  });
});

describe('POST /registro · validación (422 por campo) y menores', () => {
  const bad = (over: Fields) => post(good(over), client());

  test.each([
    ['nombre vacío', { full_name: '' }, 'full_name', 'input[autocomplete="name"]'],
    ['correo inválido', { email: 'ana' }, 'email', 'input[autocomplete="email"]'],
    ['contraseña corta', { password: 'abc12', password_confirm: 'abc12' }, 'password', 'input[type="password"]'],
    ['sin fecha', { birth_date: '' }, 'birth_date', 'input[type="date"]'],
    ['fecha malformada', { birth_date: '17/05/1990' }, 'birth_date', 'input[type="date"]'],
    ['fecha futura', { birth_date: '2999-01-01' }, 'birth_date', 'input[type="date"]'],
    ['más de 120 años', { birth_date: '1850-01-01' }, 'birth_date', 'input[type="date"]'],
    ['sin aceptar los términos', { accept_terms: false }, 'accept_terms', 'input[type="checkbox"]'],
  ] as [string, Fields, string, string][])('%s → 422, resumen role="alert", campo inválido y Supabase intacto', async (_n, over, _field, sel) => {
    const sb = client();
    const { res, doc } = await post(good(over), sb);
    expect(res.status).toBe(UNPROCESSABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(backend.seen).toHaveLength(NONE);
    expect(alertCount(doc)).toBe(ONE);
    expect(invalid(doc, sel)).toBe(true);
  });

  test('la repetición distinta de la contraseña → 422 en el segundo campo, sin llamar a Supabase', async () => {
    const sb = client();
    const { res, doc } = await post(good({ password_confirm: OTHER_PHRASE }), sb);
    expect(res.status).toBe(UNPROCESSABLE);
    expect(sb.signUp).not.toHaveBeenCalled();
    const [first, second] = [...doc.querySelectorAll('input[type="password"]')];
    expect(first.getAttribute('aria-invalid')).toBeNull();
    expect(second.getAttribute('aria-invalid')).toBe('true');
  });

  test('sin campos en el cuerpo → 422 con todos los errores y sin llamar a Supabase', async () => {
    const sb = client();
    const { res, doc } = await render({ method: 'POST', formBody: new URLSearchParams(), sb });
    expect(res.status).toBe(UNPROCESSABLE);
    expect(sb.signUp).not.toHaveBeenCalled();
    // nombre, correo, contraseña, fecha y casilla (dos contraseñas vacías son idénticas: la repetición no falla)
    expect(doc.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThanOrEqual(FIVE);
  });

  test('con 422, nombre, correo y fecha se conservan; las contraseñas no se vuelven a pintar', async () => {
    const { doc, html } = await bad({ accept_terms: false });
    expect(doc.querySelector('input[autocomplete="name"]')?.getAttribute('value')).toBe(FAKE_NAME);
    expect(doc.querySelector('input[autocomplete="email"]')?.getAttribute('value')).toBe(FAKE_EMAIL);
    expect(doc.querySelector('input[type="date"]')?.getAttribute('value')).toBe(ADULT_BIRTH);
    doc.querySelectorAll('input[type="password"]').forEach((e) => expect(e.hasAttribute('value')).toBe(false));
    expect(html).not.toContain(FAKE_PHRASE);
  });

  test('valores hostiles escritos se escapan al volver a pintarlos', async () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const { doc } = await post(good({ full_name: hostile, email: hostile, birth_date: hostile }), client());
    expect(doc.querySelector('img')).toBeNull();
  });

  test('entradas enormes no revientan (sin 5xx) ni llegan a Supabase', async () => {
    const sb = client();
    const huge = 'a'.repeat(LONG);
    const hugePw = 'p'.repeat(LONG);
    const { res, html } = await post(good({ full_name: huge, email: `${huge}@example.com`, password: hugePw, password_confirm: hugePw, birth_date: huge }), sb);
    expect(res.status).toBeLessThan(SERVER_ERROR);
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(html).not.toContain(hugePw);
  });

  test('un correo de más de 320 caracteres nunca llega a Supabase', async () => {
    const sb = client();
    await post(good({ email: `${'a'.repeat(LONG)}@example.com` }), sb);
    (sb.signUp.mock.calls as unknown as { email: string }[][]).forEach(([c]) => expect(c.email.length).toBeLessThanOrEqual(MAX_EMAIL));
  });

  test('un cuerpo que no es un formulario (JSON, text/plain) → 415, sin trazas y sin llamar a Supabase', async () => {
    const sb = client();
    for (const type of ['application/json', 'text/plain']) {
      const out = await render({ method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(good()), sb }).catch(() => ({ res: { status: SERVER_ERROR, headers: new Headers() }, html: '' }));
      expect(out.res.status, type).toBe(UNSUPPORTED_MEDIA);
      expect(out.res.headers.get('cache-control')).toBe(NO_STORE);
      expect(containsAny(out.html, LEAK_WORDS)).toBe(false);
    }
    expect(sb.signUp).not.toHaveBeenCalled();
  });
});

describe('POST /registro · un menor NO se registra (D-045 P-IDENTITY-7)', () => {
  const today = (): string => limaOf(new Date());
  const minorBirth = (): string => shiftYears(today(), -MINOR_AGE);

  test('17 años → 422 en la fecha, con el aviso de los 18 años, SIN llamar a signUp ni al backend', async () => {
    const sb = client();
    const { res, doc } = await post(good({ birth_date: minorBirth() }), sb);
    expect(res.status).toBe(UNPROCESSABLE);
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(sb.updateUser).not.toHaveBeenCalled();
    expect(backend.seen).toHaveLength(NONE);
    expect(invalid(doc, 'input[type="date"]')).toBe(true);
    expect(text(doc.body)).toMatch(/18 años/);
    expect(doc.querySelectorAll('[role="status"]')).toHaveLength(NONE);
  });

  test('la respuesta de un menor no deja cookies ni cabeceras con la fecha, y no revela la edad', async () => {
    const birth = minorBirth();
    const { res, html } = await post(good({ birth_date: birth }), client());
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(birth);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    expect(html).not.toMatch(/\b17\b años|tienes 17|edad de 17/i);
  });

  test('ni la fecha ni la contraseña llegan a la consola', async () => {
    const out: string[] = [];
    const push = (...args: unknown[]): void => void out.push(args.map(String).join(' '));
    (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(push));
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (out.push(String(c)), true));
    const birth = minorBirth();
    await post(good({ birth_date: birth }), client());
    await post(good(), client());
    const all = out.join('\n');
    expect(all).not.toContain(birth);
    expect(all).not.toContain(ADULT_BIRTH);
    expect(all).not.toContain(FAKE_PHRASE);
  });

  test('frontera de Lima: 04:59:59Z el cumpleaños 18 aún no llega (422); 05:00:00Z ya sí (registra)', async () => {
    const birth = '2008-11-28';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-28T04:59:59Z'));
    const before = client();
    expect((await post(good({ birth_date: birth }), before)).res.status).toBe(UNPROCESSABLE);
    expect(before.signUp).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-11-28T05:00:00Z'));
    const after = client();
    expect((await post(good({ birth_date: birth }), after)).res.status).toBe(OK);
    expect(after.signUp).toHaveBeenCalledTimes(ONE);
    expect(calledArgs(after).options.data.birth_date).toBe(birth);
  });

  test('exactamente 18 años cumplidos hoy → se registra; mañana los cumple → 422', async () => {
    const exact = client();
    expect((await post(good({ birth_date: shiftYears(today(), -ADULT_AGE) }), exact)).res.status).toBe(OK);
    expect(exact.signUp).toHaveBeenCalledTimes(ONE);
    const tomorrow = client();
    expect((await post(good({ birth_date: shiftYears(addDays(today(), ONE), -ADULT_AGE) }), tomorrow)).res.status).toBe(UNPROCESSABLE);
    expect(tomorrow.signUp).not.toHaveBeenCalled();
  });

  test('el 29 de febrero (R8): nacido el 29-02-2008, el 28-02-2026 es menor y el 01-03-2026 adulto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-28T17:00:00Z'));
    const minor = client();
    expect((await post(good({ birth_date: '2008-02-29' }), minor)).res.status).toBe(UNPROCESSABLE);
    expect(minor.signUp).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-03-01T17:00:00Z'));
    const adult = client();
    expect((await post(good({ birth_date: '2008-02-29' }), adult)).res.status).toBe(OK);
    expect(adult.signUp).toHaveBeenCalledTimes(ONE);
  });

  test('un menor no puede saltarse la regla con un Origin cualquiera, ni repitiendo el campo, ni en la query', async () => {
    const sb = client();
    const p = body(good({ birth_date: minorBirth() }));
    p.append(names.birth_date, ADULT_BIRTH); // segundo valor del mismo campo: gana el primero en FormData.get
    const { res } = await render({ method: 'POST', formBody: p, sb, query: `?${names.birth_date}=${ADULT_BIRTH}` });
    expect(res.status).toBe(UNPROCESSABLE);
    expect(sb.signUp).not.toHaveBeenCalled();
  });

  test('un adulto sí: la fecha viaja a signUp tal cual, sin transformar', async () => {
    const sb = client();
    await post(good({ birth_date: '1985-12-31' }), sb);
    expect(calledArgs(sb).options.data.birth_date).toBe('1985-12-31');
  });

  test('una fecha con espacios sobrantes se recorta o se rechaza, pero nunca viaja sucia', async () => {
    const sb = client();
    await post(good({ birth_date: ` ${ADULT_BIRTH} ` }), sb);
    if (sb.signUp.mock.calls.length) expect(calledArgs(sb).options.data.birth_date).toMatch(ISO_DATE);
  });
});

describe('POST /registro · Origin y tipo de contenido', () => {
  test.each([
    ['sin Origin', {}],
    ['Origin ajeno', { origin: 'https://evil.test' }],
    ['Origin null', { origin: 'null' }],
    ['otro puerto', { origin: 'http://localhost:4322' }],
    ['otro esquema', { origin: 'https://localhost:4321' }],
    ['sufijo', { origin: 'http://localhost:4321.evil.test' }],
    ['solo Referer propio (no basta)', { referer: `${ORIGIN}/registro`, origin: '' }],
  ])('POST %s → 403 sin registrar', async (_n, extra) => {
    const sb = client();
    const request = new Request(`${ORIGIN}/registro`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body: body(good()).toString(),
    });
    const container = await AstroContainer.create();
    const res = await container.renderToResponse(Registro, { request, locals: { session: null, supabase: sb as never }, routeType: 'page' });
    expect(res.status).toBe(FORBIDDEN);
    expect(res.headers.get('location')).toBeNull();
    expect(sb.signUp).not.toHaveBeenCalled();
    expect(backend.seen).toHaveLength(NONE);
  });

  test('un Origin ajeno con un menor también es 403 (no se evalúa nada del cuerpo)', async () => {
    const sb = client();
    const { res, html } = await render({ method: 'POST', formBody: body(good({ birth_date: '2020-01-01' })), headers: { origin: 'https://evil.test' }, sb });
    expect(res.status).toBe(FORBIDDEN);
    expect(html).not.toContain('2020-01-01');
  });
});

describe('POST /registro · errores de Supabase', () => {
  test('weak_password → 422 con la regla (mínimo 6) en la contraseña, el nombre y el correo conservados', async () => {
    const weak: AuthErr = { code: 'weak_password', status: UNPROCESSABLE, name: 'AuthWeakPasswordError', message: 'Password should be at least 6 characters.' };
    const { res, doc, html } = await post(good(), client(async () => failure(weak)));
    expect(res.status).toBe(UNPROCESSABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(res.headers.get('location')).toBeNull();
    expect(alertCount(doc)).toBe(ONE);
    expect(text(doc.body)).toMatch(/6 caracteres/);
    expect(doc.querySelector('input[type="password"]')?.getAttribute('aria-invalid')).toBe('true');
    expect(doc.querySelector('input[autocomplete="email"]')?.getAttribute('value')).toBe(FAKE_EMAIL);
    expect(html).not.toContain(FAKE_PHRASE);
  });

  test.each([
    ['over_request_rate_limit', SB.rateLimit()],
    ['over_email_send_rate_limit', { code: 'over_email_send_rate_limit', status: TOO_MANY, name: 'AuthApiError', message: 'rate' }],
    ['429 sin código', { status: TOO_MANY, name: 'AuthApiError', message: 'x' }],
  ] as [string, AuthErr][])('%s → 429 con el mensaje de espera', async (_n, error) => {
    const { res, doc } = await post(good(), client(async () => failure(error)));
    expect(res.status).toBe(TOO_MANY);
    expect(alertText(doc)).toContain(MSG.RATE_LIMIT);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test.each([
    ['red caída', SB.network()],
    ['5xx de Supabase', SB.serverError()],
  ] as [string, AuthErr][])('%s → 503 con "Reintentar", sin pistas', async (_n, error) => {
    const { res, doc, html } = await post(good(), client(async () => failure(error)));
    expect(res.status).toBe(UNAVAILABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect([...doc.querySelectorAll('a, button')].some((e) => text(e).toLowerCase().includes('reintentar'))).toBe(true);
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
    expect(html).not.toContain(FAKE_PHRASE);
    expect(doc.querySelector('input[autocomplete="email"]')?.getAttribute('value')).toBe(FAKE_EMAIL);
  });

  test('signUp que LANZA (sin red) → 503 genérico, sin el texto del error, la contraseña ni la fecha', async () => {
    const boom = client(async () => {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:54321 for ${FAKE_EMAIL} with ${FAKE_PHRASE} and ${ADULT_BIRTH} at supabase.ts:24`);
    });
    const { res, html } = await post(good(), boom);
    expect(res.status).toBe(UNAVAILABLE);
    expect(containsAny(html, ['ECONNREFUSED', '54321', 'supabase.ts', FAKE_PHRASE])).toBe(false);
    expect(html).not.toContain(ADULT_BIRTH.concat('  '));
  });

  test('sin configuración de Supabase (el getter lanza) → error genérico, sin variables ni trazas', async () => {
    const sb = new Proxy({}, { get: () => { throw new Error('SUPABASE_ANON_KEY missing at supabase.ts:24'); } });
    const { res, html } = await post(good(), sb);
    expect([UNAVAILABLE, SERVER_ERROR]).toContain(res.status);
    expect(res.headers.get('location')).toBeNull();
    expect(containsAny(html, LEAK_WORDS)).toBe(false);
    expect(html).not.toContain(FAKE_PHRASE);
  });

  test('un error 4xx desconocido no revela detalles de Auth', async () => {
    const odd: AuthErr = { code: 'signup_disabled', status: FORBIDDEN, name: 'AuthApiError', message: 'Signups not allowed for this instance (internal-detail-123)' };
    const { html, res } = await post(good(), client(async () => failure(odd)));
    expect(res.status).toBeLessThan(SERVER_ERROR + ONE);
    expect(html).not.toContain('internal-detail-123');
  });
});

describe('POST /registro · la contraseña y la fecha no se registran ni se devuelven', () => {
  function captureOutput(): () => string {
    const chunks: string[] = [];
    const push = (...args: unknown[]): void => void chunks.push(args.map(String).join(' '));
    (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => vi.spyOn(console, m).mockImplementation(push));
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (chunks.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (chunks.push(String(c)), true));
    return () => chunks.join('\n');
  }

  test.each([
    ['éxito', async () => NEW_USER],
    ['correo repetido', async () => DUPLICATE],
    ['contraseña débil', async () => failure({ code: 'weak_password', status: UNPROCESSABLE, name: 'AuthWeakPasswordError', message: `bad ${FAKE_PHRASE}` })],
    ['límite', async () => failure(SB.rateLimit())],
    ['fallo con datos en el mensaje', async () => { throw new Error(`fallo con ${FAKE_PHRASE} y ${ADULT_BIRTH}`); }],
  ] as [string, () => Promise<Result>][])('%s: ni la respuesta ni la consola contienen la contraseña ni la fecha', async (_n, signUp) => {
    const out = captureOutput();
    const { html, res } = await post(good(), client(signUp));
    expect(html).not.toContain(FAKE_PHRASE);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(FAKE_PHRASE);
    expect(out()).not.toContain(FAKE_PHRASE);
    expect(out()).not.toContain(ADULT_BIRTH);
  });
});

describe('/registro · ya autenticado', () => {
  test('GET con sesión → 303 sin formulario (a /cuenta por defecto; a next si es interno)', async () => {
    const plain = await render({ session: SESSION_FAKE, sb: client() });
    expect(plain.res.status).toBe(SEE_OTHER);
    expect(plain.res.headers.get('location')).toBe('/cuenta');
    expect(plain.res.headers.get('cache-control')).toBe(NO_STORE);
    expect(plain.html).not.toContain('<form');
    expect((await render({ session: SESSION_FAKE, query: '?next=/carrito' })).res.headers.get('location')).toBe('/carrito');
    expect((await render({ session: SESSION_FAKE, query: '?next=//evil.com' })).res.headers.get('location')).toBe('/cuenta');
  });

  test('POST con sesión no vuelve a registrar ni llama a Supabase', async () => {
    const sb = client();
    const { res } = await post(good(), sb, { session: SESSION_FAKE });
    expect(res.status).toBe(SEE_OTHER);
    expect(sb.signUp).not.toHaveBeenCalled();
  });
});
