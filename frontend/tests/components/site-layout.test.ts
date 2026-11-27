import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import PageTitle from '../../src/components/layout/PageTitle.astro';
import SiteFooter from '../../src/components/layout/SiteFooter.astro';
import SiteHeader from '../../src/components/layout/SiteHeader.astro';
import AuthLayout from '../../src/layouts/AuthLayout.astro';
import StoreLayout from '../../src/layouts/StoreLayout.astro';
import { PRIVACY_VERSION, SITE } from '../../src/lib/site';
import { FRONTEND, read } from '../helpers/css';
import { renderAstro, renderDocument } from '../helpers/render';

// T-119 · cabecera, pie y título de página (STATUS "T-119 › Resultado esperado / Criterios / Firmas públicas", D-041 P-1).
// Se prueba la interfaz pública (props, slots, DOM accesible), no el marcado interno: se localiza por rol, nombre y href.

type Component = Parameters<typeof renderDocument>[0];
const NONE = 0;
const ONE = 1;
const LEVEL_TWO = 2;
const MAX_Q_LENGTH = 100; // "q, ≤ 100"
const MAX_SCRIPT_LINES = 30; // "un <script> < 30 líneas"
const SNIPPET = 80; // recorte de HTML en los mensajes de error

// Cada expresión regular, con su ejemplo (regla del repositorio de estilo).
// Espacios en blanco consecutivos: "a  b\n c" casa; "abc" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cs%2B&flags=g
const WS = /\s+/g;
// Algún dígito: "Carrito 3" casa; "Carrito" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cd&flags=
const DIGIT = /\d/;
// Todo lo que no es dígito ni "+": "+51 (1) 625-4500" casa en " (", ") " y "-"; "+5116254500" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5B%5E%5Cd%2B%5D&flags=g
const NOT_PHONE = /[^\d+]/g;
// Correo con forma de correo: "contacto@valmont.pe" casa; "contacto.valmont.pe" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%5B%5E%5Cs%40%5D%2B%40%5B%5E%5Cs%40%5D%2B%5C.%5B%5E%5Cs%40%5D%2B%24&flags=
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Host de Instagram: "instagram.com" y "www.instagram.com" casan; "instagram.com.evil.io" no.
// Probar: https://regex101.com/?flavor=javascript&regex=(%5E%7C%5C.)instagram%5C.com%24&flags=
const INSTAGRAM_HOST = /(^|\.)instagram\.com$/;
// "Términos" o "Terminos": "Términos y condiciones" casa; "Privacidad" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5ET%5Be%C3%A9%5Drminos&flags=
const TERMS = /^T[eé]rminos/;
// Enlace externo: "https://x.io" y "//x.io" casan; "/relojes" y "#contenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E(https%3F%3A)%3F%5C%2F%5C%2F&flags=
const EXTERNAL = /^(https?:)?\/\//;
// Controlador de evento en línea: ' onclick=' casa; 'data-on="1"' no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cson%5Ba-z%5D%2B%5Cs*%3D&flags=i
const INLINE_HANDLER = /\son[a-z]+\s*=/i;
// Bloque <script>…</script> y su contenido: "<script>a()</script>" casa con grupo "a()".
// Probar: https://regex101.com/?flavor=javascript&regex=%3Cscript%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fscript%3E&flags=g
const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/g;
// Bloque <style>…</style>: "<style>x{}</style>" casa con grupo "x{}".
// Probar: https://regex101.com/?flavor=javascript&regex=%3Cstyle%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fstyle%3E&flags=g
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;
// Un <style> bien envuelto empieza por "@layer components {": casa; "a { }" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E%40layer%5Cs%2Bcomponents%5Cs*%5C%7B&flags=
const LAYER_COMPONENTS = /^@layer\s+components\s*\{/;
// Red, HTML dinámico o eval en un script: "fetch(" y ".innerHTML" casan; "hidePopover()" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cb(fetch%7CXMLHttpRequest%7CinnerHTML%7CinsertAdjacentHTML%7Ceval%7Cdocument%5C.write)%5Cb&flags=
const SCRIPT_FORBIDDEN = /\b(fetch|XMLHttpRequest|innerHTML|insertAdjacentHTML|eval|document\.write)\b/;
// Importación en un script: "import x from 'y'" casa; "important" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cbimport%5Cb&flags=
const IMPORT = /\bimport\b/;
// Framework de UI importado: "from 'preact'" casa; "from './x'" no.
// Probar: https://regex101.com/?flavor=javascript&regex=from%20%5B'%22%5D(preact%7Creact%7Cvue%7Csvelte%7Csolid)&flags=
const FRAMEWORK_IMPORT = /from ['"](preact|react|vue|svelte|solid)/;
// Directiva de hidratación de isla: 'client:load' casa; 'class' no.
// Probar: https://regex101.com/?flavor=javascript&regex=client%3A(load%7Cidle%7Cvisible%7Conly%7Cmedia)&flags=
const HYDRATION = /client:(load|idle|visible|only|media)/;
// Color hexadecimal suelto: "#fffde4" y "#fff" casan; "#contenido" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%23%5B0-9A-Fa-f%5D%7B3%2C8%7D%5Cb&flags=
const HEX = /#[0-9A-Fa-f]{3,8}\b/;
// Hex permitido en cabecera/pie: anclas de documento. "href='#x'" y "/nosotros#contacto" casan; "color: #fff" no.
// Probar: https://regex101.com/?flavor=javascript&regex=href%3D%5B%22'%5D%23%7C%5B%22'%5D%23contenido%7C%5C%2Fnosotros%23contacto%7C%5C%2F%23&flags=
const HEX_ALLOWED = /href=["']#|["']#contenido|\/nosotros#contacto|\/#/;
// Funciones de color: "rgb(" y "color-mix(" casan; "var(--x)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cb(rgba%3F%7Chsla%3F%7Coklch%7Coklab%7Ccolor-mix)%5C(&flags=
const COLOR_FN = /\b(rgba?|hsla?|oklch|oklab|color-mix)\(/;
// font-family literal: "font-family: Arial" casa; "font-family: var(--font-body)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=font-family%5Cs*%3A%5Cs*(%3F!var%5C(%7Cinherit%5Cb)%5CS&flags=
const FONT_LITERAL = /font-family\s*:\s*(?!var\(|inherit\b)\S/;
// font-size en px: "font-size: 12px" casa; "font-size: var(--text-14)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=font-size%5Cs*%3A%5B%5E%3B%5D*%5Cd%5Cs*px&flags=
const FONT_PX = /font-size\s*:[^;]*\d\s*px/;
// Ancho fijo en px o vw: "width: 320px" casa; "width: 100%" no.
// Probar: https://regex101.com/?flavor=javascript&regex=(inline-size%7Cwidth)%5Cs*%3A%5Cs*%5B%5Cd.%5D%2B(px%7Cvw)%5Cb&flags=
const FIXED_WIDTH = /(inline-size|width)\s*:\s*[\d.]+(px|vw)\b/;
// Línea del damero: "checkerboard" o "damero" casan; "wordmark" no.
// Probar: https://regex101.com/?flavor=javascript&regex=checker%7Cboard%7Cdamero&flags=i
const BOARD_LINE = /checker|board|damero/i;
// Ancho al 100 %: "width: 100%" casa; "width: 10%" no.
// Probar: https://regex101.com/?flavor=javascript&regex=width%3A%5Cs*100%25&flags=
const FULL_WIDTH = /width:\s*100%/;
// set:html o console: "set:html={x}" y "console.log" casan; "textContent" no.
// Probar: https://regex101.com/?flavor=javascript&regex=set%3Ahtml%7Cconsole%5C.&flags=
const UNSAFE = /set:html|console\./;
// Red o framework en el código fuente: "fetch(x)" y "from 'react'" casan.
// Probar: https://regex101.com/?flavor=javascript&regex=%5Cbfetch%5C(%7Cfrom%20%5B'%22%5D(preact%7Creact%7Cvue%7Csvelte)&flags=
const NET_OR_FRAMEWORK = /\bfetch\(|from ['"](preact|react|vue|svelte)/;
// Condición de un @media: "min-width: 800px" y "prefers-reduced-motion: reduce" casan; "max-width: 600px" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5E(min-width%3A%20(800%7C1280)px%7Cprefers-reduced-motion%3A%20(reduce%7Cno-preference))%24&flags=
const MEDIA_OK = /^(min-width: (800|1280)px|prefers-reduced-motion: (reduce|no-preference))$/;
// Consulta @media completa: "@media (min-width: 800px)" casa con grupo "min-width: 800px".
// Probar: https://regex101.com/?flavor=javascript&regex=%40media%5Cs*%5C((%5B%5E)%5D*)%5C)&flags=g
const MEDIA_QUERY = /@media\s*\(([^)]*)\)/g;
// Código fuente de datos de contacto: "625-4500", "contacto@valmont.pe", "valmontperu" casan; "Valmont" no.
// Probar: https://regex101.com/?flavor=javascript&regex=625-4500%7Ccontacto%40valmont.pe%7Cvalmontperu&flags=i
const CONTACT_LITERALS = [/625-4500/, /contacto@valmont\.pe/i, /valmontperu/i];
// Archivos de código de src/: "a.astro", "b.ts", "c.css" casan; "d.svg" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5C.(astro%7Cts%7Ccss)%24&flags=
const SOURCE_FILE = /\.(astro|ts|css)$/;
// La biblioteca del contacto: "src/lib/site.ts" casa con "/" o "\"; "src/lib/format.ts" no.
// Probar: https://regex101.com/?flavor=javascript&regex=%5B%5C%5C%2F%5Dlib%5B%5C%5C%2F%5Dsite%5C.ts%24&flags=
const SITE_FILE = /[\\/]lib[\\/]site\.ts$/;

const squash = (s: string | null | undefined): string => (s ?? '').replace(WS, ' ').trim();
const relTokens = (a: Element | undefined): string[] => (a?.getAttribute('rel') ?? '').split(WS).filter(Boolean);

/** Nombre accesible simplificado: aria-label > aria-labelledby > <label for> > alt de imagen > texto > title. */
function accName(el: Element): string {
  const doc = el.ownerDocument;
  const label = el.getAttribute('aria-label');
  if (label) return squash(label);
  const by = el.getAttribute('aria-labelledby');
  if (by) return squash(by.split(WS).map((id) => doc.getElementById(id)?.textContent ?? '').join(' '));
  const id = el.getAttribute('id');
  const forLabel = id ? doc.querySelector(`label[for="${id}"]`) : null;
  if (forLabel) return squash(forLabel.textContent);
  const alt = [...el.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join(' ');
  return squash(`${el.textContent ?? ''} ${alt}`) || squash(el.getAttribute('title'));
}

const links = (scope: ParentNode): HTMLAnchorElement[] => [...scope.querySelectorAll<HTMLAnchorElement>('a[href]')];
const linkByName = (scope: ParentNode, name: string | RegExp): HTMLAnchorElement | undefined =>
  links(scope).find((a) => (typeof name === 'string' ? accName(a) === name : name.test(accName(a))));
const header = (doc: Document): Element => doc.querySelector('header') as Element;
/** `a` aparece antes que `b` en el orden del documento. */
const precedes = (doc: Document, a: Element | null, b: Element): boolean => {
  const all = [...doc.querySelectorAll('*')];
  return a !== null && all.indexOf(a) < all.indexOf(b);
};
const requestAt = (path: string): Request => new Request(`http://localhost${path}`);

const renderHeader = (props: Record<string, unknown> = {}, path?: string): Promise<Document> =>
  renderDocument(SiteHeader as Component, { props, ...(path ? { request: requestAt(path) } : {}) });
const renderFooter = (): Promise<Document> => renderDocument(SiteFooter as Component, {});

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

// ---------------------------------------------------------------------------------------------------------------------
describe('lib/site.ts · SITE (fuente única del contacto, H-22)', () => {
  test('datos del paquete', () => {
    expect(SITE.name).toBe('Valmont');
    expect(SITE.phone).toBe('+51 (1) 625-4500');
    expect(SITE.email).toBe('contacto@valmont.pe');
    expect(SITE.instagram.label).toBe('@valmontperu');
    expect(typeof SITE.tagline).toBe('string');
    expect(SITE.tagline.trim().length).toBeGreaterThan(NONE);
  });

  test('el enlace de Instagram es https hacia instagram.com y el correo tiene forma de correo', () => {
    const url = new URL(SITE.instagram.href);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toMatch(INSTAGRAM_HOST);
    expect(SITE.email).toMatch(EMAIL);
  });

  test('PRIVACY_VERSION = "2026-10"', () => {
    expect(PRIVACY_VERSION).toBe('2026-10');
  });

  test('ningún otro archivo de src/ repite teléfono, correo o Instagram (cabecera, pie y páginas leen de SITE)', () => {
    const offenders = walk(join(FRONTEND, 'src'))
      .filter((f) => !SITE_FILE.test(f) && SOURCE_FILE.test(f))
      .filter((f) => CONTACT_LITERALS.some((n) => n.test(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SiteHeader · variante full', () => {
  test('landmarks: un header (banner) y un nav con nombre accesible "Principal"', async () => {
    const doc = await renderHeader({ variant: 'full' });
    expect(doc.querySelectorAll('header').length).toBe(ONE);
    const navs = [...doc.querySelectorAll('nav')];
    expect(navs.length).toBe(ONE);
    expect(accName(navs[0])).toBe('Principal');
    expect(header(doc).contains(navs[0])).toBe(true);
  });

  test('es la variante por defecto (sin props)', async () => {
    const byDefault = await renderHeader();
    const full = await renderHeader({ variant: 'full' });
    expect(byDefault.querySelector('form[role="search"]')).not.toBeNull();
    expect(links(header(byDefault)).map((a) => a.getAttribute('href'))).toEqual(
      links(header(full)).map((a) => a.getAttribute('href')),
    );
  });

  test('enlaces fijos de P-1: Relojes, Nosotros y Contacto, dentro del nav', async () => {
    const nav = (await renderHeader()).querySelector('nav') as Element;
    expect(linkByName(nav, 'Relojes')?.getAttribute('href')).toBe('/relojes');
    expect(linkByName(nav, 'Nosotros')?.getAttribute('href')).toBe('/nosotros');
    expect(linkByName(nav, 'Contacto')?.getAttribute('href')).toBe('/nosotros#contacto');
  });

  test.each(['/', '/relojes', '/carrito', '/cuenta/lista-de-deseos', '/nosotros'])(
    'accesos P-1 en %s: deseos, carrito y cuenta con nombre y href; la cuenta apunta SIEMPRE a /cuenta',
    async (path) => {
      const h = header(await renderHeader({ currentPath: path }));
      expect(linkByName(h, 'Lista de deseos')?.getAttribute('href')).toBe('/cuenta/lista-de-deseos');
      expect(linkByName(h, 'Carrito')?.getAttribute('href')).toBe('/carrito');
      expect(linkByName(h, 'Mi cuenta')?.getAttribute('href')).toBe('/cuenta');
    },
  );

  test('todo botón, enlace y campo de la cabecera tiene nombre accesible no vacío', async () => {
    const h = header(await renderHeader());
    const controls = [...h.querySelectorAll('a[href], button, input:not([type="hidden"])')];
    expect(controls.length).toBeGreaterThan(NONE);
    const unnamed = controls.filter((c) => accName(c) === '').map((c) => c.outerHTML.slice(NONE, SNIPPET));
    expect(unnamed).toEqual([]);
  });

  test('la búsqueda es un form role="search" por GET a /relojes con input name="q" de a lo sumo 100 y nombre accesible', async () => {
    const h = header(await renderHeader());
    const forms = [...h.querySelectorAll('form')];
    expect(forms.length).toBe(ONE);
    const form = forms[NONE];
    expect(form.getAttribute('role')).toBe('search');
    expect((form.getAttribute('method') ?? '').toLowerCase()).toBe('get');
    expect(form.getAttribute('action')).toBe('/relojes');
    const q = form.querySelector('input[name="q"]');
    expect(q, 'falta input name="q"').not.toBeNull();
    expect(Number(q?.getAttribute('maxlength'))).toBeLessThanOrEqual(MAX_Q_LENGTH);
    expect(Number(q?.getAttribute('maxlength'))).toBeGreaterThan(NONE);
    expect(['search', 'text']).toContain(q?.getAttribute('type'));
    expect(accName(q as Element)).not.toBe('');
    expect(form.querySelectorAll('input[type="hidden"]').length).toBe(NONE);
    const submit = form.querySelector('button[type="submit"], input[type="submit"]');
    expect(submit, 'falta el envío').not.toBeNull();
    expect(accName(submit as Element)).not.toBe('');
  });

  test('menú móvil sin framework: un botón con popovertarget apunta a un elemento [popover] que contiene el nav y la búsqueda', async () => {
    const doc = await renderHeader();
    const opener = doc.querySelector('button[popovertarget]') as Element;
    expect(opener, 'falta el botón que abre el menú').not.toBeNull();
    expect(accName(opener)).not.toBe('');
    const target = doc.getElementById(opener.getAttribute('popovertarget') as string);
    expect(target, 'popovertarget apunta a un id inexistente').not.toBeNull();
    expect(target?.hasAttribute('popover')).toBe(true);
    expect(target?.querySelector('nav[aria-label="Principal"]')).not.toBeNull();
    expect(target?.querySelector('form[role="search"]')).not.toBeNull();
  });

  test('el símbolo de la marca es decorativo (alt vacío) y viene del propio sitio', async () => {
    const imgs = [...header(await renderHeader()).querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThan(NONE);
    imgs.forEach((img) => {
      expect(img.getAttribute('alt'), img.outerHTML).toBe('');
      expect((img.getAttribute('src') ?? '').startsWith('/brand/'), img.outerHTML).toBe(true);
    });
    expect(imgs.some((i) => i.getAttribute('src') === '/brand/symbol.svg')).toBe(true);
  });

  test('Wordmark enlazado a "/" con nombre que incluye Valmont; el descriptor sale de SITE', async () => {
    const h = header(await renderHeader());
    const home = links(h).find((a) => a.getAttribute('href') === '/');
    expect(home, 'falta el enlace de inicio').toBeDefined();
    expect(accName(home as Element).toLowerCase()).toContain('valmont');
    expect(squash(h.textContent)).toContain(SITE.tagline);
  });

  test('damero "storefront" al pie de la cabecera (aria-hidden)', async () => {
    const h = header(await renderHeader());
    const board = h.querySelector('[data-palette="storefront"]');
    expect(board, 'falta el damero storefront').not.toBeNull();
    expect(board?.getAttribute('aria-hidden')).toBe('true');
    const last = [...h.children].filter((c) => !['STYLE', 'SCRIPT'].includes(c.tagName)).at(-ONE);
    expect(last?.contains(board) || last === board).toBe(true);
  });

  test('sin contadores ni datos por usuario: los accesos no llevan números ni regiones vivas', async () => {
    const h = header(await renderHeader());
    ['Lista de deseos', 'Carrito', 'Mi cuenta'].forEach((name) => {
      const a = linkByName(h, name) as Element;
      expect(DIGIT.test(squash(a.textContent)), `${name} lleva un número`).toBe(false);
      expect(a.querySelector('[aria-live], [role="status"], output')).toBeNull();
    });
    expect(h.querySelector('[aria-live], [role="status"], output, [data-count]')).toBeNull();
  });

  const FAKE_BEARER = 'bearer-value-for-tests-0001';
  test('invariante de caché pública: la salida no cambia con una sesión en locals', async () => {
    const anonymous = await renderAstro(SiteHeader as Component, { props: { currentPath: '/' } });
    const session = await renderAstro(SiteHeader as Component, {
      props: { currentPath: '/' },
      locals: { session: { userId: 'u-1', email: 'cliente@example.com', accessToken: FAKE_BEARER, expiresAt: 4102444800 }, supabase: {} as never },
    });
    expect(session).toBe(anonymous);
    expect(session).not.toContain('cliente@example.com');
  });

  test('ids únicos dentro de la cabecera', async () => {
    const ids = [...header(await renderHeader()).querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('la cabecera nunca pone un h1 (lo pone PageTitle)', async () => {
    expect((await renderHeader()).querySelectorAll('h1').length).toBe(NONE);
    expect((await renderHeader({ variant: 'compact' })).querySelectorAll('h1').length).toBe(NONE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SiteHeader · aria-current="page" según la ruta', () => {
  const current = (doc: Document): string[] =>
    links(header(doc))
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => accName(a));

  test('en "/" no hay enlace actual', async () => {
    expect(current(await renderHeader({ currentPath: '/' }))).toEqual([]);
  });

  test.each([
    ['/relojes', 'Relojes'],
    ['/nosotros', 'Nosotros'],
    ['/carrito', 'Carrito'],
    ['/cuenta', 'Mi cuenta'],
    ['/cuenta/lista-de-deseos', 'Lista de deseos'],
  ])('en %s el enlace "%s" es la página actual', async (path, name) => {
    const doc = await renderHeader({ currentPath: path });
    expect(current(doc)).toContain(name);
    expect(linkByName(header(doc), name)?.getAttribute('aria-current')).toBe('page');
  });

  test('en /relojes los demás enlaces fijos no son actuales', async () => {
    const doc = await renderHeader({ currentPath: '/relojes' });
    expect(linkByName(header(doc), 'Nosotros')?.hasAttribute('aria-current')).toBe(false);
    expect(linkByName(header(doc), 'Contacto')?.hasAttribute('aria-current')).toBe(false);
  });

  test.each(['/', '/relojes', '/nosotros', '/nosotros#contacto', '/cuenta', '/cuenta/lista-de-deseos', '/carrito'])(
    'Contacto (un ancla) NUNCA es la página actual (ruta %s)',
    async (path) => {
      const doc = await renderHeader({ currentPath: path });
      expect(linkByName(header(doc), 'Contacto')?.hasAttribute('aria-current')).toBe(false);
    },
  );

  test('sin la prop currentPath se toma la ruta de la petición (Astro.url.pathname)', async () => {
    const doc = await renderHeader({}, '/nosotros');
    expect(linkByName(header(doc), 'Nosotros')?.getAttribute('aria-current')).toBe('page');
    expect(linkByName(header(doc), 'Relojes')?.hasAttribute('aria-current')).toBe(false);
  });

  test('aria-current solo toma el valor "page" y no hay ninguno falso', async () => {
    const doc = await renderHeader({ currentPath: '/relojes' });
    const values = [...header(doc).querySelectorAll('[aria-current]')].map((e) => e.getAttribute('aria-current'));
    expect(values.filter((v) => v !== 'page')).toEqual([]);
  });

  test('la ruta no se inyecta como HTML (currentPath hostil)', async () => {
    const html = await renderAstro(SiteHeader as Component, { props: { currentPath: '"><img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=alert');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SiteHeader · variante compact', () => {
  const render = (path?: string): Promise<Document> => renderHeader({ variant: 'compact', currentPath: path });

  test('landmarks: header y nav "Principal"', async () => {
    const doc = await render();
    expect(doc.querySelectorAll('header').length).toBe(ONE);
    const navs = [...doc.querySelectorAll('nav')];
    expect(navs.length).toBe(ONE);
    expect(accName(navs[NONE])).toBe('Principal');
  });

  test('wordmark + Nosotros y Contacto', async () => {
    const h = header(await render());
    expect(links(h).find((a) => a.getAttribute('href') === '/')).toBeDefined();
    expect(linkByName(h, 'Nosotros')?.getAttribute('href')).toBe('/nosotros');
    expect(linkByName(h, 'Contacto')?.getAttribute('href')).toBe('/nosotros#contacto');
  });

  test('sin accesos (deseos, carrito, cuenta), sin búsqueda, sin damero y sin menú desplegable', async () => {
    const h = header(await render());
    const hrefs = links(h).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/carrito');
    expect(hrefs).not.toContain('/cuenta');
    expect(hrefs).not.toContain('/cuenta/lista-de-deseos');
    expect(h.querySelector('form, input, [role="search"]')).toBeNull();
    expect(h.querySelector('[data-palette]')).toBeNull();
    expect(h.querySelector('[popover], [popovertarget]')).toBeNull();
  });

  test('"Relojes" no está en la cabecera compacta (solo Nosotros y Contacto)', async () => {
    expect(linkByName(header(await render()), 'Relojes')).toBeUndefined();
  });

  test('es distinguible de full y más ligera', async () => {
    const full = await renderAstro(SiteHeader as Component, { props: { variant: 'full' } });
    const compact = await renderAstro(SiteHeader as Component, { props: { variant: 'compact' } });
    expect(compact).not.toBe(full);
    expect(compact.length).toBeLessThan(full.length);
  });

  test('aria-current en Nosotros y nunca en Contacto', async () => {
    const h = header(await render('/nosotros'));
    expect(linkByName(h, 'Nosotros')?.getAttribute('aria-current')).toBe('page');
    expect(linkByName(h, 'Contacto')?.hasAttribute('aria-current')).toBe(false);
  });

  test('sin símbolo ni descriptor de marca (el paquete lo excluye)', async () => {
    const h = header(await render());
    expect(h.querySelector('img')).toBeNull();
    expect(squash(h.textContent)).not.toContain(SITE.tagline);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SiteHeader · script del menú (D-014: sin framework)', () => {
  const src = read('src/components/layout/SiteHeader.astro');
  const scripts = [...src.matchAll(SCRIPT_BLOCK)].map((m) => m[ONE]);

  test('a lo sumo un <script> de menos de 30 líneas', () => {
    expect(scripts.length).toBeLessThanOrEqual(ONE);
    scripts.forEach((s) => expect(s.trim().split('\n').length).toBeLessThan(MAX_SCRIPT_LINES));
  });

  test('el script no hace red ni inserta HTML ni importa un framework', () => {
    scripts.forEach((s) => {
      expect(s).not.toMatch(SCRIPT_FORBIDDEN);
      expect(s).not.toMatch(IMPORT);
    });
    expect(src).not.toMatch(FRAMEWORK_IMPORT);
    expect(src).not.toMatch(HYDRATION);
  });

  test('el marcado no usa controladores en línea (onclick…)', () => {
    expect(src).not.toMatch(INLINE_HANDLER);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('SiteFooter', () => {
  test('landmark footer (contentinfo) único, sin header ni main dentro', async () => {
    const doc = await renderFooter();
    expect(doc.querySelectorAll('footer').length).toBe(ONE);
    expect(doc.querySelectorAll('header, main').length).toBe(NONE);
  });

  test('enlaces del paquete con su href: Relojes, Nosotros, Contacto, Privacidad y Términos', async () => {
    const f = (await renderFooter()).querySelector('footer') as Element;
    expect(linkByName(f, 'Relojes')?.getAttribute('href')).toBe('/relojes');
    expect(linkByName(f, 'Nosotros')?.getAttribute('href')).toBe('/nosotros');
    expect(linkByName(f, 'Contacto')?.getAttribute('href')).toBe('/nosotros#contacto');
    expect(linkByName(f, 'Privacidad')?.getAttribute('href')).toBe('/privacidad');
    expect(linkByName(f, TERMS)?.getAttribute('href')).toBe('/terminos');
  });

  test('cada nav del pie tiene nombre accesible, distinto de "Principal" y sin repetirse (landmarks únicos)', async () => {
    const navs = [...(await renderFooter()).querySelectorAll('nav')];
    navs.forEach((n) => {
      expect(accName(n).length, n.outerHTML.slice(NONE, SNIPPET)).toBeGreaterThan(NONE);
      expect(accName(n)).not.toBe('Principal');
    });
    const names = navs.map(accName);
    expect(new Set(names).size).toBe(names.length);
  });

  test('teléfono con tel: y correo con mailto:, y el texto visible sale de SITE', async () => {
    const f = (await renderFooter()).querySelector('footer') as Element;
    const tel = links(f).find((a) => (a.getAttribute('href') ?? '').startsWith('tel:'));
    expect(tel, 'falta el enlace tel:').toBeDefined();
    expect((tel?.getAttribute('href') ?? '').replace(NOT_PHONE, '')).toBe('+5116254500');
    expect(squash(tel?.textContent)).toContain(SITE.phone);
    const mail = links(f).find((a) => (a.getAttribute('href') ?? '').startsWith('mailto:'));
    expect(mail, 'falta el enlace mailto:').toBeDefined();
    expect(mail?.getAttribute('href')).toBe(`mailto:${SITE.email}`);
    expect(squash(mail?.textContent)).toContain(SITE.email);
  });

  test('Instagram sale de SITE y el enlace externo lleva rel="noopener noreferrer"', async () => {
    const f = (await renderFooter()).querySelector('footer') as Element;
    const ig = links(f).find((a) => a.getAttribute('href') === SITE.instagram.href);
    expect(ig, 'falta el enlace de Instagram').toBeDefined();
    expect(squash(ig?.textContent)).toContain(SITE.instagram.label);
    expect(relTokens(ig)).toContain('noopener');
    expect(relTokens(ig)).toContain('noreferrer');
  });

  test('todo enlace externo de cabecera y pie lleva rel seguro', async () => {
    const docs = [await renderFooter(), await renderHeader(), await renderHeader({ variant: 'compact' })];
    docs.forEach((doc) => {
      links(doc)
        .filter((a) => EXTERNAL.test(a.getAttribute('href') ?? ''))
        .forEach((a) => {
          expect(relTokens(a), a.outerHTML).toContain('noopener');
          expect(relTokens(a), a.outerHTML).toContain('noreferrer');
        });
    });
  });

  test('un enlace con target="_blank" siempre lleva noopener (tabnabbing)', async () => {
    const docs = [await renderFooter(), await renderHeader()];
    docs.forEach((doc) => {
      [...doc.querySelectorAll('a[target="_blank"]')].forEach((a) => expect(relTokens(a), a.outerHTML).toContain('noopener'));
    });
  });

  test('derechos: "© 2026 Valmont. Todos los derechos reservados."', async () => {
    const f = (await renderFooter()).querySelector('footer') as Element;
    expect(squash(f.textContent)).toContain('© 2026 Valmont. Todos los derechos reservados.');
  });

  test('wordmark gigante decorativo (aria-hidden) y damero al pie', async () => {
    const f = (await renderFooter()).querySelector('footer') as Element;
    const decorative = [...f.querySelectorAll('[aria-hidden="true"]')].filter((e) => !e.hasAttribute('data-palette'));
    expect(decorative.length, 'falta el wordmark decorativo oculto a lectores').toBeGreaterThan(NONE);
    expect(f.querySelector('[data-palette]'), 'falta el damero').not.toBeNull();
  });

  test('sin scripts ni controladores en línea', async () => {
    const html = await renderAstro(SiteFooter as Component, {});
    expect(parseScripts(html)).toBe(NONE);
    expect(html).not.toMatch(INLINE_HANDLER);
  });

  test('ids únicos y ningún h1', async () => {
    const doc = await renderFooter();
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.querySelectorAll('h1').length).toBe(NONE);
  });
});

/** Número de <script> del HTML (el pie no debe traer ninguno). */
function parseScripts(html: string): number {
  return [...html.matchAll(SCRIPT_BLOCK)].length;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('PageTitle', () => {
  const render = (props: Record<string, unknown>, slots: Record<string, string> = {}): Promise<Document> =>
    renderDocument(PageTitle as Component, { props, slots });

  test('por defecto pinta un único h1 con el título', async () => {
    const doc = await render({ title: 'Relojes' });
    const h1s = [...doc.querySelectorAll('h1')];
    expect(h1s.length).toBe(ONE);
    expect(squash(h1s[NONE].textContent)).toContain('Relojes');
    expect(doc.querySelectorAll('h2').length).toBe(NONE);
  });

  test('level={2} pinta un h2 y ningún h1', async () => {
    const doc = await render({ title: 'Sección', level: LEVEL_TWO });
    expect(doc.querySelectorAll('h1').length).toBe(NONE);
    const h2 = doc.querySelectorAll('h2');
    expect(h2.length).toBe(ONE);
    expect(squash(h2[NONE].textContent)).toContain('Sección');
  });

  test('kicker y description se pintan solo si se pasan', async () => {
    const bare = await render({ title: 'Solo título' });
    const full = await render({ title: 'Con todo', kicker: 'Colección', description: 'Descripción de la página' });
    expect(squash(bare.body.textContent)).toBe('Solo título');
    const text = squash(full.body.textContent);
    expect(text).toContain('Colección');
    expect(text).toContain('Descripción de la página');
    expect(text).toContain('Con todo');
  });

  test('el h1 contiene el título y no la descripción', async () => {
    const doc = await render({ title: 'Mi título', kicker: 'Antetítulo', description: 'Texto de apoyo' });
    const h1 = squash(doc.querySelector('h1')?.textContent);
    expect(h1).toContain('Mi título');
    expect(h1).not.toContain('Texto de apoyo');
  });

  test('align distingue "start" y "center" y por defecto es start', async () => {
    const start = (await render({ title: 'T', align: 'start' })).body.innerHTML;
    const center = (await render({ title: 'T', align: 'center' })).body.innerHTML;
    const byDefault = (await render({ title: 'T' })).body.innerHTML;
    expect(center).not.toBe(start);
    expect(byDefault).toBe(start);
    expect(center).toContain('center');
  });

  test('slot "meta" se pinta; sin slot no hay texto añadido', async () => {
    const withMeta = await render({ title: 'T' }, { meta: '<p id="meta-x">Actualizado hoy</p>' });
    expect(withMeta.querySelector('#meta-x')?.textContent).toBe('Actualizado hoy');
    const without = await render({ title: 'T' });
    expect(squash(without.body.textContent)).toBe('T');
  });

  test('el slot meta queda fuera del h1', async () => {
    const doc = await render({ title: 'T' }, { meta: '<p id="meta-x">Meta</p>' });
    expect(doc.querySelector('h1 #meta-x')).toBeNull();
  });

  test('título, kicker y descripción son texto, no HTML', async () => {
    const doc = await render({ title: '<img src=x onerror=alert(1)>', kicker: '<b id="k">k</b>', description: '<i id="d">d</i>' });
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('#k, #d')).toBeNull();
    expect(doc.querySelector('h1')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('StoreLayout · cableado de cabecera y pie', () => {
  const render = (props: Record<string, unknown> = {}, path?: string, slot = '<h1 id="t">Contenido</h1>'): Promise<Document> =>
    renderDocument(StoreLayout, {
      props: { title: 'Valmont', ...props },
      slots: { default: slot },
      ...(path ? { request: requestAt(path) } : {}),
    });

  test('un header, un footer y un main#contenido; cabecera antes del main y pie después', async () => {
    const doc = await render();
    expect(doc.querySelectorAll('header').length).toBe(ONE);
    expect(doc.querySelectorAll('footer').length).toBe(ONE);
    expect(doc.querySelectorAll('main#contenido').length).toBe(ONE);
    const order = [...doc.body.querySelectorAll('header, main, footer')].map((e) => e.tagName.toLowerCase());
    expect(order).toEqual(['header', 'main', 'footer']);
    expect(doc.querySelector('main')?.querySelector('header, footer')).toBeNull();
  });

  test('cabecera full por defecto: búsqueda y accesos de P-1', async () => {
    const h = header(await render());
    expect(h.querySelector('form[role="search"][action="/relojes"]')).not.toBeNull();
    expect(linkByName(h, 'Carrito')?.getAttribute('href')).toBe('/carrito');
    expect(linkByName(h, 'Relojes')?.getAttribute('href')).toBe('/relojes');
    expect(h.querySelector('[data-palette="storefront"]')).not.toBeNull();
  });

  test('headerVariant="compact" pinta la cabecera compacta (sin búsqueda ni accesos) y conserva el pie', async () => {
    const doc = await render({ headerVariant: 'compact' });
    const h = header(doc);
    expect(h.querySelector('form')).toBeNull();
    expect(linkByName(h, 'Carrito')).toBeUndefined();
    expect(linkByName(h, 'Nosotros')).toBeDefined();
    expect(doc.querySelectorAll('footer').length).toBe(ONE);
  });

  test('la cabecera recibe la ruta de la petición: aria-current en la página actual', async () => {
    const doc = await render({}, '/relojes');
    expect(linkByName(header(doc), 'Relojes')?.getAttribute('aria-current')).toBe('page');
    expect(linkByName(header(doc), 'Contacto')?.hasAttribute('aria-current')).toBe(false);
  });

  test('landmarks únicos: los nav tienen nombre y no se repiten', async () => {
    const names = [...(await render()).querySelectorAll('nav')].map(accName);
    expect(names.every((n) => n.length > NONE)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  test('sin PageTitle el layout no añade ningún h1; con un h1 en el contenido hay uno solo', async () => {
    expect((await render({}, undefined, '<p>Sin título</p>')).querySelectorAll('h1').length).toBe(NONE);
    expect((await render()).querySelectorAll('h1').length).toBe(ONE);
  });

  test('el enlace para saltar al contenido sigue siendo el primer enfocable y precede a la cabecera', async () => {
    const doc = await render();
    const first = doc.body.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(first?.getAttribute('href')).toBe('#contenido');
    expect(accName(first as Element).toLowerCase()).toBe('saltar al contenido');
    expect(precedes(doc, first, header(doc))).toBe(true);
  });

  test('el pie del layout trae el contacto de SITE', async () => {
    const f = (await render()).querySelector('footer') as Element;
    expect(links(f).some((a) => a.getAttribute('href') === `mailto:${SITE.email}`)).toBe(true);
  });
});

describe('AuthLayout · cableado de la cabecera compacta', () => {
  const render = (props: Record<string, unknown> = {}, path?: string): Promise<Document> =>
    renderDocument(AuthLayout, {
      props: { title: 'Ingresar', variant: 'login', ...props },
      slots: { default: '<h1 id="t">Ingresar</h1><form><label>Correo <input type="email"></label></form>', art: '<div id="arte">arte</div>' },
      ...(path ? { request: requestAt(path) } : {}),
    });

  test.each(['login', 'register'] as const)('variant="%s": cabecera compacta antes del main#contenido', async (variant) => {
    const doc = await render({ variant });
    expect(doc.querySelectorAll('header').length).toBe(ONE);
    expect(doc.querySelectorAll('main#contenido').length).toBe(ONE);
    const order = [...doc.body.querySelectorAll('header, main')].map((e) => e.tagName.toLowerCase());
    expect(order).toEqual(['header', 'main']);
    expect(doc.querySelector('main')?.querySelector('header')).toBeNull();
  });

  test('la cabecera es compacta: wordmark, Nosotros y Contacto; sin búsqueda, accesos ni damero', async () => {
    const h = header(await render());
    expect(links(h).find((a) => a.getAttribute('href') === '/')).toBeDefined();
    expect(linkByName(h, 'Nosotros')?.getAttribute('href')).toBe('/nosotros');
    expect(linkByName(h, 'Contacto')?.getAttribute('href')).toBe('/nosotros#contacto');
    expect(h.querySelector('form, [data-palette], [popovertarget]')).toBeNull();
    const hrefs = links(h).map((a) => a.getAttribute('href'));
    ['/carrito', '/cuenta', '/cuenta/lista-de-deseos'].forEach((forbidden) => expect(hrefs).not.toContain(forbidden));
  });

  test('un solo h1 (el del contenido) y nav con nombre', async () => {
    const doc = await render();
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    const navs = [...doc.querySelectorAll('nav')];
    expect(navs.length).toBeGreaterThan(NONE);
    expect(navs.every((n) => accName(n).length > NONE)).toBe(true);
  });

  test('el enlace para saltar al contenido sigue siendo el primer enfocable y precede a la cabecera', async () => {
    const doc = await render();
    const first = doc.body.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(first?.getAttribute('href')).toBe('#contenido');
    expect(precedes(doc, first, header(doc))).toBe(true);
  });

  test('aria-current en la cabecera compacta según la ruta', async () => {
    const h = header(await render({}, '/nosotros'));
    expect(linkByName(h, 'Nosotros')?.getAttribute('aria-current')).toBe('page');
  });

  test('sigue siendo noindex y conserva el slot art fuera del main', async () => {
    const doc = await render();
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '').toContain('noindex');
    expect(doc.querySelector('main #arte')).toBeNull();
    expect(doc.querySelector('#arte')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('RT-1 · valores sueltos en los archivos de T-119', () => {
  const COMPONENTS = [
    'src/components/layout/SiteHeader.astro',
    'src/components/layout/SiteFooter.astro',
    'src/components/layout/PageTitle.astro',
  ];
  const FILES = [
    ...COMPONENTS,
    'src/lib/site.ts',
    'src/pages/dev/layout.astro',
    'src/layouts/StoreLayout.astro',
    'src/layouts/AuthLayout.astro',
  ];
  const offenders = (f: string, re: RegExp): string[] =>
    read(f)
      .split('\n')
      .flatMap((l, i) => (re.test(l) ? [`${f}:${i + ONE}: ${l.trim()}`] : []));

  test.each(FILES)('%s · sin #hex (el grep de revisión)', (f) => {
    expect(offenders(f, HEX).filter((l) => !HEX_ALLOWED.test(l))).toEqual([]);
  });

  test.each(FILES)('%s · sin funciones de color, font-family literal ni font-size en px', (f) => {
    expect(offenders(f, COLOR_FN)).toEqual([]);
    expect(offenders(f, FONT_LITERAL)).toEqual([]);
    expect(offenders(f, FONT_PX)).toEqual([]);
  });

  test.each(COMPONENTS)('%s · el <style> va dentro de @layer components', (f) => {
    const styles = [...read(f).matchAll(STYLE_BLOCK)].map((m) => m[ONE].trim());
    expect(styles.length).toBeGreaterThan(NONE);
    expect(styles.filter((s) => !LAYER_COMPONENTS.test(s))).toEqual([]);
  });

  test.each(COMPONENTS)('%s · los @media usan los breakpoints literales 800px o 1280px', (f) => {
    const conditions = [...read(f).matchAll(MEDIA_QUERY)].map((m) => squash(m[ONE]));
    expect(conditions.filter((c) => !MEDIA_OK.test(c))).toEqual([]);
  });

  test('el damero ocupa el 100 % del contenedor, no un ancho fijo en px ni vw', () => {
    expect(read('src/components/ui/Checkerboard.astro')).toMatch(FULL_WIDTH);
    ['src/components/layout/SiteHeader.astro', 'src/components/layout/SiteFooter.astro'].forEach((f) => {
      expect(offenders(f, FIXED_WIDTH).filter((l) => BOARD_LINE.test(l))).toEqual([]);
    });
  });

  test.each(FILES)('%s · sin set:html ni console.* (RT-5)', (f) => {
    expect(offenders(f, UNSAFE)).toEqual([]);
  });

  test.each(FILES)('%s · sin fetch ni framework (RT-2, D-014)', (f) => {
    expect(offenders(f, NET_OR_FRAMEWORK)).toEqual([]);
  });
});
