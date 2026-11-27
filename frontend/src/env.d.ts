/// <reference types="astro/client" />
// Los módulos `astro:env/server` (API_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY) se tipan solos
// desde `env.schema` de astro.config.mjs.

/** Sesión validada en el servidor (T-126). El token nunca llega al HTML ni a islas. */
type Session = { userId: string; email: string | null; accessToken: string; expiresAt: number /* epoch s */ };

declare namespace App {
  interface Locals {
    session: Session | null;
    supabase: import('@supabase/supabase-js').SupabaseClient;
  }
}
