// Ayudantes de T-127 (ingreso): constantes y fábricas de errores de Supabase Auth. Sin dependencias del entorno.
export const OK = 200;
export const FOUND = 302;
export const SEE_OTHER = 303;
export const BAD_REQUEST = 400;
export const UNAUTHORIZED = 401;
export const FORBIDDEN = 403;
export const UNPROCESSABLE = 422;
export const TOO_MANY = 429;
export const SERVER_ERROR = 500;
export const BAD_GATEWAY = 502;
export const UNAVAILABLE = 503;
export const GATEWAY_TIMEOUT = 504;
export const HTTP = { OK, FOUND, SEE_OTHER, BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, UNPROCESSABLE, TOO_MANY, SERVER_ERROR, BAD_GATEWAY, UNAVAILABLE, GATEWAY_TIMEOUT } as const;

export const MSG = {
  BAD_CREDENTIALS: 'Correo o contraseña incorrectos',
  NOT_CONFIRMED: 'Confirma tu correo para ingresar',
  RATE_LIMIT: 'Demasiados intentos; espera un momento',
} as const;

export type AuthErr = { code?: string; status?: number; name?: string; message?: string };

/** Errores tal como los devuelve `signInWithPassword` (`error`) en cada caso del paquete. */
export const SB = {
  invalidCredentials: (): AuthErr => ({ code: 'invalid_credentials', status: HTTP.BAD_REQUEST, name: 'AuthApiError', message: 'Invalid login credentials' }),
  notConfirmed: (): AuthErr => ({ code: 'email_not_confirmed', status: HTTP.BAD_REQUEST, name: 'AuthApiError', message: 'Email not confirmed' }),
  rateLimit: (): AuthErr => ({ code: 'over_request_rate_limit', status: HTTP.TOO_MANY, name: 'AuthApiError', message: 'Request rate limit reached' }),
  network: (): AuthErr => ({ name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }),
  serverError: (): AuthErr => ({ name: 'AuthApiError', status: HTTP.SERVER_ERROR, message: 'Internal error' }),
};

/** Usuario ficticio de la sesión de Astro (para "ya hay sesión"). */
const BEARER_FAKE = 'bearer-value-for-tests-0001';
const FAR_FUTURE = 4_102_444_800;
export const SESSION_FAKE = { userId: 'user-0001', email: 'cliente@example.com', accessToken: BEARER_FAKE, expiresAt: FAR_FUTURE };

/** Valor falso de contraseña: no casa con el patrón del hook de secretos (no va tras una clave llamada como tal). */
export const WRONG_PHRASE = 'Zx9-Incorrecta-Qa127!';
export const RIGHT_PHRASE = 'Vm4-Correcta-Qa127!';

/** ¿El texto contiene alguna de las palabras (sin distinguir mayúsculas)? */
export const containsAny = (text: string, words: string[]): boolean => words.some((w) => text.toLowerCase().includes(w.toLowerCase()));
