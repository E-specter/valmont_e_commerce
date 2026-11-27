// Proxy autenticado para islas (STATUS ui §3.3). Lista de permitidos, no un reenviador abierto:
// el destino siempre es API_BASE_URL + '/api/v1/' + segmentos codificados de `cart|wishlist|orders`.
import type { APIRoute } from 'astro';
import { API_BASE_URL } from 'astro:env/server';
import { endSession } from '../../lib/server/session';

export const prerender = false;

const MAX_BODY = 16 * 1024;
const TIMEOUT_MS = 10_000;
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const WITH_BODY = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
// Acepta "cart", "orders/123/cancel"; rechaza "catalog/x", "identity/me", "carts".
const ALLOWED = /^(cart|wishlist|orders)(\/[^/]+)*$/;
// Acepta "abc-123"; rechaza "" o claves con espacios/control o de más de 128 caracteres.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

const NO_STORE = { 'Cache-Control': 'no-store' };

// Acepta "application/json" y "application/json; charset=utf-8"; rechaza "application/jsonx".
const JSON_TYPE = /^application\/json\s*(;.*)?$/i;
const isJson = (value: string | null): boolean => JSON_TYPE.test(value ?? '');

function problem(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, details: null } }, { status, headers: NO_STORE });
}

/** Segmentos válidos (sin '.', '..', '\', control) o null. `orders/admin` queda fuera. */
function parsePath(raw: string | undefined): string[] | null {
  if (!raw || !ALLOWED.test(raw)) return null;
  const segments = raw.split('/');
  const bad = segments.some((s) => s === '.' || s === '..' || /[\\\x00-\x1f\x7f?#]/.test(s));
  if (bad || (segments[0] === 'orders' && segments[1]?.toLowerCase() === 'admin')) return null;
  return segments;
}

/** Lee el cuerpo con tope de tamaño; null si lo supera. */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export const ALL: APIRoute = async ({ request, url, params, locals, cookies }) => {
  const segments = parsePath(params.path);
  if (!segments) return problem(404, 'not_found', 'No encontrado.');
  if (!METHODS.has(request.method)) return problem(405, 'method_not_allowed', 'Método no permitido.');
  // CSRF: las escrituras solo desde nuestro propio origen.
  if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) {
    return problem(403, 'forbidden', 'Origen no permitido.');
  }
  if (!locals.session) return problem(401, 'unauthenticated', 'Inicia sesión para continuar.');

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${locals.session.accessToken}`, // único dato de la sesión que sale del servidor
  };
  const key = request.headers.get('idempotency-key');
  if (key !== null) {
    if (!IDEMPOTENCY_KEY.test(key)) return problem(400, 'invalid_request', 'Idempotency-Key no válida.');
    headers['Idempotency-Key'] = key;
  }

  let body: string | undefined;
  if (WITH_BODY.has(request.method)) {
    const text = await readBody(request);
    if (text === null) return problem(413, 'payload_too_large', 'Cuerpo demasiado grande.');
    if (text !== '') {
      if (!isJson(request.headers.get('content-type'))) {
        return problem(415, 'unsupported_media_type', 'Solo se admite application/json.');
      }
      try {
        JSON.parse(text);
      } catch {
        return problem(400, 'invalid_request', 'JSON no válido.');
      }
      headers['Content-Type'] = 'application/json';
      body = text;
    }
  }

  const target = `${API_BASE_URL.replace(/\/+$/, '')}/api/v1/${segments.map(encodeURIComponent).join('/')}${url.search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: 'manual', // nunca seguir redirecciones a otro destino
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return problem(504, 'timeout', 'El servidor tardó demasiado en responder.');
    }
    return problem(502, 'network', 'No se pudo conectar con el servidor.');
  }

  // Token caducado y sin renovación posible: se limpia la sesión; las rutas protegidas redirigirán al ingreso.
  if (upstream.status === 401) await endSession(locals.supabase, cookies, request);

  const contentType = upstream.headers.get('content-type') ?? '';
  if (upstream.status === 204) return new Response(null, { status: 204, headers: NO_STORE });
  if (!isJson(contentType)) {
    return problem(502, 'invalid_response', 'Respuesta no válida del servidor.');
  }
  // Solo estado, tipo y cuerpo: ni Set-Cookie ni otras cabeceras del backend.
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...NO_STORE },
  });
};
