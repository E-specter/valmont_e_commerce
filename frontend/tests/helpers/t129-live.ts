// T-129 · usuarios de prueba `qa-t129-*` contra el Supabase local y el backend reales. Las claves viven solo en memoria.
// Solo se borra lo que se creó aquí; nunca se tocan otros usuarios (ni cliente.demo@example.com).
import { cookieHeader, sessionCookies, signIn, type CookiePair, type LiveEnv } from './supabase-live';

export const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000';
export const QA_PHRASE = 'Qa-T129-Valmont-2026!';

const RADIX = 36;
const SKIP = 2;
const LEN = 7;
const NO_CONTENT = 204;
const uniqueSuffix = (): string => `${Date.now()}-${Math.random().toString(RADIX).slice(SKIP, LEN)}`;

export type Preset = { full_name?: string; phone?: string; birth_date?: string };
export type Actor = { id: string; email: string; token: string; cookies: CookiePair[]; cookie: string };
export type MeJson = { user_id: string; role: string; full_name: string | null; phone: string | null; birth_date: string | null };

async function admin<T>(env: LiveEnv, path: string, init: RequestInit = {}): Promise<T | undefined> {
  const res = await fetch(`${env.url}${path}`, {
    ...init,
    headers: { apikey: env.service, authorization: `Bearer ${env.service}`, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}`);
  return body ? (JSON.parse(body) as T) : undefined;
}

/** Perfil del propio usuario por la API real (Bearer de su sesión). */
export async function me(token: string): Promise<MeJson> {
  const res = await fetch(`${API}/api/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /identity/me → ${res.status}`);
  return (await res.json()) as MeJson;
}

/** PATCH directo a la API real con el Bearer de su sesión (para preparar datos). */
export async function patchMe(token: string, body: Preset): Promise<void> {
  const res = await fetch(`${API}/api/v1/identity/me`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH /identity/me → ${res.status}`);
}

/** Crea un cliente confirmado `qa-t129-*`, inicia sesión una vez y prepara los datos del perfil indicados. */
export async function createActor(env: LiveEnv, tag: string, preset: Preset = {}): Promise<Actor> {
  const email = `qa-t129-${tag}-${uniqueSuffix()}@example.com`;
  const created = await admin<{ id: string }>(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: QA_PHRASE, email_confirm: true }),
  });
  const id = created?.id ?? '';
  const session = await signIn(env, { id, email, secret: QA_PHRASE });
  const cookies = await sessionCookies(env, session);
  if (Object.keys(preset).length > 0) await patchMe(session.access_token, preset);
  return { id, email, token: session.access_token, cookies, cookie: cookieHeader(cookies) };
}

export async function deleteActor(env: LiveEnv, actor: Actor | undefined): Promise<void> {
  if (!actor?.id) return;
  const res = await fetch(`${env.url}/auth/v1/admin/users/${actor.id}`, {
    method: 'DELETE',
    headers: { apikey: env.service, authorization: `Bearer ${env.service}` },
  }).catch(() => undefined);
  if (res && res.status !== NO_CONTENT && !res.ok) throw new Error('no se pudo borrar el usuario de prueba');
}

/** Cookies listas para `context.addCookies`. */
export const asBrowserCookies = (cookies: CookiePair[]) =>
  cookies.map((c) => ({ name: c.name, value: c.value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' as const }));

/** Fecha 'YYYY-MM-DD' a `years` años de hoy (UTC; basta para los casos lejos del borde de 18 años). */
export function yearsFromToday(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 'YYYY-MM-DD'.length);
}
