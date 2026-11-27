import { describe, expect, test } from 'vitest';
import ProductGallery from '../../src/components/catalog/ProductGallery.astro';
import type { ProductImage } from '../../src/lib/api/catalog';
import { image } from '../helpers/product-detail';
import { ui } from '../helpers/ui';

// T-125 · ProductGallery (STATUS "T-125 › Resultado esperado y criterios") con la Container API.
// Props: `{ images: ProductImage[]; productName: string }` (>= 1 imagen). Sin imágenes, la página pasa `[main_image]` (ver E2E);
// aquí se prueba el contrato del componente con 1 y con N imágenes. No se depende de clases ni de atributos data-*.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const FIVE = 5;
const MAIN_W = '712';
const MAIN_H = '593';
const NAME = 'Tourbillon Aurora';

const render = (images: ProductImage[], productName = NAME): Promise<HTMLElement> => ui(ProductGallery, { images, productName });
const five = (): ProductImage[] => Array.from({ length: FIVE }, (_, i) => image(i + ONE, `${NAME}, vista ${i + ONE}`));
/** La imagen principal es la única <img> fuera de un enlace; las miniaturas son <img> dentro de <a>. */
const mainImgs = (body: HTMLElement): Element[] => [...body.querySelectorAll('img')].filter((i) => i.closest('a') === null);
const thumbLinks = (body: HTMLElement): Element[] => [...body.querySelectorAll('a')].filter((a) => a.querySelector('img') !== null);

describe('ProductGallery · imagen principal (LCP)', () => {
  test.each([ONE, FIVE])('con %i imagen(es): una sola principal, la primera del contrato, con su alt', async (n) => {
    const imgs = Array.from({ length: n }, (_, i) => image(i + ONE, `Alt propio ${i + ONE}`));
    const main = mainImgs(await render(imgs));
    expect(main).toHaveLength(ONE);
    expect(main[NONE].getAttribute('src')).toBe(imgs[NONE].url);
    expect(main[NONE].getAttribute('alt')).toBe('Alt propio 1');
  });

  test.each([ONE, FIVE])('con %i imagen(es): la principal es la de LCP (fetchpriority high, sin lazy, con width, height y decoding async)', async (n) => {
    const imgs = Array.from({ length: n }, (_, i) => image(i + ONE));
    const [main] = mainImgs(await render(imgs));
    expect(main.getAttribute('fetchpriority')).toBe('high');
    expect(main.getAttribute('loading')).not.toBe('lazy');
    expect(main.getAttribute('width')).toBe(MAIN_W);
    expect(main.getAttribute('height')).toBe(MAIN_H);
    expect(main.getAttribute('decoding')).toBe('async');
  });

  test('solo la principal lleva fetchpriority high; las miniaturas no compiten por el LCP', async () => {
    const body = await render(five());
    expect(body.querySelectorAll('img[fetchpriority="high"]')).toHaveLength(ONE);
    expect(body.querySelector('img[fetchpriority="high"]')).toBe(mainImgs(body)[NONE]);
  });

  test('alt vacío del contrato: nunca queda una imagen sin texto alternativo (se usa el nombre del producto)', async () => {
    const body = await render([image(ONE, '')]);
    const alt = mainImgs(body)[NONE].getAttribute('alt') ?? '';
    expect(alt.trim()).not.toBe('');
    expect(alt).toContain(NAME);
  });
});

describe('ProductGallery · miniaturas', () => {
  test('con 5 imágenes hay 5 miniaturas: enlaces <a href> a la imagen (funcionan sin JavaScript), cada una con su <img> y alt propio', async () => {
    const imgs = five();
    const links = thumbLinks(await render(imgs));
    expect(links).toHaveLength(FIVE);
    links.forEach((a, i) => {
      expect(a.getAttribute('href')).toBe(imgs[i].url);
      const thumb = a.querySelector('img');
      expect(thumb?.getAttribute('src')).toBe(imgs[i].url);
      expect(thumb?.getAttribute('alt')).toBe(imgs[i].alt);
    });
  });

  test('las miniaturas tienen width, height y loading lazy (no son LCP) y ninguna lleva fetchpriority high', async () => {
    const links = thumbLinks(await render(five()));
    links.forEach((a) => {
      const t = a.querySelector('img') as Element;
      expect(Number(t.getAttribute('width'))).toBeGreaterThan(NONE);
      expect(Number(t.getAttribute('height'))).toBeGreaterThan(NONE);
      expect(t.getAttribute('loading')).toBe('lazy');
      expect(t.getAttribute('fetchpriority')).not.toBe('high');
    });
  });

  test('aria-current va en una sola miniatura, la activa (la primera), y las demás no lo llevan', async () => {
    const links = thumbLinks(await render(five()));
    const current = links.filter((a) => a.hasAttribute('aria-current'));
    expect(current).toHaveLength(ONE);
    expect(current[NONE]).toBe(links[NONE]);
    expect(current[NONE].getAttribute('aria-current')).not.toBe('false');
  });

  test('las miniaturas sin alt en el contrato reciben un alt propio y distinto entre sí', async () => {
    const blank = Array.from({ length: FIVE }, (_, i) => image(i + ONE, ''));
    const alts = thumbLinks(await render(blank)).map((a) => (a.querySelector('img')?.getAttribute('alt') ?? '').trim());
    expect(alts.every((a) => a !== '')).toBe(true);
    expect(new Set(alts).size).toBe(FIVE);
  });

  test('con una sola imagen no hay más de una miniatura y, si existe, es la activa', async () => {
    const links = thumbLinks(await render([image(ONE)]));
    expect(links.length).toBeLessThanOrEqual(ONE);
    links.forEach((a) => expect(a.hasAttribute('aria-current')).toBe(true));
  });

  test('el conjunto de miniaturas tiene un nombre accesible (lista etiquetada o navegación)', async () => {
    const body = await render(five());
    const group = body.querySelector('ul[aria-label], ol[aria-label], nav[aria-label], [role="group"][aria-label], [role="list"][aria-label]');
    expect((group?.getAttribute('aria-label') ?? '').trim()).not.toBe('');
  });
});

describe('ProductGallery · seguridad (RT-5): los textos del servidor son texto', () => {
  test('un alt y un nombre con marcado no inyectan elementos ni rompen atributos', async () => {
    const evil = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
    const body = await render([image(ONE, evil), image(TWO, evil)], evil);
    expect(body.querySelectorAll('[onerror]')).toHaveLength(NONE);
    expect([...body.querySelectorAll('script')].filter((s) => (s.textContent ?? '').includes('alert(2)'))).toEqual([]);
    expect(mainImgs(body)[NONE].getAttribute('alt')).toBe(evil);
  });

  test('una URL con comillas no escapa del atributo', async () => {
    const odd = { id: 'x', url: 'https://img.example.test/a.jpg" onerror="alert(1)', alt: 'Alt' };
    const body = await render([odd, image(TWO)]);
    expect(body.querySelectorAll('[onerror]')).toHaveLength(NONE);
  });
});
