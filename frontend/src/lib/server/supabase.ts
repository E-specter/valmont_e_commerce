import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookieSetOptions, AstroCookies } from 'astro';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from 'astro:env/server';

/** Falta configuración de autenticación. El mensaje es genérico a propósito: no nombra variables. */
export class AuthConfigError extends Error {
  constructor() {
    super('Autenticación no disponible.');
    this.name = 'AuthConfigError';
  }
}

// D-041 P-5: la cookie de sesión nunca es legible desde JavaScript.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: import.meta.env.PROD,
  path: '/',
} as const;

/** Un cliente por petición (nunca compartido): lee y escribe las cookies de Astro con atributos forzados. */
export function createSupabaseServer({ request, cookies }: { request: Request; cookies: AstroCookies }): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new AuthConfigError();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: COOKIE_OPTIONS,
    cookies: {
      getAll: () =>
        parseCookieHeader(request.headers.get('cookie') ?? '').map(({ name, value }) => ({ name, value: value ?? '' })),
      setAll: (list) =>
        list.forEach(({ name, value, options }) =>
          cookies.set(name, value, { ...options, ...COOKIE_OPTIONS } as AstroCookieSetOptions),
        ),
    },
  });
}

/** ¿La petición trae cookies de sesión de Supabase? (`sb-<ref>-auth-token`, con o sin trozos). */
// Acepta "a=1; sb-abc-auth-token.0=x"; rechaza "sb-abc-other=x".
export function hasAuthCookie(request: Request): boolean {
  return /(?:^|;\s*)sb-[^=;]*-auth-token/.test(request.headers.get('cookie') ?? '');
}
