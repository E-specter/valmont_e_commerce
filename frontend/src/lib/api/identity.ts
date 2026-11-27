// Perfil del cliente (identity SPEC §7 y §13.7). La identidad sale del token, nunca de un id.
import type { Transport } from './http';

export type Profile = {
  user_id: string;
  role: 'customer' | 'admin';
  full_name: string | null;
  phone: string | null;
  birth_date: string | null; // 'YYYY-MM-DD'; dato personal (RNF10), no se registra
  preferences: Record<string, unknown>;
  privacy_version: string | null;
  privacy_accepted_at: string | null;
  marketing_opt_in: boolean;
};

export function getProfile(t: Transport): Promise<Profile> {
  return t<Profile>({ method: 'GET', path: '/identity/me' });
}

/** Solo los campos presentes viajan; `null` borra nombre o teléfono. `birth_date` solo se fija una vez (409 si ya existe). */
const ALLOWED = ['full_name', 'phone', 'birth_date'] as const;

/** Lista blanca: nunca viaja una clave ajena (role, user_id…). */
function pick(changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(ALLOWED.filter((k) => k in changes).map((k) => [k, changes[k]]));
}

export function updateProfile(
  t: Transport,
  changes: { full_name?: string | null; phone?: string | null; birth_date?: string },
): Promise<Profile> {
  return t<Profile>({ method: 'PATCH', path: '/identity/me', body: pick(changes) });
}
