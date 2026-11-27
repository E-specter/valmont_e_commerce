import { describe, expect, test } from 'vitest';
import { PROTECTED_PREFIXES, isProtectedPath, loginUrl, safeNext } from '../../src/lib/server/guard';

// T-126 · contrato 3.2: guardia de rutas y validación de `next` (redirección abierta). Tablas de entradas hostiles.
const PROTECTED = [
  '/cuenta', '/cuenta/', '/cuenta/x', '/cuenta/pedidos/1', '/carrito', '/carrito/x', '/checkout', '/checkout/pago',
  '/Cuenta', '/CUENTA/x', '/Carrito', '/CHECKOUT', // mayúsculas
  '/%63uenta', '/%63uenta/x', '/c%75enta', '/%43uenta', '/%63heckout', '/car%72ito', // codificación porcentual
  '//cuenta', '///cuenta/x', '/cuenta//x', '//carrito', '//checkout', // barras repetidas
  '/%2Fcuenta', '/%2fcuenta', // "/" codificada → "//cuenta"
  '/cuenta%2Fx', '/%E0%A4%A/cuenta', // codificación inválida: ante la duda, protegida
];
const PUBLIC = ['/', '', '/cuentas', '/cuentas/x', '/carritos', '/checkouts', '/checkout-x', '/micuenta', '/relojes', '/relojes/cuenta', '/nosotros', '/ingresar', '/bff/cart', '/auth/callback'];

describe('isProtectedPath', () => {
  test('los prefijos declarados son los del contrato', () => {
    expect([...PROTECTED_PREFIXES].sort()).toEqual(['/carrito', '/checkout', '/cuenta']);
  });

  test.each(PROTECTED)('protegida: %j', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  test.each(PUBLIC)('pública: %j', (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  test('un prefijo no protege por subcadena: /cuentas y /carritos quedan fuera', () => {
    expect(isProtectedPath('/cuentas')).toBe(false);
    expect(isProtectedPath('/carritos')).toBe(false);
  });
});

describe('safeNext', () => {
  const FALLBACK = '/cuenta';
  const HOSTILE = [
    '//evil.com', '//evil.com/x', '///evil.com', '/\\evil.com', '/\\/evil.com', '\\\\evil.com', '/a\\b',
    'https://evil.com', 'http://evil.com/cuenta', 'HTTPS://evil.com', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x',
    'vbscript:x', '//\t/evil.com', '/\t/evil.com', '/\n//evil.com', '/a\nb', '/a\rb', '/a\u0000b', '/a\u001fb', '/a\u007fb',
    'cuenta', 'evil.com', '?next=/x', '#x', ' /cuenta', ' //evil.com', '', '   ',
  ];

  test.each(HOSTILE)('hostil %j → fallback', (raw) => {
    expect(safeNext(raw, FALLBACK)).toBe(FALLBACK);
  });

  test.each([null, undefined])('%s → fallback', (raw) => {
    expect(safeNext(raw, FALLBACK)).toBe(FALLBACK);
  });

  test('el fallback por defecto es "/"', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });

  test.each(['/', '/cuenta', '/cuenta/pedidos/12', '/relojes?categoria=a&page=2', '/carrito?x=1#y', '/a/b/c'])('interna %j se conserva', (raw) => {
    expect(safeNext(raw, FALLBACK)).toBe(raw);
  });

  test('lo que devuelve nunca cambia de origen al resolverse', () => {
    for (const raw of [...HOSTILE, '/cuenta', '/x//y', '/%2F%2Fevil.com', '/%5Cevil.com']) {
      const out = safeNext(raw, FALLBACK);
      expect(new URL(out, 'http://tienda.test').origin).toBe('http://tienda.test');
    }
  });
});

describe('loginUrl', () => {
  test('/ingresar?next=<ruta + query codificadas>', () => {
    expect(loginUrl(new URL('http://t.test/carrito?a=1&b=2'))).toBe('/ingresar?next=%2Fcarrito%3Fa%3D1%26b%3D2');
    expect(loginUrl(new URL('http://t.test/cuenta'))).toBe('/ingresar?next=%2Fcuenta');
  });

  test('el valor viaja codificado: no inyecta parámetros ni cambia de destino', () => {
    const u = new URL(loginUrl(new URL('http://t.test/cuenta?x=1&next=//evil.com')), 'http://t.test');
    expect(u.pathname).toBe('/ingresar');
    expect([...u.searchParams.keys()]).toEqual(['next']);
    expect(u.searchParams.get('next')).toBe('/cuenta?x=1&next=//evil.com');
  });

  test('ida y vuelta: safeNext acepta lo que loginUrl produce para una ruta protegida', () => {
    const next = new URL(loginUrl(new URL('http://t.test/checkout?step=2')), 'http://t.test').searchParams.get('next');
    expect(safeNext(next, '/cuenta')).toBe('/checkout?step=2');
  });
});
