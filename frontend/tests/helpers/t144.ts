// Ayudantes de T-144 (clientes de API de administración y utilidades). Sin red: un transporte que graba y un `fetch` falso.
import { vi } from 'vitest';
import type { Transport } from '../../src/lib/api/http';

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const TOO_LARGE = 413;
const UNSUPPORTED = 415;
const INVALID = 422;
const SERVER = 500;
const UNAVAILABLE = 503;
export const ST = { UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, TOO_LARGE, UNSUPPORTED, INVALID, SERVER, UNAVAILABLE } as const;

export type Req = Parameters<Transport>[0];

/** Transporte simulado: graba cada petición y responde con lo que devuelva `reply`. */
export function recorder(reply: (req: Req) => unknown = () => ({})) {
  const seen: Req[] = [];
  const transport: Transport = async <T>(req: Req): Promise<T> => {
    seen.push(req);
    return reply(req) as T;
  };
  return { transport, seen, last: () => seen[seen.length - 1] };
}

/** Cuerpo tal como viajaría por la red (JSON): descarta `undefined`, como `JSON.stringify`. */
export const wire = (body: unknown): unknown => (body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
/** Consulta sin las claves vacías. */
export const cleanQuery = (q: Req['query']): Record<string, unknown> =>
  Object.fromEntries(Object.entries(q ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// Acepta un UUID versión 4 en texto: '6f1c2a9e-5b7d-4c1e-9a10-0123456789ab'; rechaza uno versión 1: '6f1c2a9e-5b7d-1c1e-9a10-0123456789ab'.
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ORDER_ID = '6f1c2a9e-5b7d-4c1e-9a10-0123456789ab';
export const PRODUCT_ID = '7a2d3b0f-6c8e-4d2f-8b21-1234567890bc';
export const IMAGE_ID = '8b3e4c1a-7d9f-4e3a-9c32-234567890acd';
export const IMAGE_ID_2 = '9c4f5d2b-8eaa-4f4b-8d43-34567890abde';
export const API_BASE = 'http://api.test:8000/api/v1';
/** Valor falso con un nombre que no dispara el hook de secretos (RT-B4, N-5). */
export const CRED = 'cred-value-for-tests-0144';
const PRICE_CENTS = 125000;
export const MONEY = { amount: PRICE_CENTS, currency: 'PEN' } as const;

export type FetchCall = { method: string; url: string; headers: Headers; body: BodyInit | null | undefined };

/** Instala un `fetch` falso (lo desinstala `vi.unstubAllGlobals()` en el `afterEach` del llamador). */
export function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: FetchCall = { method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers), body: init?.body };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

const ST_OK = 200;
export const jsonRes = (body: unknown, status = ST_OK): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const errRes = (status: number, code: string, details: unknown = null): Response =>
  jsonRes({ error: { code, message: 'Mensaje del servidor.', details } }, status);
