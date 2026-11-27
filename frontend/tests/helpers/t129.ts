// Ayudantes de T-129 (cuenta): perfil falso y un backend simulado con las reglas de identity (SPEC §7 y §13). Sin red.
import { vi } from 'vitest';
import { HTTP } from './t127';
import { text } from './ui';

const NOT_FOUND = 404;
const NOT_ALLOWED = 405;
export const CONFLICT = 409;

export const API = 'http://api.test:8000/api/v1/identity/me';
export const ORIGIN = 'http://localhost:4321';
export const NO_STORE = 'private, no-store';

export const BIRTH = '1990-05-17';
export const BIRTH_TEXT = '17 de mayo de 1990';
export const OTHER_BIRTH = '1985-03-02';
export const USER_ID = '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab';
export const SESSION_EMAIL = 'ana.torres@example.com';
export const BEARER = 'bearer-value-for-tests-0129';
const FAR_FUTURE = 4_102_444_800;
export const SESSION = { userId: USER_ID, email: SESSION_EMAIL, accessToken: BEARER, expiresAt: FAR_FUTURE };

export type ProfileJson = {
  user_id: string;
  role: string;
  full_name: string | null;
  phone: string | null;
  birth_date: string | null;
  preferences: Record<string, unknown>;
  privacy_version: string | null;
  privacy_accepted_at: string | null;
  marketing_opt_in: boolean;
  created_at: string;
  updated_at: string;
};

/** El rol es `admin` a propósito: si algo lo pintara, la prueba lo vería (no aparece en ningún otro texto de la página). */
export const profile = (over: Partial<ProfileJson> = {}): ProfileJson => ({
  user_id: USER_ID,
  role: 'admin',
  full_name: 'Ana Torres',
  phone: '+51987654321',
  birth_date: null,
  preferences: {},
  privacy_version: '2026-10',
  privacy_accepted_at: '2026-10-26T20:00:00Z',
  marketing_opt_in: false,
  created_at: '2026-10-26T19:58:00Z',
  updated_at: '2026-10-26T20:00:00Z',
  ...over,
});

export const json = (body: unknown, status: number = HTTP.OK): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Detail = { loc: (string | number)[]; type: string; msg: string };
export const validationError = (...details: Detail[]): Response =>
  json({ error: { code: 'validation_error', message: 'La solicitud no es válida.', details } }, HTTP.UNPROCESSABLE);
export const detail = (field: string, type: string): Detail => ({ loc: ['body', field], type, msg: 'MSG-DEL-BACKEND-QX' });
export const lockedError = (): Response =>
  json({ error: { code: 'birth_date_locked', message: 'La fecha de nacimiento ya está registrada y no se puede cambiar.', details: null } }, CONFLICT);
export const unauthenticated = (): Response => json({ error: { code: 'unauthenticated', message: 'Sesión no válida.', details: null } }, HTTP.UNAUTHORIZED);
export const serverError = (status: number = HTTP.UNAVAILABLE): Response => json({ error: { code: 'internal_error', message: 'Error interno.', details: null } }, status);

export type Call = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };

/**
 * Backend simulado de `/identity/me`. Aplica las reglas del contrato: `null` borra nombre y teléfono; la fecha se fija una vez
 * (la misma es idempotente, otra → 409). `override(call)` permite forzar una respuesta (401, 5xx, 422…) por llamada.
 */
export function installBackend(initial: Partial<ProfileJson> = {}, override?: (c: Call) => Response | undefined | Promise<Response | undefined>) {
  const state = profile(initial);
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: Call = { method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body };
    calls.push(call);
    const forced = await override?.(call);
    if (forced) return forced;
    if (url !== API) return json({ error: { code: 'not_found', message: 'No encontrado.', details: null } }, NOT_FOUND);
    if (call.method === 'GET') return json(state);
    if (call.method === 'PATCH' && body) {
      if (typeof body.birth_date === 'string' && state.birth_date && body.birth_date !== state.birth_date) return lockedError();
      Object.assign(state, body);
      return json(state);
    }
    return json({ error: { code: 'method_not_allowed', message: 'No permitido.', details: null } }, NOT_ALLOWED);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    state,
    calls,
    fetchMock,
    patches: (): Call[] => calls.filter((c) => c.method === 'PATCH'),
    gets: (): Call[] => calls.filter((c) => c.method === 'GET'),
  };
}

/** Cuerpo del único PATCH (o `null` si no hubo). */
export const patchBody = (calls: Call[]): Record<string, unknown> | null => calls.find((c) => c.method === 'PATCH')?.body ?? null;

/** Texto accesible de los errores a los que apunta `aria-describedby` de un campo, sin los de ayuda (`-hint`). */
export function fieldErrorText(doc: ParentNode, input: Element): string {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter((id) => id && !id.endsWith('-hint'));
  return ids.map((id) => text(doc.querySelector(`[id="${id}"]`))).join(' ');
}

/** Ejecuta una función asíncrona por elemento, de uno en uno (las pruebas comparten el `fetch` global). */
export const inSequence = <T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> =>
  items.reduce<Promise<R[]>>(async (acc, item) => [...(await acc), await fn(item)], Promise.resolve([]));
