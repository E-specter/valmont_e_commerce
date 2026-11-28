import type { SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';
import type { Transport } from '../api/http';
import { serverTransport } from '../api/server';

/** Transporte de la API con el Bearer de la sesión (si la hay). */
export function apiFor(locals: App.Locals, opts: { timeoutMs?: number } = {}): Transport {
  return serverTransport({ accessToken: locals.session?.accessToken, timeoutMs: opts.timeoutMs });
}

/** Valida la cookie (verificación del JWT, renovación si caducó) y devuelve la sesión o null. */
export async function resolveSession(supabase: SupabaseClient): Promise<Session | null> {
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  // El token es el que getClaims acaba de validar: se lee de la misma sesión, nunca de `session.user`.
  const { data: s } = await supabase.auth.getSession();
  if (!s.session?.access_token) return null;
  const email = (claims as { email?: unknown }).email;
  return {
    userId: claims.sub,
    email: typeof email === 'string' ? email : null,
    accessToken: s.session.access_token,
    expiresAt: typeof claims.exp === 'number' ? claims.exp : (s.session.expires_at ?? 0),
  };
}

// Acepta "sb-abc-auth-token" y "sb-abc-auth-token.1"; rechaza "theme".
const AUTH_COOKIE = /^sb-.*-auth-token/;

/** Cierra la sesión de este navegador y borra las cookies de Supabase (también las huérfanas). */
export async function endSession(supabase: SupabaseClient, cookies: AstroCookies, request: Request): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // sin red o sin configuración: las cookies se borran igualmente
  }
  (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter((name) => AUTH_COOKIE.test(name))
    .forEach((name) => cookies.delete(name, { path: '/' }));
}
