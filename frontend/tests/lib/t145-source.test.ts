import { describe, expect, test } from 'vitest';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { read } from '../helpers/css';

// T-145 · pruebas de fuente del panel: capas (RT-B6), privacidad (RT-B7), sin cálculo de importes (RN-09), guardia y lista de lo tocado.
const PAGE = 'src/pages/admin/index.astro';
const LIB = 'src/lib/admin/dashboard.ts';
const COMPONENTS = ['Kpis', 'Alerts', 'Orders', 'Stock'].map((n) => `src/components/admin/Dashboard${n}.astro`);
const ASTRO_FILES = [PAGE, ...COMPONENTS];
const ALL = [...ASTRO_FILES, LIB];
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
const SENSITIVE = ['lib/server', 'astro:env', 'Astro.locals', 'apiFor', 'requireAdmin', 'getProfile', 'fetch(', 'supabase'];
const MONEY_MATH = ['parseFloat', 'parseInt', 'Number(', '.reduce(', 'toFixed(', 'Math.'];

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
  test.each(COMPONENTS)('%s: el componente no importa de lib/server ni lee sesión, entorno ni red', (file) => {
    expect(hasAny(code(file), SENSITIVE)).toEqual([]);
  });

  test('lib/admin/dashboard.ts es neutro: sin astro:env, lib/server, fetch directo, supabase ni consola', () => {
    expect(hasAny(code(LIB), ['lib/server', 'astro:env', 'fetch(', 'supabase', 'console.', 'Astro.'])).toEqual([]);
  });

  test.each(ALL)('%s: sin set:html, innerHTML, console ni handlers en línea', (file) => {
    const src = code(file);
    expect(hasAny(src, ['set:html', 'innerHTML', 'dangerouslySetInnerHTML', 'console.', 'localStorage', 'sessionStorage', 'define:vars'])).toEqual([]);
    expect(hasAny(src.toLowerCase(), EVENT_HANDLERS)).toEqual([]);
  });

  test.each(ALL)('%s: sin literales que dispare el hook de secretos (RT-B4)', (file) => {
    const src = read(file);
    expect(SECRET_HOOK.test(src)).toBe(false);
    expect(src.includes('eyJ')).toBe(false);
  });

  test.each(ALL)('%s: no se calcula ningún importe ni total en el cliente (RN-09)', (file) => {
    expect(hasAny(code(file), MONEY_MATH)).toEqual([]);
  });

  test('los componentes y la página no leen `.amount` (solo formatMoney); la capa de datos lo lee únicamente para validar la forma', () => {
    [PAGE, ...COMPONENTS].forEach((f) => expect(code(f).includes('.amount'), f).toBe(false));
    const dash = code(LIB);
    ['.amount +', '.amount -', '.amount *', '+ ', ' * '].filter((op) => dash.includes(`total${op}`)).forEach((op) => expect(op).toBe(''));
  });

  test('los componentes del panel no pintan datos que no necesitan: ni user_id ni teléfono ni dirección', () => {
    COMPONENTS.forEach((f) => expect(hasAny(code(f), ['user_id', 'phone', 'address_line', 'reference']), f).toEqual([]));
  });

  test('«Ventas del período» no llama a la API: sin referencias a reportes en la capa de datos ni en la página', () => {
    [LIB, PAGE].forEach((f) => expect(code(f).toLowerCase(), f).not.toContain('/reports'));
  });
});

describe('lib/admin/dashboard.ts', () => {
  const src = code(LIB);

  test('exporta loadDashboard y reutiliza listAdminOrders y listStock (no arma rutas a mano)', () => {
    expect(src).toContain('export');
    ['loadDashboard', 'listAdminOrders', 'listStock', 'Promise.allSettled'].forEach((n) => expect(src, n).toContain(n));
    expect(hasAny(src, ["'/orders/admin", "'/inventory/admin", '"/orders/admin"'])).toEqual([]);
  });

  test('es de solo lectura: no importa transitionOrder ni escribe', () => {
    expect(hasAny(src, ['transitionOrder', "'POST'", "'PATCH'", "'PUT'", "'DELETE'"])).toEqual([]);
  });
});

describe('la página', () => {
  const src = code(PAGE);

  test('no se prerenderiza y exige administrador antes de pedir datos', () => {
    expect(src).toContain('export const prerender = false');
    expect(src).toContain('await requireAdmin(Astro)');
    expect(src).toContain('if (!gate.ok) return gate.response');
    expect(src.indexOf('requireAdmin(Astro)')).toBeLessThan(src.indexOf('loadDashboard('));
  });

  test('respuesta siempre privada: Cache-Control private, no-store fijado por la propia página', () => {
    expect(src).toContain("'Cache-Control', 'private, no-store'");
  });

  test('los errores de la capa de datos pasan por adminErrorResponse (401 → ingreso, 403 → sin permiso)', () => {
    expect(src).toContain('adminErrorResponse(');
  });

  test('usa AdminLayout con título «Panel» y sección panel (noindex lo pone el layout)', () => {
    expect(src).toContain('title="Panel"');
    expect(src).toContain('section="panel"');
  });

  test('no hace red por su cuenta, no toca supabase y no lee la URL para consultar', () => {
    expect(hasAny(src, ['fetch(', '@supabase', 'supabase.', 'searchParams'])).toEqual([]);
  });

  test('no escribe: sin POST/PATCH/PUT/DELETE ni formularios post', () => {
    expect(hasAny(src, ["'POST'", "'PATCH'", "'PUT'", "'DELETE'", 'export async function POST'])).toEqual([]);
    expect(hasAny(src.toLowerCase(), ['method="post"', "method='post'"])).toEqual([]);
  });
});

describe('RT-B5 · estilos solo con tokens y en @layer components', () => {
  test.each(ASTRO_FILES)('%s: sin #hex, rgb(), color-mix, font-family propio ni px de tipografía', (file) => {
    const css = styleOf(file);
    expect(HEX_COLOR.test(css)).toBe(false);
    expect(hasAny(css, COLOR_FUNCTIONS)).toEqual([]);
    expect(FONT_PX.test(css)).toBe(false);
    css.split(';').filter((d) => d.includes('font-family')).forEach((d) => expect(d).toContain('var('));
    if (css.trim()) expect(css).toContain('@layer components');
  });
});

describe('nav.ts', () => {
  test('«Panel» sigue habilitado y apunta a /admin; el orden y el destino de las demás entradas no cambian', () => {
    expect(ADMIN_NAV.find((e) => e.section === 'panel')).toMatchObject({ label: 'Panel', href: '/admin', enabled: true });
    expect(ADMIN_NAV.map((e) => e.section)).toEqual(['panel', 'pedidos', 'productos', 'inventario', 'promociones', 'reportes', 'clientes', 'auditoria']);
  });
});
