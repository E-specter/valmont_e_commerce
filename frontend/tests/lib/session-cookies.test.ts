import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeCookies } from '../helpers/t126';

// T-126 · cookies de sesión (D-025, D-041 P-5): atributos forzados, lectura de la petición, hasAuthCookie, resolveSession y endSession.
const h = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  env: { url: 'http://sb.test:54321' as string | undefined, anon: 'anon-value-for-tests' as string | undefined },
}));
vi.mock('astro:env/server', () => ({
  API_BASE_URL: 'http://api.test:8000',
  get SUPABASE_URL() {
    return h.env.url;
  },
  get SUPABASE_ANON_KEY() {
    return h.env.anon;
  },
}));
vi.mock('@supabase/ssr', async (orig) => ({ ...(await orig<typeof import('@supabase/ssr')>()), createServerClient: h.createServerClient }));

type SetItem = { name: string; value: string; options?: Record<string, unknown> };
type Opts = { cookieOptions: Record<string, unknown>; cookies: { getAll: () => { name: string; value: string }[]; setAll: (l: SetItem[]) => void } };

const req = (cookie?: string) => new Request('http://localhost:4321/x', { headers: cookie ? { cookie } : {} });
const optsOf = (): Opts => h.createServerClient.mock.calls.at(-1)![2] as Opts;

beforeEach(() => {
  h.createServerClient.mockReset().mockReturnValue({ auth: {} });
  h.env.url = 'http://sb.test:54321';
  h.env.anon = 'anon-value-for-tests';
});

describe('createSupabaseServer · atributos de la cookie', () => {
  test('usa la URL y la clave anónima del entorno de servidor', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    createSupabaseServer({ request: req(), cookies: fakeCookies() as never });
    expect(h.createServerClient).toHaveBeenCalledTimes(1);
    expect(h.createServerClient.mock.calls[0].slice(0, 2)).toEqual(['http://sb.test:54321', 'anon-value-for-tests']);
  });

  test('cookieOptions: httpOnly, SameSite=Lax, path=/ y Secure solo en producción (en pruebas no)', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    createSupabaseServer({ request: req(), cookies: fakeCookies() as never });
    expect(optsOf().cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: false });
  });

  test('setAll fuerza httpOnly, SameSite=Lax y path=/ aunque la librería pida otra cosa', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    const cookies = fakeCookies();
    createSupabaseServer({ request: req(), cookies: cookies as never });
    optsOf().cookies.setAll([
      { name: 'sb-x-auth-token', value: 'v1', options: { httpOnly: false, sameSite: 'none', secure: false, path: '/otra', maxAge: 400 } },
      { name: 'sb-x-auth-token.1', value: 'v2', options: {} },
      { name: 'sb-x-auth-token-code-verifier', value: 'v3' },
    ]);
    expect(cookies.ops).toHaveLength(3);
    for (const op of cookies.ops) {
      expect(op.op).toBe('set');
      expect(op.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    }
    expect(cookies.ops[0].options).toMatchObject({ maxAge: 400 }); // lo demás de la librería se conserva (caducidad)
  });

  test('un borrado de la librería (maxAge 0) conserva la caducidad y los atributos de seguridad', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    const cookies = fakeCookies();
    createSupabaseServer({ request: req(), cookies: cookies as never });
    optsOf().cookies.setAll([{ name: 'sb-x-auth-token', value: '', options: { maxAge: 0, httpOnly: false } }]);
    expect(cookies.ops[0].options).toMatchObject({ maxAge: 0, httpOnly: true, sameSite: 'lax', path: '/' });
  });

  test('getAll devuelve las cookies de la petición (valores con "=" y trozos incluidos)', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    createSupabaseServer({ request: req('theme=dark; sb-x-auth-token.0=base64-AAA=; sb-x-auth-token.1=BBB'), cookies: fakeCookies() as never });
    expect(optsOf().cookies.getAll()).toEqual(
      expect.arrayContaining([
        { name: 'theme', value: 'dark' },
        { name: 'sb-x-auth-token.0', value: 'base64-AAA=' },
        { name: 'sb-x-auth-token.1', value: 'BBB' },
      ]),
    );
  });

  test('getAll sin cabecera Cookie → lista vacía', async () => {
    const { createSupabaseServer } = await import('../../src/lib/server/supabase');
    createSupabaseServer({ request: req(), cookies: fakeCookies() as never });
    expect(optsOf().cookies.getAll()).toEqual([]);
  });

  test.each([
    ['sin clave anónima', { anon: undefined }],
    ['clave anónima vacía', { anon: '' }],
    ['sin URL', { url: undefined }],
  ])('configuración incompleta (%s) → AuthConfigError con mensaje genérico', async (_n, patch) => {
    Object.assign(h.env, patch);
    const { AuthConfigError, createSupabaseServer } = await import('../../src/lib/server/supabase');
    let err: unknown;
    try {
      createSupabaseServer({ request: req(), cookies: fakeCookies() as never });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthConfigError);
    expect(String((err as Error).message)).not.toMatch(/SUPABASE|KEY|ANON|URL|env/i);
    expect(h.createServerClient).not.toHaveBeenCalled();
  });
});

describe('createSupabaseServer · producción', () => {
  test('con import.meta.env.PROD la cookie lleva Secure', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    try {
      const { createSupabaseServer } = await import('../../src/lib/server/supabase');
      const cookies = fakeCookies();
      createSupabaseServer({ request: req(), cookies: cookies as never });
      expect(optsOf().cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
      optsOf().cookies.setAll([{ name: 'sb-x-auth-token', value: 'v', options: { secure: false } }]);
      expect(cookies.ops[0].options).toMatchObject({ secure: true, httpOnly: true });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('hasAuthCookie', () => {
  test.each([
    ['sb-abc-auth-token=x', true],
    ['a=1; sb-abc-auth-token.0=x; sb-abc-auth-token.1=y', true],
    ['theme=dark; sb-127-auth-token=base64-eyJ', true],
    ['sb-abc-auth-token-code-verifier=x', true],
    ['', false],
    ['theme=dark', false],
    ['sb-abc-other=x', false],
    ['xsb-abc-auth-token=x', false],
    ['a=sb-abc-auth-token', false],
  ])('%j → %s', async (cookie, expected) => {
    const { hasAuthCookie } = await import('../../src/lib/server/supabase');
    expect(hasAuthCookie(req(cookie || undefined))).toBe(expected);
  });
});

const T_ACCESS = 'access-value-for-tests-0001';
type Fn = ReturnType<typeof vi.fn>;
const fakeClient = (over: Partial<Record<'getClaims' | 'getSession' | 'signOut', Fn>> = {}) =>
  ({
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: 'u-1', email: 'a@example.com', exp: 4102444800 } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: T_ACCESS, expires_at: 4102444000 } } })),
      signOut: vi.fn(async () => ({ error: null })),
      ...over,
    },
  }) as never;

describe('resolveSession', () => {
  test('claims válidas → Session con userId, email, token de getSession y expiresAt de la caducidad', async () => {
    const { resolveSession } = await import('../../src/lib/server/session');
    expect(await resolveSession(fakeClient())).toEqual({ userId: 'u-1', email: 'a@example.com', accessToken: T_ACCESS, expiresAt: 4102444800 });
  });

  test.each([
    ['error de getClaims', { getClaims: vi.fn(async () => ({ data: null, error: new Error('x') })) }],
    ['sin claims', { getClaims: vi.fn(async () => ({ data: { claims: null }, error: null })) }],
    ['claims sin sub', { getClaims: vi.fn(async () => ({ data: { claims: { email: 'a@example.com' } }, error: null })) }],
    ['claims vacías', { getClaims: vi.fn(async () => ({ data: { claims: {} }, error: null })) }],
    ['getSession sin sesión', { getSession: vi.fn(async () => ({ data: { session: null } })) }],
    ['getSession sin token', { getSession: vi.fn(async () => ({ data: { session: { access_token: '' } } })) }],
  ])('%s → null', async (_n, over) => {
    const { resolveSession } = await import('../../src/lib/server/session');
    expect(await resolveSession(fakeClient(over))).toBeNull();
  });

  test('email que no es cadena → null en el campo; sin exp usa el de la sesión', async () => {
    const { resolveSession } = await import('../../src/lib/server/session');
    const s = await resolveSession(fakeClient({ getClaims: vi.fn(async () => ({ data: { claims: { sub: 'u-2', email: 42 } }, error: null })) }));
    expect(s).toMatchObject({ userId: 'u-2', email: null, expiresAt: 4102444000 });
  });

  test('nunca lee session.user (los datos de la cookie no son de fiar): un getter que lanza no se toca', async () => {
    const { resolveSession } = await import('../../src/lib/server/session');
    const session = {
      access_token: T_ACCESS,
      expires_at: 1,
      get user(): never {
        throw new Error('session.user leído');
      },
    };
    await expect(resolveSession(fakeClient({ getSession: vi.fn(async () => ({ data: { session } })) }))).resolves.toMatchObject({ accessToken: T_ACCESS });
  });

  test('no pide el token antes de validar: si getClaims falla, no se llama a getSession', async () => {
    const { resolveSession } = await import('../../src/lib/server/session');
    const getSession = vi.fn();
    await resolveSession(fakeClient({ getClaims: vi.fn(async () => ({ data: null, error: new Error('x') })), getSession }));
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe('apiFor', () => {
  test('crea un transporte con o sin sesión', async () => {
    const { apiFor } = await import('../../src/lib/server/session');
    expect(typeof apiFor({ session: null, supabase: {} as never })).toBe('function');
    expect(typeof apiFor({ session: { userId: 'u', email: null, accessToken: T_ACCESS, expiresAt: 1 }, supabase: {} as never })).toBe('function');
  });
});

describe('endSession', () => {
  test('signOut local y borra las cookies sb-*-auth-token (con trozos), nunca las ajenas', async () => {
    const { endSession } = await import('../../src/lib/server/session');
    const cookies = fakeCookies();
    const client = fakeClient();
    await endSession(client, cookies as never, req('theme=dark; sb-x-auth-token=a; sb-x-auth-token.0=b; sb-x-auth-token.1=c; sb-x-auth-token-code-verifier=d; session=s; sb-x-other=o'));
    expect((client as unknown as { auth: { signOut: Fn } }).auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookies.deleted()).toEqual(['sb-x-auth-token', 'sb-x-auth-token-code-verifier', 'sb-x-auth-token.0', 'sb-x-auth-token.1']);
    for (const op of cookies.ops) expect(op.options).toMatchObject({ path: '/' });
  });

  test('si signOut lanza (sin red), las cookies se borran igualmente y no propaga el error', async () => {
    const { endSession } = await import('../../src/lib/server/session');
    const cookies = fakeCookies();
    const signOut = vi.fn(async () => {
      throw new Error('red');
    });
    await expect(endSession(fakeClient({ signOut }), cookies as never, req('sb-x-auth-token=a'))).resolves.toBeUndefined();
    expect(cookies.deleted()).toEqual(['sb-x-auth-token']);
  });

  test('sin cabecera Cookie no borra nada', async () => {
    const { endSession } = await import('../../src/lib/server/session');
    const cookies = fakeCookies();
    await endSession(fakeClient(), cookies as never, req());
    expect(cookies.ops).toEqual([]);
  });
});
