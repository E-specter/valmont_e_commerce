// Ayudante E2E del backoffice (D-050, D-AB3): crea usuarios `qa-t142-*` (cliente o administrador) contra el Supabase local y el backend reales.
// El rol se fija en la BD local con `docker exec … psql` SOLO para los usuarios que crea este ayudante (correo `qa-t142-%`), y se borran al terminar
// (usuario de Auth y su fila de perfil: `app.profiles` no cae en cascada). Las claves viven solo en memoria. Nunca toca otros usuarios.
import { execFileSync } from 'node:child_process';
import { cookieHeader, sessionCookies, signIn, type CookiePair, type LiveEnv } from '../../tests/helpers/supabase-live';

export const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8000';
export const QA_PHRASE = 'Qa-T142-Valmont-2026!';
const DB_CONTAINER = 'supabase_db_valmont';
const EMAIL_PREFIX = 'qa-t142-';
const RADIX = 36;
const SKIP = 2;
const LEN = 7;
// Acepta "3f1c2a9e-5b7d-4c1e-9a10-0123456789ab"; rechaza cualquier otra cosa (se interpola en SQL).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type QaUser = { id: string; email: string; token: string; cookies: CookiePair[]; cookie: string; role: 'admin' | 'customer' };

const suffix = (): string => `${Date.now()}-${Math.random().toString(RADIX).slice(SKIP, LEN)}`;

async function auth<T>(env: LiveEnv, path: string, init: RequestInit = {}): Promise<T | undefined> {
  const res = await fetch(`${env.url}${path}`, {
    ...init,
    headers: { apikey: env.service, authorization: `Bearer ${env.service}`, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}`);
  return body ? (JSON.parse(body) as T) : undefined;
}

/** Perfil por la API real; la primera llamada crea el perfil de forma perezosa. */
export async function me(token: string): Promise<{ user_id: string; role: string; full_name: string | null }> {
  const res = await fetch(`${API}/api/v1/identity/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /identity/me → ${res.status}`);
  return (await res.json()) as { user_id: string; role: string; full_name: string | null };
}

/** Ejecuta un SQL en la BD local. Solo con identificadores validados (UUID) interpolados; sin shell. */
function psql(sql: string): string {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

const own = (id: string): string => {
  if (!UUID.test(id)) throw new Error('id de usuario no válido');
  // La subconsulta garantiza que solo se actúe sobre usuarios de esta suite (correo qa-t142-*).
  return `user_id = '${id}' AND user_id IN (SELECT id FROM auth.users WHERE email LIKE '${EMAIL_PREFIX}%')`;
};

/** Cambia el rol de un usuario `qa-t142-*` (0 filas si no lo es: falla). */
export async function setRole(user: QaUser, role: 'admin' | 'customer'): Promise<void> {
  const out = psql(`UPDATE app.profiles SET role = '${role}' WHERE ${own(user.id)} RETURNING user_id`);
  if (!out.includes(user.id)) throw new Error('no se cambió el rol: el usuario no es de la suite');
  user.role = role;
}

/** Crea un usuario confirmado `qa-t142-<tag>-…`, inicia sesión una vez y asegura su perfil. Con `role: 'admin'` lo promueve. */
export async function createQaUser(env: LiveEnv, tag: string, role: 'admin' | 'customer'): Promise<QaUser> {
  const email = `${EMAIL_PREFIX}${tag}-${suffix()}@example.com`;
  const created = await auth<{ id: string }>(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: QA_PHRASE, email_confirm: true }),
  });
  const id = created?.id ?? '';
  const session = await signIn(env, { id, email, secret: QA_PHRASE });
  const cookies = await sessionCookies(env, session);
  const profile = await me(session.access_token); // crea el perfil (rol customer)
  if (profile.role !== 'customer') throw new Error('un usuario nuevo debe nacer como cliente');
  const user: QaUser = { id, email, token: session.access_token, cookies, cookie: cookieHeader(cookies), role: 'customer' };
  if (role === 'admin') {
    await setRole(user, 'admin');
    if ((await me(session.access_token)).role !== 'admin') throw new Error('la API no ve el rol admin');
  }
  return user;
}

/** Borra el perfil y el usuario de Auth de un `qa-t142-*`. Silencioso si ya no existe. */
export async function deleteQaUser(env: LiveEnv, user: QaUser | undefined): Promise<void> {
  if (!user?.id || !UUID.test(user.id)) return;
  try {
    psql(`DELETE FROM app.profiles WHERE ${own(user.id)}`);
  } catch {
    // sin Docker o ya borrado: se intenta igualmente el borrado en Auth
  }
  await auth(env, `/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }).catch(() => undefined);
}

/** Cookies listas para `context.addCookies`. */
export const browserCookies = (cookies: CookiePair[]) =>
  cookies.map((c) => ({ name: c.name, value: c.value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' as const }));
