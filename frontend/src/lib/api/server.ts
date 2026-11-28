import { API_BASE_URL } from 'astro:env/server';
import { ApiError, parseResponse, toQueryString, type Transport } from './http';

const TIMEOUT_MS = 8000;

/** Transporte del servidor de Astro: base API_BASE_URL + '/api/v1'. El token solo se añade si el llamador lo pasa. */
export function serverTransport(opts: { accessToken?: string | null; timeoutMs?: number } = {}): Transport {
  return async <T>(req: Parameters<Transport>[0]): Promise<T> => {
    // Solo rutas relativas a la API: nunca una URL absoluta ni '//host'.
    if (!req.path.startsWith('/') || req.path.startsWith('//')) {
      throw new ApiError(0, 'invalid_request', 'Ruta de API no válida.');
    }
    const qs = req.query ? toQueryString(req.query) : '';
    const url = `${API_BASE_URL.replace(/\/+$/, '')}/api/v1${req.path}${qs ? `?${qs}` : ''}`;

    const headers: Record<string, string> = { ...req.headers, Accept: 'application/json' };
    if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
    // FormData: sin Content-Type propio, para que fetch ponga el multipart con su límite.
    const isForm = req.body instanceof FormData;
    if (isForm) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
    } else if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let timedOut = false;
    const timer = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
    timer.addEventListener('abort', () => (timedOut = true));
    const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;

    try {
      // Sin reintentos: una escritura no se repite a ciegas.
      const res = await fetch(url, {
        method: req.method,
        headers,
        body: isForm ? (req.body as FormData) : req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal,
      });
      return await parseResponse<T>(res);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (timedOut) throw new ApiError(0, 'timeout', 'El servidor tardó demasiado en responder.');
      throw new ApiError(0, 'network', 'No se pudo conectar con el servidor.');
    }
  };
}
