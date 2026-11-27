import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import DefinitionList from '../../src/components/ui/DefinitionList.astro';
import HeroCta from '../../src/components/home/HeroCta.astro';
import ManifestoBlock from '../../src/components/home/ManifestoBlock.astro';
import CollectionLinks from '../../src/components/home/CollectionLinks.astro';
import FeaturedBanner from '../../src/components/catalog/FeaturedBanner.astro';
import PageTitle from '../../src/components/layout/PageTitle.astro';
import BuyBox from '../../src/components/catalog/BuyBox.astro';
import { FRONTEND, read } from '../helpers/css';
import { markers, text, ui } from '../helpers/ui';
import { detail } from '../helpers/product-detail';

// T-137 · corrección visual E (D-044, REVIEW-2026-11-27: foto del hero, D-03, D-06, D-07, D-08, D-12, D-13).
// Interfaz pública: props -> HTML. Las reglas de maquetación (ancho, color calculado) están en e2e/t137-visual.spec.ts.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const MIN_FILES = 30;
const PRICE_CENTS = 100000;
const SRC = join(FRONTEND, 'src');
const PUBLIC = join(FRONTEND, 'public');
const FOREIGN = ['citizen', 'eco-drive', 'ecodrive'];
const RASTER = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'];
const BINARY = [...RASTER, '.woff', '.woff2', '.ico'];

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');
const isRaster = (f: string): boolean => RASTER.some((e) => f.toLowerCase().endsWith(e));
const foreign = (s: string): boolean => FOREIGN.some((w) => s.toLowerCase().includes(w));
const imgs = (b: ParentNode): HTMLImageElement[] => [...b.querySelectorAll('img')];

describe('D-044 · sin marcas ajenas en el código ni en los activos', () => {
  const textFiles = [...walk(SRC), ...walk(PUBLIC)].filter((f) => !BINARY.some((e) => f.toLowerCase().endsWith(e)));

  test('hay archivos que revisar (la prueba no es vacía)', () => {
    expect(textFiles.length).toBeGreaterThan(MIN_FILES);
  });

  test('ningún archivo de frontend/src ni de frontend/public menciona CITIZEN ni Eco-Drive', () => {
    expect(textFiles.filter((f) => foreign(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  test('ningún nombre de archivo de src/public menciona la marca ajena', () => {
    expect([...walk(SRC), ...walk(PUBLIC)].filter(foreign).map(rel)).toEqual([]);
  });

  test('la foto del hero se borró: no queda ningún raster en src/assets/home ni un hero.* raster en src', () => {
    expect(existsSync(join(SRC, 'assets', 'home', 'hero.png'))).toBe(false);
    expect(walk(join(SRC, 'assets', 'home'))).toEqual([]);
    expect(walk(SRC).filter((f) => isRaster(f) && f.toLowerCase().includes('hero'))).toEqual([]);
  });

  test('ningún componente, página ni dato referencia una imagen raster de hero', () => {
    const offenders = walk(SRC)
      .filter((f) => f.endsWith('.astro') || f.endsWith('.ts'))
      .filter((f) => {
        const body = readFileSync(f, 'utf8').toLowerCase();
        return body.includes('assets/home/hero') || RASTER.some((e) => body.includes(`hero${e}`));
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  test('la portada y el hero no importan rasters: el bloque usa solo el símbolo SVG de marca', () => {
    const hero = read('src/components/home/HeroCta.astro');
    expect(hero).toContain('/brand/symbol.svg');
    const index = read('src/pages/index.astro');
    expect(RASTER.some((e) => index.includes(`${e}'`) || index.includes(`${e}"`))).toBe(false);
  });
});

describe('D-044 · HeroCta sin foto', () => {
  const props = { title: 'Tradición mecánica', ctaLabel: 'Explorar', ctaHref: '/relojes' };

  test('sin la prop image se renderiza: un h1 con el título y el CTA con su href', async () => {
    const b = await ui(HeroCta, props);
    const h1s = b.querySelectorAll('h1');
    expect(h1s).toHaveLength(ONE);
    expect(text(h1s[NONE])).toBe('Tradición mecánica');
    expect([...b.querySelectorAll('a')].find((a) => text(a).includes('Explorar'))?.getAttribute('href')).toBe('/relojes');
  });

  test('ningún fetchpriority, picture ni srcset: el LCP es el titular, no una imagen', async () => {
    const b = await ui(HeroCta, props);
    expect(b.querySelectorAll('[fetchpriority], picture, source, [srcset]')).toHaveLength(NONE);
  });

  test('las únicas imágenes son activos de marca decorativos (SVG propio, alt vacío, con tamaño): nunca un raster ni texto incrustado', async () => {
    const found = imgs(await ui(HeroCta, props));
    found.forEach((img) => {
      expect(img.getAttribute('src'), img.outerHTML).toBe('/brand/symbol.svg');
      expect(img.getAttribute('alt'), img.outerHTML).toBe('');
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(NONE);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(NONE);
    });
  });

  test('el bloque de marca incluye el damero de 2 filas (decorativo, aria-hidden)', async () => {
    const board = (await ui(HeroCta, props)).querySelector('.checkerboard');
    expect(board).not.toBeNull();
    expect(board?.getAttribute('data-rows')).toBe(String(TWO));
    expect(board?.getAttribute('aria-hidden')).toBe('true');
  });

  test('el HTML renderizado no menciona marcas ajenas', async () => {
    expect(foreign((await ui(HeroCta, props)).innerHTML)).toBe(false);
  });

  test('la prop image sigue siendo opcional y, si se pasa una foto propia, es la imagen de LCP (eager + fetchpriority high)', async () => {
    const [img] = imgs(await ui(HeroCta, { ...props, image: { src: 'https://img.example.test/propia.jpg', alt: 'Reloj propio' } }));
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('alt')).toBe('Reloj propio');
  });

  test('el título del servidor se escapa también sin foto', async () => {
    const b = await ui(HeroCta, { ...props, title: '<script>window.__x=1</script><b>x</b>' });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('h1 b')).toBeNull();
  });
});

describe('D-08 · manifiesto y enlaces gigantes', () => {
  test('el manifiesto no añade encabezados: el único h1 de la portada sigue siendo el del hero', async () => {
    const b = await ui(ManifestoBlock, { text: 'Una boutique.', linkLabel: 'Historia', linkHref: '/nosotros' });
    expect(b.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(NONE);
  });

  test('"(demo)" va en su propio elemento; el enlace conserva su href y su texto accesible íntegro', async () => {
    const b = await ui(CollectionLinks, {
      links: [
        { label: 'Deportivos (demo)', href: '/relojes?category=deportivos' },
        { label: 'Aviador (demo)', href: '/relojes?category=aviador' },
        { label: 'Clásicos', href: '/relojes?category=clasicos' },
      ],
    });
    const links = [...b.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/relojes?category=deportivos',
      '/relojes?category=aviador',
      '/relojes?category=clasicos',
    ]);
    expect(links.map((a) => text(a).split(' ').filter(Boolean).join(' '))).toEqual(['Deportivos (demo)', 'Aviador (demo)', 'Clásicos']);
    expect([...b.querySelectorAll('a *')].filter((e) => text(e) === '(demo)')).toHaveLength(TWO);
    expect(links[TWO].querySelector('*')).toBeNull();
  });

  test('el texto de la categoría se escapa (nunca HTML)', async () => {
    const b = await ui(CollectionLinks, { links: [{ label: '<script>window.__x=1</script> (demo)', href: '/r' }] });
    expect(b.querySelector('script')).toBeNull();
  });
});

describe('D-12 · DefinitionList variante rows', () => {
  const ITEMS = [
    { term: 'Calibre', description: 'Automático 9001' },
    { term: 'Caja', description: 'Oro 18K' },
  ];
  const wrap = async (props: Record<string, unknown>): Promise<Element> =>
    (await ui(DefinitionList, { items: ITEMS, ...props })).querySelector('dl')?.parentElement as Element;

  test('rows se distingue del uso por defecto en el marcado; columns y el uso por defecto no cambian', async () => {
    const base = markers(await wrap({}));
    expect(markers(await wrap({ variant: 'rows' }))).not.toBe(base);
    expect(markers(await wrap({ columns: TWO }))).not.toBe(base);
    expect(markers(await wrap({ variant: 'stacked' }))).toBe(base);
  });

  test('con rows cada fila conserva su <dt> y su <dd>, en orden, y nada se interpreta como HTML', async () => {
    const hostile = [{ term: '<i id="t">x</i>', description: '<script>window.__x=1</script>' }, ...ITEMS];
    const body = await ui(DefinitionList, { items: hostile, variant: 'rows' });
    expect([...body.querySelectorAll('dt')].map(text)).toEqual(hostile.map((i) => i.term));
    expect([...body.querySelectorAll('dd')].map(text)).toEqual(hostile.map((i) => i.description));
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('i#t')).toBeNull();
  });

  test('la ficha usa variant="rows" y no columns={2}; el muestrario /dev/products conserva columns', () => {
    const page = read('src/pages/relojes/[slug].astro');
    expect(page).toContain('variant="rows"');
    expect(page).not.toContain('columns={2}');
    expect(read('src/pages/dev/products.astro')).toContain('columns=');
  });
});

describe('D-06 · PageTitle; D-07 · banner sin CTA; D-13 · asesor', () => {
  test('PageTitle sigue renderizando h1 por defecto y h2 con level=2', async () => {
    expect((await ui(PageTitle, { title: 'Relojes' })).querySelectorAll('h1')).toHaveLength(ONE);
    const two = await ui(PageTitle, { title: 'Relojes', level: TWO });
    expect(two.querySelectorAll('h1')).toHaveLength(NONE);
    expect(two.querySelectorAll('h2')).toHaveLength(ONE);
  });

  test('FeaturedBanner: sin enlace ni botón (P-2), marcado de demostración, sin h1 y con bloque de color decorativo', async () => {
    const b = await ui(FeaturedBanner, { kicker: 'Destacado', title: 'Pieza', description: 'Texto', price: { amount: PRICE_CENTS, currency: 'PEN' } });
    expect(b.querySelectorAll('a, button, input, select, [tabindex]')).toHaveLength(NONE);
    expect(b.querySelector('[data-demo-content]')).not.toBeNull();
    expect(b.querySelectorAll('h1')).toHaveLength(NONE);
    expect(b.querySelector('[aria-hidden="true"] img[alt=""]')).not.toBeNull();
  });

  test('BuyBox: "Consultar con un asesor" sigue siendo un enlace a /nosotros#contacto', async () => {
    const b = await ui(BuyBox, { product: detail() });
    const a = [...b.querySelectorAll('a')].find((x) => text(x).includes('Consultar con un asesor'));
    expect(a?.getAttribute('href')).toBe('/nosotros#contacto');
  });
});
