import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, test } from 'vitest';
import NavItem from '../../src/components/admin/NavItem.astro';
import UserMenu from '../../src/components/admin/UserMenu.astro';
import AdminLayout from '../../src/layouts/AdminLayout.astro';
import BaseLayout from '../../src/layouts/BaseLayout.astro';
import StoreLayout from '../../src/layouts/StoreLayout.astro';
import NoDisponible from '../../src/pages/admin/no-disponible.astro';
import SinPermiso from '../../src/pages/admin/sin-permiso.astro';
import { ADMIN_NAV } from '../../src/lib/admin/nav';
import { parseHtml, renderAstro, renderDocument } from '../helpers/render';
import { BEARER_VALUE } from '../helpers/t126';
import { text } from '../helpers/ui';

const FAR_FUTURE = 4102444800;

// T-142 · Container API de AdminLayout (completo y `minimal`), NavItem, UserMenu, BaseLayout.context y las páginas
// /admin/sin-permiso y /admin/no-disponible. Seguridad: un cliente que recibe el 403 no ve ninguna entrada de administración.
const ONE = 1;
const EIGHT = 8;
const SEVEN = 7;
const FORBIDDEN = 403;
const UNAVAILABLE = 503;
const ORIGIN = 'http://localhost:4321';
const NO_STORE = 'private, no-store';
const LABELS = ['Panel', 'Pedidos', 'Productos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría'];
const MENU_ONLY = LABELS.filter((l) => l !== 'Panel');
const PROTECTED_WORDS = ['Pedidos', 'Productos', 'Inventario', 'Promociones', 'Reportes', 'Clientes', 'Auditoría', 'Pronto'];
const LEAKS = ['Authorization', 'API_BASE_URL', 'api/v1', 'Bearer', 'ana.torres@example.com', '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', 'customer'];
const HOSTILE = '<img src=x onerror=alert(1)><script>window.__x=1</script>';

const layout = (props: Record<string, unknown> = {}, slots: Record<string, string> = { default: '<p id="cuerpo">Contenido</p>' }) =>
  renderDocument(AdminLayout, { props: { title: 'Panel', section: 'panel', userName: 'Ana Torres', ...props }, slots });
const hrefs = (doc: Document): string[] => [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
const noHostileMarkup = (doc: Document, html: string): void => {
  expect(doc.querySelectorAll('img[onerror]').length).toBe(0);
  expect([...doc.querySelectorAll('script')].filter((s) => (s.textContent ?? '').includes('__x')).length).toBe(0);
  // Los atributos entre comillas pueden llevar `<`: lo que importa es que el DOM no gane elementos ni manejadores.
  expect(doc.querySelectorAll('[onerror], [onfocus], [onclick], [onload]').length).toBe(0);
};

describe('BaseLayout · prop context', () => {
  const html = (props: Record<string, unknown>) => renderAstro(BaseLayout, { props: { title: 'x', ...props }, slots: { default: '<p>hola</p>' } });

  test('context="backoffice" → <html lang="es" data-context="backoffice">', async () => {
    const doc = parseHtml(await html({ context: 'backoffice' }));
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.documentElement.getAttribute('data-context')).toBe('backoffice');
  });

  test.each([[undefined], ['store'], ['evil'], ['"><script>x</script>'], ['']])('context %j → la tienda: sin data-context="backoffice"', async (context) => {
    const out = await html(context === undefined ? {} : { context });
    expect(out).not.toMatch(/data-context\s*=\s*["']?backoffice/);
    expect(parseHtml(out).documentElement.getAttribute('data-context')).not.toBe('backoffice');
    expect(out).not.toContain('<script>x</script>');
  });

  test('las páginas de la tienda (StoreLayout) no declaran el contexto', async () => {
    const out = await renderAstro(StoreLayout, { props: { title: 'Tienda' }, slots: { default: '<p>x</p>' } });
    expect(out).not.toContain('data-context');
  });

  test('el orden de capas sigue declarado antes de cualquier hoja (CSS @layer en línea) con el contexto activo', async () => {
    const out = await html({ context: 'backoffice' });
    expect(out.indexOf('@layer reset, tokens, base, components, utilities;')).toBeGreaterThan(-ONE);
    expect(out.indexOf('@layer reset, tokens')).toBeLessThan(out.indexOf('<body'));
  });
});

describe('AdminLayout · marco completo', () => {
  test('<html lang="es" data-context="backoffice">, noindex y título', async () => {
    const doc = await layout({ title: 'Pedidos' });
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.documentElement.getAttribute('data-context')).toBe('backoffice');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(/noindex/);
    expect(doc.title).toContain('Pedidos');
  });

  test('enlace de salto al main#contenido y es el primer elemento enfocable', async () => {
    const doc = await layout();
    const skip = [...doc.querySelectorAll('a')].find((a) => /saltar al contenido/i.test(a.textContent ?? ''));
    expect(skip?.getAttribute('href')).toBe('#contenido');
    expect(doc.body.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).toBe(skip);
  });

  test('un solo main#contenido (tabindex -1) y un solo h1 con el título', async () => {
    const doc = await layout({ title: 'Inventario' }, { default: '<h2>Sub</h2>', actions: '<button>Acción</button>' });
    expect(doc.querySelectorAll('main').length).toBe(ONE);
    expect(doc.querySelector('main#contenido')?.getAttribute('tabindex')).toBe('-1');
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    expect(text(doc.querySelector('h1'))).toBe('Inventario');
    expect(doc.querySelector('main')?.contains(doc.querySelector('h1'))).toBe(true);
  });

  test('nav aria-label="Administración" con las 8 entradas en orden', async () => {
    const doc = await layout();
    const navs = [...doc.querySelectorAll('nav[aria-label="Administración"]')];
    expect(navs.length).toBe(ONE);
    const items = [...navs[0].querySelectorAll('li')];
    expect(items.length).toBe(EIGHT);
    expect(items.map((li, i) => text(li).startsWith(LABELS[i]))).toEqual(LABELS.map(() => true));
  });

  test('section="panel": Panel es un enlace a /admin con aria-current="page"; las que aún no tienen pantalla no tienen href y dicen «Pronto» (T-147 habilita Productos)', async () => {
    const doc = await layout({ section: 'panel' });
    const nav = doc.querySelector('nav[aria-label="Administración"]')!;
    const current = [...nav.querySelectorAll('[aria-current]')];
    expect(current.length).toBe(ONE);
    expect(current[0].getAttribute('aria-current')).toBe('page');
    expect(current[0].tagName).toBe('A');
    expect(current[0].getAttribute('href')).toBe('/admin');
    expect(text(current[0])).toContain('Panel');
    const enabledLabels = ADMIN_NAV.filter((e) => e.enabled).map((e) => e.label);
    expect(nav.querySelectorAll('a[href]').length).toBe(enabledLabels.length);
    const disabled = [...nav.querySelectorAll('[aria-disabled="true"]')];
    expect(disabled.length).toBe(EIGHT - enabledLabels.length);
    disabled.forEach((el) => {
      expect(el.hasAttribute('href')).toBe(false);
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(text(el)).toContain('Pronto');
    });
    expect(disabled.map((el) => LABELS.find((l) => text(el).includes(l)))).toEqual(LABELS.filter((l) => !enabledLabels.includes(l)));
  });

  test('section de un módulo aún sin pantalla (pedidos): nada marca aria-current (no hay enlace al que apuntar) y sigue habiendo 8 entradas', async () => {
    const doc = await layout({ section: 'pedidos', title: 'Pedidos' });
    const nav = doc.querySelector('nav[aria-label="Administración"]')!;
    expect(nav.querySelectorAll('[aria-current="page"]').length).toBeLessThanOrEqual(ONE);
    expect(nav.querySelectorAll('li').length).toBe(EIGHT);
    expect(nav.querySelectorAll('[href]').length).toBe(ADMIN_NAV.filter((e) => e.enabled).length);
  });

  test('ADMIN_NAV: 8 entradas con el orden, las rutas y los textos del paquete; Panel siempre habilitado y los módulos sin pantalla (inventario…auditoría) deshabilitados (D-B1)', () => {
    expect(ADMIN_NAV.map((e) => e.section)).toEqual(['panel', 'pedidos', 'productos', 'inventario', 'promociones', 'reportes', 'clientes', 'auditoria']);
    expect(ADMIN_NAV.map((e) => e.label)).toEqual(LABELS);
    expect(ADMIN_NAV.map((e) => e.href)).toEqual(['/admin', '/admin/pedidos', '/admin/productos', '/admin/inventario', '/admin/promociones', '/admin/reportes', '/admin/clientes', '/admin/auditoria']);
    const enabled = ADMIN_NAV.filter((e) => e.enabled).map((e) => e.section);
    expect(enabled).toContain('panel');
    ['inventario', 'promociones', 'reportes', 'clientes', 'auditoria'].forEach((s) => expect(enabled).not.toContain(s));
    expect(new Set(ADMIN_NAV.map((e) => e.icon)).size).toBe(EIGHT);
  });

  test('migas (nav "Migas de pan"): el último elemento es la página actual y los anteriores con href son enlaces', async () => {
    const doc = await layout({ crumbs: [{ label: 'Pedidos', href: '/admin/pedidos' }, { label: 'VAL-000123' }] });
    const crumbs = doc.querySelector('nav[aria-label="Migas de pan"]')!;
    expect(crumbs).not.toBeNull();
    const last = crumbs.querySelector('[aria-current="page"]');
    expect(text(last)).toBe('VAL-000123');
    expect(crumbs.querySelector('a[href="/admin/pedidos"]')).not.toBeNull();
  });

  test('UserMenu: «Ver tienda» (/) y un formulario POST a /salir con «Cerrar sesión»', async () => {
    const doc = await layout();
    const shop = [...doc.querySelectorAll('a')].filter((a) => /ver tienda/i.test(text(a)));
    expect(shop.length).toBeGreaterThanOrEqual(ONE);
    shop.forEach((a) => expect(a.getAttribute('href')).toBe('/'));
    const form = doc.querySelector('form[action="/salir"]');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(text(form?.querySelector('button[type="submit"]'))).toBe('Cerrar sesión');
    expect(doc.querySelectorAll('form').length).toBe(ONE);
  });

  test('la barra lateral es un popover enlazado por un botón con nombre accesible (menú por teclado bajo 1025 px; <nav> utilizable sin JavaScript)', async () => {
    const doc = await layout();
    const panel = doc.querySelector('[popover]:has(nav[aria-label="Administración"])');
    expect(panel, 'el nav de administración debe vivir dentro de un [popover]').not.toBeNull();
    const id = panel!.getAttribute('id');
    expect(id).toBeTruthy();
    const openers = [...doc.querySelectorAll(`button[popovertarget="${id}"]`)];
    expect(openers.length).toBeGreaterThanOrEqual(ONE);
    openers.forEach((b) => expect(b.getAttribute('aria-label') || text(b)).toBeTruthy());
    expect(doc.querySelectorAll('script[src], script:not([src])').length).toBe(doc.querySelectorAll('script[src], script:not([src])').length);
  });

  test('slots: el contenido y las acciones se pintan; sin slot actions no hay contenedor de acciones vacío', async () => {
    const withActions = await layout({}, { default: '<p id="cuerpo">Contenido</p>', actions: '<button id="accion">Nuevo</button>' });
    expect(withActions.querySelector('main #cuerpo')).not.toBeNull();
    expect(withActions.querySelector('main #accion')).not.toBeNull();
    const without = await layout({}, { default: '<p id="cuerpo">Contenido</p>' });
    expect(without.querySelector('#accion')).toBeNull();
    expect([...without.querySelectorAll('main div')].filter((d) => d.children.length === 0 && text(d) === '' && /action/i.test(d.className)).length).toBe(0);
  });

  test('description opcional: aparece solo si se envía', async () => {
    expect(text((await layout({ description: 'Gestiona los pedidos.' })).querySelector('main'))).toContain('Gestiona los pedidos.');
    expect(text((await layout()).querySelector('main'))).not.toContain('undefined');
  });

  test('textos hostiles (título, descripción, miga, nombre) se escapan: sin HTML ni script inyectado', async () => {
    const html = await renderAstro(AdminLayout, {
      props: { title: HOSTILE, section: 'panel', userName: HOSTILE, description: HOSTILE, crumbs: [{ label: HOSTILE, href: '/admin' }, { label: HOSTILE }] },
      slots: { default: '<p>x</p>' },
    });
    noHostileMarkup(parseHtml(html), html);
    expect(html).toContain('&lt;');
  });

  test('userName null: el marco sigue completo y no imprime "null" ni "undefined"', async () => {
    const doc = await layout({ userName: null });
    expect(doc.querySelector('nav[aria-label="Administración"]')).not.toBeNull();
    expect(doc.body.textContent ?? '').not.toMatch(/\bnull\b|\bundefined\b/);
    expect(doc.querySelector('form[action="/salir"]')).not.toBeNull();
  });

  test('el HTML no contiene credenciales, la URL de la API ni datos del perfil más allá del nombre (RT-1)', async () => {
    const html = await renderAstro(AdminLayout, { props: { title: 'Panel', section: 'panel', userName: 'Ana Torres' }, slots: { default: '<p>x</p>' } });
    LEAKS.forEach((leak) => expect(html).not.toContain(leak));
  });
});

describe('AdminLayout · minimal (el cliente que recibe el 403 no ve ninguna entrada de administración)', () => {
  const minimal = (props: Record<string, unknown> = {}) =>
    renderAstro(AdminLayout, { props: { title: 'No tienes permiso', section: 'panel', userName: 'Ana Torres', minimal: true, ...props }, slots: { default: '<p>Texto</p>' } });

  test('sin barra lateral, sin nav de administración, sin popover, sin migas, sin UserMenu', async () => {
    const doc = parseHtml(await minimal());
    expect(doc.querySelector('nav[aria-label="Administración"]')).toBeNull();
    expect(doc.querySelector('[popover]')).toBeNull();
    expect(doc.querySelector('[popovertarget]')).toBeNull();
    expect(doc.querySelector('nav[aria-label="Migas de pan"]')).toBeNull();
    expect(doc.querySelector('form[action="/salir"]')).toBeNull();
    expect(doc.querySelector('[aria-disabled]')).toBeNull();
    expect(doc.querySelector('[aria-current="page"]')).toBeNull();
  });

  test.each(PROTECTED_WORDS)('el HTML no menciona «%s»', async (word) => {
    const html = await minimal();
    expect(parseHtml(html).body.textContent ?? '').not.toContain(word);
    expect(html).not.toContain(`>${word}<`);
  });

  test('ningún enlace a /admin/…: los únicos destinos son la tienda (/) y el salto al contenido', async () => {
    const doc = parseHtml(await minimal());
    expect(hrefs(doc).filter((h) => h !== '#contenido' && h !== '/')).toEqual([]);
    expect(hrefs(doc)).toContain('/');
    expect([...doc.querySelectorAll('a')].some((a) => /volver a la tienda/i.test(text(a)))).toBe(true);
  });

  test('no filtra el nombre de la cuenta aunque se le pase userName', async () => {
    const html = await minimal({ userName: 'Ana Torres' });
    expect(html).not.toContain('Ana Torres');
    expect(html).not.toContain('Administrador');
  });

  test('mantiene lo esencial: data-context, noindex, un h1, main#contenido, enlace de salto y el wordmark', async () => {
    const doc = parseHtml(await minimal());
    expect(doc.documentElement.getAttribute('data-context')).toBe('backoffice');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(/noindex/);
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    expect(text(doc.querySelector('h1'))).toBe('No tienes permiso');
    expect(doc.querySelectorAll('main#contenido').length).toBe(ONE);
    expect([...doc.querySelectorAll('a')].some((a) => a.getAttribute('href') === '#contenido')).toBe(true);
    expect(text(doc.body)).toContain('Valmont');
  });

  test('el wordmark del modo mínimo no enlaza al panel (/admin)', async () => {
    const doc = parseHtml(await minimal());
    expect(doc.querySelector('a[href="/admin"]')).toBeNull();
  });

  test('minimal={false} es el marco completo (valor por defecto)', async () => {
    const doc = parseHtml(await minimal({ minimal: false }));
    expect(doc.querySelector('nav[aria-label="Administración"]')).not.toBeNull();
  });
});

describe('inyección por atributo (comillas en el texto)', () => {
  const QUOTE = 'x" onfocus="window.__x=1" autofocus x="';

  test('un nombre con comillas no añade atributos al botón del UserMenu ni al marco', async () => {
    const html = await renderAstro(AdminLayout, { props: { title: QUOTE, section: 'panel', userName: QUOTE, crumbs: [{ label: QUOTE, href: '/admin' }] }, slots: { default: '' } });
    noHostileMarkup(parseHtml(html), html);
    expect(parseHtml(html).querySelectorAll('[autofocus]').length).toBe(0);
  });

  test('la etiqueta de NavItem con comillas tampoco', async () => {
    const html = await renderAstro(NavItem, { props: { label: QUOTE, icon: 'orders', href: '/admin' } });
    noHostileMarkup(parseHtml(html), html);
  });
});

describe('NavItem', () => {
  const item = async (props: Record<string, unknown>) => (await renderDocument(NavItem, { props: { label: 'Pedidos', icon: 'orders', ...props } })).body;

  test('con href: enlace, texto visible, icono decorativo; aria-current="page" solo si current', async () => {
    const body = await item({ href: '/admin/pedidos', current: true });
    const a = body.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/admin/pedidos');
    expect(a.getAttribute('aria-current')).toBe('page');
    expect(text(a)).toContain('Pedidos');
    expect(a.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(body.querySelector('li')).not.toBeNull();
    const plain = await item({ href: '/admin/pedidos' });
    expect(plain.querySelector('a')?.hasAttribute('aria-current')).toBe(false);
  });

  test.each([
    ['disabled con href', { href: '/admin/pedidos', disabled: true, hint: 'Pronto' }],
    ['sin href', { hint: 'Pronto' }],
    ['disabled sin hint', { href: '/admin/pedidos', disabled: true }],
  ])('deshabilitado (%s): sin href ni enlace, aria-disabled="true", fuera del orden de tabulación', async (_n, props) => {
    const body = await item(props);
    expect(body.querySelector('a')).toBeNull();
    expect(body.querySelector('[href]')).toBeNull();
    const el = body.querySelector('[aria-disabled="true"]')!;
    expect(el).not.toBeNull();
    expect(el.hasAttribute('tabindex')).toBe(false);
    expect(text(el)).toContain('Pedidos');
  });

  test('el texto «Pronto» es visible (no solo aria-label ni title) y solo cuando hay hint', async () => {
    expect(text(await item({ disabled: true, hint: 'Pronto' }))).toContain('Pronto');
    expect(text(await item({ href: '/admin/pedidos' }))).not.toContain('Pronto');
  });

  test('un elemento deshabilitado nunca se marca como página actual', async () => {
    const body = await item({ href: '/admin/pedidos', disabled: true, current: true });
    expect(body.querySelector('[aria-current]')).toBeNull();
  });

  test('la etiqueta se escapa', async () => {
    const html = await renderAstro(NavItem, { props: { label: HOSTILE, icon: 'orders', href: '/admin' } });
    noHostileMarkup(parseHtml(html), html);
  });
});

describe('UserMenu', () => {
  const menu = async (name: string | null) => (await renderDocument(UserMenu, { props: { name } })).body;

  test('con nombre: botón que abre un popover; dentro, «Ver tienda» (/) y el formulario POST /salir con «Cerrar sesión»', async () => {
    const body = await menu('Ana Torres');
    const trigger = body.querySelector('button[popovertarget]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-label') ?? text(trigger)).toContain('Ana Torres');
    // WCAG 2.5.3 (etiqueta en el nombre): un aria-label, si existe, debe contener todo el texto visible; si no, el nombre sale del texto.
    const visible = text(trigger);
    const label = trigger.getAttribute('aria-label');
    if (label !== null) expect(label).toContain(visible);
    const panel = body.querySelector(`[id="${trigger.getAttribute('popovertarget')}"]`)!;
    expect(panel.hasAttribute('popover')).toBe(true);
    expect(panel.querySelector('a[href="/"]')).not.toBeNull();
    const form = panel.querySelector('form[action="/salir"]')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(text(form.querySelector('button[type="submit"]'))).toBe('Cerrar sesión');
    expect(text(body)).toContain('Ana Torres');
  });

  test('las iniciales son decorativas (aria-hidden) y salen de las dos primeras palabras', async () => {
    const body = await menu('ana maría torres');
    const avatar = body.querySelector('[aria-hidden="true"]:not(svg)');
    expect(text(avatar)).toBe('AM');
  });

  test('sin nombre: se pinta igualmente, con «Cerrar sesión» y sin "null"', async () => {
    const body = await menu(null);
    expect(body.querySelector('form[action="/salir"]')).not.toBeNull();
    expect(body.textContent ?? '').not.toMatch(/\bnull\b|\bundefined\b/);
    expect(body.querySelector('button[popovertarget]')?.getAttribute('aria-label') || text(body.querySelector('button[popovertarget]'))).toBeTruthy();
  });

  test.each(['   ', 'x', 'ñandú López', HOSTILE, '\n\t'])('nombre raro %j no rompe el render ni inyecta HTML', async (name) => {
    const html = await renderAstro(UserMenu, { props: { name } });
    noHostileMarkup(parseHtml(html), html);
    expect(html).toContain('form');
  });

  test('no imprime ningún dato del perfil que no sea el nombre (ni correo ni rol en bruto)', async () => {
    const html = await renderAstro(UserMenu, { props: { name: 'Ana Torres' } });
    ['ana.torres@example.com', 'customer', '"role"', 'user_id', 'Bearer'].forEach((s) => expect(html).not.toContain(s));
  });
});

describe('páginas /admin/sin-permiso y /admin/no-disponible', () => {
  type Page = Parameters<AstroContainer['renderToResponse']>[0];
  async function open(page: Page, path: string, session: unknown = { userId: '3f1c2a9e-5b7d-4c1e-9a10-0123456789ab', email: 'ana.torres@example.com', accessToken: BEARER_VALUE, expiresAt: FAR_FUTURE }) {
    const container = await AstroContainer.create();
    const res = await container.renderToResponse(page, { request: new Request(`${ORIGIN}${path}`), locals: { session } as never, routeType: 'page' });
    const html = await res.text();
    return { res, html, doc: parseHtml(html) };
  }

  test('sin-permiso: 403, no-store, h1 «No tienes permiso», enlace a la tienda y «Cerrar sesión» (POST /salir)', async () => {
    const { res, doc } = await open(SinPermiso, '/admin/sin-permiso');
    expect(res.status).toBe(FORBIDDEN);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(text(doc.querySelector('h1'))).toBe('No tienes permiso');
    expect(doc.querySelectorAll('h1').length).toBe(ONE);
    expect(doc.querySelector('a[href="/"]')).not.toBeNull();
    const form = doc.querySelector('form[action="/salir"]');
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(text(form)).toContain('Cerrar sesión');
    expect(doc.documentElement.getAttribute('data-context')).toBe('backoffice');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toMatch(/noindex/);
  });

  test('sin-permiso: ninguna entrada del menú de administración, ningún enlace /admin/…, ningún dato de la cuenta', async () => {
    const { html, doc } = await open(SinPermiso, '/admin/sin-permiso');
    expect(doc.querySelector('nav[aria-label="Administración"]')).toBeNull();
    expect(doc.querySelector('[popover]')).toBeNull();
    PROTECTED_WORDS.forEach((w) => expect(doc.body.textContent ?? '', w).not.toContain(w));
    expect(hrefs(doc).filter((h) => h !== '#contenido' && h !== '/')).toEqual([]);
    LEAKS.forEach((leak) => expect(html).not.toContain(leak));
    expect(html).not.toContain('Ana');
  });

  test('sin-permiso no revela si existe la ruta consultada: el HTML es idéntico tras un rewrite desde cualquier ruta', async () => {
    const a = await open(SinPermiso, '/admin/sin-permiso');
    const b = await open(SinPermiso, '/admin/pedidos/3f1c2a9e-5b7d-4c1e-9a10-0123456789ab?volver=status%3Dpagado');
    const c = await open(SinPermiso, '/admin/no-existe-secreto-9');
    expect(b.html).toBe(a.html);
    expect(c.html).toBe(a.html);
    ['secreto-9', 'no-existe', 'volver', 'pagado'].forEach((s) => expect(b.html + c.html).not.toContain(s));
  });

  test('sin-permiso no vuelve a exigir administrador (sin bucle): su fuente no llama a requireAdmin', async () => {
    const { read } = await import('../helpers/css');
    expect(read('src/pages/admin/sin-permiso.astro')).not.toMatch(/requireAdmin|adminErrorResponse/);
    expect(read('src/pages/admin/no-disponible.astro')).not.toMatch(/requireAdmin|adminErrorResponse/);
  });

  test('no-disponible: 503, no-store, aviso de error (role="alert") con «Reintentar» y sin menú de administración', async () => {
    const { res, doc, html } = await open(NoDisponible, '/admin/no-disponible');
    expect(res.status).toBe(UNAVAILABLE);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect([...doc.querySelectorAll('a, button')].some((el) => /reintentar/i.test(text(el)))).toBe(true);
    expect(doc.querySelector('nav[aria-label="Administración"]')).toBeNull();
    PROTECTED_WORDS.forEach((w) => expect(doc.body.textContent ?? '', w).not.toContain(w));
    ['ECONNREFUSED', 'fetch failed', 'TypeError', 'stack', ...LEAKS].forEach((s) => expect(html).not.toContain(s));
  });

  test('no-disponible: «Reintentar» vuelve a la página pedida (misma ruta y consulta) y nunca a otro origen', async () => {
    const retry = async (path: string) => {
      const { doc } = await open(NoDisponible, path);
      return [...doc.querySelectorAll('a')].find((a) => /reintentar/i.test(text(a)))?.getAttribute('href');
    };
    expect(await retry('/admin/pedidos?status=pagado')).toBe('/admin/pedidos?status=pagado');
    expect(await retry('/admin/no-disponible')).toBe('/admin');
    const hostile = await retry('/admin/pedidos?x="><script>alert(1)</script>');
    expect(hostile?.startsWith('/admin')).toBe(true);
    expect(hostile).not.toContain('<script>');
    expect((await retry('/admin//evil.test'))?.startsWith('//')).toBe(false);
  });

  test('no-disponible: ni un 403 ni nada de administración: el rewrite de un cliente no cambia el HTML (sin datos de la sesión)', async () => {
    const withSession = await open(NoDisponible, '/admin/no-disponible');
    const without = await open(NoDisponible, '/admin/no-disponible', null);
    expect(withSession.html).toBe(without.html);
  });
});

describe('layout minimal frente al completo: la diferencia es solo el menú', () => {
  test('el completo trae las 7 entradas con «Pronto»; el mínimo no trae ninguna de las 8', async () => {
    const full = await renderAstro(AdminLayout, { props: { title: 'T', section: 'panel', userName: null }, slots: { default: '' } });
    const min = await renderAstro(AdminLayout, { props: { title: 'T', section: 'panel', userName: null, minimal: true }, slots: { default: '' } });
    MENU_ONLY.forEach((l) => {
      expect(full).toContain(l);
      expect(min).not.toContain(l);
    });
  });
});
