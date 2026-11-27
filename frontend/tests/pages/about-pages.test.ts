import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import Nosotros from '../../src/pages/nosotros.astro';
import Privacidad from '../../src/pages/privacidad.astro';
import Terminos from '../../src/pages/terminos.astro';
import { about } from '../../src/data/about';
import { privacy, terms } from '../../src/data/legal';
import { formatDateOnly } from '../../src/lib/format';
import { PRIVACY_VERSION, SITE } from '../../src/lib/site';
import { FRONTEND } from '../helpers/css';
import { renderDocument } from '../helpers/render';
import { text } from '../helpers/ui';

// T-122 · las tres páginas estáticas renderizadas con la Container API (STATUS "T-122 › Criterios de aceptación", RT-4, D-041 P-9, RNF10).
const NONE = 0;
const ONE = 1;
const THREE = 3;
const MIN_LINE = 55;
const MAX_LINE = 75;
const DEMO = 'Contenido de demostración';
// Marcas diacríticas Unicode: la "ó" descompuesta deja "o" + U+0301 y casa; "o" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cp%7BM%7D&flags=gu
const DIACRITICS = /\p{M}/gu;
// Caracteres que no son dígito ni "+": "(1) 6" casa en "(", ")" y " "; "+511" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5B%5E%5Cd%2B%5D&flags=g
const NOT_DIAL = /[^\d+]/g;
// Esquema peligroso: "javascript:alert(1)" casa; "/nosotros" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%5Cs*javascript%3A&flags=i
const JS_SCHEME = /^\s*javascript:/i;
// Ancho en caracteres: "max-inline-size: 68ch" casa y captura 68; "max-width: 68px" no.
// Probar: https://regex101.com/?flavor=javascript&regex=max-inline-size%3A%5Cs*(%5Cd%2B)ch&flags=g
const WIDTH_CH = /max-inline-size:\s*(\d+)ch/g;
/** Minúsculas y sin tildes, para comparar textos sin depender de la grafía. */
const norm = (s: string): string => s.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
const has = (haystack: string, needle: string): boolean => norm(haystack).includes(norm(needle));
const NOT_FINAL = 'definitiv';
const pages = [
  ['/nosotros', Nosotros, 'nosotros'],
  ['/privacidad', Privacidad, 'privacidad'],
  ['/terminos', Terminos, 'terminos'],
] as const;
const legal = [
  ['/privacidad', Privacidad, privacy],
  ['/terminos', Terminos, terms],
] as const;
const render = (c: Parameters<typeof renderDocument>[0]) => renderDocument(c);
const levels = (doc: Document): number[] => [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[ONE]));

describe.each(pages)('%s · estructura (RT-4)', (_path, Page, titleRe) => {
  test('un solo h1 (dentro de main), un solo main#contenido, lang="es", navegaciones con nombre y pie', async () => {
    const doc = await render(Page);
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    expect(doc.querySelectorAll('main').length).toBe(ONE);
    expect(doc.querySelector('main#contenido')).not.toBeNull();
    expect(doc.querySelector('main')!.contains(doc.querySelector('h1'))).toBe(true);
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.querySelector('footer')).not.toBeNull();
    const navs = [...doc.querySelectorAll('nav')];
    expect(navs.length).toBeGreaterThan(NONE);
    expect(navs.every((n) => n.getAttribute('aria-label') || n.getAttribute('aria-labelledby'))).toBe(true);
  });

  test('jerarquía de encabezados sin saltos (nunca se baja más de un nivel de golpe)', async () => {
    const lv = levels(await render(Page));
    expect(lv[NONE]).toBe(ONE);
    const jumps = lv.flatMap((l, i) => (i > NONE && l - lv[i - ONE] > ONE ? [`h${lv[i - ONE]} → h${l}`] : []));
    expect(jumps).toEqual([]);
  });

  test('<title> y meta description no vacíos, con el nombre de la marca', async () => {
    const doc = await render(Page);
    expect(has(doc.title, titleRe)).toBe(true);
    expect(has(doc.title, 'valmont')).toBe(true);
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim().length).toBeGreaterThan(NONE);
  });

  test('indexable (sin noindex): son páginas públicas; sin enlaces javascript:', async () => {
    const doc = await render(Page);
    expect(has(doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '', 'noindex')).toBe(false);
    expect([...doc.querySelectorAll('a')].filter((a) => JS_SCHEME.test(a.getAttribute('href') ?? ''))).toEqual([]);
  });
});

describe.each(pages)('%s · contenido de demostración (P-9, D-041)', (_path, Page) => {
  test('cada [data-demo-content] contiene el Badge "Contenido de demostración" visible (no oculto a lectores)', async () => {
    const doc = await render(Page);
    const blocks = [...doc.querySelectorAll('[data-demo-content]')];
    expect(blocks.length).toBeGreaterThan(NONE);
    blocks.forEach((b) => {
      const badges = [...b.querySelectorAll('.badge')].filter((x) => text(x) === DEMO);
      expect(badges.length, `bloque sin etiqueta: ${text(b).slice(0, 40)}`).toBeGreaterThan(NONE);
      expect(badges.every((x) => x.closest('[aria-hidden="true"], [hidden]') === null)).toBe(true);
    });
  });

  test('no hay etiqueta de demostración fuera de un bloque marcado (el grep de lanzamiento los halla todos)', async () => {
    const doc = await render(Page);
    const stray = [...doc.querySelectorAll('.badge')].filter((x) => text(x) === DEMO && !x.closest('[data-demo-content]'));
    expect(stray).toEqual([]);
  });
});

describe('/nosotros · bloques y contacto', () => {
  test('hay 3 bloques de demostración (hero, compromisos, contacto) dentro de main', async () => {
    const doc = await render(Nosotros);
    expect(doc.querySelectorAll('[data-demo-content]').length).toBe(THREE);
    expect(doc.querySelector('main')!.querySelectorAll('[data-demo-content]').length).toBe(THREE);
  });

  test('el h1 sale de data/about.ts y cada compromiso aparece en la lista', async () => {
    const doc = await render(Nosotros);
    expect(text(doc.querySelector('h1'))).toBe(about.hero.title);
    const main = doc.querySelector('main')!;
    expect(main.querySelectorAll('ul > li').length).toBeGreaterThanOrEqual(about.awards.items.length);
    about.awards.items.forEach((i) => expect(text(main)).toContain(i.title));
  });

  test('ancla #contacto única en main, con teléfono, correo y red de SITE (tel:, mailto:)', async () => {
    const doc = await render(Nosotros);
    expect(doc.querySelectorAll('#contacto').length).toBe(ONE);
    const block = doc.querySelector('main #contacto')!;
    const hrefs = [...block.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`tel:${SITE.phone.replace(NOT_DIAL, '')}`);
    expect(hrefs).toContain(`mailto:${SITE.email}`);
    expect(hrefs).toContain(SITE.instagram.href);
    expect(text(block)).toContain(SITE.phone);
    expect(text(block)).toContain(SITE.email);
    expect(text(block)).toContain(SITE.instagram.label);
  });

  test('el mismo teléfono y correo en el pie y en "Nosotros" (H-22)', async () => {
    const doc = await render(Nosotros);
    const block = doc.querySelector('main #contacto')!;
    const footer = doc.querySelector('footer')!;
    const href = (scope: Element, sel: string) => scope.querySelector(sel)?.getAttribute('href');
    expect(href(block, 'a[href^="tel:"]')).toBe(href(footer, 'a[href^="tel:"]'));
    expect(href(block, 'a[href^="mailto:"]')).toBe(href(footer, 'a[href^="mailto:"]'));
    expect(text(block.querySelector('a[href^="tel:"]'))).toBe(text(footer.querySelector('a[href^="tel:"]')));
  });

  test('los enlaces "Contacto" de cabecera y pie apuntan al bloque que existe (/nosotros#contacto)', async () => {
    const doc = await render(Nosotros);
    const links = [...doc.querySelectorAll('a')].filter((a) => text(a) === 'Contacto');
    expect(links.length).toBeGreaterThan(NONE);
    links.forEach((a) => expect(a.getAttribute('href')).toBe('/nosotros#contacto'));
    expect(doc.getElementById('contacto')).not.toBeNull();
  });

  test('no lleva aviso legal ni migas (el paquete no las pide)', async () => {
    const doc = await render(Nosotros);
    expect(doc.querySelector('main [role="status"]')).toBeNull();
    expect(doc.querySelector('main nav')).toBeNull();
  });
});

describe.each(legal)('%s · aviso legal de demostración', (path, Page, doc) => {
  test('lleva el Notice (role=status) de "no es texto legal definitivo" dentro del bloque de demostración', async () => {
    const dom = await render(Page);
    const notices = [...dom.querySelectorAll('main [role="status"]')].filter((n) => has(text(n), NOT_FINAL));
    expect(notices.length).toBe(ONE);
    expect(notices[NONE].closest('[data-demo-content]')).not.toBeNull();
  });

  test('muestra la fecha de última actualización con el formato del proyecto', async () => {
    const main = text((await render(Page)).querySelector('main'));
    expect(main).toContain(formatDateOnly(doc.updated));
    expect(has(main, 'Última actualización')).toBe(true);
  });

  test('un h2 por sección del documento y cada <section> se nombra por su h2 (aria-labelledby)', async () => {
    const dom = await render(Page);
    expect([...dom.querySelectorAll('main h2')].map(text)).toEqual(doc.sections.map((s) => s.title));
    const sections = [...dom.querySelectorAll('main section')];
    expect(sections.length).toBe(doc.sections.length);
    sections.forEach((s) => expect(dom.getElementById(s.getAttribute('aria-labelledby') ?? '')).not.toBeNull());
  });

  test(`longitud de línea: el ancho del texto largo está fijado entre ${MIN_LINE} y ${MAX_LINE} caracteres (ch)`, () => {
    const src = readFileSync(`${FRONTEND}/src/pages/${path.slice(ONE)}.astro`, 'utf8');
    const widths = [...src.matchAll(WIDTH_CH)].map((m) => Number(m[ONE]));
    expect(widths.length).toBeGreaterThan(NONE);
    expect(widths.filter((n) => n < MIN_LINE || n > MAX_LINE)).toEqual([]);
  });
});

describe('/privacidad · contenido exigido (RNF10, Ley 29733, D-041 P-8, D-043, D-025)', () => {
  const body = async () => text((await render(Privacidad)).querySelector('main'));

  test('cita la Ley 29733 y menciona la versión vigente PRIVACY_VERSION', async () => {
    const t = await body();
    expect(has(t, 'Ley N.º 29733') || has(t, 'Ley 29733')).toBe(true);
    expect(t).toContain(PRIVACY_VERSION);
  });

  test('declara las finalidades, con la fecha de nacimiento entre ellas (P-8)', async () => {
    const t = await body();
    ['finalidad', 'fecha de nacimiento', 'mayor de edad'].forEach((w) => expect(has(t, w), w).toBe(true));
  });

  test('solo los 4 últimos dígitos de la tarjeta; nunca el número completo (D-043)', async () => {
    const t = await body();
    expect(has(t, '4 dígitos')).toBe(true);
    expect(has(t, 'nunca guardamos el número completo')).toBe(true);
  });

  test('cookies de sesión httpOnly (D-025)', async () => {
    expect(await body()).toContain('httpOnly');
  });

  test('derechos ARCO: acceso, rectificación, cancelación y oposición', async () => {
    const t = await body();
    expect(t).toContain('ARCO');
    ['acceso', 'rectificación', 'cancelación', 'oposición'].forEach((w) => expect(has(t, w), w).toBe(true));
  });

  test('responsable del tratamiento y plazo de conservación', async () => {
    const t = await body();
    ['responsable', 'plazo'].forEach((w) => expect(has(t, w), w).toBe(true));
  });
});

describe('/terminos · contenido', () => {
  test('mayoría de edad, pagos simulados con 4 dígitos y precios confirmados por el servidor', async () => {
    const t = text((await render(Terminos)).querySelector('main'));
    ['mayor de edad', 'simulad', '4 dígitos', 'servidor'].forEach((w) => expect(has(t, w), w).toBe(true));
  });
});
