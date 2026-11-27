// T-128 + T-131 · ayudantes del E2E contra el Supabase local real. Las claves viven solo en memoria.
// Solo se crean y borran usuarios `qa-t128-*` que registra esta suite.
import type { LiveEnv } from './supabase-live';

export const QA_PHRASE = 'Qa-T128-Valmont-2026!';
const RADIX = 36;
const SKIP = 2;
const LEN = 7;
const uniqueSuffix = (): string => `${Date.now()}-${Math.random().toString(RADIX).slice(SKIP, LEN)}`;

/** Correo único `qa-t128-<tag>-…`. */
export const qaEmail = (tag: string): string => `qa-t128-${tag}-${uniqueSuffix()}@example.com`;

export type AdminUser = { id: string; email: string; user_metadata?: Record<string, unknown>; raw_user_meta_data?: Record<string, unknown>; identities?: unknown[] };

async function admin<T>(env: LiveEnv, path: string, init: RequestInit = {}): Promise<{ status: number; body: T | undefined }> {
  const res = await fetch(`${env.url}${path}`, {
    ...init,
    headers: { apikey: env.service, authorization: `Bearer ${env.service}`, 'content-type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as T) : undefined };
}

/** Busca un usuario por correo (API de administración; solo entorno local). */
export async function findUser(env: LiveEnv, email: string): Promise<AdminUser | undefined> {
  const { body } = await admin<{ users: AdminUser[] }>(env, '/auth/v1/admin/users?per_page=1000');
  return body?.users.find((u) => u.email === email);
}

/** Borra un usuario por correo y confirma que ya no existe. Devuelve false si no existía. */
export async function deleteByEmail(env: LiveEnv, email: string): Promise<boolean> {
  const user = await findUser(env, email);
  if (!user) return false;
  await admin(env, `/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
  if (await findUser(env, email)) throw new Error(`No se pudo borrar el usuario de prueba ${email}`);
  return true;
}

/** Usuarios `qa-t128-*` que quedaron en Auth (para el control de limpieza). */
export async function leftovers(env: LiveEnv): Promise<string[]> {
  const { body } = await admin<{ users: AdminUser[] }>(env, '/auth/v1/admin/users?per_page=1000');
  return (body?.users ?? []).map((u) => u.email).filter((e) => e.startsWith('qa-t128-'));
}

type CookiePair = { name: string; value: string };

/** Sesión guardada en las cookies de @supabase/ssr (`base64-` + JSON, posiblemente en trozos). */
export function sessionFromCookies(cookies: CookiePair[]): { access_token: string; user: { user_metadata?: Record<string, unknown> } } {
  const chunks = cookies
    .filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (chunks.length === 0) throw new Error('No hay cookie de sesión');
  const joined = chunks.map((c) => c.value).join('');
  return JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64url').toString('utf8'));
}

/** Carga útil (sin verificar) de un JWT, solo para inspección en pruebas. */
export function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// --- contraste WCAG 2.x ---------------------------------------------------------------------------------------
const SRGB_MAX = 255;
const SRGB_KNEE = 0.03928;
const SRGB_LOW_DIV = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_GAMMA = 2.4;
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const CONTRAST_OFFSET = 0.05;
const channel = (v: number): number => {
  const s = v / SRGB_MAX;
  return s <= SRGB_KNEE ? s / SRGB_LOW_DIV : ((s + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
};
/** Acepta `rgb(r, g, b)` y `rgba(r, g, b, a)`; devuelve los tres canales. */
const channels = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
export const luminance = (css: string): number => {
  const [r, g, b] = channels(css);
  return LUMA_R * channel(r) + LUMA_G * channel(g) + LUMA_B * channel(b);
};
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + CONTRAST_OFFSET) / (lo + CONTRAST_OFFSET);
};

/** Crea un cliente ya confirmado `qa-t128-*` (API de administración) para probar "correo ya registrado". */
export async function createConfirmedUser(env: LiveEnv, email: string): Promise<void> {
  const { status } = await admin(env, '/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: QA_PHRASE, email_confirm: true }) });
  if (status >= 300) throw new Error(`No se pudo crear el usuario de prueba (HTTP ${status})`);
}
