// Guardia de administrador (STATUS ui §10.5 · 3.6). El rol lo decide siempre el backend: esto es comodidad (D-050).
import type { Transport } from '../api/http';
import { ApiError } from '../api/http';
import { getProfile, type Profile } from '../api/identity';
import { loginUrl } from './guard';
import { apiFor, endSession } from './session';

export type AdminCtx = { api: Transport; profile: Profile }; // profile.role === 'admin'
export type AdminGate = { ok: true; ctx: AdminCtx } | { ok: false; response: Response };
type AstroLike = Pick<import('astro').AstroGlobal, 'locals' | 'url' | 'request' | 'cookies' | 'rewrite'>;

const NO_STORE = 'private, no-store';
const FOUND = 302;
const SEE_OTHER = 303;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 401 del backend: cierra la sesión local antes de redirigir (si no, /ingresar devolvería aquí). */
async function toLogin(astro: AstroLike): Promise<Response> {
  await endSession(astro.locals.supabase, astro.cookies, astro.request);
  return new Response(null, { status: FOUND, headers: { Location: loginUrl(astro.url), 'Cache-Control': NO_STORE } });
}

/** GET /identity/me. 401 → endSession + 302 login · role ≠ admin → rewrite sin permiso (403) · 5xx o red → rewrite no disponible (503). */
export async function requireAdmin(astro: AstroLike): Promise<AdminGate> {
  // La guardia del middleware ya exige sesión; esto es la red de seguridad.
  if (!astro.locals.session) {
    return { ok: false, response: new Response(null, { status: FOUND, headers: { Location: loginUrl(astro.url), 'Cache-Control': NO_STORE } }) };
  }
  const api = apiFor(astro.locals);
  let profile: Profile;
  try {
    profile = await getProfile(api);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { ok: false, response: await toLogin(astro) };
    if (e instanceof ApiError && e.status === 403) return { ok: false, response: await astro.rewrite('/admin/sin-permiso') };
    return { ok: false, response: await astro.rewrite('/admin/no-disponible') };
  }
  // 200 con una forma inesperada (p. ej. `null`) es un fallo del servicio, nunca un acceso ni un 500.
  if (!profile || typeof profile !== 'object' || typeof profile.role !== 'string') {
    return { ok: false, response: await astro.rewrite('/admin/no-disponible') };
  }
  if (profile.role !== 'admin') return { ok: false, response: await astro.rewrite('/admin/sin-permiso') };
  return { ok: true, ctx: { api, profile } };
}

/** ApiError 401 → 302 login · 403 → sin permiso · 404 → /404; lo demás (incluido lo que no es ApiError) → null: lo trata la página. */
export async function adminErrorResponse(astro: AstroLike, e: unknown): Promise<Response | null> {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return toLogin(astro);
  if (e.status === 403) return astro.rewrite('/admin/sin-permiso');
  if (e.status === 404) return astro.rewrite('/404');
  return null;
}

/** RT-B1: el `Origin` de un POST debe ser el del propio sitio; ausente → false. */
export function checkAdminOrigin(request: Request, url: URL): boolean {
  return request.headers.get('origin') === url.origin;
}

/** RT-B3: redirección tras un POST (303), nunca en caché. */
export function seeOther(location: string): Response {
  return new Response(null, { status: SEE_OTHER, headers: { Location: location, 'Cache-Control': NO_STORE } });
}

/** Identificador 8-4-4-4-12 hexadecimal, sin recortar. */
export function isUuid(s: string): boolean {
  return UUID.test(s);
}
