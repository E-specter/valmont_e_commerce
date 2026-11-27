import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type Transport } from '../../src/lib/api/http';
import { getProfile, updateProfile, type Profile } from '../../src/lib/api/identity';
import { serverTransport } from '../../src/lib/api/server';
import { BEARER, BIRTH, detail, json, profile, validationError } from '../helpers/t129';
import { HTTP } from '../helpers/t127';

vi.mock('astro:env/server', () => ({ API_BASE_URL: 'http://api.test:8000' }));

// T-129 · lib/api/identity.ts (identity SPEC §7 y §13.7): contrato de getProfile/updateProfile con un transporte simulado
// y con el transporte real del servidor sobre un `fetch` falso. No hay red.
const ONE = 1;
const NONE = 0;
const ME = '/identity/me';
const CONFLICT = 409;
const ALLOWED_KEYS = ['full_name', 'phone', 'birth_date'];

type Req = Parameters<Transport>[0];
let seen: Req[];
let reply: () => unknown;
const transport: Transport = async <T>(req: Req): Promise<T> => {
  seen = [...seen, req];
  return reply() as T;
};
const lastBody = (): Record<string, unknown> => JSON.parse(JSON.stringify(seen.at(-ONE)?.body ?? null)) as Record<string, unknown>;

beforeEach(() => {
  seen = [];
  reply = () => profile();
});
afterEach(() => vi.unstubAllGlobals());

describe('getProfile', () => {
  test('GET /identity/me sin cuerpo, sin query y sin identificadores en la ruta', async () => {
    await getProfile(transport);
    expect(seen).toHaveLength(ONE);
    expect(seen[NONE]).toMatchObject({ method: 'GET', path: ME });
    expect(seen[NONE].body).toBeUndefined();
    expect(seen[NONE].query ?? {}).toEqual({});
  });

  test('devuelve el perfil tal cual, con birth_date null o con la fecha YYYY-MM-DD', async () => {
    reply = () => profile({ birth_date: null });
    const empty: Profile = await getProfile(transport);
    expect(empty.birth_date).toBeNull();
    reply = () => profile({ birth_date: BIRTH });
    expect((await getProfile(transport)).birth_date).toBe(BIRTH);
  });

  test('un ApiError del transporte (401, 503) se propaga sin envolver', async () => {
    const unauthenticated = new ApiError(HTTP.UNAUTHORIZED, 'unauthenticated', 'Sesión no válida.');
    reply = () => {
      throw unauthenticated;
    };
    await expect(getProfile(transport)).rejects.toBe(unauthenticated);
  });
});

describe('updateProfile · cuerpo mínimo', () => {
  test('PATCH /identity/me con solo los campos que se pasan', async () => {
    await updateProfile(transport, { full_name: 'Ana María Torres' });
    expect(seen[NONE]).toMatchObject({ method: 'PATCH', path: ME });
    expect(lastBody()).toEqual({ full_name: 'Ana María Torres' });
    await updateProfile(transport, { phone: '+51987654321' });
    expect(lastBody()).toEqual({ phone: '+51987654321' });
    await updateProfile(transport, { birth_date: BIRTH });
    expect(lastBody()).toEqual({ birth_date: BIRTH });
  });

  test('un campo undefined no viaja; varios campos viajan juntos en el mismo PATCH', async () => {
    await updateProfile(transport, { full_name: 'Ana', phone: undefined, birth_date: undefined });
    expect(lastBody()).toEqual({ full_name: 'Ana' });
    await updateProfile(transport, { full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH });
    expect(lastBody()).toEqual({ full_name: 'Ana', phone: '+51987654321', birth_date: BIRTH });
    expect(seen).toHaveLength(ONE + ONE);
  });

  test('null viaja como null (borra el nombre o el teléfono)', async () => {
    await updateProfile(transport, { full_name: null });
    expect(lastBody()).toEqual({ full_name: null });
    expect(Object.keys(lastBody())).toEqual(['full_name']);
    await updateProfile(transport, { phone: null });
    expect(lastBody()).toEqual({ phone: null });
    await updateProfile(transport, { full_name: null, phone: null });
    expect(lastBody()).toEqual({ full_name: null, phone: null });
  });

  test('nunca envía user_id, role ni otros campos fuera del contrato (aunque se los cuelen)', async () => {
    const sneaky = { full_name: 'Ana', user_id: 'otro-usuario', role: 'admin', email: 'x@example.com', preferences: {}, marketing_opt_in: true };
    await updateProfile(transport, sneaky as Parameters<typeof updateProfile>[1]);
    const keys = Object.keys(lastBody());
    expect(keys.filter((k) => !ALLOWED_KEYS.includes(k))).toEqual([]);
  });

  test('el cuerpo es JSON serializable y la ruta no lleva query ni el id del usuario', async () => {
    await updateProfile(transport, { full_name: 'Ana' });
    expect(seen[NONE].path).toBe(ME);
    expect(seen[NONE].query ?? {}).toEqual({});
  });

  test('devuelve el perfil actualizado de la respuesta', async () => {
    reply = () => profile({ full_name: 'Nuevo Nombre' });
    expect((await updateProfile(transport, { full_name: 'Nuevo Nombre' })).full_name).toBe('Nuevo Nombre');
  });

  test('un 422 con details se propaga como el mismo ApiError (el llamador traduce por type)', async () => {
    const err = new ApiError(HTTP.UNPROCESSABLE, 'validation_error', 'La solicitud no es válida.', [{ loc: ['body', 'phone'], type: 'value_error', msg: 'x' }]);
    reply = () => {
      throw err;
    };
    await expect(updateProfile(transport, { phone: 'abc' })).rejects.toBe(err);
  });
});

describe('con el transporte real del servidor (fetch simulado)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  const lastFetch = (): { url: string; init: RequestInit & { headers: Record<string, string> } } => {
    const [url, init] = fetchMock.mock.calls.at(-ONE) as [string, RequestInit & { headers: Record<string, string> }];
    return { url, init };
  };
  const headersOf = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  test('getProfile: GET {API}/api/v1/identity/me con el Bearer de la sesión y sin cuerpo', async () => {
    fetchMock.mockResolvedValue(json(profile()));
    await getProfile(serverTransport({ accessToken: BEARER }));
    expect(lastFetch().url).toBe('http://api.test:8000/api/v1/identity/me');
    expect(lastFetch().init.method).toBe('GET');
    expect(headersOf(lastFetch().init.headers).authorization).toBe(`Bearer ${BEARER}`);
    expect(lastFetch().init.body).toBeUndefined();
  });

  test('updateProfile: PATCH con JSON mínimo y null para borrar', async () => {
    fetchMock.mockResolvedValue(json(profile()));
    await updateProfile(serverTransport({ accessToken: BEARER }), { full_name: null, birth_date: BIRTH });
    expect(lastFetch().url).toBe('http://api.test:8000/api/v1/identity/me');
    expect(lastFetch().init.method).toBe('PATCH');
    expect(headersOf(lastFetch().init.headers)['content-type']).toContain('application/json');
    expect(JSON.parse(String(lastFetch().init.body))).toEqual({ full_name: null, birth_date: BIRTH });
  });

  test('422: ApiError con status, code y details por campo (loc y type; sin el valor enviado)', async () => {
    fetchMock.mockResolvedValue(validationError(detail('birth_date', 'birth_date_underage'), detail('phone', 'value_error')));
    const err = await updateProfile(serverTransport({ accessToken: BEARER }), { phone: 'abc', birth_date: BIRTH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: HTTP.UNPROCESSABLE, code: 'validation_error' });
    const details = (err as ApiError).details as { loc: string[]; type: string }[];
    expect(details.map((d) => `${d.loc.join('.')}:${d.type}`)).toEqual(['body.birth_date:birth_date_underage', 'body.phone:value_error']);
    expect(JSON.stringify((err as ApiError).details)).not.toContain(BIRTH);
  });

  test('409 birth_date_locked y 401 llegan como ApiError con su code', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'birth_date_locked', message: 'x', details: null } }, CONFLICT));
    await expect(updateProfile(serverTransport({ accessToken: BEARER }), { birth_date: BIRTH })).rejects.toMatchObject({ status: CONFLICT, code: 'birth_date_locked' });
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'unauthenticated', message: 'x', details: null } }, HTTP.UNAUTHORIZED));
    await expect(getProfile(serverTransport({ accessToken: BEARER }))).rejects.toMatchObject({ status: HTTP.UNAUTHORIZED });
  });

  test('un fallo de red es ApiError de red, sin datos del perfil ni de la fecha', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await updateProfile(serverTransport({ accessToken: BEARER }), { birth_date: BIRTH }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: NONE, code: 'network' });
    expect(String((err as ApiError).message)).not.toContain(BIRTH);
  });
});
