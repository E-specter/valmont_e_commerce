import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { about } from '../../src/data/about';
import { FRONTEND, read } from '../helpers/css';

// T-122 · lectura del código fuente: P-9 (no copiar el contenido de marca de Figma), RT-1 (sin valores sueltos), RT-5 (sin set:html).
const NONE = 0;
const ONE = 1;
const THREE = 3;
const TABLET = 800;
const DESKTOP = 1280;
const SRC = join(FRONTEND, 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const TEXT_EXT = ['.astro', '.ts', '.css', '.md', '.json', '.svg', '.mjs'];
const srcFiles = walk(SRC).filter((f) => TEXT_EXT.some((e) => f.endsWith(e)));
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');
const NEW_FILES = [
  'src/pages/nosotros.astro',
  'src/pages/privacidad.astro',
  'src/pages/terminos.astro',
  'src/components/about/AwardsList.astro',
  'src/components/about/ContactBlock.astro',
  'src/data/about.ts',
  'src/data/legal.ts',
];
const PAGES = NEW_FILES.slice(NONE, THREE);

// "Est. 2005" y variantes: "Est. 2005" y "EST 2005" casan; "Establecidos en 2026" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5CbEst%5C.%3F%5Cs*2005%5Cb&flags=i
const EST_2005 = /\bEst\.?\s*2005\b/i;
// Nombre propio del frame de Figma: "Mike Vera" casa; "Mikel" no.
// Probar: https://regex101.com/?flavor=javascript&regex=Mike%5Cs%2BVera&flags=i
const FRAME_NAME = /Mike\s+Vera/i;
// Teléfono del frame (987 654 321, con o sin separadores): "+51 987 654 321" y "987654321" casan; "+51 (1) 625-4500" no.
// Probar: https://regex101.com/?flavor=javascript&regex=987%5B%5Cs.-%5D%3F654%5B%5Cs.-%5D%3F321&flags=
const FRAME_PHONE = /987[\s.-]?654[\s.-]?321/;
// Años de reconocimientos de Figma (2022–2025): "2023" casa; "2026" y "12023" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cb202%5B2-5%5D%5Cb&flags=
const FIGMA_YEARS = /\b202[2-5]\b/;
// Color hexadecimal suelto: "#a1b2c3" casa; "#contacto" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%23%5B0-9A-Fa-f%5D%7B3%2C8%7D%5Cb&flags=
const HEX = /#[0-9A-Fa-f]{3,8}\b/;
// Funciones de color: "rgb(0 0 0)" y "color-mix(" casan; "var(--x)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cb(rgba%3F%7Chsla%3F%7Coklch%7Coklab%7Clab%7Clch%7Ccolor-mix)%5C(&flags=
const COLOR_FN = /\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/;
// font-family con nombre literal: "font-family: Arial" casa; "font-family: var(--font-ui)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=font-family%5Cs*%3A%5Cs*(%3F!var%5C()(%3F!inherit%5Cb)%5CS&flags=
const LOOSE_FONT = /font-family\s*:\s*(?!var\()(?!inherit\b)\S/;
// Tamaño de letra en px/rem suelto: "font-size: 14px" casa; "font-size: var(--text-caption)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=font-size%5Cs*%3A%5Cs*%5B%5Cd.%5D%2B(px%7Crem%7Cem%7Cpt)&flags=
const LOOSE_FONT_SIZE = /font-size\s*:\s*[\d.]+(px|rem|em|pt)/;
// HTML sin escapar: "set:html" casa; "set:text" no.
// Probar: https://regex101.com/?flavor=javascript&regex=set%3Ahtml&flags=
const SET_HTML = /set:html/;
// Petición de red: "fetch(" casa; "prefetch" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cbfetch%5Cs*%5C(&flags=
const FETCH = /\bfetch\s*\(/;
// Prerenderizada: "export const prerender = true;" casa; "= false" no.
// Probar: https://regex101.com/?flavor=javascript&regex=export%20const%20prerender%20%3D%20true&flags=
const PRERENDER_TRUE = /export const prerender = true/;
// Atributo de demostración: "<header data-demo-content>" casa; "data-demo" no.
// Probar: https://regex101.com/?flavor=javascript&regex=data-demo-content&flags=g
const DEMO_ATTR = /data-demo-content/g;
// Estilos en línea con color: 'style="color: red"' casa; 'class="x"' no.
// Probar: https://regex101.com/?flavor=javascript&regex=style%3D%5B%22'%7B%5D%5B%5E%3E%5D*(color%7Cbackground)&flags=
const INLINE_STYLE = /style=["'{][^>]*(color|background)/;

// Contacto escrito a mano: "+51 1", "tel:+", "a@b.pe" e "instagram.com" casan; "SITE.phone" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5C%2B51%5Cs%3F%5Cd%7Ctel%3A%5C%2B%7C%5B%5Cw.-%5D%2B%40%5B%5Cw-%5D%2B%5C.%5Ba-z%5D%7B2%2C%7D%7Cinstagram%5C.com&flags=i
const LITERAL_CONTACT = /\+51\s?\d|tel:\+|[\w.-]+@[\w-]+\.[a-z]{2,}|instagram\.com/i;
// Bloque <style>: "<style>a{}</style>" casa y captura "a{}"; "<script>" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%3Cstyle%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fstyle%3E&flags=g
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;
// Ancho de media query: "@media (min-width: 800px)" casa y captura 800; "(max-width: 1px)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%40media%5Cs*%5C(min-width%3A%5Cs*(%5Cd%2B)px%5C)&flags=g
const MEDIA_WIDTH = /@media\s*\(min-width:\s*(\d+)px\)/g;

const lines = (file: string, re: RegExp): string[] =>
  read(file)
    .split(/\r?\n/)
    .flatMap((l, i) => (re.test(l) ? [`${file}:${i + ONE}: ${l.trim()}`] : []));
const across = (files: string[], re: RegExp): string[] => files.flatMap((f) => lines(f, re));

describe('P-9 / D-041 · nada del contenido de marca de Figma en src/', () => {
  test('hay archivos que revisar (la prueba no es vacía)', () => {
    expect(srcFiles.length).toBeGreaterThan(NEW_FILES.length);
  });

  test.each([
    ['"Est. 2005"', EST_2005],
    ['el nombre del frame', FRAME_NAME],
    ['el teléfono del frame', FRAME_PHONE],
  ])('ningún archivo de src/ contiene %s', (_label, re) => {
    expect(across(srcFiles.map(rel), re)).toEqual([]);
  });

  test('los reconocimientos de about.ts no usan los años de Figma (2022–2025)', () => {
    expect(about.awards.items.filter((i) => FIGMA_YEARS.test(String(i.year)))).toEqual([]);
    expect(across(['src/data/about.ts', 'src/pages/nosotros.astro', 'src/components/about/AwardsList.astro'], FIGMA_YEARS)).toEqual([]);
  });

  test('about.ts se declara contenido de demostración (comentario DEMO y etiqueta)', () => {
    expect(read('src/data/about.ts')).toContain('DEMO');
    expect(about.demoLabel).toBe('Contenido de demostración');
  });

  test('el contacto de /nosotros no está escrito a mano: no hay teléfono, correo ni red literales en las páginas y componentes', () => {
    expect(across(['src/pages/nosotros.astro', 'src/components/about/ContactBlock.astro', 'src/components/about/AwardsList.astro'], LITERAL_CONTACT)).toEqual([]);
  });
});

describe('RT-1 · valores sueltos en los archivos nuevos', () => {
  test.each([
    ['#hex', HEX],
    ['rgb()/hsl()/color-mix()', COLOR_FN],
    ['font-family literal', LOOSE_FONT],
    ['font-size suelto', LOOSE_FONT_SIZE],
    ['estilo en línea con color', INLINE_STYLE],
  ])('sin %s', (_label, re) => {
    expect(across(NEW_FILES, re)).toEqual([]);
  });

  test('cada <style> de los componentes y páginas nuevos va envuelto en @layer components', () => {
    NEW_FILES.filter((f) => f.endsWith('.astro')).forEach((f) => {
      const styles = [...read(f).matchAll(STYLE_BLOCK)].map((m) => m[ONE].trim());
      expect(styles.filter((s) => !s.startsWith('@layer components')), f).toEqual([]);
    });
  });

  test('anchos de media query solo con los literales del proyecto (800 y 1280)', () => {
    const widths = NEW_FILES.flatMap((f) => [...read(f).matchAll(MEDIA_WIDTH)].map((m) => Number(m[ONE])));
    const ALLOWED = [TABLET, DESKTOP];
    expect(widths.filter((w) => !ALLOWED.includes(w))).toEqual([]);
  });
});

describe('RT-2 / RT-5 · estático y sin HTML de servidor', () => {
  test.each(NEW_FILES.filter((f) => f.endsWith('.astro')))('%s: sin set:html ni fetch', (f) => {
    expect(lines(f, SET_HTML)).toEqual([]);
    expect(lines(f, FETCH)).toEqual([]);
  });

  test.each(PAGES)('%s: prerender = true (D-024, estática)', (f) => {
    expect(read(f)).toMatch(PRERENDER_TRUE);
  });

  test('las páginas legales y /nosotros importan el contacto y la versión desde lib/site (fuente única, H-22)', () => {
    expect(read('src/pages/nosotros.astro')).toContain("from '../lib/site'");
    expect(read('src/pages/privacidad.astro')).toContain('PRIVACY_VERSION');
  });

  test('/nosotros marca 3 bloques con data-demo-content y las legales 1', () => {
    expect((read('src/pages/nosotros.astro').match(DEMO_ATTR) ?? []).length).toBe(THREE);
    expect((read('src/pages/privacidad.astro').match(DEMO_ATTR) ?? []).length).toBe(ONE);
    expect((read('src/pages/terminos.astro').match(DEMO_ATTR) ?? []).length).toBe(ONE);
  });
});
