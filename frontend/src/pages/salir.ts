import type { APIRoute } from 'astro';
import { endSession } from '../lib/server/session';

export const prerender = false;

const NO_STORE = 'private, no-store';

// Un GET no cierra sesión (evita cierres por enlaces o imágenes de terceros).
export const GET: APIRoute = () =>
  new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': NO_STORE } });

export const POST: APIRoute = async ({ request, url, locals, cookies }) => {
  if (request.headers.get('origin') !== url.origin) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': NO_STORE } });
  }
  try {
    await endSession(locals.supabase, cookies, request); // el getter lanza si falta configuración
  } catch {
    return new Response('Error interno del servidor.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_STORE },
    });
  }
  return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': NO_STORE } });
};
