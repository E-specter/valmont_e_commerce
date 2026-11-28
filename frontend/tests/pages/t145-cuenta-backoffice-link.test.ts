import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Cuenta from '../../src/pages/cuenta/index.astro';
import { parseHtml } from '../helpers/render';
import { HTTP } from '../helpers/t127';
import { API, BEARER, NO_STORE, ORIGIN, SESSION, installBackend, json, profile } from '../helpers/t129';
import { text } from '../helpers/ui';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-145 (acceso) · /cuenta muestra «Ir al backoffice» → /admin SOLO si GET /identity/me dice role = 'admin'.
// El rol sale del perfil del backend: nunca del token, de la sesión local ni de la URL. El backend sigue siendo quien autoriza /admin.
const LINK_TEXT = 'Ir al backoffice';
const ADMIN_HREF = '/admin';
const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';
const ONE = 1;
const NONE = 0;
const NOT_ADMIN_ROLES: unknown[] = ['customer', '', 'ADMIN', 'Admin', ' admin', 'admin ', 'superadmin', 'administrator', 'admin\n', null, 1, true, ['admin'], { role: 'admin' }];

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Un token con forma de JWT que AFIRMA ser administrador; el backend dice otra cosa. */
const CLAIMS_ADMIN = [b64({ alg: 'none' }), b64({ role: 'admin', app_metadata: { role: 'admin' }, user_metadata: { role: 'admin' } }), 'sig'].join('.');
/** Un token con forma de JWT sin ninguna afirmación de rol. */
const CLAIMS_PLAIN = [b64({ alg: 'none' }), b64({ sub: 'u1' }), 'sig'].join('.');

function supabaseMock() {
  const signOut = vi.fn(async () => ({ error: null }));
  return { auth: { signOut }, signOut };
}
let sb: ReturnType<typeof supabaseMock>;
beforeEach(() => {
  sb = supabaseMock();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Init = { session?: unknown; query?: string };
async function cuenta(init: Init = {}) {
  const request = new Request(`${ORIGIN}/cuenta${init.query ?? ''}`, { headers: { cookie: COOKIE_HEADER } });
  const session = 'session' in init ? init.session : SESSION;
  const container = await AstroContainer.create();
  const res = await container.renderToResponse(Cuenta, { request, locals: { session, supabase: sb } as never, routeType: 'page' });
  const html = await res.text();
  return { res, html, doc: parseHtml(html) };
}

const link = (d: Document): HTMLAnchorElement | undefined => ([...d.querySelectorAll('a')] as HTMLAnchorElement[]).find((a) => text(a).includes(LINK_TEXT));
const ancestors = (el: Element): Element[] => (el.parentElement ? [el, ...ancestors(el.parentElement)] : [el]);
const toAdmin = (d: Document): Element[] => [...d.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').toLowerCase().startsWith('/admin'));

describe('/cuenta · administrador (rol = admin en /identity/me)', () => {
  test('aparece el enlace visible «Ir al backoffice» que lleva a /admin', async () => {
    installBackend({ role: 'admin' });
    const { res, doc } = await cuenta();
    expect(res.status).toBe(HTTP.OK);
    const a = link(doc);
    expect(a, 'falta «Ir al backoffice»').toBeDefined();
    expect(a?.getAttribute('href')).toBe(ADMIN_HREF);
  });

  test('es un enlace real (a[href]) visible: sin hidden, aria-hidden, display:none ni tabindex negativo, y fuera de un formulario de envío', async () => {
    installBackend({ role: 'admin' });
    const { doc } = await cuenta();
    const a = link(doc) as HTMLAnchorElement;
    ancestors(a).forEach((n) => {
      expect(n.hasAttribute('hidden'), n.tagName).toBe(false);
      expect(n.getAttribute('aria-hidden'), n.tagName).not.toBe('true');
      expect((n.getAttribute('style') ?? '').replaceAll(' ', ''), n.tagName).not.toContain('display:none');
    });
    expect(a.getAttribute('tabindex')).not.toBe('-1');
    expect(a.closest('form')).toBeNull();
    expect(a.getAttribute('target')).toBeNull();
  });

  test('hay un único enlace al backoffice y ningún otro enlace a /admin en la página', async () => {
    installBackend({ role: 'admin' });
    const { doc } = await cuenta();
    expect(toAdmin(doc)).toHaveLength(ONE);
  });

  test('el rol sale de GET /identity/me: una sola llamada, con el Bearer de la sesión y sin parámetros', async () => {
    const be = installBackend({ role: 'admin' });
    await cuenta();
    expect(be.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}`]);
    expect(be.calls[NONE].auth).toBe(`Bearer ${BEARER}`);
  });

  test('un token SIN afirmaciones de rol no impide el enlace si el backend dice admin', async () => {
    installBackend({ role: 'admin' });
    const { doc } = await cuenta({ session: { ...SESSION, accessToken: CLAIMS_PLAIN } });
    expect(link(doc)).toBeDefined();
  });

  test('conserva el resto de la cuenta: «Mis pedidos», «Lista de deseos» y «Cerrar sesión»', async () => {
    installBackend({ role: 'admin' });
    const { doc } = await cuenta();
    const labels = [...doc.querySelectorAll('a, button')].map((e) => text(e));
    ['Mis pedidos', 'Lista de deseos', 'Cerrar sesión'].forEach((l) => expect(labels.some((t) => t.includes(l)), l).toBe(true));
  });

  test('la respuesta sigue siendo privada (no-store) y el rol no se imprime como dato', async () => {
    installBackend({ role: 'admin' });
    const { res, html } = await cuenta();
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(html).not.toContain('"role"');
    expect(html).not.toContain('role&quot;');
  });
});

describe('/cuenta · cliente y casos que NO son administrador', () => {
  test('con role = customer no hay enlace al backoffice ni ningún href a /admin ni la palabra «backoffice» en el HTML', async () => {
    installBackend({ role: 'customer' });
    const { html, doc } = await cuenta();
    expect(link(doc)).toBeUndefined();
    expect(toAdmin(doc)).toHaveLength(NONE);
    expect(html.toLowerCase()).not.toContain('backoffice');
    expect(html).not.toContain('href="/admin');
  });

  test.each(NOT_ADMIN_ROLES)('role %j (distinto de «admin» exacto) → no hay enlace', async (role) => {
    installBackend({ role: role as string });
    const { doc, res } = await cuenta();
    expect(res.status).toBe(HTTP.OK);
    expect(link(doc)).toBeUndefined();
    expect(toAdmin(doc)).toHaveLength(NONE);
  });

  test('un token que AFIRMA ser administrador no basta: si el backend dice customer, no hay enlace', async () => {
    installBackend({ role: 'customer' });
    const { doc } = await cuenta({ session: { ...SESSION, accessToken: CLAIMS_ADMIN } });
    expect(link(doc)).toBeUndefined();
    expect(toAdmin(doc)).toHaveLength(NONE);
  });

  test('un campo `role: admin` en la sesión local o en la URL no basta: ?role=admin&admin=1 no muestra el enlace', async () => {
    installBackend({ role: 'customer' });
    const { doc } = await cuenta({ query: '?role=admin&admin=1&backoffice=1', session: { ...SESSION, role: 'admin', isAdmin: true } });
    expect(link(doc)).toBeUndefined();
  });

  test('si el perfil no carga (503 o red caída) no hay enlace: sin datos del backend no se asume ningún rol', async () => {
    installBackend({}, () => json({ error: { code: 'internal_error', message: 'x', details: null } }, HTTP.UNAVAILABLE));
    const failed = await cuenta();
    expect(failed.res.status).toBe(HTTP.UNAVAILABLE);
    expect(link(failed.doc)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const net = await cuenta();
    expect(link(net.doc)).toBeUndefined();
    expect(toAdmin(net.doc)).toHaveLength(NONE);
  });

  test('un 200 con un perfil sin role (forma inesperada) no muestra el enlace ni rompe la página', async () => {
    const { role: _drop, ...noRole } = profile();
    vi.stubGlobal('fetch', vi.fn(async () => json(noRole)));
    const { res, doc } = await cuenta();
    expect(res.status).toBe(HTTP.OK);
    expect(link(doc)).toBeUndefined();
  });

  test('sin sesión (red de seguridad): redirige al ingreso y no hay enlace ni llamadas', async () => {
    const be = installBackend({ role: 'admin' });
    const { res } = await cuenta({ session: null });
    expect([HTTP.FOUND, HTTP.SEE_OTHER]).toContain(res.status);
    expect(be.calls).toHaveLength(NONE);
  });
});
