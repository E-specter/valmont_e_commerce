import { describe, expect, test } from 'vitest';
import { read } from '../helpers/css';

// T-125 · reglas de código de los 5 archivos del paquete: RT-1 (solo tokens, `@layer components`), RT-2 (componentes sin fetch),
// RT-5 (nada de `set:html`), RT-7 (formato por lib/format.ts) y las decisiones de la página (SSR, caché, rewrite a 404).
const COMPONENTS = ['src/components/catalog/ProductGallery.astro', 'src/components/catalog/BuyBox.astro'];
const PAGES = ['src/pages/relojes/[slug].astro', 'src/pages/404.astro'];
const FILES = [...COMPONENTS, ...PAGES, 'src/components/catalog/spec-rows.ts'];
const STYLED = [...COMPONENTS, 'src/pages/relojes/[slug].astro'];
const HEX_DIGITS = '0123456789abcdefABCDEF';
const MIN_HEX = 3;
const MAX_HEX = 8;
const SCRIPT_MAX_LINES = 30;
const ONE = 1;
const NONE = 0;
const THREE = 3;
/** Colores `#rgb`, `#rrggbb` o `#rrggbbaa`: un `#` seguido de entre 3 y 8 dígitos hexadecimales. */
const hexLike = (src: string): string[] =>
  src
    .split('#')
    .slice(ONE)
    .map((rest) => {
      const digits = [...rest].findIndex((c) => !HEX_DIGITS.includes(c));
      return digits === -ONE ? rest.length : digits;
    })
    .map((n, i, all) => (n >= MIN_HEX && n <= MAX_HEX ? `#${all[i]}` : ''))
    .filter(Boolean);
const styleOf = (src: string): string => src.split('<style').slice(ONE).join('<style');
const scriptOf = (src: string): string => src.split('<script>').slice(ONE).join('').split('</script>')[NONE] ?? '';

describe('T-125 · estilos (RT-1)', () => {
  test.each(STYLED)('%s: ningún color #hex en su <style> (solo variables de tokens)', (file) => {
    expect(hexLike(styleOf(read(file)))).toEqual([]);
  });

  test.each(STYLED)('%s: sin font-family literal ni tamaños de letra en px', (file) => {
    const css = styleOf(read(file));
    css
      .split(';')
      .filter((d) => d.includes('font-family'))
      .forEach((d) => expect(d.includes('var(--font-')).toBe(true));
    css
      .split(';')
      .filter((d) => d.trim().startsWith('font-size'))
      .forEach((d) => expect(d.includes('px')).toBe(false));
  });

  test.each(STYLED)('%s: el CSS va dentro de @layer components', (file) => {
    const css = styleOf(read(file));
    expect(css.length).toBeGreaterThan(NONE);
    expect(css.includes('@layer components')).toBe(true);
  });

  test.each(FILES)('%s: ningún #hex tampoco en el marcado ni en el código', (file) => {
    const src = read(file).split('<style')[NONE];
    expect(hexLike(src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.includes('regex101')).join('\n'))).toEqual([]);
  });
});

describe('T-125 · seguridad y capas (RT-2, RT-5, RT-7)', () => {
  test.each(FILES)('%s: sin set:html, innerHTML, console ni eval', (file) => {
    const src = read(file);
    ['set:html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'console.', 'eval(', 'document.write'].forEach((bad) =>
      expect(src.includes(bad), `${file} contiene ${bad}`).toBe(false),
    );
  });

  test.each([...COMPONENTS, 'src/components/catalog/spec-rows.ts'])('%s: sin fetch ni acceso a la API (RT-2)', (file) => {
    const src = read(file);
    expect(src.includes('fetch(')).toBe(false);
    expect(src.includes('serverTransport')).toBe(false);
    expect(src.includes('getProduct')).toBe(false);
    expect(src.includes('/api/v1')).toBe(false);
  });

  test.each(FILES)('%s: sin toFixed, toLocaleString ni Intl sueltos (RT-7)', (file) => {
    const src = read(file);
    ['toFixed', 'toLocaleString', 'Intl.NumberFormat'].forEach((bad) => expect(src.includes(bad)).toBe(false));
  });

  test('BuyBox no calcula importes: ninguna resta ni multiplicación sobre price/amount (RN-09)', () => {
    const src = read('src/components/catalog/BuyBox.astro').split('<style')[NONE];
    expect(src.includes('.amount')).toBe(false);
  });

  test('la descripción se presenta con white-space: pre-line', () => {
    expect(styleOf(read('src/components/catalog/BuyBox.astro')).includes('white-space: pre-line')).toBe(true);
  });

  test('ningún secreto ni la URL del backend en los archivos del paquete', () => {
    FILES.forEach((file) => {
      const src = read(file);
      ['127.0.0.1:8000', 'API_BASE_URL', 'SUPABASE_ANON_KEY', 'Bearer '].forEach((bad) => expect(src.includes(bad), `${file}: ${bad}`).toBe(false));
    });
  });
});

describe('T-125 · galería: un script corto (< 30 líneas) y miniaturas como enlaces', () => {
  const src = read('src/components/catalog/ProductGallery.astro');

  test('un único <script> de menos de 30 líneas', () => {
    expect(src.split('<script').length - ONE).toBe(ONE);
    expect(scriptOf(src).split('\n').length).toBeLessThan(SCRIPT_MAX_LINES);
  });

  test('el script no usa HTML dinámico ni red: solo cambia src, alt y aria-current', () => {
    const js = scriptOf(src);
    ['fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.cookie'].forEach((bad) => expect(js.includes(bad)).toBe(false));
    expect(js.includes('aria-current')).toBe(true);
  });
});

describe('T-125 · página: SSR bajo demanda, caché y 404 real', () => {
  const page = read('src/pages/relojes/[slug].astro');
  const notFound = read('src/pages/404.astro');

  test('la ficha y la 404 son bajo demanda (prerender = false)', () => {
    expect(page.includes('export const prerender = false')).toBe(true);
    expect(notFound.includes('export const prerender = false')).toBe(true);
  });

  test('declara la caché pública del paquete y no-store para el error', () => {
    expect(page.includes('public, max-age=30, stale-while-revalidate=60')).toBe(true);
    expect(page.includes('no-store')).toBe(true);
  });

  test('inexistente o despublicado se reescribe a /404 (estado 404 real); el error de API da 502', () => {
    expect(page.includes("Astro.rewrite('/404')")).toBe(true);
    expect(page.includes('502')).toBe(true);
    expect(page.includes('500')).toBe(false);
  });

  test('la 404 usa EmptyState y un enlace al catálogo, y no consulta la API', () => {
    expect(notFound.includes('EmptyState')).toBe(true);
    expect(notFound.includes('/relojes')).toBe(true);
    expect(notFound.includes('getProduct')).toBe(false);
    expect(notFound.includes('fetch(')).toBe(false);
  });

  test('N-2: slug vacío, "." y ".." se rechazan antes de llamar a la API', () => {
    const guard = page.indexOf("'..'");
    const call = page.indexOf('getProduct(serverTransport');
    expect(guard).toBeGreaterThan(-ONE);
    expect(call).toBeGreaterThan(guard);
  });
});

describe('T-132 · orden de capas CSS en producción', () => {
  const layers = (src: string): string => src.split('@layer')[ONE].split(';')[NONE].trim();
  const globalDecl = layers(read('src/styles/global.css'));

  test('BaseLayout declara las capas en línea, antes de cualquier otro estilo del head, con el orden de global.css', () => {
    const head = read('src/layouts/BaseLayout.astro').split('<head>')[ONE];
    expect(head.includes('<style is:inline>')).toBe(true);
    expect(head.indexOf('<style is:inline>')).toBeLessThan(head.indexOf('<Font'));
    expect(head.indexOf('<style is:inline>')).toBeLessThan(head.indexOf('<slot name="head"'));
    expect(layers(head)).toBe(globalDecl);
  });

  test('BuyBox protege palabras largas (descripción y colección) con overflow-wrap', () => {
    const css = styleOf(read('src/components/catalog/BuyBox.astro'));
    expect(css.split('overflow-wrap').length - ONE).toBeGreaterThanOrEqual(THREE);
  });
});
