import { describe, expect, test } from 'vitest';
import AwardsList from '../../src/components/about/AwardsList.astro';
import ContactBlock from '../../src/components/about/ContactBlock.astro';
import { text, ui } from '../helpers/ui';

// T-122 · firmas públicas de AwardsList y ContactBlock (STATUS "T-122 › Firmas públicas"), con la Container API.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const YEAR = 2031;
const PHONE = '+51 (1) 555-0100';
const EMAIL = 'hola@ejemplo.test';
const IG = { label: '@ejemplo', href: 'https://www.instagram.com/ejemplo' };
// Nombre de un ítem de prueba: "Primero" casa; "Cuarto" no.
// Probar: https://regex101.com/?flavor=javascript&regex=Primero%7CSegundo%7CTercero&flags=
const ITEM_NAME = /Primero|Segundo|Tercero/;
// Solo dígitos y "+" tras "tel:": "tel:+5115550100" casa; "tel:+51 (1)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Etel%3A%5B%5Cd%2B%5D%2B%24&flags=
const DIAL_ONLY = /^tel:[\d+]+$/;
const XSS = '<script>window.__pwned=1</script><b>x</b>';
const contact = (extra: Record<string, unknown> = {}, slots: Record<string, string> = {}) =>
  ui(ContactBlock, { phone: PHONE, email: EMAIL, instagram: IG, ...extra }, slots);

describe('AwardsList', () => {
  const items = [
    { year: YEAR, title: 'Primero', description: 'Detalle uno' },
    { year: YEAR + ONE, title: 'Segundo' },
    { year: YEAR + TWO, title: 'Tercero', description: 'Detalle tres' },
  ];

  test('es una lista (ul > li) con un elemento por ítem, con año, título y descripción', async () => {
    const body = await ui(AwardsList, { items });
    expect(body.querySelectorAll('ul').length).toBe(ONE);
    const lis = [...body.querySelectorAll('ul > li')];
    expect(lis.length).toBe(THREE);
    expect(text(lis[NONE])).toContain(String(YEAR));
    expect(text(lis[NONE])).toContain('Primero');
    expect(text(lis[NONE])).toContain('Detalle uno');
  });

  test('la descripción es opcional: sin ella no se pinta nada de más', async () => {
    const body = await ui(AwardsList, { items: [{ year: YEAR, title: 'Solo título' }] });
    const li = body.querySelector('li')!;
    expect(text(li)).toContain('Solo título');
    expect(text(li)).not.toContain('undefined');
    // Año + cuerpo (con título): sin un tercer bloque vacío para la descripción.
    expect(li.querySelectorAll('span').length).toBe(THREE);
  });

  test('conserva el orden recibido', async () => {
    const body = await ui(AwardsList, { items });
    const order = [...body.querySelectorAll('li')].map((li) => ITEM_NAME.exec(text(li))?.[NONE]);
    expect(order).toEqual(['Primero', 'Segundo', 'Tercero']);
  });

  test('lista vacía: no pinta elementos (ni revienta)', async () => {
    const body = await ui(AwardsList, { items: [] });
    expect(body.querySelectorAll('li').length).toBe(NONE);
  });

  test('el texto llega escapado (sin inyección de HTML)', async () => {
    const body = await ui(AwardsList, { items: [{ year: YEAR, title: XSS, description: XSS }] });
    expect(body.querySelectorAll('script').length).toBe(NONE);
    expect(body.querySelectorAll('li b').length).toBe(NONE);
    expect(text(body.querySelector('li'))).toContain('<script>');
  });
});

describe('ContactBlock', () => {
  test('sección con id="contacto", encabezado h2 y nombre accesible por aria-labelledby', async () => {
    const body = await contact();
    const sec = body.querySelector('section#contacto')!;
    expect(sec).not.toBeNull();
    expect(body.querySelectorAll('#contacto').length).toBe(ONE);
    const h2 = sec.querySelector('h2')!;
    expect(h2).not.toBeNull();
    expect(h2.id).not.toBe('');
    expect(sec.getAttribute('aria-labelledby')).toBe(h2.id);
    expect(body.querySelectorAll('h1').length).toBe(NONE);
  });

  test('dl con un dt y un dd por dato (teléfono, correo, redes), sin texto suelto dentro del dl', async () => {
    const dl = (await contact()).querySelector('dl')!;
    expect(dl).not.toBeNull();
    const dts = [...dl.querySelectorAll('dt')];
    expect(dts.length).toBe(THREE);
    expect(dl.querySelectorAll('dd').length).toBe(THREE);
    expect(dts.map(text)).toEqual(['Teléfono', 'Correo', 'Redes']);
    expect([...dl.children].every((c) => ['DT', 'DD', 'DIV'].includes(c.tagName))).toBe(true);
  });

  test('el teléfono es un enlace tel: solo con dígitos y "+" (sin espacios, paréntesis ni guiones)', async () => {
    const a = (await contact()).querySelector('a[href^="tel:"]')!;
    expect(a.getAttribute('href')).toBe('tel:+5115550100');
    expect(text(a)).toBe(PHONE);
  });

  test('el correo es un enlace mailto: con el correo recibido', async () => {
    const a = (await contact()).querySelector('a[href^="mailto:"]')!;
    expect(a.getAttribute('href')).toBe(`mailto:${EMAIL}`);
    expect(text(a)).toBe(EMAIL);
  });

  test('la red es un enlace externo con rel="noopener noreferrer"', async () => {
    const a = (await contact()).querySelector(`a[href="${IG.href}"]`)!;
    expect(a).not.toBeNull();
    expect(text(a)).toContain(IG.label);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel') ?? '').toContain('noopener');
  });

  test('sin imagen no pinta <img>; con imagen (URL) la pinta con alt, width/height y carga diferida', async () => {
    expect((await contact()).querySelectorAll('img').length).toBe(NONE);
    expect((await contact({ image: null })).querySelectorAll('img').length).toBe(NONE);
    const img = (await contact({ image: { src: 'https://img.example.test/x.jpg', alt: 'Mostrador de la boutique' } })).querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('Mostrador de la boutique');
    expect(img.getAttribute('src')).toBe('https://img.example.test/x.jpg');
    expect(img.getAttribute('width')).toBeTruthy();
    expect(img.getAttribute('height')).toBeTruthy();
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  test('slot "media" y slot por defecto: el contenido entra en el bloque', async () => {
    const body = await contact({}, { media: '<span id="m">MEDIA</span>', default: '<span id="d">DEFECTO</span>' });
    const sec = body.querySelector('#contacto')!;
    expect(sec.querySelector('#m')).not.toBeNull();
    expect(sec.querySelector('#d')).not.toBeNull();
  });

  test('el contacto llega escapado y el tel: descarta caracteres de marcado', async () => {
    const body = await contact({ phone: `${XSS}+51 1`, email: XSS, instagram: { label: XSS, href: IG.href } });
    expect(body.querySelectorAll('script').length).toBe(NONE);
    expect(body.querySelectorAll('dd b').length).toBe(NONE);
    expect(body.querySelector('a[href^="tel:"]')!.getAttribute('href')).toMatch(DIAL_ONLY);
  });
});
