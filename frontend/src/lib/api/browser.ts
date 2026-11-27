import { ApiError, parseResponse, toQueryString, type Transport } from './http';

const TIMEOUT_MS = 12000; // el proxy corta a los 10 s

/** Transporte de las islas: mismo origen, `/bff/*`. El servidor de Astro añade el Bearer; aquí no hay token. */
export const browserTransport: Transport = async <T>(req: Parameters<Transport>[0]): Promise<T> => {
  if (!req.path.startsWith('/') || req.path.startsWith('//')) {
    throw new ApiError(0, 'invalid_request', 'Ruta de API no válida.');
  }
  const qs = req.query ? toQueryString(req.query) : '';
  const headers: Record<string, string> = { ...req.headers, Accept: 'application/json' };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  let timedOut = false;
  const timer = AbortSignal.timeout(TIMEOUT_MS);
  timer.addEventListener('abort', () => (timedOut = true));
  const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;

  try {
    const res = await fetch(`/bff${req.path}${qs ? `?${qs}` : ''}`, {
      method: req.method,
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      credentials: 'same-origin',
      signal,
    });
    return await parseResponse<T>(res);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) throw new ApiError(0, 'timeout', 'El servidor tardó demasiado en responder.');
    throw new ApiError(0, 'network', 'No se pudo conectar con el servidor.');
  }
};
