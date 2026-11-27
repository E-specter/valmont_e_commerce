import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { BEARER_VALUE, FakeServer, ORIGIN, fakeCookies } from '../helpers/t126';
import { ADULT_BIRTH, FAKE_NAME, MALFORMED_DATES, shiftYears } from '../helpers/t128';

// T-131 · `GET /auth/callback` con fecha de nacimiento (D-045 P-IDENTITY-6; identity SPEC §13.9 "Tránsito por Supabase Auth").
// El callback guarda la fecha con el PATCH de mejor esfuerzo y después la borra de user_metadata con updateUser.
// Complementa tests/lib/auth-routes.test.ts (T-126), que sigue en verde sin cambios.
const h = vi.hoisted(() => ({ api: 'http://127.0.0.1:1' }));
vi.mock('astro:env/server', () => ({
  get API_BASE_URL() {
    return h.api;
  },
  SUPABASE_URL: 'http://sb.test:54321',
  SUPABASE_ANON_KEY: 'anon-value-for-tests',
}));

const backend = new FakeServer();
const ONE = 1;
const TWO = 2;
const NONE = 0;
const ADULT_AGE = 18;
const MAX_AGE = 120;
const TODAY_YEAR = new Date().getUTCFullYear();
const PRIVACY = '2026-10';
const JSON_HEADERS = { 'content-type': 'application/json' };
const ERROR_BODY = '{"error":{"code":"x","message":"m","details":null}}';

const calls: string[] = [];
beforeAll(async () => {
  await backend.start();
  h.api = backend.base;
});
afterAll(() => backend.stop());
beforeEach(() => {
  backend.reset();
  calls.length = NONE;
  backend.reply = () => {
    calls.push('patch');
    return { status: 200, headers: JSON_HEADERS, body: '{}' };
  };
});
afterEach(() => vi.restoreAllMocks());

type Meta = Record<string, unknown>;
const sessionWith = (meta: Meta | undefined) => ({ access_token: BEARER_VALUE, user: { user_metadata: meta } });
const full = (extra: Meta = {}): Meta => ({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY, birth_date: ADULT_BIRTH, ...extra });

function supabase(meta: Meta | undefined, opts: { updateUser?: () => Promise<unknown> } = {}) {
  const exchangeCodeForSession = vi.fn(async () => ({ data: { session: sessionWith(meta) }, error: null }));
  const updateUser = vi.fn(async (..._a: unknown[]) => {
    calls.push('updateUser');
    return opts.updateUser ? opts.updateUser() : { data: {}, error: null };
  });
  const signOut = vi.fn(async () => ({ error: null }));
  return { auth: { exchangeCodeForSession, updateUser, signOut }, exchangeCodeForSession, updateUser, signOut };
}
type Sb = ReturnType<typeof supabase>;

async function callback(meta: Meta | undefined, query = '?code=abc&next=/cuenta', sb: Sb = supabase(meta)) {
  const { GET } = await import('../../src/pages/auth/callback');
  const url = new URL(`${ORIGIN}/auth/callback${query}`);
  const res = (await GET({ url, locals: { supabase: sb, session: null }, request: new Request(url), cookies: fakeCookies() } as never)) as Response;
  return { res, sb, location: res.headers.get('location') };
}
const patchBody = (i = NONE): Record<string, unknown> => JSON.parse(backend.seen[i].body);

describe('callback · el PATCH lleva birth_date solo si es una fecha válida', () => {
  test('con nombre, versión y fecha: UN PATCH con los tres campos exactos y el Bearer de la sesión', async () => {
    const { location } = await callback(full());
    expect(location).toBe('/cuenta');
    expect(backend.seen).toHaveLength(ONE);
    const [call] = backend.seen;
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('/api/v1/identity/me');
    expect(call.headers.authorization).toBe(`Bearer ${BEARER_VALUE}`);
    expect(JSON.parse(call.body)).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY, birth_date: ADULT_BIRTH });
  });

  test('la fecha se envía tal cual (no se reformatea ni se convierte a ISO con hora)', async () => {
    await callback(full({ birth_date: '1985-12-31' }));
    expect(patchBody().birth_date).toBe('1985-12-31');
  });

  test('un 29 de febrero real (2004-02-29) es válido y se envía', async () => {
    await callback(full({ birth_date: '2004-02-29' }));
    expect(patchBody().birth_date).toBe('2004-02-29');
  });

  test('no se reenvían otros campos de user_metadata (rol, banderas, ids ajenos)', async () => {
    await callback(full({ role: 'admin', is_admin: true, customer_id: 'otro', email: 'x@example.com', user_id: 'otro' }));
    expect(Object.keys(patchBody()).sort()).toEqual(['accept_privacy_version', 'birth_date', 'full_name']);
  });

  test.each(MALFORMED_DATES)('fecha %s (%j) → el PATCH sale SIN birth_date y conserva nombre y versión', async (_n, birth_date) => {
    const { location } = await callback(full({ birth_date }));
    expect(location).toBe('/cuenta');
    expect(backend.seen).toHaveLength(ONE);
    expect(patchBody()).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY });
  });

  test.each([
    ['un número', 19_900_517],
    ['un objeto', { a: 1 }],
    ['un arreglo', [ADULT_BIRTH]],
    ['un booleano', true],
    ['nulo', null],
  ])('birth_date que es %s → el PATCH sale sin birth_date', async (_n, birth_date) => {
    await callback(full({ birth_date }));
    expect(backend.seen).toHaveLength(ONE);
    expect(patchBody()).not.toHaveProperty('birth_date');
  });

  test('con espacios sobrantes, ` 1990-05-17` no se envía sucio (se recorta o se omite)', async () => {
    await callback(full({ birth_date: ` ${ADULT_BIRTH} ` }));
    const sent = patchBody().birth_date;
    expect(sent === undefined || sent === ADULT_BIRTH).toBe(true);
  });

  test.each([
    ['futura', '2999-01-01'],
    ['un menor de 17', shiftYears(`${TODAY_YEAR}-06-15`, -(ADULT_AGE - ONE))],
    ['de 121 años', shiftYears(`${TODAY_YEAR}-01-01`, -(MAX_AGE + TWO))],
  ])('fecha fuera de rango (%s): el flujo sigue, nada se rompe y la fecha se borra de los metadatos', async (_n, birth_date) => {
    const { res, location, sb } = await callback(full({ birth_date }));
    expect(res.status).toBe(302);
    expect(location).toBe('/cuenta');
    expect(backend.seen.length).toBeLessThanOrEqual(TWO);
    expect(sb.updateUser).toHaveBeenCalledWith({ data: { birth_date: null } });
  });

  test('sin birth_date en los metadatos: el PATCH es el de T-126 (solo dos campos) y NO se llama a updateUser', async () => {
    const { sb } = await callback(full({ birth_date: undefined }));
    expect(patchBody()).toEqual({ full_name: FAKE_NAME, accept_privacy_version: PRIVACY });
    expect(sb.updateUser).not.toHaveBeenCalled();
  });

  test('sin metadatos en absoluto: ni PATCH ni updateUser', async () => {
    const { location, sb } = await callback(undefined);
    expect(location).toBe('/cuenta');
    expect(backend.seen).toHaveLength(NONE);
    expect(sb.updateUser).not.toHaveBeenCalled();
  });
});

describe('callback · la fecha se borra de user_metadata DESPUÉS del PATCH', () => {
  test('updateUser({ data: { birth_date: null } }) exactamente, una sola vez, tras el PATCH', async () => {
    const { sb } = await callback(full());
    expect(sb.updateUser).toHaveBeenCalledTimes(ONE);
    expect(sb.updateUser).toHaveBeenCalledWith({ data: { birth_date: null } });
    expect(calls).toEqual(['patch', 'updateUser']);
  });

  test('solo se toca birth_date: no se borran nombre ni versión de los metadatos', async () => {
    const { sb } = await callback(full());
    const [arg] = sb.updateUser.mock.calls[NONE] as [{ data: Record<string, unknown> }];
    expect(Object.keys(arg.data)).toEqual(['birth_date']);
    expect(arg.data.birth_date).toBeNull();
  });

  test('el borrado no depende de que el PATCH haya funcionado: se llama también con 409, 422, 401, 500 y 503', async () => {
    const outcomes = [409, 422, 401, 500, 503];
    for (const status of outcomes) {
      calls.length = NONE;
      backend.reply = () => {
        calls.push('patch');
        return { status, headers: JSON_HEADERS, body: ERROR_BODY };
      };
      const { res, sb, location } = await callback(full(), '?code=abc&next=/checkout');
      expect(res.status, String(status)).toBe(302);
      expect(location, String(status)).toBe('/checkout');
      expect(sb.updateUser, String(status)).toHaveBeenCalledWith({ data: { birth_date: null } });
      expect(calls[calls.length - ONE], String(status)).toBe('updateUser');
    }
  });

  test('backend caído: el usuario entra y la fecha se borra igualmente', async () => {
    const dead = await new FakeServer().start();
    const base = dead.base;
    await dead.stop();
    h.api = base;
    try {
      const { location, sb } = await callback(full());
      expect(location).toBe('/cuenta');
      expect(sb.updateUser).toHaveBeenCalledWith({ data: { birth_date: null } });
    } finally {
      h.api = backend.base;
    }
  });

  test('con fecha pero sin nombre/versión: no rompe, la redirección sigue y la fecha se borra', async () => {
    const { location, sb } = await callback({ birth_date: ADULT_BIRTH });
    expect(location).toBe('/cuenta');
    expect(sb.updateUser).toHaveBeenCalledWith({ data: { birth_date: null } });
  });

  test('si updateUser devuelve error, el usuario entra igualmente (no es un fallo de confirmación)', async () => {
    const { location } = await callback(full(), '?code=abc&next=/cuenta', supabase(full(), { updateUser: async () => ({ data: null, error: { message: 'boom' } }) }));
    expect(location).toBe('/cuenta');
  });

  test('si updateUser LANZA, el usuario entra igualmente y no se muestra error de confirmación', async () => {
    const sb = supabase(full(), {
      updateUser: async () => {
        throw new Error(`red caída con ${ADULT_BIRTH}`);
      },
    });
    const { res, location } = await callback(full(), '?code=abc&next=/cuenta', sb);
    expect(res.status).toBe(302);
    expect(location).toBe('/cuenta');
    expect(location).not.toContain('error');
  });

  test('un código inválido no toca nada: sin PATCH ni updateUser', async () => {
    const sb = supabase(full());
    sb.exchangeCodeForSession.mockResolvedValueOnce({ data: { session: null as never }, error: { message: 'x' } as never });
    const { location } = await callback(full(), '?code=abc', sb);
    expect(location).toBe('/ingresar?error=confirmacion');
    expect(backend.seen).toHaveLength(NONE);
    expect(sb.updateUser).not.toHaveBeenCalled();
  });
});

describe('callback · la fecha no sale a ningún sitio', () => {
  test('ni en la redirección, ni en la cabecera, ni en el cuerpo', async () => {
    const { res, location } = await callback(full());
    expect(location).not.toContain(ADULT_BIRTH);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(ADULT_BIRTH);
    expect(await res.text()).not.toContain(ADULT_BIRTH);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('nada en consola (ni log, info, warn, error, debug, stdout ni stderr) en el éxito ni con el backend fallando', async () => {
    const out: string[] = [];
    const push = (...args: unknown[]): void => void out.push(args.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(push));
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (out.push(String(c)), true));
    await callback(full());
    backend.reply = { status: 409, headers: JSON_HEADERS, body: ERROR_BODY };
    await callback(full());
    backend.reply = { status: 422, headers: JSON_HEADERS, body: ERROR_BODY };
    await callback(full());
    await callback(full(), '?code=abc', supabase(full(), { updateUser: async () => { throw new Error(`x ${ADULT_BIRTH}`); } }));
    spies.forEach((s) => expect(s).not.toHaveBeenCalled());
    expect(out.join('\n')).not.toContain(ADULT_BIRTH);
    expect(out.join('\n')).not.toContain(FAKE_NAME);
  });

  test('la fecha solo se envía al backend de Valmont (una única petición, a /identity/me)', async () => {
    await callback(full());
    expect(backend.seen.map((s) => s.url)).toEqual(['/api/v1/identity/me']);
  });

  test('un next hostil con fecha sigue cayendo en /cuenta', async () => {
    expect((await callback(full(), '?code=abc&next=//evil.com')).location).toBe('/cuenta');
    expect((await callback(full(), '?code=abc&next=/checkout')).location).toBe('/checkout');
  });

  test('el código se canjea una sola vez y no se cierra la sesión', async () => {
    const { sb } = await callback(full());
    expect(sb.exchangeCodeForSession).toHaveBeenCalledTimes(ONE);
    expect(sb.signOut).not.toHaveBeenCalled();
  });
});
