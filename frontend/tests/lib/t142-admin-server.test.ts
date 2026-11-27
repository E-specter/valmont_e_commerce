import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../src/lib/api/http';
import { adminErrorResponse, checkAdminOrigin, isUuid, requireAdmin, seeOther } from '../../src/lib/server/admin';
import {
  API, BEARER, ST, inSequence, NOT_FOUND_PATH, NO_PERMISSION_PATH, ORIGIN, UNAVAILABLE_PATH, astroFake, json, meAs, meBackend, profile,
} from '../helpers/t142';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-142 · contrato 3.6 (lib/server/admin.ts): requireAdmin, adminErrorResponse, checkAdminOrigin, seeOther e isUuid.
// Astro y `fetch` simulados; cada rama. La autorización real es del backend: aquí se prueba que la guardia nunca da acceso por error.
const NONE = 0;
const ONE = 1;
const FOUND = ST.FOUND;
const SEE_OTHER = ST.SEE_OTHER;
const FORBIDDEN = ST.FORBIDDEN;
const SERVER_ERRORS = [ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE, ST.GATEWAY_TIMEOUT];
const OTHER_CLIENT_ERRORS = [ST.BAD_REQUEST, ST.NOT_FOUND, ST.METHOD_NOT_ALLOWED, ST.CONFLICT, ST.UNPROCESSABLE, ST.TOO_MANY];
const NO_STORE = 'private, no-store';
const SB_COOKIES = ['sb-127-auth-token', 'sb-127-auth-token.1'];
const UNAUTHENTICATED = { error: { code: 'unauthenticated', message: 'Sesión no válida.', details: null } };
const FORBIDDEN_BODY = { error: { code: 'forbidden', message: 'Sin permiso.', details: null } };
const ADMIN_TARGETS = [NO_PERMISSION_PATH, UNAVAILABLE_PATH];
const LEAKS = ['Ana Torres', 'ana.torres', BEARER, 'api.test', 'role'];

afterEach(() => vi.unstubAllGlobals());

const loginFor = (path: string): string => `/ingresar?next=${encodeURIComponent(path)}`;
const body = (r: Response): Promise<string> => r.clone().text();

describe('requireAdmin · perfil de administrador', () => {
  test('GET /identity/me una sola vez, con el Bearer de la sesión, y devuelve { ok: true, ctx } con el perfil', async () => {
    const be = meAs('admin');
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.ctx.profile.role).toBe('admin');
    expect(be.calls).toHaveLength(ONE);
    expect(be.calls[NONE]).toMatchObject({ method: 'GET', url: API, auth: `Bearer ${BEARER}` });
    expect(f.rewrite).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  test('ctx.api es un transporte que lleva el mismo Bearer (las páginas lo usan para el resto de llamadas)', async () => {
    const be = meAs('admin');
    const gate = await requireAdmin(astroFake().astro);
    if (!gate.ok) throw new Error('debía ser administrador');
    be.calls.length = NONE;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      be.calls.push({ method: init?.method ?? 'GET', url: String(input), auth: new Headers(init?.headers).get('authorization'), accept: null });
      return json({ ok: true });
    }));
    await gate.ctx.api({ method: 'GET', path: '/orders/admin', query: { page_size: 5 } });
    expect(be.calls).toHaveLength(ONE);
    expect(be.calls[NONE].url).toBe('http://api.test:8000/api/v1/orders/admin?page_size=5');
    expect(be.calls[NONE].auth).toBe(`Bearer ${BEARER}`);
  });
});

describe('requireAdmin · quien no es administrador', () => {
  test('perfil customer → rewrite("/admin/sin-permiso") con estado 403, sin ctx ni datos del perfil', async () => {
    meAs('customer');
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(f.rewrite).toHaveBeenCalledTimes(ONE);
    expect(f.rewrite).toHaveBeenCalledWith(NO_PERMISSION_PATH);
    expect(gate.response.status).toBe(FORBIDDEN);
    expect(gate).not.toHaveProperty('ctx');
    const html = await body(gate.response);
    LEAKS.forEach((leak) => expect(html).not.toContain(leak));
    expect(f.signOut).not.toHaveBeenCalled(); // el cliente sigue con su sesión
  });

  // El rol se compara de forma estricta: un texto distinto de «admin» (mayúsculas, espacios, vacío) es «Sin permiso» (403).
  test.each(['Admin', 'ADMIN', 'administrator', 'superadmin', ' admin', 'admin ', 'admin\n', '', 'customer'])('role %j → «Sin permiso» (403)', async (role) => {
    meAs(role);
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(FORBIDDEN);
    expect(f.rewrite).toHaveBeenCalledWith(NO_PERMISSION_PATH);
  });

  // Un role que no es texto es una forma inesperada del servicio: «no disponible» (503), nunca un acceso.
  test.each([null, undefined, 1, true, ['admin'], { role: 'admin' }])('role no textual %j → «no disponible» (503), nunca ok', async (role) => {
    meAs(role);
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(ST.UNAVAILABLE);
    expect(f.rewrite).toHaveBeenCalledWith(UNAVAILABLE_PATH);
  });

  test('respuesta 200 sin campo role → no es administrador', async () => {
    const { role: _drop, ...noRole } = profile();
    meBackend(() => json(noRole));
    const f = astroFake();
    expect((await requireAdmin(f.astro)).ok).toBe(false);
    expect(f.rewrite).toHaveBeenCalledWith(UNAVAILABLE_PATH);
  });

  test('cuerpo 200 que no es JSON, ni un perfil (arreglo, cadena, número) → nunca ok', async () => {
    const makes = [() => new Response('<html>hola</html>', { status: ST.OK }), () => json([]), () => json('admin'), () => json(ST.OK)];
    const oks = await inSequence(makes, async (make) => {
      meBackend(make);
      return (await requireAdmin(astroFake().astro)).ok;
    });
    expect(oks).toEqual(makes.map(() => false));
  });

  test('cuerpo 200 con JSON `null` → falla cerrado y sin excepción: «no disponible» (503), nunca un 500 de la página', async () => {
    meBackend(() => json(null));
    const f = astroFake();
    const gate = await requireAdmin(f.astro).catch((e: unknown) => e);
    expect(gate, 'requireAdmin lanzó en vez de responder').not.toBeInstanceOf(Error);
    expect((gate as { ok: boolean }).ok).toBe(false);
    expect(f.rewrite).toHaveBeenCalledWith(UNAVAILABLE_PATH);
  });

  test('/me con 403 (rol retirado o backend estricto) → "Sin permiso" 403, sin cerrar la sesión', async () => {
    meBackend(() => json(FORBIDDEN_BODY, FORBIDDEN));
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(f.rewrite).toHaveBeenCalledWith(NO_PERMISSION_PATH);
    expect(gate.response.status).toBe(FORBIDDEN);
    expect(f.signOut).not.toHaveBeenCalled();
  });

  test.each(OTHER_CLIENT_ERRORS)('/me con %i → nunca da acceso y no filtra datos', async (status) => {
    meBackend(() => json({ error: { code: 'x', message: 'Datos internos: Ana Torres', details: { role: 'admin' } } }, status));
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    const html = gate.ok ? '' : await body(gate.response);
    ['Ana Torres', 'Datos internos', BEARER].forEach((leak) => expect(html).not.toContain(leak));
  });
});

describe('requireAdmin · sesión caducada (401)', () => {
  test('401 → cierra la sesión local, borra las cookies sb-* (y solo ellas) y responde 302 al ingreso con next', async () => {
    meBackend(() => json(UNAUTHENTICATED, ST.UNAUTHORIZED));
    const f = astroFake({ path: '/admin/pedidos?status=pagado' });
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.response.status).toBe(FOUND);
    expect(gate.response.headers.get('location')).toBe(loginFor('/admin/pedidos?status=pagado'));
    expect(f.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(f.cookies.deleted()).toEqual([...SB_COOKIES].sort());
    expect(f.rewrite).not.toHaveBeenCalled(); // sin bucle: no se reescribe a otra página protegida
    const cache = gate.response.headers.get('cache-control');
    if (cache !== null) expect(cache).toContain('no-store');
  });

  test('401 sin red en signOut sigue cerrando: las cookies se borran igualmente', async () => {
    meBackend(() => json(UNAUTHENTICATED, ST.UNAUTHORIZED));
    const f = astroFake();
    f.signOut.mockRejectedValue(new Error('sin red'));
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(FOUND);
    expect(f.cookies.deleted()).toEqual([...SB_COOKIES].sort());
  });

  test('sin sesión en locals (el middleware ya debió redirigir) → nunca ok: 302 al ingreso', async () => {
    meBackend(() => json(UNAUTHENTICATED, ST.UNAUTHORIZED));
    const f = astroFake({ session: null });
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(FOUND);
      expect(gate.response.headers.get('location')).toBe(loginFor('/admin'));
    }
  });
});

describe('requireAdmin · backend caído', () => {
  test.each(SERVER_ERRORS)('/me con %i → rewrite("/admin/no-disponible") con estado 503, sin cerrar la sesión', async (status) => {
    meBackend(() => json({ error: { code: 'internal_error', message: 'Error interno.', details: null } }, status));
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(f.rewrite).toHaveBeenCalledTimes(ONE);
    expect(f.rewrite).toHaveBeenCalledWith(UNAVAILABLE_PATH);
    expect(gate.response.status).toBe(ST.UNAVAILABLE);
    expect(f.signOut).not.toHaveBeenCalled();
  });

  test('sin red (fetch rechaza) → 503 no-disponible, sin trazas', async () => {
    meBackend(() => Promise.reject(new TypeError('fetch failed: ECONNREFUSED 10.0.0.1')));
    const f = astroFake();
    const gate = await requireAdmin(f.astro);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(f.rewrite).toHaveBeenCalledWith(UNAVAILABLE_PATH);
    expect(gate.response.status).toBe(ST.UNAVAILABLE);
    const html = await body(gate.response);
    ['ECONNREFUSED', 'fetch failed', 'TypeError', '10.0.0.1'].forEach((leak) => expect(html).not.toContain(leak));
  });

  test('ninguna rama reescribe a una ruta que vuelva a exigir administrador (sin bucle)', async () => {
    const setups = [() => meAs('customer'), () => meBackend(() => json(FORBIDDEN_BODY, FORBIDDEN)), () => meBackend(() => json({}, ST.UNAVAILABLE))];
    const targets = await inSequence(setups, async (setup) => {
      setup();
      const f = astroFake();
      await requireAdmin(f.astro);
      return f.rewrite.mock.calls.map(([path]) => path);
    });
    expect([...new Set(targets.flat())].sort()).toEqual([...ADMIN_TARGETS].sort());
  });
});

describe('adminErrorResponse', () => {
  const fails = (status: number, code = 'x', details: unknown = null) => new ApiError(status, code, 'mensaje técnico en inglés', details);

  test('ApiError 401 → cierra la sesión local, borra las cookies sb-* y 302 al ingreso con next', async () => {
    const f = astroFake({ path: '/admin/pedidos/abc?volver=status%3Dpagado' });
    const res = await adminErrorResponse(f.astro, fails(ST.UNAUTHORIZED, 'unauthenticated'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(FOUND);
    expect(res!.headers.get('location')).toBe(loginFor('/admin/pedidos/abc?volver=status%3Dpagado'));
    expect(f.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(f.cookies.deleted()).toEqual([...SB_COOKIES].sort());
  });

  test('ApiError 403 → rewrite("/admin/sin-permiso") (403); no cierra la sesión', async () => {
    const f = astroFake();
    const res = await adminErrorResponse(f.astro, fails(ST.FORBIDDEN, 'forbidden'));
    expect(f.rewrite).toHaveBeenCalledWith(NO_PERMISSION_PATH);
    expect(res!.status).toBe(FORBIDDEN);
    expect(f.signOut).not.toHaveBeenCalled();
  });

  test('ApiError 404 → rewrite("/404")', async () => {
    const f = astroFake();
    const res = await adminErrorResponse(f.astro, fails(ST.NOT_FOUND, 'not_found'));
    expect(f.rewrite).toHaveBeenCalledWith(NOT_FOUND_PATH);
    expect(res!.status).toBe(ST.NOT_FOUND);
  });

  test.each([ST.CONFLICT, ST.UNPROCESSABLE, ST.PAYLOAD_TOO_LARGE, ST.UNSUPPORTED_MEDIA, ST.TOO_MANY, ST.SERVER_ERROR, ST.BAD_GATEWAY, ST.UNAVAILABLE, ST.GATEWAY_TIMEOUT, NONE])('ApiError %i → null (lo trata la página)', async (status) => {
    const f = astroFake();
    expect(await adminErrorResponse(f.astro, fails(status, status === NONE ? 'network' : 'x'))).toBeNull();
    expect(f.rewrite).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });

  test.each([
    ['Error', new Error('boom')],
    ['TypeError', new TypeError('x')],
    ['cadena', 'forbidden'],
    ['null', null],
    ['undefined', undefined],
    ['número', ST.FORBIDDEN],
    ['objeto con status 401 (no es ApiError)', { status: ST.UNAUTHORIZED, code: 'unauthenticated' }],
    ['objeto con status 403', { status: ST.FORBIDDEN }],
    ['Response', new Response('x', { status: ST.FORBIDDEN })],
  ])('error que no es ApiError (%s) → null', async (_label, e) => {
    const f = astroFake();
    expect(await adminErrorResponse(f.astro, e)).toBeNull();
    expect(f.rewrite).not.toHaveBeenCalled();
    expect(f.signOut).not.toHaveBeenCalled();
  });
});

describe('checkAdminOrigin (RT-B1)', () => {
  const url = new URL(`${ORIGIN}/admin/pedidos/x`);
  const req = (headers: Record<string, string> = {}) => new Request(url, { method: 'POST', headers });

  test('Origin igual a url.origin → true', () => {
    expect(checkAdminOrigin(req({ origin: ORIGIN }), url)).toBe(true);
  });

  test('sin Origin → false (aunque haya Referer del propio sitio)', () => {
    expect(checkAdminOrigin(req(), url)).toBe(false);
    expect(checkAdminOrigin(req({ referer: `${ORIGIN}/admin` }), url)).toBe(false);
  });

  test.each([
    'null', '', 'https://evil.test', 'http://localhost:4322', 'http://localhost:43210', 'https://localhost:4321', 'http://localhost',
    'http://localhost:4321.evil.test', 'http://evil.test:4321', 'http://localhost:4321/', 'http://localhost:4321/admin',
    'http://127.0.0.1:4321', 'http://localhost:4321@evil.test',
  ])('Origin ajeno o con forma distinta %j → false', (origin) => {
    expect(checkAdminOrigin(req({ origin }), url)).toBe(false);
  });

  test('usa el origen de la URL recibida, no uno fijo', () => {
    const other = new URL('https://tienda.example/admin');
    expect(checkAdminOrigin(new Request(other, { method: 'POST', headers: { origin: 'https://tienda.example' } }), other)).toBe(true);
    expect(checkAdminOrigin(new Request(other, { method: 'POST', headers: { origin: ORIGIN } }), other)).toBe(false);
  });
});

describe('seeOther', () => {
  test('303 con Location y Cache-Control private, no-store, sin cuerpo', async () => {
    const res = seeOther('/admin/pedidos?status=pagado#o-1');
    expect(res.status).toBe(SEE_OTHER);
    expect(res.headers.get('location')).toBe('/admin/pedidos?status=pagado#o-1');
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(await res.text()).toBe('');
  });
});

describe('isUuid', () => {
  test.each([
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', '3F1C2A9E-5B7D-4C1E-9A10-0123456789AB', '3f1c2a9e-5B7d-4C1e-9a10-0123456789aB',
    '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('válido %j', (s) => expect(isUuid(s)).toBe(true));

  test.each([
    '', ' ', 'abc', 'null', 'undefined', '123', '3f1c2a9e5b7d4c1e9a100123456789ab', // sin guiones
    ' 3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab ', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab\n', '\n3f1c2a9e-5b7d-4c1e-9a10-0123456789ab',
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789a', '3f1c2a9e-5b7d-4c1e-9a10-0123456789abc', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ag',
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab-', '{3f1c2a9e-5b7d-4c1e-9a10-0123456789ab}', 'urn:uuid:3f1c2a9e-5b7d-4c1e-9a10-0123456789ab',
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab?x=1', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab/../x', '../3f1c2a9e-5b7d-4c1e-9a10-0123456789ab',
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab\n3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab\u0000',
    '3f1c2a9e-5b7d-4c1e-9a10-01234567-9ab', '3f1c2a9e_5b7d_4c1e_9a10_0123456789ab', '١٢٣c2a9e-5b7d-4c1e-9a10-0123456789ab',
    '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab%00', "'; DROP TABLE orders; --",
  ])('inválido %j', (s) => expect(isUuid(s)).toBe(false));
});
