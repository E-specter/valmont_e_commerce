import { defineMiddleware } from 'astro:middleware';
import { isProtectedPath, loginUrl } from './lib/server/guard';
import { resolveSession } from './lib/server/session';
import { AuthConfigError, createSupabaseServer, hasAuthCookie } from './lib/server/supabase';

const NO_STORE = 'private, no-store';
const FOUND = 302;
const SERVER_ERROR = 500;

export const onRequest = defineMiddleware(async (context, next) => {
  // Las rutas prerenderizadas no tienen petición ni sesión: no se tocan.
  if (context.isPrerendered) return next();

  const { request, cookies, url, locals } = context;
  const protectedRoute = isProtectedPath(url.pathname);

  // Cliente por petición, creado al primer uso: sin configuración solo falla quien lo necesita.
  let client: App.Locals['supabase'] | undefined;
  Object.defineProperty(locals, 'supabase', {
    configurable: true,
    enumerable: true,
    get: () => (client ??= createSupabaseServer({ request, cookies })),
  });
  locals.session = null;

  // Sin cookie de sesión no hace falta cliente ni configuración.
  if (hasAuthCookie(request)) {
    try {
      locals.session = await resolveSession(locals.supabase);
    } catch (e) {
      // Sin configuración, solo las rutas con sesión fallan (mensaje genérico); el resto del sitio sigue.
      if (e instanceof AuthConfigError && (protectedRoute || needsAuth(url.pathname))) return genericError();
      locals.session = null;
    }
  }

  if (protectedRoute && !locals.session) {
    return new Response(null, { status: FOUND, headers: { Location: loginUrl(url), 'Cache-Control': NO_STORE } });
  }

  const response = await next();
  // Rutas privadas, o cookies renovadas/borradas: nunca en cachés compartidas.
  if (protectedRoute || [...cookies.headers()].length > 0) {
    const out = new Response(response.body, response);
    out.headers.set('Cache-Control', NO_STORE);
    return out;
  }
  return response;
});

/** Rutas cuyo trabajo es la sesión: sin configuración responden 500 genérico (el resto del sitio sigue). */
function needsAuth(pathname: string): boolean {
  return ['/bff', '/auth/callback', '/salir'].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function genericError(): Response {
  return new Response('Error interno del servidor.', {
    status: SERVER_ERROR,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
