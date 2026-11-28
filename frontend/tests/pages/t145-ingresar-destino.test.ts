import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Ingresar from '../../src/pages/ingresar.astro';
import Registro from '../../src/pages/registro.astro';
import { parseHtml } from '../helpers/render';
import { text } from '../helpers/ui';
import { BEARER, NO_STORE, ORIGIN, json, profile } from '../helpers/t129';
import { FORBIDDEN, MSG, OK, RIGHT_PHRASE, SB, SEE_OTHER, SERVER_ERROR, UNAUTHORIZED, UNPROCESSABLE, WRONG_PHRASE, type AuthErr } from '../helpers/t127';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-145 (acceso) · destino del ingreso según el rol que dice GET /identity/me (y solo él):
//   · administrador sin `next` explícito válido → /admin;  · cliente → /cuenta;
//   · `next` explícito válido se respeta SIEMPRE (también al administrador);  · `next` hostil o vacío → el destino por rol;
//   · si /identity/me falla tras el ingreso → /cuenta (el ingreso nunca se rompe por esto).
// Más una regresión de T-127 (anti-enumeración, Origin, 415, 303 con no-store) con el nuevo camino de éxito.
const EMAIL = 'ana.perez@example.com';
const GHOST_EMAIL = 'fantasma@example.com';
const UNSUPPORTED_MEDIA = 415;
const FAR_FUTURE = 4_102_444_800;
const RENEWAL = 'renewal-value-0145';
const NOT_FOUND = 404;
const ME_URL = 'http://api.test:8000/api/v1/identity/me';
const SIGN_IN_TOKEN = BEARER;
const NONE = 0;
const ONE = 1;
const RUNS = 5;
const HALF = 2;
const MAX_DRIFT_MS = 150;
const SIMULATED_MS = 20;
const UNAVAILABLE = 503;
const ADMIN_DEST = '/admin';
const CUSTOMER_DEST = '/cuenta';
const HOSTILE_NEXT = ['//evil.com', '///evil.com', '/\\evil.com', 'https://evil.com/x', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', 'cuenta', '', '%2F%2Fevil.com', 'data:text/html,x', 'http://localhost:4321@evil.com'];
const VALID_NEXT = ['/carrito', '/checkout', '/cuenta/pedidos', '/relojes?categoria=clasicos', '/cuenta', '/admin/pedidos', '/admin/productos/nuevo'];
const LEAK_WORDS = ['SUPABASE', 'ANON_KEY', '.ts:', 'api.test', 'fetch failed', 'TypeError', 'stack'];

type Result = { error: AuthErr | null; data: { session: unknown; user: unknown } };
type SignIn = (c: { email: string; password: string }) => Promise<Result>;
type Fields = Partial<Record<'email' | 'password' | 'next' | 'role' | 'redirect', string>>;

const SESSION_BODY = { access_token: SIGN_IN_TOKEN, refresh_token: RENEWAL, expires_at: FAR_FUTURE };
const okResult = (): Result => ({ error: null, data: { session: SESSION_BODY, user: { id: 'u-1' } } });
const failResult = (error: AuthErr): Result => ({ error, data: { session: null, user: null } });

/** Cliente de Supabase simulado. `getSession` devuelve la misma sesión nueva, por si la página la lee de ahí en vez de la respuesta del ingreso. */
function client(signIn: SignIn) {
  const signInWithPassword = vi.fn(signIn);
  const getSession = vi.fn(async () => ({ data: { session: SESSION_BODY }, error: null }));
  const getClaims = vi.fn(async () => ({ data: { claims: { sub: 'u-1', role: 'authenticated' } }, error: null }));
  return { auth: { signInWithPassword, getSession, getClaims }, signInWithPassword };
}
const asOk = () => client(async () => okResult());

type FetchLog = { url: string; method: string; auth: string | null };
/** `fetch` falso: responde a /identity/me con el rol dado (o con `reply`); registra cada llamada. */
function backend(role: unknown, reply?: () => Response | Promise<Response>) {
  const calls: FetchLog[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
    return reply ? reply() : json({ ...profile(), role });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function render(init: { method?: string; query?: string; fields?: Record<string, string>; headers?: Record<string, string>; sb?: unknown; session?: unknown; body?: string }) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET';
  const body = hasBody ? (init.body ?? new URLSearchParams(init.fields ?? {}).toString()) : undefined;
  const headers: Record<string, string> = { ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } : {}), ...init.headers };
  const request = new Request(`${ORIGIN}/ingresar${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Ingresar, {
    request,
    locals: { session: (init.session ?? null) as App.Locals['session'], supabase: init.sb as App.Locals['supabase'] },
    routeType: 'page',
  });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

/** Nombres reales de los campos, leídos del formulario que sirve el GET (la prueba no depende de cómo los llame). */
let names: { email: string; password: string; next: string | null };
beforeEach(async () => {
  const { doc } = await render({ query: '?next=/carrito' });
  const email = doc.querySelector('input[autocomplete="email"]')?.getAttribute('name');
  const password = doc.querySelector('input[type="password"]')?.getAttribute('name');
  if (!email || !password) throw new Error('El formulario no expone los campos de correo y contraseña');
  names = { email, password, next: doc.querySelector('input[type="hidden"]')?.getAttribute('name') ?? null };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fields = (f: Fields): Record<string, string> => ({
  ...(f.email !== undefined ? { [names.email]: f.email } : {}),
  ...(f.password !== undefined ? { [names.password]: f.password } : {}),
  ...(f.next !== undefined && names.next ? { [names.next]: f.next } : {}),
  ...(f.role !== undefined ? { role: f.role } : {}),
  ...(f.redirect !== undefined ? { redirect: f.redirect } : {}),
});
/** `next` viaja en el cuerpo (si el formulario lo lleva) y en la query, como lo hace el navegador. */
const post = (f: Fields, sb: unknown, extra: { query?: string } = {}) =>
  render({ method: 'POST', fields: fields(f), query: extra.query ?? (f.next !== undefined ? `?next=${encodeURIComponent(f.next)}` : ''), sb });
const login = (sb: unknown, next?: string) => post({ email: EMAIL, password: RIGHT_PHRASE, ...(next !== undefined ? { next } : {}) }, sb);
const dest = (res: Response): string | null => res.headers.get('location');
const alertText = (doc: Document): string => text(doc.querySelector('[role="alert"]'));

describe('POST /ingresar · destino por rol (sin next explícito)', () => {
  test('administrador (role = admin en /identity/me) → 303 a /admin con private, no-store', async () => {
    backend('admin');
    const { res } = await login(asOk());
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(ADMIN_DEST);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test('cliente (role = customer) → 303 a /cuenta', async () => {
    backend('customer');
    const { res } = await login(asOk());
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(CUSTOMER_DEST);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test('el rol se pide a GET /identity/me con el Bearer de la sesión recién creada (una sola llamada, sin cuerpo)', async () => {
    const be = backend('admin');
    await login(asOk());
    const me = be.calls.filter((c) => c.url === ME_URL);
    expect(me).toHaveLength(ONE);
    expect(me[NONE].method).toBe('GET');
    expect(me[NONE].auth).toBe(`Bearer ${SIGN_IN_TOKEN}`);
    expect(be.calls).toHaveLength(ONE);
  });

  test.each(['customer', '', 'ADMIN', 'Admin', ' admin', 'admin ', 'superadmin', 'administrator', null, ONE, true, ['admin'], { role: 'admin' }])(
    'role %j (distinto de «admin» exacto) → /cuenta: ningún valor raro abre /admin',
    async (role) => {
      backend(role);
      const { res } = await login(asOk());
      expect(res.status).toBe(SEE_OTHER);
      expect(dest(res)).toBe(CUSTOMER_DEST);
    },
  );

  test('el rol viene del backend: un campo `role=admin` o `redirect=/admin` enviado por un cliente no cambia su destino', async () => {
    backend('customer');
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE, role: 'admin', redirect: '/admin' }, asOk());
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });

  test('el rol viene del backend: `?role=admin` en la URL del POST no cambia el destino de un cliente', async () => {
    backend('customer');
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE, role: 'admin' }, asOk(), { query: '?role=admin&admin=1' });
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });

  test('el rol viene del backend: una sesión cuyo token AFIRMA ser admin no basta (el backend dice customer)', async () => {
    const claims = [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from('{"role":"admin","app_metadata":{"role":"admin"}}').toString('base64url'), 'sig'].join('.');
    backend('customer');
    const sb = client(async () => ({ error: null, data: { session: { ...SESSION_BODY, access_token: claims }, user: { id: 'u-1', app_metadata: { role: 'admin' }, user_metadata: { role: 'admin' } } } }));
    const { res } = await login(sb);
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });

  test('el cuerpo de la respuesta de éxito no filtra el rol ni el token', async () => {
    backend('admin');
    const { html } = await login(asOk());
    expect(html).not.toContain(SIGN_IN_TOKEN);
    expect(html.toLowerCase()).not.toContain('admin');
  });
});

describe('POST /ingresar · con `next` explícito válido se respeta (también al administrador)', () => {
  test.each(VALID_NEXT)('administrador con next=%s → exactamente ese destino', async (next) => {
    backend('admin');
    const { res } = await login(asOk(), next);
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(next);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test.each(VALID_NEXT)('cliente con next=%s → exactamente ese destino', async (next) => {
    backend('customer');
    const { res } = await login(asOk(), next);
    expect(dest(res)).toBe(next);
  });

  test('next solo en la query (sin campo en el cuerpo) también se respeta para el administrador', async () => {
    backend('admin');
    const { res } = await post({ email: EMAIL, password: RIGHT_PHRASE }, asOk(), { query: '?next=%2Fcarrito' });
    expect(dest(res)).toBe('/carrito');
  });

  test('si /identity/me falla y hay next explícito válido, se sigue respetando next', async () => {
    backend('admin', () => json({ error: { code: 'internal_error', message: 'x', details: null } }, UNAVAILABLE));
    const { res } = await login(asOk(), '/carrito');
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe('/carrito');
  });
});

describe('POST /ingresar · `next` hostil o vacío cuenta como «sin next»: el destino lo decide el rol', () => {
  test.each(HOSTILE_NEXT)('administrador con next=%j → /admin (nunca el destino hostil)', async (next) => {
    backend('admin');
    const { res } = await login(asOk(), next);
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(ADMIN_DEST);
    expect(dest(res) ?? '').not.toContain('evil');
  });

  test.each(HOSTILE_NEXT)('cliente con next=%j → /cuenta (nunca el destino hostil)', async (next) => {
    backend('customer');
    const { res } = await login(asOk(), next);
    expect(dest(res)).toBe(CUSTOMER_DEST);
    expect(dest(res) ?? '').not.toContain('evil');
  });

  test('next hostil solo en la query: el administrador va a /admin y el cliente a /cuenta', async () => {
    backend('admin');
    const a = await post({ email: EMAIL, password: RIGHT_PHRASE }, asOk(), { query: '?next=%2F%2Fevil.com' });
    expect(dest(a.res)).toBe(ADMIN_DEST);
    backend('customer');
    const c = await post({ email: EMAIL, password: RIGHT_PHRASE }, asOk(), { query: '?next=%2F%2Fevil.com' });
    expect(dest(c.res)).toBe(CUSTOMER_DEST);
  });

  test('la cabecera Location nunca lleva saltos de línea (sin inyección de cabeceras)', async () => {
    backend('admin');
    const { res } = await login(asOk(), '/a\r\nSet-Cookie: x=1');
    expect(dest(res) ?? '').not.toMatch(/[\r\n]/u);
  });
});

/**
 * Lo que enviaría el NAVEGADOR al pulsar «Ingresar»: todos los campos con nombre del formulario tal como los sirvió el GET (incluido el `next`
 * oculto, con el valor que la página le puso) más el correo y la contraseña tecleados, y a la `action` del formulario (`/ingresar`, SIN la query del GET).
 */
async function submitLikeBrowser(query: string, sb: unknown) {
  const { doc } = await render({ query });
  const form = doc.querySelector('form[method="post" i]');
  const sent: Record<string, string> = {};
  form?.querySelectorAll('input[name]').forEach((el) => {
    sent[el.getAttribute('name') ?? ''] = el.getAttribute('value') ?? '';
  });
  sent[names.email] = EMAIL;
  sent[names.password] = RIGHT_PHRASE;
  return render({ method: 'POST', fields: sent, sb });
}

describe('POST /ingresar · el formulario del propio sitio (campo oculto `next` incluido) respeta el destino por rol', () => {
  test.each(['', '?next=', '?next=%2F%2Fevil.com', '?next=javascript%3Aalert(1)', '?next=cuenta', '?next=https%3A%2F%2Fevil.com%2Fx'])(
    'GET /ingresar%s sin next explícito válido: el administrador entra a /admin',
    async (query) => {
      backend('admin');
      const { res } = await submitLikeBrowser(query, asOk());
      expect(res.status).toBe(SEE_OTHER);
      expect(dest(res)).toBe(ADMIN_DEST);
    },
  );

  test.each(['', '?next=', '?next=%2F%2Fevil.com', '?next=javascript%3Aalert(1)', '?next=cuenta'])('GET /ingresar%s sin next explícito válido: el cliente entra a /cuenta', async (query) => {
    backend('customer');
    const { res } = await submitLikeBrowser(query, asOk());
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });

  test.each([['?next=%2Fcarrito', '/carrito'], ['?next=%2Fcuenta', '/cuenta'], ['?next=%2Fcuenta%2Fpedidos', '/cuenta/pedidos'], ['?next=%2Fadmin%2Fpedidos', '/admin/pedidos']])(
    'GET /ingresar%s con next explícito válido: se respeta (administrador y cliente) → %s',
    async (query, expected) => {
      backend('admin');
      expect(dest((await submitLikeBrowser(query, asOk())).res)).toBe(expected);
      backend('customer');
      expect(dest((await submitLikeBrowser(query, asOk())).res)).toBe(expected);
    },
  );

  test('el GET sin next no deja en el formulario un destino que se confunda con uno explícito', async () => {
    const { doc, html } = await render({});
    const hidden = [...doc.querySelectorAll('form input[type="hidden"]')].map((i) => i.getAttribute('value') ?? '');
    // Si hay un campo oculto con el destino por omisión, el POST de arriba ya lo prueba; aquí solo se exige que no filtre nada ajeno.
    hidden.forEach((v) => expect(v === '' || v.startsWith('/')).toBe(true));
    expect(html).not.toContain('evil');
  });
});

describe('POST /ingresar · si /identity/me falla tras el ingreso, el destino es /cuenta (el ingreso no se rompe)', () => {
  const failures: [string, () => Response | Promise<Response>][] = [
    ['401', () => json({ error: { code: 'unauthenticated', message: 'x', details: null } }, UNAUTHORIZED)],
    ['403', () => json({ error: { code: 'forbidden', message: 'x', details: null } }, FORBIDDEN)],
    ['404', () => json({ error: { code: 'not_found', message: 'x', details: null } }, NOT_FOUND)],
    ['500', () => json({ error: { code: 'internal_error', message: 'x', details: null } }, SERVER_ERROR)],
    ['503', () => json({ error: { code: 'internal_error', message: 'x', details: null } }, UNAVAILABLE)],
    ['200 con null', () => json(null)],
    ['200 sin role', () => json({ user_id: 'u' })],
    ['200 con HTML', () => new Response('<html>oops</html>', { status: OK, headers: { 'content-type': 'text/html' } })],
    ['red caída', () => Promise.reject(new TypeError('fetch failed'))],
  ];

  test.each(failures)('/identity/me → %s: 303 a /cuenta con no-store, sin trazas', async (_name, reply) => {
    backend('admin', reply);
    const { res, html } = await login(asOk());
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(CUSTOMER_DEST);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    LEAK_WORDS.forEach((w) => expect(html, w).not.toContain(w));
  });

  test('/identity/me que nunca responde (cuelga) no deja la respuesta colgada para siempre: termina en /cuenta', async () => {
    // El transporte del servidor corta a los 8 s (AbortSignal.timeout); aquí se simula el corte con un rechazo diferido.
    backend('admin', () => new Promise<Response>((_ok, reject) => setTimeout(() => reject(new DOMException('timeout', 'TimeoutError')), SIMULATED_MS)));
    const { res } = await login(asOk());
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });

  test('el ingreso sin sesión en la respuesta (session = null) tampoco rompe: 303 a /cuenta', async () => {
    backend('admin');
    const sb = client(async () => ({ error: null, data: { session: null, user: { id: 'u-1' } } }));
    const sbNoSession = { auth: { ...sb.auth, getSession: vi.fn(async () => ({ data: { session: null }, error: null })) } };
    const { res } = await login(sbNoSession);
    expect(res.status).toBe(SEE_OTHER);
    expect(dest(res)).toBe(CUSTOMER_DEST);
  });
});

describe('POST /ingresar · regresión de T-127 con el camino nuevo', () => {
  test('credenciales incorrectas: 401 con el mismo mensaje y SIN pedir /identity/me ni tocar la red', async () => {
    const be = backend('admin');
    const { res, doc } = await login(client(async () => failResult(SB.invalidCredentials())));
    expect(res.status).toBe(UNAUTHORIZED);
    expect(alertText(doc)).toContain(MSG.BAD_CREDENTIALS);
    expect(be.calls).toHaveLength(NONE);
    expect(dest(res)).toBeNull();
  });

  test('anti-enumeración: correo inexistente y contraseña errónea dan la MISMA respuesta (estado, cabeceras y HTML)', async () => {
    backend('admin');
    const wrongPassword = await post({ email: EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.invalidCredentials())));
    const ghost = await post({ email: GHOST_EMAIL, password: WRONG_PHRASE }, client(async () => failResult(SB.invalidCredentials())));
    expect(ghost.res.status).toBe(wrongPassword.res.status);
    expect(alertText(ghost.doc)).toBe(alertText(wrongPassword.doc));
    expect(ghost.res.headers.get('cache-control')).toBe(wrongPassword.res.headers.get('cache-control'));
    expect(alertText(ghost.doc)).not.toContain(GHOST_EMAIL);
  });

  test('tiempo comparable: correo inexistente y contraseña errónea tardan lo mismo (mediana de cinco, margen de 150 ms) aunque el éxito ahora llame a la API', async () => {
    backend('admin');
    const slow = () =>
      client(async () => {
        await new Promise((r) => setTimeout(r, SIMULATED_MS));
        return failResult(SB.invalidCredentials());
      });
    const time = async (sb: unknown, email: string): Promise<number> => {
      const t0 = performance.now();
      await post({ email, password: WRONG_PHRASE }, sb);
      return performance.now() - t0;
    };
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / HALF)];
    const sample = async (email: string): Promise<number> => median(await Promise.all(Array.from({ length: RUNS }, () => time(slow(), email))));
    const [a, b] = [await sample(EMAIL), await sample(GHOST_EMAIL)];
    expect(Math.abs(a - b)).toBeLessThan(MAX_DRIFT_MS);
  });

  test('Origin ausente o ajeno → 403 sin llamar a Supabase ni a la API', async () => {
    const be = backend('admin');
    const sb = asOk();
    const foreign = await render({ method: 'POST', fields: fields({ email: EMAIL, password: RIGHT_PHRASE }), headers: { origin: 'https://evil.test' }, sb });
    expect(foreign.res.status).toBe(FORBIDDEN);
    const request = new Request(`${ORIGIN}/ingresar`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields({ email: EMAIL, password: RIGHT_PHRASE })).toString() });
    const container = await AstroContainer.create();
    const none = await container.renderToResponse(Ingresar, { request, locals: { session: null, supabase: sb } as never, routeType: 'page' });
    expect(none.status).toBe(FORBIDDEN);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(be.calls).toHaveLength(NONE);
  });

  test('un cuerpo que no es un formulario (JSON) → 415 con no-store, sin llamar a Supabase ni a la API', async () => {
    const be = backend('admin');
    const sb = asOk();
    const { res } = await render({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }), sb });
    expect(res.status).toBe(UNSUPPORTED_MEDIA);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(be.calls).toHaveLength(NONE);
  });

  test('un fallo de validación (correo vacío) → 422 sin llamar a Supabase ni a la API', async () => {
    const be = backend('admin');
    const sb = asOk();
    const { res } = await post({ email: '', password: '' }, sb);
    expect(res.status).toBe(UNPROCESSABLE);
    expect(sb.signInWithPassword).not.toHaveBeenCalled();
    expect(be.calls).toHaveLength(NONE);
  });

  test('la contraseña no se vuelve a pintar ni viaja a la API de identidad', async () => {
    const be = backend('admin');
    const { html } = await login(asOk());
    expect(html).not.toContain(RIGHT_PHRASE);
    expect(JSON.stringify(be.calls)).not.toContain(RIGHT_PHRASE);
  });

  test('GET /ingresar sigue sirviéndose sin llamar a la API ni a Supabase', async () => {
    const be = backend('admin');
    const { res } = await render({});
    expect(res.status).toBe(OK);
    expect(be.calls).toHaveLength(NONE);
  });
});

describe('regresión de T-128 · el registro no cambia con el ajuste del formulario de ingreso', () => {
  const registro = async (query: string) => {
    const container = await AstroContainer.create();
    const res = await container.renderToResponse(Registro, { request: new Request(`${ORIGIN}/registro${query}`), locals: { session: null, supabase: {} } as never, routeType: 'page' });
    return { res, doc: parseHtml(await res.text()) };
  };
  const hiddenNext = (d: Document): string | null => d.querySelector('form input[type="hidden"][name="next"]')?.getAttribute('value') ?? null;

  test('GET /registro?next=/carrito sigue sirviéndose y conserva el next en su campo oculto', async () => {
    const { res, doc } = await registro('?next=%2Fcarrito');
    expect(res.status).toBe(OK);
    expect(hiddenNext(doc)).toBe('/carrito');
  });

  test('GET /registro con next hostil no lo refleja', async () => {
    const { res, doc } = await registro('?next=%2F%2Fevil.com');
    expect(res.status).toBe(OK);
    expect(doc.documentElement.outerHTML).not.toContain('evil.com');
  });

  test('el enlace «registro» del ingreso conserva un next explícito y nunca uno hostil', async () => {
    const good = await render({ query: '?next=%2Fcarrito' });
    expect(good.html).toContain('/registro?next=%2Fcarrito');
    const bad = await render({ query: '?next=%2F%2Fevil.com' });
    expect(bad.html).not.toContain('evil.com');
  });
});
