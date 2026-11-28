import { describe, expect, test } from 'vitest';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { read } from '../helpers/css';

// T-084 · pruebas de fuente del listado de pedidos: capas (RT-B6), privacidad (RT-B7), lista blanca, guardia y entrega acotada (nav.ts).
const PAGE = 'src/pages/admin/pedidos/index.astro';
const FILTERS = 'src/components/admin/OrderFilters.astro';
const TABLE = 'src/components/admin/OrdersTable.astro';
const OWN = [PAGE, FILTERS, TABLE];
const FIVE = 5;
// Literal de 8 o más caracteres asignado a un nombre sensible (el patrón de `.githooks/pre-commit`, RT-B4).
// Acepta una asignación con un literal largo (nombre sensible, dos puntos, comillas, 8 o más caracteres); rechaza uno corto.
// https://regex101.com/?regex=(api%5B_-%5D%3Fkey%7Csecret%7Cpassword%7Ctoken)%5B%22'%20%5D*%5B%3A%3D%5D%20*%5B%22'%5D%5B%5E%22'%5D%7B8%2C%7D%5B%22'%5D&testString=password%3A%20%22abcdefgh1%22
const SECRET_HOOK = /(api[_-]?key|secret|password|token)["' ]*[:=] *["'][^"']{8,}["']/i;
// Color en notación hexadecimal de 3 a 8 dígitos dentro de un CSS.
// Acepta "color: #fff" y "#00241280"; rechaza "color: var(--x)".
// https://regex101.com/?regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb&testString=color%3A%20%23fff
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
// Tamaño de letra fijo en píxeles.
// Acepta "font-size: 14px"; rechaza "font-size: var(--text-body)".
// https://regex101.com/?regex=font-size%5Cs*%3A%5Cs*%5Cd%2B(%5C.%5Cd%2B)%3Fpx&testString=font-size%3A%2014px
const FONT_PX = /font-size\s*:\s*\d+(\.\d+)?px/;
const COLOR_FUNCTIONS = ['rgb(', 'rgba(', 'hsl(', 'hsla(', 'color-mix('];
const EVENT_HANDLERS = [' onclick=', ' onerror=', ' onload=', ' onfocus=', ' onsubmit=', ' onchange='];

/** Quita lo que está entre `open` y `close` (comentarios), sin expresiones regulares. */
function dropBetween(src: string, open: string, close: string): string {
  const at = src.indexOf(open);
  if (at < 0) return src;
  const end = src.indexOf(close, at + open.length);
  return end < 0 ? src.slice(0, at) : dropBetween(src.slice(0, at) + src.slice(end + close.length), open, close);
}
const code = (file: string): string =>
  dropBetween(dropBetween(read(file), '<!--', '-->'), '/*', '*/')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
const hasAny = (src: string, needles: readonly string[]): string[] => needles.filter((n) => src.includes(n));
const styleOf = (file: string): string => {
  const src = read(file);
  const at = src.indexOf('<style');
  return at < 0 ? '' : src.slice(src.indexOf('>', at) + 1, src.indexOf('</style>', at));
};

describe('capas y privacidad (RT-B6, RT-B7, RT-B9)', () => {
  test.each([FILTERS, TABLE])('%s: los componentes no importan de lib/server ni leen sesión, entorno ni red', (file) => {
    expect(hasAny(code(file), ['lib/server', 'astro:env', 'Astro.locals', 'apiFor', 'requireAdmin', 'getProfile', 'fetch('])).toEqual([]);
  });

  test.each(OWN)('%s: sin set:html, innerHTML, console ni handlers en línea', (file) => {
    const src = code(file);
    expect(hasAny(src, ['set:html', 'set:text', 'innerHTML', 'dangerouslySetInnerHTML', 'console.', 'localStorage', 'sessionStorage', 'define:vars'])).toEqual([]);
    expect(hasAny(src.toLowerCase(), EVENT_HANDLERS)).toEqual([]);
  });

  test.each(OWN)('%s: sin literales que dispare el hook de secretos (RT-B4)', (file) => {
    const src = read(file);
    expect(SECRET_HOOK.test(src)).toBe(false);
    expect(src.includes('eyJ')).toBe(false);
  });

  test('la tabla no pinta datos que el listado no necesita: ni user_id ni teléfono ni dirección', () => {
    expect(hasAny(code(TABLE), ['user_id', 'phone', 'address_line', 'reference'])).toEqual([]);
  });

  test('la página no escribe: sin transitionOrder, sin POST/PATCH/PUT/DELETE y sin formularios post', () => {
    const src = code(PAGE);
    expect(hasAny(src, ['transitionOrder', "'POST'", '"POST"', "'PATCH'", "'PUT'", "'DELETE'", 'export async function POST', 'export function POST'])).toEqual([]);
    expect(hasAny(src.toLowerCase(), ['method="post"', "method='post'"])).toEqual([]);
  });
});

describe('la página', () => {
  const src = code(PAGE);

  test('no se prerenderiza y exige administrador antes de pedir datos', () => {
    expect(src).toContain('export const prerender = false');
    expect(src).toContain('await requireAdmin(Astro)');
    expect(src).toContain('if (!gate.ok) return gate.response');
    expect(src.indexOf('requireAdmin(Astro)')).toBeLessThan(src.indexOf('listAdminOrders('));
  });

  test('respuesta siempre privada: Cache-Control private, no-store fijado por la propia página', () => {
    expect(src).toContain("'Cache-Control', 'private, no-store'");
  });

  test('la consulta se construye con parseOrderQuery y se envía con listAdminOrders; los errores pasan por adminErrorResponse', () => {
    ['parseOrderQuery(', 'listAdminOrders(', 'adminErrorResponse(', 'orderQueryString('].forEach((n) => expect(src, n).toContain(n));
  });

  test('no lee parámetros por su cuenta: nada de searchParams.get ni entries de la URL', () => {
    expect(hasAny(src, ['searchParams.get(', 'searchParams.entries', 'searchParams.getAll', 'Object.fromEntries(Astro.url'])).toEqual([]);
  });

  test('usa AdminLayout con título «Pedidos» y sección pedidos (noindex lo pone el layout)', () => {
    expect(src).toContain('title="Pedidos"');
    expect(src).toContain('section="pedidos"');
  });

  test('no hace red por su cuenta ni toca supabase', () => {
    expect(hasAny(src, ['fetch(', '@supabase', 'supabase.'])).toEqual([]);
  });
});

describe('RT-B5 · estilos solo con tokens y en @layer components', () => {
  test.each(OWN)('%s: sin #hex, rgb(), color-mix, font-family propio ni px de tipografía', (file) => {
    const css = styleOf(file);
    expect(HEX_COLOR.test(css)).toBe(false);
    expect(hasAny(css, COLOR_FUNCTIONS)).toEqual([]);
    expect(FONT_PX.test(css)).toBe(false);
    css.split(';').filter((d) => d.includes('font-family')).forEach((d) => expect(d).toContain('var('));
    if (css.trim()) expect(css).toContain('@layer components');
  });
});

describe('nav.ts · entrega acotada a una línea', () => {
  test('«Pedidos» está habilitado y apunta a /admin/pedidos', () => {
    expect(ADMIN_NAV.find((e) => e.section === 'pedidos')).toMatchObject({ label: 'Pedidos', href: '/admin/pedidos', enabled: true });
  });

  test('el resto de entradas conserva su orden y destino; Panel sigue habilitado', () => {
    expect(ADMIN_NAV.map((e) => e.section)).toEqual(['panel', 'pedidos', 'productos', 'inventario', 'promociones', 'reportes', 'clientes', 'auditoria']);
    expect(ADMIN_NAV.map((e) => e.href)).toEqual([
      '/admin', '/admin/pedidos', '/admin/productos', '/admin/inventario', '/admin/promociones', '/admin/reportes', '/admin/clientes', '/admin/auditoria',
    ]);
    expect(ADMIN_NAV.find((e) => e.section === 'panel')?.enabled).toBe(true);
  });

  test('las pantallas sin paquete en esta ola siguen «Pronto» (inventario, promociones, reportes, clientes, auditoría)', () => {
    const enabled = ADMIN_NAV.filter((e) => e.enabled).map((e) => e.section);
    ['inventario', 'promociones', 'reportes', 'clientes', 'auditoria'].forEach((s) => expect(enabled, s).not.toContain(s));
    expect(enabled.length).toBeLessThanOrEqual(FIVE);
  });
});
