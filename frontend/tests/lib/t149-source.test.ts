import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { read } from '../helpers/css';
import { product } from '../helpers/t149';

// T-149 · pruebas de fuente y de contrato del listado de productos: capas (RT-B6), privacidad (RT-B7), lista cerrada, guardia,
// solo lectura y tipo `AdminProduct` frente al OpenAPI (api-contract-review §6): copia recortada y, si está levantado, el backend en :8000.
const PAGE = 'src/pages/admin/productos/index.astro';
const TABLE = 'src/components/admin/ProductsTable.astro';
const OWN = [PAGE, TABLE];
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, '../helpers/fixtures/openapi-admin.json'), 'utf8'));
const LIVE_URL = 'http://127.0.0.1:8000/openapi.json';
const LIVE_TIMEOUT_MS = 3000;
const LIST = '/api/v1/catalog/admin/products';
const MAX_PAGE_SIZE = 48;
// Literal de 8 o más caracteres asignado a un nombre sensible (el patrón de `.githooks/pre-commit`, RT-B4).
// Acepta una asignación con un literal largo (nombre sensible, dos puntos, comillas, 8 o más caracteres); rechaza uno corto.
// https://regex101.com/?regex=(api%5B_-%5D%3Fkey%7Csecret%7Cpassword%7Ctoken)%5B%22'%20%5D*%5B%3A%3D%5D%20*%5B%22'%5D%5B%5E%22'%5D%7B8%2C%7D%5B%22'%5D&testString=password%3A%20%22abcdefgh1%22
const SECRET_HOOK = /(api[_-]?key|secret|password|token)["' ]*[:=] *["'][^"']{8,}["']/i;
// Color en notación hexadecimal de 3 a 8 dígitos dentro de un CSS.
// Acepta "color: #fff"; rechaza "color: var(--x)".
// https://regex101.com/?regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb&testString=color%3A%20%23fff
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
// Tamaño de letra fijo en píxeles.
// Acepta "font-size: 14px"; rechaza "font-size: var(--text-body)".
// https://regex101.com/?regex=font-size%5Cs*%3A%5Cs*%5Cd%2B(%5C.%5Cd%2B)%3Fpx&testString=font-size%3A%2014px
const FONT_PX = /font-size\s*:\s*\d+(\.\d+)?px/;
const COLOR_FUNCTIONS = ['rgb(', 'rgba(', 'hsl(', 'hsla(', 'color-mix('];
const EVENT_HANDLERS = [' onclick=', ' onerror=', ' onload=', ' onfocus=', ' onsubmit=', ' onchange='];
// Campos que el contrato de AdminProductOut no tiene: leerlos sería inventar datos.
const INVENTED = ['.stock', '.stock_on_hand', '.available', '.quantity', '.cost', '.discount', '.rating', '.brand', '.collection', '.is_published'];

type Param = { name: string; schema: { maximum?: number } };
type Spec = {
  paths: Record<string, { get: { parameters: Param[]; responses: Record<string, unknown> } }>;
  components: { schemas: Record<string, { enum?: string[]; properties: Record<string, unknown> }> };
};
const live: Spec | null = await fetch(LIVE_URL, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const SPECS: [string, Spec][] = [['copia recortada', FIXTURE as Spec], ...(live ? ([['backend en :8000', live]] as [string, Spec][]) : [])];

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
  test('la tabla es un componente: no importa de lib/server ni lee sesión, entorno ni red', () => {
    expect(hasAny(code(TABLE), ['lib/server', 'astro:env', 'Astro.locals', 'apiFor', 'requireAdmin', 'getProfile', 'fetch('])).toEqual([]);
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

  test.each(OWN)('%s: no lee campos que el contrato no tiene', (file) => {
    expect(hasAny(code(file), INVENTED)).toEqual([]);
  });

  test('la página no escribe: sin create/update/publish, sin POST/PATCH/PUT/DELETE y sin formularios post', () => {
    const src = code(PAGE);
    expect(hasAny(src, ['createProduct', 'updateProduct', 'publishProduct', 'unpublishProduct', "'POST'", '"POST"', "'PATCH'", "'PUT'", "'DELETE'", 'export async function POST'])).toEqual([]);
    expect(hasAny(src.toLowerCase(), ['method="post"', "method='post'"])).toEqual([]);
  });
});

describe('la página', () => {
  const src = code(PAGE);

  test('no se prerenderiza y exige administrador antes de pedir datos', () => {
    expect(src).toContain('export const prerender = false');
    expect(src).toContain('await requireAdmin(Astro)');
    expect(src).toContain('if (!gate.ok) return gate.response');
    expect(src.indexOf('requireAdmin(Astro)')).toBeLessThan(src.indexOf('listAdminProducts('));
  });

  test('respuesta siempre privada: Cache-Control private, no-store fijado por la propia página', () => {
    expect(src).toContain("'Cache-Control', 'private, no-store'");
  });

  test('la consulta se envía con listAdminProducts y los errores pasan por adminErrorResponse', () => {
    ['listAdminProducts(', 'adminErrorResponse('].forEach((n) => expect(src, n).toContain(n));
  });

  test('usa AdminLayout con título «Productos» y sección productos (noindex lo pone el layout)', () => {
    expect(src).toContain('title="Productos"');
    expect(src).toContain('section="productos"');
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

describe('nav.ts · «Productos» habilitado', () => {
  test('«Productos» apunta a /admin/productos y está habilitado; el orden del menú no cambia', () => {
    expect(ADMIN_NAV.find((e) => e.section === 'productos')).toMatchObject({ label: 'Productos', href: '/admin/productos', enabled: true });
    expect(ADMIN_NAV.map((e) => e.section)).toEqual(['panel', 'pedidos', 'productos', 'inventario', 'promociones', 'reportes', 'clientes', 'auditoria']);
  });

  test('las pantallas sin paquete siguen «Pronto»', () => {
    const enabled = ADMIN_NAV.filter((e) => e.enabled).map((e) => e.section);
    ['inventario', 'promociones', 'reportes', 'clientes', 'auditoria'].forEach((s) => expect(enabled, s).not.toContain(s));
  });
});

describe.each(SPECS)('contrato del listado frente al OpenAPI (%s)', (_name, spec) => {
  const op = () => spec.paths[LIST].get;
  const schemas = () => spec.components.schemas;

  test('GET admite exactamente status, q, page y page_size: no hay filtro de categoría que el cliente deje sin exponer', () => {
    const names = op().parameters.map((p) => p.name).sort();
    expect(names).toEqual(['page', 'page_size', 'q', 'status']);
  });

  test('page_size ≤ 48, q ≤ 100 y status solo draft | published', () => {
    const byName = Object.fromEntries(op().parameters.map((p) => [p.name, p.schema]));
    expect(byName.page_size.maximum).toBe(MAX_PAGE_SIZE);
    expect(JSON.stringify(byName.q)).toContain('"maxLength":100');
    expect(schemas().ProductStatus.enum).toEqual(['draft', 'published']);
  });

  test('el producto de las pruebas tiene exactamente los campos de AdminProductOut (ni uno inventado ni uno que falte)', () => {
    expect(Object.keys(product()).sort()).toEqual(Object.keys(schemas().AdminProductOut.properties).sort());
  });

  test('la página del listado es {items, total, page, page_size}', () => {
    expect(Object.keys(schemas().AdminProductPageOut.properties).sort()).toEqual(['items', 'page', 'page_size', 'total']);
  });

  test('el listado documenta 200, 401 y 403', () => {
    ['200', '401', '403'].forEach((c) => expect(Object.keys(op().responses), c).toContain(c));
  });
});
