// T-126 · ayudantes para las pruebas contra el Supabase local real (E2E y servidor de producción).
// Las claves salen del entorno o de `npx supabase status -o env`; viven solo en memoria: nunca se escriben ni se imprimen.
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerClient } from '@supabase/ssr';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LOCAL_URL = 'http://127.0.0.1:54321';
const CHUNK = 3180; // MAX_CHUNK_SIZE de @supabase/ssr

export type LiveEnv = { url: string; anon: string; service: string };

let cached: LiveEnv | null | undefined;

/** Variables del stack local, o null si no está levantado. */
export function liveEnv(): LiveEnv | null {
  if (cached !== undefined) return cached;
  const fromEnv = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  let parsed: Record<string, string> = {};
  try {
    const out = execSync('npx --no-install supabase status -o env', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).toString();
    parsed = Object.fromEntries(
      out.split(/\r?\n/).map((l) => /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]),
    );
  } catch {
    // sin CLI o sin stack: se usa solo lo que haya en el entorno
  }
  const url = fromEnv.url ?? parsed.API_URL ?? LOCAL_URL;
  const anon = fromEnv.anon ?? parsed.ANON_KEY ?? parsed.PUBLISHABLE_KEY;
  const service = fromEnv.service ?? parsed.SERVICE_ROLE_KEY ?? parsed.SECRET_KEY;
  cached = anon && service ? { url, anon, service } : null;
  return cached;
}

export type LiveUser = { id: string; email: string; secret: string };

const QA_CREDENTIAL = 'Qa-T126-Valmont-2026!';

async function api<T>(env: LiveEnv, path: string, init: RequestInit & { key?: string } = {}): Promise<T> {
  const { key = env.anon, ...rest } = init;
  const res = await fetch(`${env.url}${path}`, { ...rest, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...rest.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Crea un cliente confirmado de pruebas (API de administración). Solo se borra el que se creó aquí. */
export async function createUser(env: LiveEnv, tag: string): Promise<LiveUser> {
  const email = `qa-t126-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const u = await api<{ id: string }>(env, '/auth/v1/admin/users', { method: 'POST', key: env.service, body: JSON.stringify({ email, password: QA_CREDENTIAL, email_confirm: true }) });
  return { id: u.id, email, secret: QA_CREDENTIAL };
}

export async function deleteUser(env: LiveEnv, user: LiveUser): Promise<void> {
  await api(env, `/auth/v1/admin/users/${user.id}`, { method: 'DELETE', key: env.service }).catch(() => undefined);
}

export type RawSession = { access_token: string; refresh_token: string; expires_at: number; [k: string]: unknown };

export async function signIn(env: LiveEnv, user: LiveUser): Promise<RawSession> {
  return api<RawSession>(env, '/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: user.email, password: user.secret }) });
}

export type CookiePair = { name: string; value: string };

/** Cookies exactamente como las escribiría @supabase/ssr (nombre, codificación y trozos), para una sesión real. */
export async function sessionCookies(env: LiveEnv, session: RawSession): Promise<CookiePair[]> {
  const jar = new Map<string, string>();
  const client = createServerClient(env.url, env.anon, {
    cookies: { getAll: () => [], setAll: (l) => l.forEach(({ name, value }) => jar.set(name, value)) },
  });
  const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw new Error('setSession falló');
  return [...jar].map(([name, value]) => ({ name, value }));
}

/** Reescribe la caducidad (`expires_at`) de la sesión guardada en las cookies, y opcionalmente el refresh token. */
export function tamperCookies(cookies: CookiePair[], patch: { expires_at?: number; refresh_token?: string; access_token?: string }): CookiePair[] {
  const base = cookies[0].name.replace(/\.\d+$/, '');
  const joined = cookies.sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.value).join('');
  const json = JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64url').toString('utf8')) as Record<string, unknown>;
  const encoded = `base64-${Buffer.from(JSON.stringify({ ...json, ...patch }), 'utf8').toString('base64url')}`;
  if (encoded.length <= CHUNK) return [{ name: base, value: encoded }];
  const out: CookiePair[] = [];
  for (let i = 0; i * CHUNK < encoded.length; i++) out.push({ name: `${base}.${i}`, value: encoded.slice(i * CHUNK, (i + 1) * CHUNK) });
  return out;
}

export const cookieHeader = (c: CookiePair[]): string => c.map((p) => `${p.name}=${p.value}`).join('; ');
