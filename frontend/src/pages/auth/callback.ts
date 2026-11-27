import type { APIRoute } from 'astro';
import { serverTransport } from '../../lib/api/server';
import { safeNext } from '../../lib/server/guard';
import { isCalendarDate } from '../../lib/server/register';

export const prerender = false;

const NO_STORE = 'private, no-store';

function go(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': NO_STORE } });
}

// Destino del enlace de confirmación del correo (PKCE): canjea `code` por la sesión (cookies httpOnly).
export const GET: APIRoute = async ({ url, locals }) => {
  const failure = go('/ingresar?error=confirmacion');
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) return failure;

  let supabase: App.Locals['supabase'];
  try {
    supabase = locals.supabase; // el getter lanza si falta configuración
  } catch {
    return new Response('Error interno del servidor.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  }

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return failure;

    // El registro dejó nombre y versión de privacidad en user_metadata: se guardan en el perfil una sola vez
    // (el código solo se canjea una vez). Mejor esfuerzo: si falla, el usuario ya entró y puede completarlo en su cuenta.
    const meta = data.session.user.user_metadata ?? {};
    const birthDate = typeof meta.birth_date === 'string' && isCalendarDate(meta.birth_date) ? meta.birth_date : undefined;
    if (typeof meta.full_name === 'string' && typeof meta.accept_privacy_version === 'string') {
      await serverTransport({ accessToken: data.session.access_token })({
        method: 'PATCH',
        path: '/identity/me',
        body: {
          full_name: meta.full_name,
          accept_privacy_version: meta.accept_privacy_version,
          ...(birthDate && { birth_date: birthDate }),
        },
      }).catch(() => undefined); // 409/422 de la fecha: el perfil queda sin ella y se pedirá antes de comprar
    }
    // La fecha es un dato personal: se borra de los metadatos de Auth se haya guardado o no (mejor esfuerzo).
    if (meta.birth_date !== undefined) {
      await supabase.auth.updateUser({ data: { birth_date: null } }).catch(() => undefined);
    }
  } catch {
    return failure; // sin configuración o sin red: mensaje genérico, nada en logs
  }
  return go(safeNext(url.searchParams.get('next'), '/cuenta'));
};
