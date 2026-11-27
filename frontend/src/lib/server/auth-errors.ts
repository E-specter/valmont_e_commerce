// Traduce errores de Supabase Auth a estado HTTP y mensaje en español (T-127).
// Anti-enumeración: correo inexistente y contraseña errónea dan el mismo resultado.
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const UNPROCESSABLE = 422;
const TOO_MANY_REQUESTS = 429;
const UNAVAILABLE = 503;
const SERVER_ERROR_MIN = 500;

export type AuthErrorStatus = typeof UNAUTHORIZED | typeof FORBIDDEN | typeof UNPROCESSABLE | typeof TOO_MANY_REQUESTS | typeof UNAVAILABLE;
import { SERVICE_UNAVAILABLE_MESSAGE } from '../auth-messages';

export { SERVICE_UNAVAILABLE_MESSAGE };

const BAD_CREDENTIALS = { status: UNAUTHORIZED, message: 'Correo o contraseña incorrectos' } as const;
const UNAVAILABLE_RESULT = { status: UNAVAILABLE, message: SERVICE_UNAVAILABLE_MESSAGE } as const;

export function mapAuthError(
  e: { code?: string; status?: number; name?: string; message?: string } | null,
): { status: AuthErrorStatus; message: string } {
  if (!e) return UNAVAILABLE_RESULT;
  if (e.code === 'email_not_confirmed') return { status: FORBIDDEN, message: 'Confirma tu correo para ingresar' };
  if (e.code === 'over_request_rate_limit' || e.code === 'over_email_send_rate_limit' || e.status === TOO_MANY_REQUESTS) {
    return { status: TOO_MANY_REQUESTS, message: 'Demasiados intentos; espera un momento' };
  }
  if (e.code === 'validation_failed') return { status: UNPROCESSABLE, message: 'Revisa los datos ingresados' };
  // Sin respuesta (red caída), reintentos agotados o 5xx: servicio no disponible.
  if (e.name === 'AuthRetryableFetchError' || !e.status || e.status >= SERVER_ERROR_MIN) return UNAVAILABLE_RESULT;
  // invalid_credentials y cualquier otro 4xx: mensaje único, sin revelar la causa.
  return BAD_CREDENTIALS;
}
