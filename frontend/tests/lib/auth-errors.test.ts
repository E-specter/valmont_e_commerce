import { describe, expect, test } from 'vitest';
import { mapAuthError } from '../../src/lib/server/auth-errors';
import { BAD_REQUEST, containsAny, FORBIDDEN, GATEWAY_TIMEOUT, BAD_GATEWAY, MSG, SB, SERVER_ERROR, TOO_MANY, UNAUTHORIZED, UNAVAILABLE, UNPROCESSABLE } from '../helpers/t127';

// T-127 · `mapAuthError` (STATUS ui › T-127 › Firmas públicas): errores de Supabase Auth → estado HTTP y mensaje en español.
const VALID_STATUS = [UNAUTHORIZED, FORBIDDEN, UNPROCESSABLE, TOO_MANY, UNAVAILABLE];
// Detalle interno que jamás debe llegar al usuario.
const RAW = 'Invalid login credentials for ana.perez@example.com (gotrue-internal-xyz)';
const LEAKS = ['ana.perez', 'gotrue', 'internal', 'xyz', 'invalid login credentials'];
const ENGLISH = ['invalid', 'credentials', 'rate limit', 'too many', 'failed', 'error', 'unauthorized'];
const ACCOUNT_STATE = ['@', 'existe', 'registrad', 'cuenta'];

describe('mapAuthError · códigos de Supabase', () => {
  test('invalid_credentials → 401 con el mensaje del paquete', () => {
    const r = mapAuthError(SB.invalidCredentials());
    expect(r.status).toBe(UNAUTHORIZED);
    expect(r.message).toContain(MSG.BAD_CREDENTIALS);
  });

  test('email_not_confirmed → 403 con "Confirma tu correo para ingresar"', () => {
    const r = mapAuthError(SB.notConfirmed());
    expect(r.status).toBe(FORBIDDEN);
    expect(r.message).toContain(MSG.NOT_CONFIRMED);
  });

  test('over_request_rate_limit → 429 con el mensaje de espera', () => {
    const r = mapAuthError(SB.rateLimit());
    expect(r.status).toBe(TOO_MANY);
    expect(r.message).toContain(MSG.RATE_LIMIT);
  });

  test('el código manda sobre el estado HTTP: dos errores 400 se distinguen solo por `code`', () => {
    expect(mapAuthError(SB.invalidCredentials()).status).not.toBe(mapAuthError(SB.notConfirmed()).status);
  });

  test('429 sin `code` también es límite de intentos', () => {
    expect(mapAuthError({ status: TOO_MANY, name: 'AuthApiError' }).status).toBe(TOO_MANY);
  });
});

describe('mapAuthError · red y 5xx → 503', () => {
  test.each([
    ['fallo de red (AuthRetryableFetchError, status 0)', SB.network()],
    ['fallo de red sin status', { name: 'AuthRetryableFetchError' }],
    ['500', SB.serverError()],
    ['502', { name: 'AuthApiError', status: BAD_GATEWAY }],
    ['504', { name: 'AuthRetryableFetchError', status: GATEWAY_TIMEOUT }],
    ['código desconocido con 5xx', { code: 'unexpected_failure', status: SERVER_ERROR }],
  ])('%s', (_n, e) => {
    const r = mapAuthError(e);
    expect(r.status).toBe(UNAVAILABLE);
    expect(r.message.trim().length).toBeGreaterThan(0);
  });
});

describe('mapAuthError · seguridad y forma', () => {
  test('anti-enumeración: ningún código de "usuario no existe" se distingue de invalid_credentials', () => {
    const base = mapAuthError(SB.invalidCredentials());
    const others = ['user_not_found', 'email_not_found', 'invalid_grant'].map((code) => mapAuthError({ code, status: BAD_REQUEST }));
    others.forEach((r) => expect(r).toEqual(base));
  });

  test.each([
    { ...SB.invalidCredentials(), message: RAW },
    { ...SB.notConfirmed(), message: RAW },
    { ...SB.rateLimit(), message: RAW },
    { code: 'unexpected_failure', status: SERVER_ERROR, message: RAW },
    { ...SB.network(), message: RAW },
    { code: 'quien_sabe', status: BAD_REQUEST, message: RAW },
  ])('el mensaje de Supabase no se refleja al usuario (%j)', (e) => {
    expect(containsAny(mapAuthError(e).message, LEAKS)).toBe(false);
  });

  test('un código desconocido devuelve un estado válido del contrato y un mensaje genérico', () => {
    const r = mapAuthError({ code: 'algo_nuevo_de_supabase', status: BAD_REQUEST });
    expect(VALID_STATUS).toContain(r.status);
    expect(r.message.trim().length).toBeGreaterThan(0);
  });

  test('todos los mensajes están en español (sin las frases en inglés de Supabase)', () => {
    const all = [SB.invalidCredentials(), SB.notConfirmed(), SB.rateLimit(), SB.network(), { code: 'x', status: SERVER_ERROR }].map((e) => mapAuthError(e).message);
    all.forEach((m) => expect(containsAny(m, ENGLISH)).toBe(false));
  });

  test('no muta su entrada y es determinista', () => {
    const e = Object.freeze({ code: 'invalid_credentials', status: BAD_REQUEST, name: 'AuthApiError' });
    expect(mapAuthError(e)).toEqual(mapAuthError(e));
  });

  test('el mensaje de 403 no revela nada más que la confirmación pendiente (ni correo ni estado de la cuenta)', () => {
    expect(containsAny(mapAuthError({ ...SB.notConfirmed(), message: RAW }).message, ACCOUNT_STATE)).toBe(false);
  });
});
