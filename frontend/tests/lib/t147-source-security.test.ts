import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ADMIN_NAV } from '../../src/lib/admin/nav';

// T-147 · revisión estática de los archivos del paquete (RT-B4, RT-B5, RT-B6, RT-B9): sin `set:html`, sin `lib/server` en componentes e islas,
// sin colores ni tipografía fuera de tokens, sin aritmética de coma flotante en el dinero y sin literales que dispare el hook de secretos.
const NONE = 0;
const NEWLINE = String.fromCharCode(10);
const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const COMPONENTS = [
  'components/admin/ProductForm.astro', 'components/admin/PublishPanel.astro', 'components/admin/SpecsEditor.astro',
  'components/ui/Select.astro', 'components/ui/Textarea.astro', 'components/ui/RadioGroup.astro',
];
const ISLANDS = ['islands/specs-editor.ts', 'islands/unsaved-changes.ts'];
const PAGES = ['pages/admin/productos/nuevo.astro', 'pages/admin/productos/[product_id].astro'];
const LIB = ['lib/admin/product-form.ts'];
const ALL = [...COMPONENTS, ...ISLANDS, ...PAGES, ...LIB];
// Valor literal de 8 o más caracteres asignado a un nombre con key, secret, password o token (el patrón de `.githooks/pre-commit`).
// Acepta una asignación de clave con valor literal largo entre comillas; rechaza una etiqueta cualquiera o un tipo sin valor.
// https://regex101.com/?regex=(api%5B_-%5D%3Fkey%7Csecret%7Cpassword%7Ctoken)%5B%22%27%20%5D*%5B%3A%3D%5D%20*%5B%22%27%5D%5B%5E%22%27%5D%7B8%2C%7D%5B%22%27%5D&testString=apiKey%3A%20%22abcdefgh1%22
const SECRET_LITERAL = /(api[_-]?key|secret|password|token)["' ]*[:=] *["'][^"']{8,}["']/i;
// Color hexadecimal (#fff, #002c18) o función de color en línea: acepta `color: #fff`, rechaza `href="#datos"` (no son 3, 4, 6 u 8 dígitos hex seguidos de un límite de palabra).
// https://regex101.com/?regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb&testString=color%3A%20%23fff
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
// Tamaño de letra en px fijo: acepta `font-size: 14px`, rechaza `font-size: var(--text-body)`.
// https://regex101.com/?regex=font-size%3A%5Cs*%5B0-9.%5D%2Bpx&testString=font-size%3A%2014px
const FONT_PX = /font-size:\s*[0-9.]+px/;

const styleOf = (src: string): string => src.split('<style')[ONE_PART]?.split('</style>')[NONE] ?? '';
const ONE_PART = 1;

describe('archivos del paquete', () => {
  test.each(ALL)('%s existe y no está vacío', (file) => {
    expect(read(file).length).toBeGreaterThan(NONE);
  });

  test.each(ALL)('%s no usa set:html ni escribe HTML desde cadenas', (file) => {
    const src = read(file);
    ['set:html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function('].forEach((bad) => expect(src, bad).not.toContain(bad));
  });

  test.each(ALL)('%s no escribe en console ni deja depuración', (file) => {
    const src = read(file);
    ['console.', 'debugger'].forEach((bad) => expect(src, bad).not.toContain(bad));
  });

  test.each(ALL)('%s no contiene literales que dispare el hook de secretos (RT-B4)', (file) => {
    expect(SECRET_LITERAL.test(read(file))).toBe(false);
  });

  test.each([...COMPONENTS, ...ISLANDS, ...LIB])('%s es neutro: no importa de lib/server ni de astro:env (RT-B6)', (file) => {
    const imports = read(file).split(NEWLINE).filter((l) => l.trimStart().startsWith('import ') || l.includes(" from '"));
    imports.forEach((l) => {
      expect(l, l).not.toContain('lib/server');
      expect(l, l).not.toContain('astro:env');
    });
  });

  test.each(COMPONENTS)('%s: sin colores ni tamaños de letra fijos y con sus estilos en @layer components (RT-B5)', (file) => {
    const css = styleOf(read(file));
    expect(HEX_COLOR.test(css)).toBe(false);
    expect(FONT_PX.test(css)).toBe(false);
    ['rgb(', 'rgba(', 'hsl(', 'color-mix'].forEach((bad) => expect(css, bad).not.toContain(bad));
    // La familia de letra solo puede salir de un token: `font-family: var(--font-ui)`.
    css.split('font-family:').slice(ONE_PART).forEach((rest) => expect(rest.trim().startsWith('var(')).toBe(true));
    if (css.length > NONE) expect(css).toContain('@layer components');
  });

  test('el dinero se convierte solo con parseSoles/solesInput: sin coma flotante en product-form.ts', () => {
    const src = read('lib/admin/product-form.ts');
    ['parseFloat', 'toFixed', 'Math.round', 'Math.floor * 100'].forEach((bad) => expect(src, bad).not.toContain(bad));
    expect(src).toContain('parseSoles');
    expect(src).toContain('solesInput');
  });

  test.each(PAGES)('%s: SSR con las guardias de Origen, rol y UUID, PRG con seeOther y sin `fetch` directo', (file) => {
    const src = read(file);
    expect(src).toContain('export const prerender = false');
    expect(src).toContain('requireAdmin');
    expect(src).toContain('checkAdminOrigin');
    expect(src).toContain('seeOther');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('user_id');
  });

  test('la página de edición valida el UUID antes de llamar al backend', () => {
    const src = read('pages/admin/productos/[product_id].astro');
    expect(src).toContain('isUuid');
    expect(src.indexOf('isUuid')).toBeLessThan(src.indexOf('getAdminProduct('));
  });

  test('los mensajes de interfaz del paquete se traducen por código (no se muestra `.message` del backend)', () => {
    [...PAGES, ...LIB].forEach((file) => expect(read(file), file).not.toContain('.message'));
  });
});

describe('navegación del backoffice', () => {
  test('«Productos» queda habilitado y no se habilita ningún otro módulo de esta tarea', () => {
    const enabled = (s: string) => ADMIN_NAV.find((n) => n.section === s)?.enabled;
    expect(enabled('productos')).toBe(true);
    expect(enabled('panel')).toBe(true);
    ['inventario', 'promociones', 'reportes', 'clientes', 'auditoria'].forEach((s) => expect(enabled(s), s).toBe(false));
  });
});
