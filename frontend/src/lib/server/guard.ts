// Guardia de rutas y validación de `next` (STATUS ui §3.2). Sin dependencias del entorno.
export const PROTECTED_PREFIXES: readonly string[] = ['/cuenta', '/carrito', '/checkout', '/admin'];

/** Prefijo exacto por segmento: '/cuenta/x' sí, '/cuentas' no. Normaliza codificación, mayúsculas y '//'. */
export function isProtectedPath(pathname: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return true; // codificación inválida: ante la duda, protegida
  }
  // Colapsa barras repetidas: "/cuenta//x" pasa a "/cuenta/x"; "/cuenta/x" queda igual.
  p = p.replace(/\/{2,}/g, '/').toLowerCase();
  return PROTECTED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Solo rutas internas ('/x'): no '//x', no con '\', sin esquema ni caracteres de control. Si no, `fallback`. */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // Rechaza '\' y caracteres de control: "/a\b" y "/a<LF>b" fallan; "/a/b" pasa.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    if (new URL(raw, 'http://internal.invalid').origin !== 'http://internal.invalid') return fallback;
  } catch {
    return fallback;
  }
  return raw;
}

export function loginUrl(url: URL): string {
  return `/ingresar?next=${encodeURIComponent(url.pathname + url.search)}`;
}
