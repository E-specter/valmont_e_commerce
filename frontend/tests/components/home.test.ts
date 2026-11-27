import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import CollectionLinks from '../../src/components/home/CollectionLinks.astro';
import CollectionTile from '../../src/components/home/CollectionTile.astro';
import FeaturedProduct from '../../src/components/home/FeaturedProduct.astro';
import HeroCta from '../../src/components/home/HeroCta.astro';
import ManifestoBlock from '../../src/components/home/ManifestoBlock.astro';
import StoreBanner from '../../src/components/home/StoreBanner.astro';
// T-137: hero.png se borró (D-044); el activo de prueba para ImageMetadata es un PNG propio de las pruebas.
import heroImg from '../helpers/fixtures/pixel.png';
import type { ProductSummary } from '../../src/lib/api/catalog';
import { FRONTEND } from '../helpers/css';
import { text, ui } from '../helpers/ui';

// T-121 · componentes de la portada (STATUS "T-121 > Firmas públicas"). Interfaz pública: props -> HTML accesible.
// Los valores de las props son inventados; el texto del servidor debe salir escapado y sin `set:html`.
const NONE = 0;
const ONE = 1;
const MIN_COMPONENTS = 6;
const PRICE = 290000; // S/ 2,900
const SALE = 80000; // S/ 800
const LIST = 100000; // S/ 1,000
const SAVING = 20000;
const IMG = 'https://img.example.test/a.jpg';
const XSS = '<script>window.__pwned=1</script><b>x</b>';

const PRODUCT: ProductSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'demo-reloj-1',
  sku: 'DEMO-001',
  name: 'Demo Reloj 1',
  category: { slug: 'demo-vestir', name: 'Vestir (demo)' },
  price: { amount: PRICE, currency: 'PEN' },
  original_price: null,
  discount_amount: null,
  movement: null,
  case_material: null,
  case_diameter_mm: null,
  water_resistance_m: null,
  main_image: { id: '00000000-0000-4000-8000-000000000002', url: IMG, alt: 'Reloj demo sobre fondo claro' },
  availability: { status: 'in_stock', lead_time_days: null },
};

// Importe es-PE sin decimales redondos: "S/ 2,900" casa; "S/ 29,000" no.
// Probar: https://regex101.com/?flavor=javascript&regex=S%5C%2F%5Cs%3F2%2C900%5Cb&flags=
const AMOUNT_2900 = /S\/\s?2,900(?!\d)/;
// "Precio original S/ 1,000" casa; "S/ 10,000" no.
// Probar: https://regex101.com/?flavor=javascript&regex=S%5C%2F%5Cs%3F1%2C000%5Cb&flags=
const AMOUNT_1000 = /S\/\s?1,000(?!\d)/;
// "S/ 800" casa; "S/ 8,000" no.
// Probar: https://regex101.com/?flavor=javascript&regex=S%5C%2F%5Cs%3F800%5Cb&flags=
const AMOUNT_800 = /S\/\s?800(?!\d)/;
// Uso prohibido en un componente: "set:html" casa; "set:text" no.
// Probar: https://regex101.com/?flavor=javascript&regex=set%3Ahtml%7CinnerHTML%7C%5Cbfetch%5Cs*%5C(&flags=
const FORBIDDEN = /set:html|innerHTML|[^\w]fetch\s*\(/;
// Extensión de componente: "a.astro" casa; "a.ts" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5C.astro%24&flags=
const ASTRO_FILE = /\.astro$/;

const imgs = (b: ParentNode): HTMLImageElement[] => [...b.querySelectorAll('img')];
const hasSize = (img: Element): boolean => Number(img.getAttribute('width')) > NONE && Number(img.getAttribute('height')) > NONE;

describe('HeroCta', () => {
  const props = { title: 'Tradición mecánica', ctaLabel: 'Explorar', ctaHref: '/relojes', image: { src: IMG, alt: 'Reloj de pulsera' } };

  test('un único h1 con el título y un enlace de llamada a la acción con su href', async () => {
    const b = await ui(HeroCta, props);
    const h1s = b.querySelectorAll('h1');
    expect(h1s).toHaveLength(ONE);
    expect(text(h1s[0])).toBe('Tradición mecánica');
    const cta = [...b.querySelectorAll('a')].find((a) => text(a).includes('Explorar'));
    expect(cta?.getAttribute('href')).toBe('/relojes');
  });

  test('la imagen de LCP es eager con fetchpriority alta, nunca lazy, con alt y dimensiones', async () => {
    const [img] = imgs(await ui(HeroCta, props));
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.getAttribute('alt')).toBe('Reloj de pulsera');
    expect(img.getAttribute('src')).toBe(IMG);
    expect(hasSize(img)).toBe(true);
  });

  test('con ImageMetadata (astro:assets) la imagen también es eager/high y trae dimensiones', async () => {
    const [img] = imgs(await ui(HeroCta, { ...props, image: { src: heroImg, alt: 'Reloj de pulsera' } }));
    expect(img).toBeTruthy();
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(hasSize(img)).toBe(true);
  });

  test('el texto se escapa: no se interpreta HTML', async () => {
    const b = await ui(HeroCta, { ...props, title: XSS, image: { src: IMG, alt: XSS } });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('h1 b')).toBeNull();
    expect(text(b.querySelector('h1'))).toContain('<script>');
    expect(imgs(b)[0].getAttribute('alt')).toBe(XSS);
  });
});

describe('ManifestoBlock', () => {
  test('muestra el texto y un enlace con su etiqueta y href; sin encabezados', async () => {
    const b = await ui(ManifestoBlock, { text: 'Una boutique de relojería.', linkLabel: 'Conoce nuestra historia', linkHref: '/nosotros' });
    expect(text(b)).toContain('Una boutique de relojería.');
    const a = b.querySelector('a');
    expect(text(a)).toBe('Conoce nuestra historia');
    expect(a?.getAttribute('href')).toBe('/nosotros');
    expect(b.querySelectorAll('h1,h2,h3')).toHaveLength(NONE);
  });

  test('escapa el texto', async () => {
    const b = await ui(ManifestoBlock, { text: XSS, linkLabel: XSS, linkHref: '/x' });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('b')).toBeNull();
  });
});

describe('CollectionTile', () => {
  test('es un único enlace con el título, el href dado y sin imagen por defecto (bloque de color)', async () => {
    const b = await ui(CollectionTile, { title: 'Vestir (demo)', href: '/relojes?category=demo-vestir' });
    const links = b.querySelectorAll('a');
    expect(links).toHaveLength(ONE);
    expect(links[0].getAttribute('href')).toBe('/relojes?category=demo-vestir');
    expect(text(links[0])).toContain('Vestir (demo)');
    expect(imgs(b)).toHaveLength(NONE);
  });

  test('image nula equivale a sin imagen', async () => {
    const b = await ui(CollectionTile, { title: 'Buceo', href: '/relojes?category=b', image: null });
    expect(imgs(b)).toHaveLength(NONE);
    expect(b.querySelectorAll('a')).toHaveLength(ONE);
  });

  test('con imagen: lazy, alt del llamador, width y height', async () => {
    const [img] = imgs(await ui(CollectionTile, { title: 'Buceo', href: '/r', image: { src: IMG, alt: 'Esfera azul' } }));
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('Esfera azul');
    expect(hasSize(img)).toBe(true);
  });

  test('con ImageMetadata también es lazy y trae dimensiones', async () => {
    const [img] = imgs(await ui(CollectionTile, { title: 'Buceo', href: '/r', image: { src: heroImg, alt: 'Esfera' } }));
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(hasSize(img)).toBe(true);
  });

  test('el título del servidor se escapa', async () => {
    const b = await ui(CollectionTile, { title: XSS, href: '/r' });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('b')).toBeNull();
    expect(text(b)).toContain('<script>');
  });
});

describe('CollectionLinks', () => {
  test('un nav con nombre accesible y un enlace por elemento, con su href y etiqueta, en orden', async () => {
    const b = await ui(CollectionLinks, {
      links: [
        { label: 'Vestir', href: '/relojes?category=demo-vestir' },
        { label: 'Buceo', href: '/relojes?category=demo-buceo' },
      ],
    });
    const nav = b.querySelector('nav');
    expect(nav?.getAttribute('aria-label') ?? nav?.getAttribute('aria-labelledby')).toBeTruthy();
    expect([...b.querySelectorAll('a')].map((a) => [text(a), a.getAttribute('href')])).toEqual([
      ['Vestir', '/relojes?category=demo-vestir'],
      ['Buceo', '/relojes?category=demo-buceo'],
    ]);
  });

  test('lista vacía: sin enlaces', async () => {
    expect((await ui(CollectionLinks, { links: [] })).querySelectorAll('a')).toHaveLength(NONE);
  });

  test('etiqueta con HTML se escapa', async () => {
    const b = await ui(CollectionLinks, { links: [{ label: XSS, href: '/r' }] });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('a b')).toBeNull();
  });
});

describe('StoreBanner', () => {
  const props = { title: 'Visítanos', text: 'Con cita previa.', linkLabel: 'Contáctanos', linkHref: '/nosotros#contacto' };

  test('título (nivel 2, nunca h1), texto y enlace; sin imagen no hay <img>', async () => {
    const b = await ui(StoreBanner, props);
    expect(b.querySelectorAll('h1')).toHaveLength(NONE);
    expect(text(b.querySelector('h2'))).toBe('Visítanos');
    expect(text(b)).toContain('Con cita previa.');
    const a = b.querySelector('a');
    expect(text(a)).toBe('Contáctanos');
    expect(a?.getAttribute('href')).toBe('/nosotros#contacto');
    expect(imgs(b)).toHaveLength(NONE);
  });

  test('image nula: sin <img>; con imagen: lazy, alt, width y height', async () => {
    expect(imgs(await ui(StoreBanner, { ...props, image: null }))).toHaveLength(NONE);
    const [img] = imgs(await ui(StoreBanner, { ...props, image: { src: IMG, alt: 'Boutique' } }));
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('Boutique');
    expect(hasSize(img)).toBe(true);
  });

  test('escapa el texto', async () => {
    const b = await ui(StoreBanner, { ...props, title: XSS, text: XSS, linkLabel: XSS });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('b')).toBeNull();
  });
});

describe('FeaturedProduct', () => {
  const productLink = (b: ParentNode): Element | undefined =>
    [...b.querySelectorAll('a')].find((x) => x.getAttribute('href')?.startsWith('/relojes/'));

  test('nombre en h2 (nunca h1), categoría, precio es-PE del servidor y enlace a la ficha', async () => {
    const b = await ui(FeaturedProduct, { product: PRODUCT });
    expect(b.querySelectorAll('h1')).toHaveLength(NONE);
    expect(text(b.querySelector('h2'))).toBe('Demo Reloj 1');
    expect(text(b)).toContain('Vestir (demo)');
    expect(text(b)).toMatch(AMOUNT_2900);
    expect(productLink(b)?.getAttribute('href')).toBe('/relojes/demo-reloj-1');
  });

  test('muestra la insignia "Novedad" por defecto', async () => {
    expect(text(await ui(FeaturedProduct, { product: PRODUCT }))).toContain('Novedad');
  });

  test('la imagen es la del contrato: lazy, alt del contrato, width y height', async () => {
    const [img] = imgs(await ui(FeaturedProduct, { product: PRODUCT }));
    expect(img.getAttribute('src')).toBe(IMG);
    expect(img.getAttribute('alt')).toBe('Reloj demo sobre fondo claro');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(hasSize(img)).toBe(true);
  });

  test('con descuento muestra el precio original tal como lo manda el servidor (sin recalcular)', async () => {
    const b = await ui(FeaturedProduct, {
      product: {
        ...PRODUCT,
        price: { amount: SALE, currency: 'PEN' },
        original_price: { amount: LIST, currency: 'PEN' },
        discount_amount: { amount: SAVING, currency: 'PEN' },
      },
    });
    expect(b.querySelector('del')).not.toBeNull();
    expect(text(b)).toMatch(AMOUNT_1000);
    expect(text(b)).toMatch(AMOUNT_800);
  });

  test('el slug se codifica en el href y el nombre se escapa', async () => {
    const b = await ui(FeaturedProduct, { product: { ...PRODUCT, slug: 'a b/c?d', name: XSS } });
    expect(b.querySelector('script')).toBeNull();
    expect(b.querySelector('h2 b')).toBeNull();
    expect(productLink(b)?.getAttribute('href')).toBe('/relojes/a%20b%2Fc%3Fd');
  });
});

describe('seguridad común de home/', () => {
  test('ningún componente de home/ usa set:html, innerHTML ni fetch', () => {
    const dir = join(FRONTEND, 'src', 'components', 'home');
    const files = readdirSync(dir).filter((f) => ASTRO_FILE.test(f));
    expect(files.length).toBeGreaterThanOrEqual(MIN_COMPONENTS);
    files.forEach((f) => expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(FORBIDDEN));
  });
});
