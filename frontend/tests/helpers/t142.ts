// Ayudantes de T-142 (guardia de administrador): un `Astro` mínimo (AstroLike de 3.6) y un `fetch` falso de `/identity/me`. Sin red.
import { vi } from 'vitest';
import { API, BEARER, SESSION, inSequence, json, profile, type ProfileJson } from './t129';
import { fakeCookies } from './t126';

export { API, BEARER, SESSION, inSequence, json, profile };
export const ORIGIN = 'http://localhost:4321';
export const NO_PERMISSION_PATH = '/admin/sin-permiso';
export const UNAVAILABLE_PATH = '/admin/no-disponible';
export const NOT_FOUND_PATH = '/404';
/** Estados HTTP con nombre (evita números sueltos en las pruebas). */
export const ST = {
  OK: 200, FOUND: 302, SEE_OTHER: 303, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, UNPROCESSABLE: 422, TOO_MANY: 429, SERVER_ERROR: 500, BAD_GATEWAY: 502,
  UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
} as const;
const HTTP_OK = ST.OK;
const HTTP_FORBIDDEN = ST.FORBIDDEN;
const HTTP_NOT_FOUND = ST.NOT_FOUND;
const HTTP_UNAVAILABLE = ST.UNAVAILABLE;
const STATUS_OF: Record<string, number> = { [NO_PERMISSION_PATH]: HTTP_FORBIDDEN, [UNAVAILABLE_PATH]: HTTP_UNAVAILABLE, [NOT_FOUND_PATH]: HTTP_NOT_FOUND };
export const COOKIE_HEADER = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';

export type Fake = ReturnType<typeof astroFake>;

/** Contexto de Astro con lo que usan `requireAdmin` y `adminErrorResponse`: `rewrite` devuelve una respuesta con el estado de la página destino. */
export function astroFake(init: { path?: string; session?: unknown; cookie?: string } = {}) {
  const url = new URL(`${ORIGIN}${init.path ?? '/admin'}`);
  const cookies = fakeCookies();
  const signOut = vi.fn(async () => ({ error: null }));
  const rewrite = vi.fn(async (path: string) => new Response(`rewrite:${path}`, { status: STATUS_OF[path] ?? HTTP_OK }));
  const session = 'session' in init ? init.session : SESSION;
  const request = new Request(url, { headers: { cookie: init.cookie ?? COOKIE_HEADER } });
  const astro = { locals: { session, supabase: { auth: { signOut } } }, url, request, cookies, rewrite };
  return { astro: astro as never, rewrite, signOut, cookies, url };
}

export type Seen = { method: string; url: string; auth: string | null; accept: string | null };

/** `fetch` falso: responde a `/identity/me` con `reply` (o lanza si es una función que lanza). Registra cada llamada. */
export function meBackend(reply: () => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url: String(input), auth: headers.get('authorization'), accept: headers.get('accept') });
    return reply();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const meAs = (role: unknown, over: Partial<ProfileJson> = {}) => meBackend(() => json({ ...profile(over), role }));
