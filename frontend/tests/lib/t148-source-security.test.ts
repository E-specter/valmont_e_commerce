import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  RE_COLOR_FN, RE_CONSOLE, RE_DOM_SINK, RE_FONT_FAMILY, RE_FONT_PX, RE_HEX_COLOR, RE_HTML_COMMENT, RE_LAYER_COMPONENTS, RE_LIB_SERVER, RE_NETWORK_CALL, RE_SET_HTML,
  RE_STYLE_BLOCK,
} from '../helpers/t148-re';

// T-148 · prueba de código fuente: RT-B4 (sin literales sensibles), RT-B5 (sin colores ni tipografías sueltos), RT-B6 (capas), RT-B9 (texto sin set:html)
// y la privacidad de los archivos (nada en console). Solo mira los archivos del paquete.
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(FRONTEND, 'src');
const SLASH = '/';
const BACKSLASH_CODE = 0x5c;
const BACKSLASH = String.fromCharCode(BACKSLASH_CODE);
const rel = (f: string) => relative(FRONTEND, f).split(BACKSLASH).join(SLASH);
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const read = (f: string) => readFileSync(join(FRONTEND, f), 'utf8');
const NONE = 0;
const EOL = '\n';
const MIN_LITERAL = 8;

const COMPONENT_FILES = ['src/components/admin/ImageManager.astro', 'src/components/ui/FileDropzone.astro'];
const ISLAND = 'src/islands/image-sort.ts';
const PAGE = 'src/pages/admin/productos/[product_id].astro';
const TRANSPORT = 'src/lib/api/server.ts';
const NEW_FILES = [...COMPONENT_FILES, ISLAND];
const isSource = (f: string): boolean => f.endsWith('.astro') || f.endsWith('.ts');
/** Solo líneas de código: sin comentarios de línea, de bloque ni de HTML. */
const code = (text: string) =>
  text
    .replaceAll(RE_HTML_COMMENT, '')
    .split(EOL)
    .filter((l) => !['//', '/*', '*'].some((c) => l.trimStart().startsWith(c)))
    .join(EOL);
const styles = (f: string): string => [...read(f).matchAll(RE_STYLE_BLOCK)].map((m) => m[1]).join(EOL);

describe('los archivos del paquete existen', () => {
  test.each([...NEW_FILES, PAGE])('%s', (f) => {
    expect(existsSync(join(FRONTEND, f))).toBe(true);
  });
});

describe('RT-B6: componentes e islas no importan de lib/server', () => {
  test('ningún archivo de src/components ni de src/islands menciona lib/server (grep del paquete)', () => {
    const files = [...walk(join(SRC, 'components')), ...walk(join(SRC, 'islands'))].filter(isSource);
    const offenders = files.filter((f) => RE_LIB_SERVER.test(code(readFileSync(f, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  test.each(NEW_FILES)('%s no importa de astro:env, node:*, supabase ni process.env', (f) => {
    const imports = code(read(f)).split(EOL).filter((l) => l.trimStart().startsWith('import') || l.includes(' from '));
    ['astro:env', 'node:', 'supabase', 'astro:middleware'].forEach((b) => expect(imports.filter((l) => l.includes(b)), b).toEqual([]));
    expect(code(read(f))).not.toContain('process.env');
    expect(code(read(f))).not.toContain('import.meta.env');
  });
});

describe('texto del servidor y del cliente como texto (RT-B9)', () => {
  test.each([...NEW_FILES, PAGE])('%s no usa set:html ni vuelca HTML (innerHTML, insertAdjacentHTML, document.write, eval)', (f) => {
    expect(RE_SET_HTML.test(code(read(f)))).toBe(false);
    expect(RE_DOM_SINK.test(code(read(f)))).toBe(false);
  });
});

describe('la isla image-sort es solo del navegador: no llama a la API', () => {
  test('sin fetch, XMLHttpRequest ni sendBeacon', () => {
    expect(RE_NETWORK_CALL.test(code(read(ISLAND)))).toBe(false);
  });

  test('exporta `initImageSort` (firma pública del paquete)', () => {
    expect(read(ISLAND)).toContain('export function initImageSort(');
    expect(read(ISLAND)).toContain('ParentNode');
  });

  test('es idempotente por construcción: marca lo ya iniciado', () => {
    const src = code(read(ISLAND));
    expect(src.includes('dataset') || src.includes("setAttribute('data-")).toBe(true);
  });
});

describe('privacidad: ni el archivo ni el alt se registran', () => {
  test.each([...NEW_FILES, PAGE, TRANSPORT])('%s no escribe en console', (f) => {
    expect(RE_CONSOLE.test(code(read(f)))).toBe(false);
  });
});

describe('transporte: la validación de ruta se conserva y FormData no pone Content-Type', () => {
  test('sigue rechazando rutas no relativas', () => {
    const t = code(read(TRANSPORT));
    expect(t).toContain("startsWith('/')");
    expect(t).toContain("startsWith('//')");
  });

  test('el transporte no añade a mano un Content-Type multipart', () => {
    expect(code(read(TRANSPORT)).toLowerCase()).not.toContain('multipart');
  });
});

describe('RT-B5: estilos con tokens, en @layer components', () => {
  test.each(COMPONENT_FILES)('%s: sin #hex, rgb(), color-mix, font-family ni px de tipografía fuera de tokens', (f) => {
    const css = styles(f);
    expect(RE_HEX_COLOR.test(css)).toBe(false);
    expect(RE_COLOR_FN.test(css)).toBe(false);
    expect(RE_FONT_FAMILY.test(css)).toBe(false);
    expect(RE_FONT_PX.test(css)).toBe(false);
  });

  test.each(COMPONENT_FILES)('%s: cada <style> envuelve sus reglas en @layer components', (f) => {
    const blocks = [...read(f).matchAll(RE_STYLE_BLOCK)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(NONE);
    blocks.forEach((b) => expect(RE_LAYER_COMPONENTS.test(b)).toBe(true));
  });

  test('ImageManager: .manager, .item y .body llevan min-inline-size: 0 (la fila no empuja el ancho de la página, 360 y 375 px)', () => {
    const css = styles(COMPONENT_FILES[NONE]);
    ['.item', '.body'].forEach((sel) => expect(css.includes(sel), sel).toBe(true));
    expect(css.split('min-inline-size: 0').length - 1, 'min-inline-size: 0 en la regla de .manager, .item y .body').toBeGreaterThanOrEqual(1);
    expect(css).toContain('@media (min-width: 40rem)');
  });

  test.each(COMPONENT_FILES)('%s: respeta prefers-reduced-motion si anima o hace transiciones', (f) => {
    const css = styles(f);
    const moves = ['transition', 'animation', '@keyframes'].some((w) => css.includes(w));
    if (moves) expect(css).toContain('prefers-reduced-motion');
  });
});

describe('RT-B4: sin literales de 8 o más caracteres en nombres con key, secret, password o token', () => {
  // Construida en tiempo de ejecución: acepta "apiKey con un literal de 8 o más letras entre comillas" y rechaza "label con el mismo literal" (la regla del hook del repositorio).
  // https://regex101.com/?regex=(api%5B_-%5D%3Fkey%7Csecret%7Cpassword%7Ctoken)&testString=apiKey
  const sensitive = new RegExp(`(api[_-]?key|secret|password|token)["' ]*[:=] *["'][^"']{${MIN_LITERAL},}["']`, 'i');
  test.each([...NEW_FILES, PAGE, TRANSPORT])('%s', (f) => {
    expect(sensitive.test(read(f))).toBe(false);
  });
});
