import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND, read } from '../helpers/css';

// T-146 · pruebas de fuente del detalle de pedido: capas (RT-B6), tokens (RT-B5), privacidad (RT-B7), texto del servidor (RT-B9),
// sin acciones por GET y sin llamadas a la API desde el navegador (AB-1). El comportamiento está en las pruebas de página y de componente.
const PAGE = 'src/pages/admin/pedidos/[order_id].astro';
const COMPONENTS = ['OrderActions', 'OrderLines', 'OrderDelivery', 'OrderSummaryCard'].map((n) => `src/components/admin/${n}.astro`);
const ALL = [PAGE, ...COMPONENTS];
const MIN_SECRET_LEN = 8;
const ONE = 1;
const NONE = 0;
const BODY_WINDOW = 700;
// Hook de secretos (RT-B4): un literal largo (8+ caracteres) asignado a un nombre que contiene key, secret, password o token. Un literal corto o con otro nombre no casa.
// https://regex101.com/?regex=(api%5B_-%5D%3Fkey%7Csecret%7Cpassword%7Ctoken)%5B%22%27%20%5D*%5B%3A%3D%5D%20*%5B%22%27%5D%5B%5E%22%27%5D%7B8%2C%7D%5B%22%27%5D&testString=token%3A%20%27abcdefgh1%27
const SECRET_LITERAL = new RegExp(`(api[_-]?key|secret|password|token)["' ]*[:=] *["'][^"']{${MIN_SECRET_LEN},}["']`, 'i');
// Colores y tipografía sueltos (RT-B5): "#fff" y "rgb(0 0 0)" casan; "var(--color-mint)" no.
// https://regex101.com/?regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb%7Crgba%3F%5C(%7Chsla%3F%5C(%7Ccolor-mix%5C(&testString=color%3A%20%23fff
const LOOSE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/;
// Tamaño de letra en píxeles: "font-size: 14px" casa; "font-size: var(--text-body-ui)" no.
// https://regex101.com/?regex=font-size%3A%5Cs*%5B0-9.%5D%2Bpx&testString=font-size%3A%2014px
const FONT_SIZE_PX = /font-size:\s*[0-9.]+px/;
// Valor de font-family: en "font-family: var(--font-ui);" captura "var(--font-ui)"; "font-family: Arial;" captura "Arial".
// https://regex101.com/?regex=font-family%3A%5Cs*(%5B%5E%3B%7D%5D%2B)&testString=font-family%3A%20var(--font-ui)%3B
const FONT_FAMILY = /font-family:\s*([^;}]+)/g;
// Una hoja `<style>` y lo que contiene.
// https://regex101.com/?regex=%3Cstyle%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%2Fstyle%3E&testString=%3Cstyle%3E.a%7B%7D%3C%2Fstyle%3E
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;
// Identificadores de import hacia `lib/server`: "from '../../lib/server/admin'" casa.
// https://regex101.com/?regex=from%5Cs%2B%5B%27%22%5D%5B%5E%27%22%5D*lib%2Fserver&testString=import%20x%20from%20%27..%2Flib%2Fserver%2Fadmin%27
const IMPORTS_SERVER = /from\s+['"][^'"]*lib\/server/;

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const styles = (src: string): string[] => [...src.matchAll(STYLE_BLOCK)].map((m) => m[ONE]);

describe('T-146 · archivos del paquete', () => {
  ALL.forEach((file) =>
    test(`${file} existe y no está vacío`, () => {
      expect(read(file).length).toBeGreaterThan(NONE);
    }),
  );
});

describe('T-146 · RT-B5, RT-B6, RT-B7, RT-B9 en el fuente', () => {
  ALL.forEach((file) => {
    const src = read(file);
    test(`${file}: sin set:html, innerHTML, console ni fetch directo`, () => {
      expect(src).not.toContain('set:html');
      expect(src).not.toContain('innerHTML');
      expect(src).not.toContain('console.');
      expect(src).not.toContain('fetch(');
      expect(src).not.toContain('document.write');
    });
    test(`${file}: sin secretos literales (hook RT-B4)`, () => {
      expect(SECRET_LITERAL.test(src)).toBe(false);
    });
    test(`${file}: estilos solo con tokens (sin color suelto, font-family ni font-size en px) y dentro de @layer components`, () => {
      styles(src).forEach((css) => {
        expect(LOOSE_COLOR.test(css)).toBe(false);
        [...css.matchAll(FONT_FAMILY)].forEach((m) => expect(m[ONE].startsWith('var(--font-'), m[ONE]).toBe(true));
        expect(FONT_SIZE_PX.test(css)).toBe(false);
        expect(css).toContain('@layer components');
      });
    });
  });

  COMPONENTS.forEach((file) =>
    test(`${file}: no importa de lib/server (RT-B6): recibe todo por props`, () => {
      expect(IMPORTS_SERVER.test(read(file))).toBe(false);
      expect(read(file)).not.toContain('astro:env');
    }),
  );

  test('ningún componente ni isla de src importa de lib/server (grep global de RT-B6)', () => {
    const offenders = [...walk(join(FRONTEND, 'src/components')), ...walk(join(FRONTEND, 'src/islands'))].filter((f) => IMPORTS_SERVER.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('ningún componente de T-146 ni isla llama a la API desde el navegador (AB-1: sin proxy de administración)', () => {
    const islands = walk(join(FRONTEND, 'src/islands')).map((f) => readFileSync(f, 'utf8'));
    islands.forEach((src) => expect(src).not.toContain('/orders/admin'));
    COMPONENTS.forEach((f) => {
      expect(read(f)).not.toContain('/bff');
      expect(read(f)).not.toContain('/api/v1');
    });
  });

  test('«Reembolso» y el texto fijo del stock están en componentes: no se calculan ni vienen del servidor', () => {
    const card = read('src/components/admin/OrderSummaryCard.astro');
    expect(card).toContain('Reembolso');
    expect(card).toContain('El stock no se repone automáticamente');
  });

  test('los componentes usan formatMoney y formatDateTimeNumeric (D-B5 A, D-B6 B), sin Intl propio ni toLocale*', () => {
    COMPONENTS.concat(PAGE).forEach((f) => {
      const src = read(f);
      expect(src).not.toContain('toLocale');
      expect(src).not.toContain('new Intl');
      expect(src).not.toContain('toFixed');
    });
    expect(read('src/components/admin/OrderLines.astro')).toContain('formatMoney');
    expect(read('src/components/admin/OrderSummaryCard.astro')).toContain('formatMoney');
  });
});

describe('T-146 · la página', () => {
  const page = read(PAGE);

  test('es SSR (prerender = false) y fija Cache-Control: private, no-store', () => {
    expect(page).toContain('export const prerender = false');
    expect(page).toContain('private, no-store');
  });

  test('usa la guardia y los ayudantes de T-142 (requireAdmin, checkAdminOrigin, isUuid, seeOther, adminErrorResponse)', () => {
    ['requireAdmin(', 'checkAdminOrigin(', 'isUuid(', 'seeOther(', 'adminErrorResponse('].forEach((fn) => expect(page, fn).toContain(fn));
  });

  test('el cliente de API es transitionOrder/getAdminOrder de T-144 (nada de rutas a mano)', () => {
    expect(page).toContain('getAdminOrder(');
    expect(page).toContain('transitionOrder(');
    expect(page).not.toContain('/orders/admin');
  });

  test('construye «Volver» con parseOrderQuery + orderQueryString y monta el destino como /admin/pedidos', () => {
    expect(page).toContain('parseOrderQuery(');
    expect(page).toContain('orderQueryString(');
    expect(page).toContain('/admin/pedidos');
  });

  test('la validación del UUID ocurre antes de la guardia y de cualquier llamada', () => {
    expect(page.indexOf('isUuid(')).toBeGreaterThan(-ONE);
    expect(page.indexOf('isUuid(')).toBeLessThan(page.indexOf('requireAdmin('));
    expect(page.indexOf('isUuid(')).toBeLessThan(page.indexOf('getAdminOrder('));
  });

  test('la comprobación de Origin y la lectura del cuerpo preceden a la escritura', () => {
    expect(page.indexOf('checkAdminOrigin(')).toBeLessThan(page.indexOf('formData()'));
    expect(page.indexOf('formData()')).toBeLessThan(page.indexOf('transitionOrder('));
  });

  test('la escritura solo ocurre dentro de la rama POST (nada de efectos en GET)', () => {
    const write = page.indexOf('transitionOrder(');
    const branch = page.lastIndexOf("request.method === 'POST'", write);
    expect(branch).toBeGreaterThan(-ONE);
  });

  test('nunca reenvía user_id, role ni importes: el cuerpo de la transición se arma solo con to, note, carrier y tracking_code', () => {
    const body = page.slice(page.indexOf('const body'), page.indexOf('const body') + BODY_WINDOW);
    ['user_id', 'role', 'total', 'amount', 'price'].forEach((k) => expect(body, k).not.toContain(k));
  });

  test('noindex: lo aporta AdminLayout (no se redefine ni se retira en la página)', () => {
    expect(page).toContain('AdminLayout');
    expect(page).not.toContain('index,follow');
  });
});
