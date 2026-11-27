import { describe, expect, test } from 'vitest';
import SiteFooter from '../../src/components/layout/SiteFooter.astro';
import SiteHeader from '../../src/components/layout/SiteHeader.astro';
import { read } from '../helpers/css';
import { renderDocument } from '../helpers/render';

// T-133 · fix visual A: cabecera y pie (REVIEW-2026-11-27 D-01, D-02, D-09, D-14; D-044; accesos de D-041 P-1).
// Container API: no emite CSS, así que lo visual del contacto se comprueba sobre la regla del fuente y el marcado sobre el DOM.

type Component = Parameters<typeof renderDocument>[0];
const NONE = 0;
const ONE = 1;
const TWO = 2;

// Comentario CSS: "/* x */" casa; "x" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5C%2F%5C*%5B%5Cs%5CS%5D*%3F%5C*%5C%2F&flags=g
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
// Cuerpo de la regla del contacto del pie: ".site-footer__contact { a: b; }" captura " a: b; ".
// Probar: https://regex101.com/?flavor=javascript&regex=%5C.site-footer__contact%5Cs*%5C%7B(%5B%5E%7D%5D*)%5C%7D&flags=
const CONTACT_RULE = /\.site-footer__contact\s*\{([^}]*)\}/;
// Mayúsculas forzadas: "text-transform: uppercase" casa; "text-transform: none" no.
// Probar: https://regex101.com/?flavor=javascript&regex=text-transform%5Cs*%3A%5Cs*uppercase&flags=
const UPPERCASE = /text-transform\s*:\s*uppercase/;
// Familia Geist del brief: "font-family: var(--font-ui)" casa; "font-family: var(--font-brand)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=font-family%5Cs*%3A%5Cs*var%5C(--font-ui%5C)&flags=
const FONT_UI = /font-family\s*:\s*var\(--font-ui\)/;
// Fin de una regla CSS: "a { b }" se parte en "a { b " y "".
// Probar: https://regex101.com/?flavor=javascript&regex=%5C%7D&flags=g
const RULE_END = /\}/;
// Wordmark: "Valmont, inicio" casa; "Relojes" no.
// Probar: https://regex101.com/?flavor=javascript&regex=valmont&flags=i
const VALMONT = /valmont/i;

const contactRule = (css: string): string => CONTACT_RULE.exec(css.replace(CSS_COMMENT, ''))?.[ONE] ?? '';

const header = (props: Record<string, unknown> = {}): Promise<Document> =>
  renderDocument(SiteHeader as Component, { props });
const footer = (): Promise<Document> => renderDocument(SiteFooter as Component, {});
const byLabel = (doc: Document, label: string): Element | null => doc.querySelector(`a[aria-label="${label}"]`);

describe('T-133 · D-01 · damero de dos filas', () => {
  test('cabecera full: el damero lleva data-rows="2" y es decorativo', async () => {
    const boards = [...(await header({ variant: 'full' })).querySelectorAll('.checkerboard')];
    expect(boards).toHaveLength(ONE);
    expect(boards[NONE].getAttribute('data-rows')).toBe(String(TWO));
    expect(boards[NONE].getAttribute('aria-hidden')).toBe('true');
  });

  test('cabecera compacta: sigue sin damero', async () => {
    expect((await header({ variant: 'compact' })).querySelectorAll('.checkerboard')).toHaveLength(NONE);
  });

  test('pie: el damero lleva data-rows="2" y es decorativo', async () => {
    const boards = [...(await footer()).querySelectorAll('.checkerboard')];
    expect(boards).toHaveLength(ONE);
    expect(boards[NONE].getAttribute('data-rows')).toBe(String(TWO));
    expect(boards[NONE].getAttribute('aria-hidden')).toBe('true');
  });
});

describe('T-133 · D-02 · símbolo de la cabecera', () => {
  test('el símbolo sigue en el marcado, decorativo (alt vacío) y con la ruta de la guía de marca', async () => {
    const imgs = [...(await header({ variant: 'full' })).querySelectorAll('header img')];
    expect(imgs).toHaveLength(ONE);
    expect(imgs[NONE].getAttribute('src')).toBe('/brand/symbol.svg');
    expect(imgs[NONE].getAttribute('alt')).toBe('');
  });

  test('el wordmark es un enlace a "/" con nombre accesible', async () => {
    const doc = await header({ variant: 'full' });
    const home = doc.querySelector('header a[href="/"]');
    expect(home?.getAttribute('aria-label') ?? home?.textContent).toMatch(VALMONT);
  });
});

describe('T-133 · accesos de D-041 P-1 intactos', () => {
  test.each([
    ['Lista de deseos', '/cuenta/lista-de-deseos'],
    ['Carrito', '/carrito'],
    ['Mi cuenta', '/cuenta'],
  ])('%s → %s, con nombre accesible', async (label, href) => {
    const a = byLabel(await header(), label);
    expect(a, label).not.toBeNull();
    expect(a?.getAttribute('href')).toBe(href);
  });

  test('búsqueda: formulario role=search GET /relojes, input q (≤ 100) con etiqueta y botón "Buscar"', async () => {
    const doc = await header();
    const form = doc.querySelector('form[role="search"]');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form?.getAttribute('action')).toBe('/relojes');
    const input = form?.querySelector('input[name="q"]');
    expect(input?.getAttribute('maxlength')).toBe('100');
    const label = doc.querySelector(`label[for="${input?.id}"]`);
    expect(label?.textContent?.trim()).toBe('Buscar relojes');
    expect(form?.querySelector('button[aria-label="Buscar"][type="submit"]')).not.toBeNull();
  });

  test('menú móvil: botón de abrir y de cerrar con nombre accesible y popover', async () => {
    const doc = await header();
    const menu = doc.querySelector('[popover]');
    expect(menu?.id).toBe('menu-principal');
    expect(doc.querySelector('button[aria-label="Abrir menú"][popovertarget="menu-principal"]')).not.toBeNull();
    expect(doc.querySelector('button[aria-label="Cerrar menú"][popovertarget="menu-principal"]')).not.toBeNull();
  });
});

describe('T-133 · aria-current sigue funcionando', () => {
  test.each([
    ['/carrito', 'Carrito'],
    ['/cuenta', 'Mi cuenta'],
    ['/cuenta/lista-de-deseos', 'Lista de deseos'],
  ])('en %s solo marca "%s"', async (currentPath, label) => {
    const doc = await header({ currentPath });
    const marked = [...doc.querySelectorAll('.site-header__actions [aria-current="page"]')].map((e) => e.getAttribute('aria-label'));
    expect(marked).toEqual([label]);
  });

  test('en /nosotros el nav marca Nosotros y no Contacto', async () => {
    const doc = await header({ currentPath: '/nosotros' });
    const nav = doc.querySelector('nav[aria-label="Principal"]') as Element;
    const marked = [...nav.querySelectorAll('[aria-current="page"]')].map((e) => e.textContent?.trim());
    expect(marked).toEqual(['Nosotros']);
  });

  test('en la portada no hay ningún aria-current', async () => {
    expect((await header({ currentPath: '/' })).querySelectorAll('[aria-current]')).toHaveLength(NONE);
  });
});

describe('T-133 · D-09 · pie', () => {
  test('los cinco enlaces del pie siguen en una lista de un nav "Pie de página"', async () => {
    const nav = (await footer()).querySelector('nav[aria-label="Pie de página"]') as Element;
    expect([...nav.querySelectorAll('li a')].map((a) => a.textContent?.trim())).toEqual([
      'Relojes',
      'Nosotros',
      'Contacto',
      'Privacidad',
      'Términos',
    ]);
  });

  test('el wordmark del pie es decorativo (aria-hidden) y dice VALMONT', async () => {
    const mark = (await footer()).querySelector('.site-footer__mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.textContent?.trim()).toBe('Valmont');
  });
});

describe('T-133 · D-14 · Jaro solo en el wordmark', () => {
  const css = read('src/components/layout/SiteFooter.astro');

  test('el contacto del pie no usa --font-brand ni mayúsculas forzadas, y usa Geist (--font-ui)', () => {
    const rule = contactRule(css);
    expect(rule, 'no se encontró la regla .site-footer__contact').not.toBe('');
    expect(rule).not.toContain('--font-brand');
    expect(rule).not.toMatch(UPPERCASE);
    expect(rule).toMatch(FONT_UI);
  });

  test('en el pie, --font-brand solo aparece en la regla del wordmark decorativo', () => {
    const style = css.slice(css.indexOf('<style>'));
    const hits = style.split(RULE_END).filter((block) => block.includes('--font-brand'));
    expect(hits).toHaveLength(ONE);
    expect(hits[NONE]).toContain('.site-footer__mark');
  });

  test('los textos del contacto siguen visibles tal cual (sin mayúsculas en el marcado)', async () => {
    const text = (await footer()).querySelector('address')?.textContent ?? '';
    expect(text).toContain('contacto@valmont.pe');
    expect(text).toContain('@valmontperu');
  });
});
