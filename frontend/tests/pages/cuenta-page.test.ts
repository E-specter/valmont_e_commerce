import { App } from 'astro/app';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Cuenta from '../../src/pages/cuenta/index.astro';
import Ingresar from '../../src/pages/ingresar.astro';
import { parseHtml } from '../helpers/render';
import { HTTP } from '../helpers/t127';
import {
  BEARER, BIRTH, BIRTH_TEXT, CONFLICT, NO_STORE, ORIGIN, OTHER_BIRTH, SESSION, SESSION_EMAIL, USER_ID,
  detail, fieldErrorText, inSequence, installBackend, json, patchBody, serverError, unauthenticated, validationError,
  type Call,
} from '../helpers/t129';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-129 · ruta GET|POST /cuenta con la Container API, un `fetch` falso como backend de identity y un cliente de Supabase simulado.
// La guardia de sesión (middleware, T-126) no corre aquí: se prueba la página por sí sola y, de extremo a extremo, en el E2E.
const NONE = 0;
const ONE = 1;
const THREE = 3;
const MAX_HOPS = 6;
const SERVER_ERRORS = [HTTP.SERVER_ERROR, HTTP.BAD_GATEWAY, HTTP.UNAVAILABLE];
const UNSUPPORTED_MEDIA = 415;
const NEW_NAME = 'Ana María Torres';
const NEW_PHONE = '+51911222333';
const LEAK_WORDS = ['fetch failed', 'TypeError', 'ECONNREFUSED', 'stack', '.ts:', 'api.test', 'MSG-DEL-BACKEND-QX', BEARER];
const ALLOWED_KEYS = ['full_name', 'phone', 'birth_date'];
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
// Invitación a repetir: "Reintentar", "Inténtalo de nuevo" o "Intenta nuevamente".
const RETRY_WORDS = ['reintent', 'inténtalo', 'intenta ', 'de nuevo'];
const SB_COOKIES = ['sb-127-auth-token', 'sb-127-auth-token.1'];

type Init = { method?: string; query?: string; fields?: Record<string, string>; headers?: Record<string, string>; session?: unknown; cookie?: string; body?: string };

function supabaseMock() {
  const signOut = vi.fn(async () => ({ error: null }));
  return { auth: { signOut }, signOut };
}
let sb: ReturnType<typeof supabaseMock>;

async function render(page: Parameters<AstroContainer['renderToResponse']>[0], path: string, init: Init = {}) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET';
  const body = hasBody ? (init.body ?? new URLSearchParams(init.fields ?? {}).toString()) : undefined;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } : {}),
    ...(init.cookie ? { cookie: init.cookie } : {}),
    ...init.headers,
  };
  const request = new Request(`${ORIGIN}${path}${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  const session = 'session' in init ? init.session : SESSION;
  const res = await container.renderToResponse(page, { request, locals: { session: session as App.Locals['session'], supabase: sb as unknown as App.Locals['supabase'] }, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}
const cuenta = (init: Init = {}) => render(Cuenta, '/cuenta', init);
const post = (fields: Record<string, string>, init: Init = {}) => cuenta({ method: 'POST', fields, ...init });

const input = (doc: Document, name: string): HTMLInputElement | null => doc.querySelector(`input[name="${name}"]`);
const alertText = (doc: Document): string => text(doc.querySelector('[role="alert"]'));
const isInvalid = (doc: Document, name: string): boolean => input(doc, name)?.getAttribute('aria-invalid') === 'true';
// Astro guarda las cookies en la respuesta (no en cabeceras) hasta que el adaptador las serializa: así se leen.
const setCookies = (res: Response): string[] => [...App.getSetCookieFromResponse(res)];
const isRedirect = (res: Response): boolean => [HTTP.FOUND, HTTP.SEE_OTHER].includes(res.status as never);
const cacheOk = (res: Response): boolean => (res.headers.get('cache-control') ?? 'no-store').includes('no-store');
const retryIn = (doc: Document): boolean =>
  [...doc.querySelectorAll('[role="alert"] a, [role="alert"] button')].some((el) => text(el).toLowerCase().includes('reintentar')) || RETRY_WORDS.some((w) => alertText(doc).toLowerCase().includes(w));

/** Éxito: la propia respuesta con "Datos guardados" (role="status") o una redirección a /cuenta que, al seguirla, lo muestra. */
async function expectSaved(res: Response, doc: Document, after: () => Promise<{ doc: Document }>): Promise<void> {
  if (isRedirect(res)) {
    const to = res.headers.get('location') ?? '';
    expect(to.split('?')[NONE]).toBe('/cuenta');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    const next = await after();
    expect(text(next.doc.querySelector('[role="status"]'))).toContain('Datos guardados');
    return;
  }
  expect(res.status).toBe(HTTP.OK);
  expect(text(doc.querySelector('[role="status"]'))).toContain('Datos guardados');
}
const savedAfter = (res: Response) => async () => {
  const to = res.headers.get('location') ?? '/cuenta';
  const q = to.includes('?') ? `?${to.split('?')[ONE]}` : '';
  return cuenta({ query: q });
};

beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /cuenta', () => {
  test('200: PageTitle "Mi cuenta" (único h1), título, noindex y el perfil actual en el formulario', async () => {
    installBackend({ full_name: 'Ana Torres', phone: '+51987654321' });
    const { res, doc } = await cuenta();
    expect(res.status).toBe(HTTP.OK);
    expect(doc.querySelectorAll('h1')).toHaveLength(ONE);
    expect(text(doc.querySelector('h1'))).toBe('Mi cuenta');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe('Ana Torres');
    expect(input(doc, 'phone')?.getAttribute('value')).toBe('+51987654321');
    expect(doc.querySelector('form[method="post" i]')).not.toBeNull();
  });

  test('pide el perfil con UNA sola GET /identity/me y el Bearer de la sesión; ninguna otra llamada ni query', async () => {
    const backend = installBackend();
    await cuenta();
    expect(backend.calls).toHaveLength(ONE);
    expect(backend.calls[NONE]).toMatchObject({ method: 'GET', url: 'http://api.test:8000/api/v1/identity/me', auth: `Bearer ${BEARER}` });
  });

  test('respuesta privada: nunca una caché pública', async () => {
    installBackend();
    const { res } = await cuenta();
    expect(cacheOk(res)).toBe(true);
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
  });

  test('el correo sale de la sesión validada, no de un parámetro de la URL', async () => {
    installBackend();
    const { html } = await cuenta({ query: '?email=intruso@example.com&user_id=otro&role=admin' });
    expect(html).toContain(SESSION_EMAIL);
    expect(html).not.toContain('intruso@example.com');
  });

  test('los parámetros de la URL no viajan al backend (la identidad es la del token)', async () => {
    const backend = installBackend();
    await cuenta({ query: `?user_id=${USER_ID}&id=1&birth_date=${BIRTH}` });
    expect(backend.calls.map((c) => c.url)).toEqual(['http://api.test:8000/api/v1/identity/me']);
  });

  test('no se muestra el rol, el user_id ni otros datos internos del perfil', async () => {
    installBackend({ role: 'admin' });
    const { html, doc } = await cuenta();
    expect(html).not.toContain(USER_ID);
    expect(text(doc.body).toLowerCase()).not.toContain('admin');
    expect(doc.querySelector('input[name="role"], input[name="user_id"]')).toBeNull();
    expect(html).not.toContain('2026-10-26');
  });

  test('un nombre hostil del backend se escapa', async () => {
    installBackend({ full_name: '<script>window.__pwned=1</script><b>x</b>' });
    const { html, doc } = await cuenta();
    expect(doc.querySelector('script:not([src]), b')).toBeNull();
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe('<script>window.__pwned=1</script><b>x</b>');
    expect(html).not.toContain('<b>x</b></');
  });

  test('perfil sin nombre ni teléfono: campos vacíos, sin "null"', async () => {
    installBackend({ full_name: null, phone: null });
    const { doc, html } = await cuenta();
    expect(input(doc, 'full_name')?.getAttribute('value') ?? '').toBe('');
    expect(input(doc, 'phone')?.getAttribute('value') ?? '').toBe('');
    expect(html).not.toContain('value="null"');
  });

  test('enlaces a "Mis pedidos" y "Lista de deseos"', async () => {
    installBackend();
    const { doc } = await cuenta();
    const link = (href: string) => doc.querySelector(`main a[href="${href}"]`);
    expect(text(link('/cuenta/pedidos')).toLowerCase()).toContain('mis pedidos');
    expect(text(link('/cuenta/lista-de-deseos')).toLowerCase()).toContain('lista de deseos');
  });

  test('"Cerrar sesión" es un <form method="post" action="/salir"> con botón; nunca un enlace GET a /salir', async () => {
    installBackend();
    const { doc } = await cuenta();
    const logout = doc.querySelector<HTMLFormElement>('main form[action="/salir"]');
    expect(logout, 'falta el formulario de cierre').not.toBeNull();
    expect(logout?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(text(logout?.querySelector('button[type="submit"]')).toLowerCase()).toContain('cerrar sesión');
    expect(doc.querySelectorAll('a[href="/salir"]')).toHaveLength(NONE);
  });

  test('sin fecha de nacimiento: campo de fecha editable (type=date)', async () => {
    installBackend({ birth_date: null });
    const { doc } = await cuenta();
    expect(input(doc, 'birth_date')?.getAttribute('type')).toBe('date');
    expect(text(doc.body)).not.toContain('Para corregirla');
  });

  test('con fecha de nacimiento: solo lectura con formatDateOnly y el texto de atención al cliente; sin campo editable', async () => {
    installBackend({ birth_date: BIRTH });
    const { doc } = await cuenta();
    expect(text(doc.body)).toContain(BIRTH_TEXT);
    expect(text(doc.body)).toContain('Para corregirla, contacta con atención al cliente.');
    expect(doc.querySelector('input[type="date"]')).toBeNull();
    expect(doc.querySelector('input[name="birth_date"]:not([readonly]):not([disabled])')).toBeNull();
  });

  test('sin sesión (red de seguridad si el middleware fallara): redirige a /ingresar?next=/cuenta y NO llama al backend', async () => {
    const backend = installBackend();
    const { res } = await cuenta({ session: null });
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcuenta');
    expect(backend.calls).toHaveLength(NONE);
  });

  test.each(SERVER_ERRORS)('el backend responde %i → Notice de error con reintento, sin trazas ni el cuerpo del backend', async (status) => {
    installBackend({}, () => serverError(status));
    const { res, doc, html } = await cuenta();
    expect(isRedirect(res)).toBe(false);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(retryIn(doc)).toBe(true);
    LEAK_WORDS.forEach((w) => expect(html).not.toContain(w));
    expect(sb.signOut).not.toHaveBeenCalled();
  });

  test('sin red con el backend (fetch rechaza) → Notice con reintento, sin detalles técnicos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const { res, doc, html } = await cuenta();
    expect(isRedirect(res)).toBe(false);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(retryIn(doc)).toBe(true);
    LEAK_WORDS.forEach((w) => expect(html).not.toContain(w));
  });

  test.each(['PUT', 'DELETE', 'PATCH'])('%s no modifica el perfil', async (method) => {
    const backend = installBackend();
    await cuenta({ method, fields: { full_name: NEW_NAME }, headers: { origin: ORIGIN } });
    expect(backend.patches()).toHaveLength(NONE);
  });
});

describe('POST /cuenta · protección (Origin y tipo de cuerpo)', () => {
  test.each([
    ['Origin ajeno', { origin: 'https://evil.test' }],
    ['Origin "null"', { origin: 'null' }],
    ['Origin con el host como prefijo', { origin: `${ORIGIN}.evil.test` }],
  ])('%s → 403 y no se escribe nada', async (_name, headers) => {
    const backend = installBackend();
    const { res } = await post({ full_name: NEW_NAME }, { headers });
    expect(res.status).toBe(HTTP.FORBIDDEN);
    expect(res.headers.get('location')).toBeNull();
    expect(backend.patches()).toHaveLength(NONE);
  });

  test('sin Origin (solo Referer) → 403', async () => {
    const backend = installBackend();
    const request = new Request(`${ORIGIN}/cuenta`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${ORIGIN}/cuenta` }, body: 'full_name=Zed' });
    const container = await AstroContainer.create();
    const res = await container.renderToResponse(Cuenta, { request, locals: { session: SESSION, supabase: sb } as unknown as App.Locals, routeType: 'page' });
    expect(res.status).toBe(HTTP.FORBIDDEN);
    expect(backend.patches()).toHaveLength(NONE);
  });

  test.each([
    ['JSON', 'application/json', '{"full_name":"Zed"}'],
    ['texto plano', 'text/plain', 'full_name=Zed'],
  ])('un cuerpo %s (no es un formulario) → 415, sin 500 ni trazas y sin escribir', async (_name, type, body) => {
    const backend = installBackend();
    const { res, html } = await cuenta({ method: 'POST', body, headers: { 'content-type': type, origin: ORIGIN } });
    expect(res.status).toBe(UNSUPPORTED_MEDIA);
    expect(backend.patches()).toHaveLength(NONE);
    ['TypeError', '.ts:', 'stack'].forEach((w) => expect(html).not.toContain(w));
  });

  test('sin sesión, un POST no llega al backend', async () => {
    const backend = installBackend();
    const { res } = await post({ full_name: NEW_NAME }, { session: null });
    expect(isRedirect(res)).toBe(true);
    expect(backend.calls).toHaveLength(NONE);
  });
});

describe('POST /cuenta · el PATCH lleva solo lo cambiado', () => {
  const current = { full_name: 'Ana Torres', phone: '+51987654321' };

  test('solo el nombre cambia → PATCH {full_name} con el Bearer de la sesión; el éxito se confirma con "Datos guardados"', async () => {
    const backend = installBackend(current);
    const { res, doc } = await post({ full_name: NEW_NAME, phone: current.phone });
    expect(patchBody(backend.calls)).toEqual({ full_name: NEW_NAME });
    expect(backend.patches()[NONE]).toMatchObject({ url: 'http://api.test:8000/api/v1/identity/me', auth: `Bearer ${BEARER}` });
    await expectSaved(res, doc, savedAfter(res));
  });

  test('solo el teléfono cambia → PATCH {phone}', async () => {
    const backend = installBackend(current);
    await post({ full_name: current.full_name, phone: NEW_PHONE });
    expect(patchBody(backend.calls)).toEqual({ phone: NEW_PHONE });
  });

  test('nombre y teléfono cambian → un único PATCH con ambos', async () => {
    const backend = installBackend(current);
    await post({ full_name: NEW_NAME, phone: NEW_PHONE });
    expect(backend.patches()).toHaveLength(ONE);
    expect(patchBody(backend.calls)).toEqual({ full_name: NEW_NAME, phone: NEW_PHONE });
  });

  test('vaciar un campo envía null (borra el dato); el otro no viaja', async () => {
    const backend = installBackend(current);
    await post({ full_name: '', phone: current.phone });
    expect(patchBody(backend.calls)).toEqual({ full_name: null });
    const second = installBackend(current);
    await post({ full_name: current.full_name, phone: '' });
    expect(patchBody(second.calls)).toEqual({ phone: null });
    const both = installBackend(current);
    await post({ full_name: '', phone: '' });
    expect(patchBody(both.calls)).toEqual({ full_name: null, phone: null });
  });

  test('un perfil sin datos y un formulario vacío no cambian nada: ningún campo viaja (null→"" no es un cambio)', async () => {
    const backend = installBackend({ full_name: null, phone: null });
    const { res, doc } = await post({ full_name: '', phone: '' });
    backend.patches().forEach((c) => expect(c.body ?? {}).toEqual({}));
    expect(res.status === HTTP.OK || isRedirect(res)).toBe(true);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('sin cambios no se envía ningún campo (PATCH ausente o vacío) y no es un error', async () => {
    const backend = installBackend(current);
    const { res, doc } = await post({ full_name: current.full_name, phone: current.phone });
    backend.patches().forEach((c) => expect(c.body ?? {}).toEqual({}));
    expect(res.status === HTTP.OK || isRedirect(res)).toBe(true);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('campos ajenos del formulario (role, user_id, email, preferences) jamás viajan al backend', async () => {
    const backend = installBackend(current);
    await post({ full_name: NEW_NAME, phone: current.phone, role: 'admin', user_id: 'otro-usuario', email: 'otro@example.com', marketing_opt_in: 'true', preferences: '{}' });
    const keys = Object.keys(patchBody(backend.calls) ?? {});
    expect(keys.filter((k) => !ALLOWED_KEYS.includes(k))).toEqual([]);
    expect(keys).toEqual(['full_name']);
    backend.calls.forEach((c) => expect(c.url).toBe('http://api.test:8000/api/v1/identity/me'));
  });

  test('un campo repetido o un valor no textual (archivo) no provoca 500', async () => {
    installBackend(current);
    const { res } = await cuenta({ method: 'POST', body: 'full_name=A&full_name=B&phone=%00', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN } });
    expect(res.status).toBeLessThan(HTTP.SERVER_ERROR);
  });
});

describe('POST /cuenta · fecha de nacimiento (D-045)', () => {
  test('sin fecha previa: la fecha viaja en el MISMO PATCH que el nombre y solo ella si lo demás no cambia', async () => {
    const backend = installBackend({ birth_date: null });
    await post({ full_name: 'Ana Torres', phone: '+51987654321', birth_date: BIRTH });
    expect(patchBody(backend.calls)).toEqual({ birth_date: BIRTH });
    const both = installBackend({ birth_date: null });
    await post({ full_name: NEW_NAME, phone: '+51987654321', birth_date: BIRTH });
    expect(both.patches()).toHaveLength(ONE);
    expect(patchBody(both.calls)).toEqual({ full_name: NEW_NAME, birth_date: BIRTH });
  });

  test('sin fecha previa y campo vacío: birth_date no viaja (ni como null ni como "")', async () => {
    const backend = installBackend({ birth_date: null });
    await post({ full_name: NEW_NAME, phone: '+51987654321', birth_date: '' });
    expect(Object.keys(patchBody(backend.calls) ?? {})).toEqual(['full_name']);
  });

  test('con fecha ya fijada y el formulario habitual (sin campo de fecha): birth_date no viaja', async () => {
    const backend = installBackend({ birth_date: BIRTH });
    await post({ full_name: NEW_NAME, phone: '+51987654321' });
    expect(patchBody(backend.calls)).toEqual({ full_name: NEW_NAME });
  });

  test('con fecha fijada y la MISMA fecha reenviada: no es un error', async () => {
    const backend = installBackend({ birth_date: BIRTH });
    const { res, doc } = await post({ full_name: NEW_NAME, phone: '+51987654321', birth_date: BIRTH });
    // La autoridad es el backend: una fecha igual a la guardada (o vacía) no viaja en el PATCH.
    expect(patchBody(backend.calls)).toEqual({ full_name: NEW_NAME });
    expect(res.status === HTTP.OK || isRedirect(res)).toBe(true);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('con fecha fijada y OTRA fecha por POST directo → 409 y aviso en el formulario; la fecha original queda intacta', async () => {
    const backend = installBackend({ birth_date: BIRTH });
    const { res, doc, html } = await post({ full_name: 'Ana Torres', phone: '+51987654321', birth_date: OTHER_BIRTH });
    expect(res.status).toBe(CONFLICT);
    expect(alertText(doc).toLowerCase()).toContain('fecha');
    expect(text(doc.body)).not.toContain('Datos guardados');
    expect(backend.state.birth_date).toBe(BIRTH);
    expect(html).not.toContain(OTHER_BIRTH);
  });

  test('409 birth_date_locked del backend (otra pestaña la fijó antes) → 409 en el formulario, sin "Datos guardados"', async () => {
    installBackend({ birth_date: null }, (c: Call) => (c.method === 'PATCH' ? json({ error: { code: 'birth_date_locked', message: 'MSG-DEL-BACKEND-QX', details: null } }, CONFLICT) : undefined));
    const { res, doc, html } = await post({ full_name: 'Ana Torres', phone: '+51987654321', birth_date: OTHER_BIRTH });
    expect(res.status).toBe(CONFLICT);
    expect(alertText(doc).toLowerCase()).toContain('fecha');
    expect(text(doc.body)).not.toContain('Datos guardados');
    expect(html).not.toContain('MSG-DEL-BACKEND-QX');
  });

  test.each([
    ['birth_date_future', ['futura', 'futuro', 'posterior']],
    ['birth_date_too_old', ['antigua', 'revisa', 'válida', 'valida']],
    ['birth_date_underage', ['18']],
    ['value_error', ['fecha']],
  ])('422 %s → error en el campo de la fecha (aria-invalid + texto en español asociado), sin el texto ni el código del backend', async (type, words) => {
    installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? validationError(detail('birth_date', type)) : undefined));
    const { res, doc, html } = await post({ full_name: 'Ana Torres', phone: '+51987654321', birth_date: BIRTH });
    expect(res.status).toBe(HTTP.UNPROCESSABLE);
    expect(isInvalid(doc, 'birth_date')).toBe(true);
    expect(isInvalid(doc, 'full_name')).toBe(false);
    expect(isInvalid(doc, 'phone')).toBe(false);
    const message = fieldErrorText(doc, input(doc, 'birth_date') as Element).toLowerCase();
    expect(message.length).toBeGreaterThan(NONE);
    expect(words.some((w) => message.includes(w)), `mensaje inesperado: ${message}`).toBe(true);
    ['MSG-DEL-BACKEND-QX', type, 'Value error'].forEach((w) => expect(html).not.toContain(w));
    expect(input(doc, 'birth_date')?.getAttribute('value')).toBe(BIRTH);
  });

  test('los tres errores de rango dan mensajes distintos entre sí', async () => {
    const messages = await inSequence(['birth_date_future', 'birth_date_too_old', 'birth_date_underage'], async (type) => {
      installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? validationError(detail('birth_date', type)) : undefined));
      const { doc } = await post({ full_name: 'Ana Torres', phone: '+51987654321', birth_date: BIRTH });
      return fieldErrorText(doc, input(doc, 'birth_date') as Element);
    });
    expect(new Set(messages).size).toBe(THREE);
  });

  test('un 422 de la fecha no pinta "Datos guardados" y no cambia lo ya guardado', async () => {
    const backend = installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? validationError(detail('birth_date', 'birth_date_underage')) : undefined));
    const { doc } = await post({ full_name: NEW_NAME, phone: '+51987654321', birth_date: BIRTH });
    expect(text(doc.body)).not.toContain('Datos guardados');
    expect(backend.state.full_name).toBe('Ana Torres');
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe(NEW_NAME);
  });
});

describe('POST /cuenta · errores del backend', () => {
  test.each([
    ['phone', 'value_error'],
    ['full_name', 'string_too_long'],
    ['full_name', 'string_too_short'],
  ])('422 en %s (%s) → error en ESE campo con texto en español; el otro campo y lo escrito se conservan', async (field, type) => {
    installBackend({}, (c) => (c.method === 'PATCH' ? validationError(detail(field, type)) : undefined));
    const typed = { full_name: field === 'full_name' ? 'Nombre escrito' : 'Ana Torres', phone: field === 'phone' ? 'abc' : '+51987654321' };
    const { res, doc, html } = await post(typed);
    expect(res.status).toBe(HTTP.UNPROCESSABLE);
    expect(isInvalid(doc, field)).toBe(true);
    expect(isInvalid(doc, field === 'phone' ? 'full_name' : 'phone')).toBe(false);
    const message = fieldErrorText(doc, input(doc, field) as Element);
    expect(message.length).toBeGreaterThan(NONE);
    ['MSG-DEL-BACKEND-QX', type, 'Value error'].forEach((w) => expect(html).not.toContain(w));
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe(typed.full_name);
    expect(input(doc, 'phone')?.getAttribute('value')).toBe(typed.phone);
    expect(text(doc.body)).not.toContain('Datos guardados');
  });

  test('422 con varios campos → cada uno recibe su error', async () => {
    installBackend({}, (c) => (c.method === 'PATCH' ? validationError(detail('phone', 'value_error'), detail('full_name', 'string_too_long')) : undefined));
    const { doc } = await post({ full_name: 'x', phone: 'abc' });
    expect(isInvalid(doc, 'phone') && isInvalid(doc, 'full_name')).toBe(true);
  });

  test('422 sin details o con un campo desconocido → aviso de formulario, sin 500 ni trazas', async () => {
    installBackend({}, (c) => (c.method === 'PATCH' ? json({ error: { code: 'validation_error', message: 'MSG-DEL-BACKEND-QX', details: null } }, HTTP.UNPROCESSABLE) : undefined));
    const { res, doc, html } = await post({ full_name: NEW_NAME, phone: '+51987654321' });
    expect(res.status).toBeLessThan(HTTP.SERVER_ERROR);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(html).not.toContain('MSG-DEL-BACKEND-QX');
  });

  test.each(SERVER_ERRORS)('PATCH %i → Notice con reintento, el formulario conserva lo escrito, sin trazas', async (status) => {
    installBackend({}, (c) => (c.method === 'PATCH' ? serverError(status) : undefined));
    const { res, doc, html } = await post({ full_name: NEW_NAME, phone: NEW_PHONE });
    expect(isRedirect(res)).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(HTTP.SERVER_ERROR);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(retryIn(doc)).toBe(true);
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe(NEW_NAME);
    expect(input(doc, 'phone')?.getAttribute('value')).toBe(NEW_PHONE);
    LEAK_WORDS.forEach((w) => expect(html).not.toContain(w));
    expect(text(doc.body)).not.toContain('Datos guardados');
  });

  test('PATCH sin red → Notice con reintento y lo escrito conservado', async () => {
    const backend = installBackend();
    backend.fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new TypeError('fetch failed');
      return json(backend.state);
    });
    const { res, doc, html } = await post({ full_name: NEW_NAME, phone: '+51987654321' });
    expect(isRedirect(res)).toBe(false);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(input(doc, 'full_name')?.getAttribute('value')).toBe(NEW_NAME);
    LEAK_WORDS.forEach((w) => expect(html).not.toContain(w));
  });
});

describe('401 del backend · cierra la sesión local y redirige al ingreso, sin bucle', () => {
  const answer401 = (only?: 'GET' | 'PATCH') => (c: Call) => (!only || c.method === only ? unauthenticated() : undefined);
  const cases = [
    ['GET', (cookie?: string) => cuenta({ cookie }), answer401('GET')],
    ['PATCH (POST del formulario)', (cookie?: string) => post({ full_name: NEW_NAME, phone: '+51987654321' }, { cookie }), answer401('PATCH')],
  ] as const;

  test.each(cases)('%s → 303 a /ingresar?next=%2Fcuenta con Cache-Control: private, no-store', async (_name, run, override) => {
    installBackend({}, override);
    const { res } = await run(COOKIE_HEADER);
    expect(res.status).toBe(HTTP.SEE_OTHER);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcuenta');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  });

  test.each(cases)('%s → la respuesta lleva Set-Cookie de borrado de cada cookie sb-* y ninguna de las ajenas', async (_name, run, override) => {
    installBackend({}, override);
    const { res } = await run(COOKIE_HEADER);
    const cookies = setCookies(res);
    SB_COOKIES.forEach((name) => {
      const line = cookies.find((c) => c.startsWith(`${name}=`));
      expect(line, `falta el Set-Cookie de borrado de ${name}`).toBeDefined();
      const lower = (line ?? '').toLowerCase();
      expect(lower.includes('max-age=0') || lower.includes('expires=thu, 01 jan 1970')).toBe(true);
      expect(lower).toContain('path=/');
      expect(line?.startsWith(`${name}=;`) || line?.startsWith(`${name}=deleted`) || line?.startsWith(`${name}=`)).toBe(true);
    });
    expect(cookies.some((c) => c.startsWith('theme='))).toBe(false);
  });

  test.each(cases)('%s → cierra la sesión local de Supabase (scope local), como /bff', async (_name, run, override) => {
    installBackend({}, override);
    await run(COOKIE_HEADER);
    expect(sb.signOut).toHaveBeenCalledTimes(ONE);
    expect(sb.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test.each(cases)('%s → el cuerpo de la redirección no lleva datos', async (_name, run, override) => {
    installBackend({}, override);
    const { html } = await run(COOKIE_HEADER);
    expect(html).toBe('');
  });

  test.each(cases)('%s → sin cookies de sesión en la petición redirige igual y no emite Set-Cookie de sb-*', async (_name, run, override) => {
    installBackend({}, override);
    const { res } = await run();
    expect(res.status).toBe(HTTP.SEE_OTHER);
    expect(res.headers.get('location')).toBe('/ingresar?next=%2Fcuenta');
    expect(setCookies(res).filter((c) => c.startsWith('sb-'))).toHaveLength(NONE);
  });

  /** Navegador mínimo: guarda las cookies, aplica los Set-Cookie y sigue las redirecciones. La sesión de la página es la de la cookie (como el middleware con una cookie aún válida). */
  async function browse(first: (cookie?: string) => Promise<{ res: Response }>) {
    const jar = new Map<string, string>(COOKIE_HEADER.split('; ').map((p) => [p.split('=')[NONE], p.split('=').slice(ONE).join('=')]));
    const trail: string[] = [];
    const apply = (res: Response): void =>
      setCookies(res).forEach((line) => {
        const [pair, ...attrs] = line.split(';').map((s) => s.trim());
        const name = pair.split('=')[NONE];
        const value = pair.split('=').slice(ONE).join('=');
        const gone = attrs.some((a) => a.toLowerCase() === 'max-age=0' || a.toLowerCase().startsWith('expires=thu, 01 jan 1970'));
        if (gone || value === '') jar.delete(name);
        else jar.set(name, value);
      });
    const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const hasSession = (): boolean => [...jar.keys()].some((k) => k.startsWith('sb-'));
    type Step = { res: Response; doc?: Document };
    const follow = async (step: Step, hops: number): Promise<Step> => {
      apply(step.res);
      if (hops >= MAX_HOPS || !isRedirect(step.res)) return step;
      const to = step.res.headers.get('location') ?? '';
      const path = to.split('?')[NONE];
      trail.push(to);
      const query = to.includes('?') ? `?${to.split('?').slice(ONE).join('?')}` : '';
      const session = hasSession() ? SESSION : null;
      // El middleware: una ruta protegida sin cookie de sesión redirige al ingreso.
      if (path === '/cuenta' && !session) {
        return follow({ res: new Response(null, { status: HTTP.FOUND, headers: { location: '/ingresar?next=%2Fcuenta' } }) }, hops + ONE);
      }
      return follow(await render(path === '/cuenta' ? Cuenta : Ingresar, path, { query, cookie: cookieHeader(), session }), hops + ONE);
    };
    trail.push('/cuenta');
    const last = await follow(await first(COOKIE_HEADER), NONE);
    const doc = last.doc ?? null;
    const status: number = last.res.status;
    return { trail, doc, status, final: isRedirect(last.res) ? 'redirect' : 'page' };
  }

  test.each(cases)('%s → seguir las redirecciones termina en el formulario de /ingresar (200), sin bucle', async (_name, run, override) => {
    installBackend({}, override);
    const out = await browse(run);
    expect(out.final).toBe('page');
    expect(out.status).toBe(HTTP.OK);
    expect(out.trail.at(-ONE)?.startsWith('/ingresar')).toBe(true);
    expect(out.trail.filter((p) => p.startsWith('/cuenta'))).toHaveLength(ONE);
    expect(out.trail.length).toBeLessThanOrEqual(THREE);
    expect(out.doc?.querySelector('input[type="password"]')).not.toBeNull();
    expect(out.doc?.querySelector('input[autocomplete="email"]')).not.toBeNull();
  });
});

describe('la fecha de nacimiento no se registra (R9, RNF10)', () => {
  test('ningún console.* recibe la fecha en GET, POST correcto, 422, 409 ni 5xx; tampoco Location ni Set-Cookie', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const written: string[] = [];
    const runs: (() => Promise<{ res: Response; html: string }>)[] = [
      async () => (installBackend({ birth_date: BIRTH }), cuenta({ cookie: COOKIE_HEADER })),
      async () => (installBackend({ birth_date: null }), post({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH })),
      async () => (installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? validationError(detail('birth_date', 'birth_date_underage')) : undefined)), post({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH })),
      async () => (installBackend({ birth_date: BIRTH }), post({ full_name: 'Ana', phone: '+51987654321', birth_date: OTHER_BIRTH })),
      async () => (installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? serverError() : undefined)), post({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH })),
      async () => (installBackend({ birth_date: null }, (c) => (c.method === 'PATCH' ? unauthenticated() : undefined)), post({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH }, { cookie: COOKIE_HEADER })),
    ];
    const results = await inSequence(runs, (run) => run());
    results.forEach(({ res }) => written.push(res.headers.get('location') ?? '', ...setCookies(res)));
    const logged = spies.flatMap((s) => s.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
    [BIRTH, OTHER_BIRTH, BIRTH_TEXT].forEach((d) => {
      logged.forEach((line) => expect(line).not.toContain(d));
      written.forEach((line) => expect(line).not.toContain(d));
    });
  });

  test('las redirecciones de éxito no llevan la fecha en la URL (ni en la query)', async () => {
    installBackend({ birth_date: null });
    const { res } = await post({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH });
    expect(res.headers.get('location') ?? '').not.toContain(BIRTH);
  });
});
