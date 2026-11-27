// Contrato de transporte (STATUS ui §3.1). Sin dependencias del entorno: sirve en SSR y en islas.
export type Money = { amount: number; currency: 'PEN' }; // céntimos enteros (D-015)
export type Page<T> = { items: T[]; total: number; page: number; page_size: number };

export class ApiError extends Error {
  status: number; // HTTP; 0 si no hubo respuesta
  code: string; // del cuerpo {"error":{"code"}} o 'network' | 'timeout' | 'invalid_response'
  details: unknown; // error.details o null

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;

export type Transport = <T>(req: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string; // relativo a /api/v1, p. ej. '/catalog/products'
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<T>;

const enc = encodeURIComponent;
const skip = (v: unknown) => v === undefined || v === null || v === '';

/** Omite undefined, null y ''; los arrays repiten la clave; claves en orden alfabético. */
export function toQueryString(q: Query): string {
  const parts: string[] = [];
  for (const key of Object.keys(q).sort()) {
    const value = q[key];
    if (skip(value)) continue;
    const values = Array.isArray(value) ? (value as readonly string[]) : [value as string | number | boolean];
    for (const v of values) if (!skip(v)) parts.push(`${enc(key)}=${enc(String(v))}`);
  }
  return parts.join('&');
}

/** Convierte la respuesta HTTP en datos o en ApiError. No registra cuerpos ni cabeceras. */
export async function parseResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new ApiError(res.status, 'invalid_response', 'Respuesta no válida del servidor.');
  }
  if (res.ok) return data as T;
  const err = (data as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  if (err && typeof err.code === 'string' && typeof err.message === 'string') {
    throw new ApiError(res.status, err.code, err.message, err.details ?? null);
  }
  throw new ApiError(res.status, 'invalid_response', 'Respuesta no válida del servidor.');
}
