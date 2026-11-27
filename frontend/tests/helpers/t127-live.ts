// T-127 · usuarios de prueba `qa-t127-*` contra el Supabase local (API de administración). Las claves viven solo en memoria.
// Solo se borra lo que se creó aquí.
import type { LiveEnv } from './supabase-live';

export const QA_PHRASE = 'Qa-T127-Valmont-2026!';
export const NOT_THE_PHRASE = 'Zx9-Incorrecta-Qa127!';

const RADIX = 36;
const SKIP = 2;
const LEN = 7;
const uniqueSuffix = (): string => `${Date.now()}-${Math.random().toString(RADIX).slice(SKIP, LEN)}`;

export type QaUser = { id: string; email: string; secret: string };

async function admin<T>(env: LiveEnv, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.url}${path}`, {
    ...init,
    headers: { apikey: env.service, authorization: `Bearer ${env.service}`, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}`);
  return (body ? JSON.parse(body) : undefined) as T;
}

/** Correo único `qa-t127-*`; `confirmed: false` deja el correo sin confirmar (para el caso 403). */
export async function createQaUser(env: LiveEnv, tag: string, confirmed = true): Promise<QaUser> {
  const email = `qa-t127-${tag}-${uniqueSuffix()}@example.com`;
  const u = await admin<{ id: string }>(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: QA_PHRASE, email_confirm: confirmed }),
  });
  return { id: u.id, email, secret: QA_PHRASE };
}

export async function deleteQaUser(env: LiveEnv, user: QaUser): Promise<void> {
  await admin(env, `/auth/v1/admin/users/${user.id}`, { method: 'DELETE' }).catch(() => undefined);
}

/** Correo que no existe en Supabase (con el mismo formato que los de prueba). */
export const ghostEmail = (): string => `qa-t127-ghost-${uniqueSuffix()}@example.com`;
