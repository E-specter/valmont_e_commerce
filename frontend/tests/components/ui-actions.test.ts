import { describe, expect, test } from 'vitest';
import Button from '../../src/components/ui/Button.astro';
import IconButton from '../../src/components/ui/IconButton.astro';
import TextLink from '../../src/components/ui/TextLink.astro';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-117 · Button, IconButton y TextLink (STATUS "T-117 › Firmas públicas") con la Container API.
// El paquete no fija el nombre de las clases: las variantes se comprueban con `markers()` (clases, data-*, style).

const VARIANTS = ['primary', 'dark', 'secondary', 'mint'] as const;
const SIZE_S = 32;
const SIZE_M = 44;
const SIZE_L = 56;
const LABEL = 'Añadir al carrito';

const button = async (props: Record<string, unknown> = {}, label = LABEL): Promise<HTMLElement> =>
  ui(Button, props, { default: label });

/** Hojas del elemento cuyo texto propio empieza por "Cargando" (el aviso para lectores de pantalla). */
const loadingAnnouncements = (el: Element): Element[] =>
  [...el.querySelectorAll('*')].filter((e) => e.children.length === 0 && text(e).toLowerCase().startsWith('cargando'));

describe('Button · elemento y atributos', () => {
  test('sin href es un <button> con type="button" por defecto (nunca envía un formulario por accidente)', async () => {
    const body = await button();
    const el = root(body);
    expect(el.tagName.toLowerCase()).toBe('button');
    expect(el.getAttribute('type')).toBe('button');
    expect(body.querySelectorAll('a').length).toBe(0);
    expect(text(el)).toContain(LABEL);
  });

  test.each(['submit', 'reset', 'button'] as const)('type="%s" se respeta', async (type) => {
    expect(root(await button({ type })).getAttribute('type')).toBe(type);
  });

  test('con href es un <a href> y no un <button>', async () => {
    const body = await button({ href: '/relojes' });
    const el = root(body);
    expect(el.tagName.toLowerCase()).toBe('a');
    expect(el.getAttribute('href')).toBe('/relojes');
    expect(body.querySelectorAll('button').length).toBe(0);
    expect(text(el)).toContain(LABEL);
  });

  test('el contenido del slot default es la etiqueta, sin escapar el marcado propio del slot', async () => {
    const body = await ui(Button, {}, { default: 'Ver <span id="x">detalle</span>' });
    expect(body.querySelector('button #x')?.textContent).toBe('detalle');
  });

  test('...rest: atributos HTML adicionales llegan al elemento y la clase recibida se suma', async () => {
    const el = root(
      await button({ id: 'cta', 'data-testid': 'buy', 'aria-label': 'Comprar reloj', name: 'accion', value: 'comprar', form: 'f1', class: 'extra' }),
    );
    expect(el.getAttribute('id')).toBe('cta');
    expect(el.getAttribute('data-testid')).toBe('buy');
    expect(el.getAttribute('aria-label')).toBe('Comprar reloj');
    expect(el.getAttribute('name')).toBe('accion');
    expect(el.getAttribute('value')).toBe('comprar');
    expect(el.getAttribute('form')).toBe('f1');
    expect(el.classList.contains('extra')).toBe(true);
    expect(el.classList.length).toBeGreaterThan(1);
  });

  test('...rest en un enlace: target y rel llegan al <a>', async () => {
    const el = root(await button({ href: '/x', target: '_blank', rel: 'noopener noreferrer' }));
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('Button · variantes y tamaños', () => {
  test.each(VARIANTS)('variant="%s" se refleja en el marcado', async (variant) => {
    expect(hasMarker(root(await button({ variant })), variant)).toBe(true);
  });

  test('las cuatro variantes son visualmente distintas entre sí', async () => {
    const keys = await Promise.all(VARIANTS.map(async (variant) => markers(root(await button({ variant })))));
    expect(new Set(keys).size).toBe(VARIANTS.length);
  });

  test('primary es la variante por defecto', async () => {
    expect(markers(root(await button()))).toBe(markers(root(await button({ variant: 'primary' }))));
  });

  test('md es el tamaño por defecto y lg se distingue', async () => {
    const def = markers(root(await button()));
    expect(def).toBe(markers(root(await button({ size: 'md' }))));
    const lg = root(await button({ size: 'lg' }));
    expect(hasMarker(lg, 'lg')).toBe(true);
    expect(markers(lg)).not.toBe(def);
  });

  test('fullWidth se refleja en el marcado y no es el valor por defecto', async () => {
    const full = root(await button({ fullWidth: true }));
    expect(hasMarker(full, 'full')).toBe(true);
    expect(markers(full)).not.toBe(markers(root(await button())));
    expect(markers(root(await button({ fullWidth: false })))).toBe(markers(root(await button())));
  });

  test('la variante también aplica a los enlaces (<a>)', async () => {
    expect(hasMarker(root(await button({ href: '/', variant: 'mint' })), 'mint')).toBe(true);
  });
});

describe('Button · estados', () => {
  test('en reposo: sin disabled, sin aria-busy, sin aviso "Cargando"', async () => {
    const el = root(await button());
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.getAttribute('aria-busy')).not.toBe('true');
    expect(loadingAnnouncements(el)).toEqual([]);
  });

  test('disabled en <button> pone el atributo disabled (no se puede activar ni enfocar)', async () => {
    expect(root(await button({ disabled: true })).hasAttribute('disabled')).toBe(true);
    expect(root(await button({ disabled: false })).hasAttribute('disabled')).toBe(false);
  });

  test('disabled en un enlace: aria-disabled="true" y sin href navegable', async () => {
    const el = root(await button({ href: '/pagar', disabled: true }));
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.hasAttribute('href'), 'un enlace deshabilitado con href sigue siendo navegable').toBe(false);
  });

  test('loading: aria-busy="true" y no se puede pulsar dos veces (disabled o aria-disabled)', async () => {
    const el = root(await button({ loading: true }));
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  test('loading anuncia "Cargando" a lectores de pantalla sin mostrarlo (sr-only o región viva)', async () => {
    const el = root(await button({ loading: true }));
    const notes = loadingAnnouncements(el);
    expect(notes.length, 'falta el texto "Cargando"').toBeGreaterThan(0);
    const announced = notes.some((n) => {
      const live = n.closest('[role="status"], [aria-live]');
      return n.classList.contains('sr-only') || (n.closest('.sr-only') !== null) || live !== null;
    });
    expect(announced, 'el texto "Cargando" no está oculto visualmente ni en una región viva').toBe(true);
  });

  test('loading conserva la etiqueta del botón (el ancho no salta)', async () => {
    expect(text(root(await button({ loading: true })))).toContain(LABEL);
  });

  test('loading en un enlace: aria-busy y sin href', async () => {
    const el = root(await button({ href: '/pagar', loading: true }));
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.hasAttribute('href')).toBe(false);
  });

  test('loading no deja el type por defecto "submit": sigue siendo type="button"', async () => {
    expect(root(await button({ loading: true })).getAttribute('type')).toBe('button');
  });
});

describe('Button · icono', () => {
  test('iconRight pinta un icono decorativo (aria-hidden) después de la etiqueta', async () => {
    const el = root(await button({ iconRight: 'arrow-right' }));
    const svg = el.querySelector('svg');
    expect(svg, 'falta el icono').not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    const html = el.innerHTML;
    expect(html.indexOf(LABEL)).toBeLessThan(html.indexOf('<svg'));
  });

  test('sin iconRight no hay icono', async () => {
    expect((await button()).querySelectorAll('svg').length).toBe(0);
  });

  test('el nombre accesible no incluye el icono', async () => {
    expect(text(root(await button({ iconRight: 'arrow-right' })))).toBe(LABEL);
  });
});

describe('IconButton', () => {
  const iconButton = async (props: Record<string, unknown> = {}): Promise<HTMLElement> =>
    ui(IconButton, { icon: 'heart', label: 'Guardar en favoritos', ...props });

  test('por defecto: <button type="button"> con aria-label y un icono decorativo', async () => {
    const body = await iconButton();
    const el = root(body);
    expect(el.tagName.toLowerCase()).toBe('button');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('aria-label')).toBe('Guardar en favoritos');
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.hasAttribute('aria-label')).toBe(false);
  });

  test('label es obligatorio: sin label (o en blanco) renderizar es un error', async () => {
    await expect(ui(IconButton, { icon: 'heart' })).rejects.toThrow();
    await expect(ui(IconButton, { icon: 'heart', label: '' })).rejects.toThrow();
    await expect(ui(IconButton, { icon: 'heart', label: '   ' })).rejects.toThrow();
  });

  test('type="submit" se respeta', async () => {
    expect(root(await iconButton({ type: 'submit', icon: 'send', label: 'Enviar' })).getAttribute('type')).toBe('submit');
  });

  test('con href es un <a href> con el mismo nombre accesible', async () => {
    const body = await iconButton({ href: '/lista-de-deseos' });
    const el = root(body);
    expect(el.tagName.toLowerCase()).toBe('a');
    expect(el.getAttribute('href')).toBe('/lista-de-deseos');
    expect(el.getAttribute('aria-label')).toBe('Guardar en favoritos');
    expect(body.querySelectorAll('button').length).toBe(0);
  });

  test('pressed={true} → aria-pressed="true"; pressed={false} → "false"', async () => {
    expect(root(await iconButton({ pressed: true })).getAttribute('aria-pressed')).toBe('true');
    expect(root(await iconButton({ pressed: false })).getAttribute('aria-pressed')).toBe('false');
  });

  test('sin pressed no es un botón de alternancia: no hay aria-pressed', async () => {
    expect(root(await iconButton()).hasAttribute('aria-pressed')).toBe(false);
  });

  test('disabled pone el atributo disabled', async () => {
    expect(root(await iconButton({ disabled: true })).hasAttribute('disabled')).toBe(true);
    expect(root(await iconButton()).hasAttribute('disabled')).toBe(false);
  });

  test('outline es la variante por defecto y plain se distingue', async () => {
    const def = root(await iconButton());
    expect(markers(def)).toBe(markers(root(await iconButton({ variant: 'outline' }))));
    expect(hasMarker(def, 'outline')).toBe(true);
    const plain = root(await iconButton({ variant: 'plain' }));
    expect(hasMarker(plain, 'plain')).toBe(true);
    expect(markers(plain)).not.toBe(markers(def));
  });

  test('44 es el tamaño por defecto; 32 y 56 se distinguen', async () => {
    const def = markers(root(await iconButton()));
    expect(def).toBe(markers(root(await iconButton({ size: SIZE_M }))));
    expect(hasMarker(root(await iconButton()), String(SIZE_M))).toBe(true);
    const small = root(await iconButton({ size: SIZE_S }));
    const large = root(await iconButton({ size: SIZE_L }));
    expect(hasMarker(small, String(SIZE_S))).toBe(true);
    expect(hasMarker(large, String(SIZE_L))).toBe(true);
    expect(new Set([def, markers(small), markers(large)]).size).toBe(VARIANTS.length - 1);
  });

  test('el icono pedido es el que se dibuja (heart y heart-off son distintos)', async () => {
    const heart = (await iconButton({ icon: 'heart' })).querySelector('svg')!.innerHTML;
    const off = (await iconButton({ icon: 'heart-off' })).querySelector('svg')!.innerHTML;
    expect(heart).not.toBe(off);
  });

  test('una clase recibida se suma a la del componente (no la sustituye: el botón conserva su estilo)', async () => {
    const plain = root(await iconButton());
    const withClass = root(await iconButton({ class: 'extra' }));
    expect(withClass.classList.contains('extra')).toBe(true);
    [...plain.classList].forEach((c) => expect(withClass.classList.contains(c), `se perdió la clase base "${c}"`).toBe(true));
  });

  test('el label se escapa (sin inyección de HTML)', async () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const body = await iconButton({ label: hostile });
    expect(body.querySelectorAll('img').length).toBe(0);
    expect(root(body).getAttribute('aria-label')).toBe(hostile);
  });
});

describe('TextLink', () => {
  const link = async (props: Record<string, unknown> = {}, label = 'Ver detalle'): Promise<HTMLElement> =>
    ui(TextLink, { href: '/relojes/valmont-1', ...props }, { default: label });

  test('es un <a href> con el texto del slot', async () => {
    const el = root(await link());
    expect(el.tagName.toLowerCase()).toBe('a');
    expect(el.getAttribute('href')).toBe('/relojes/valmont-1');
    expect(text(el)).toBe('Ver detalle');
  });

  test('por defecto: sin flecha, sin target ni rel de enlace externo', async () => {
    const body = await link();
    const el = root(body);
    expect(body.querySelectorAll('svg').length).toBe(0);
    expect(el.hasAttribute('target')).toBe(false);
    expect(el.getAttribute('rel') ?? '').not.toContain('noopener');
  });

  test('arrow añade una flecha decorativa (aria-hidden) después del texto', async () => {
    const el = root(await link({ arrow: true }));
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(el.innerHTML.indexOf('Ver detalle')).toBeLessThan(el.innerHTML.indexOf('<svg'));
    expect(text(el)).toBe('Ver detalle');
  });

  test('external: target="_blank" y rel con noopener y noreferrer', async () => {
    const el = root(await link({ external: true, href: 'https://example.com' }));
    expect(el.getAttribute('target')).toBe('_blank');
    const rel = (el.getAttribute('rel') ?? '').split(' ');
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  test('external=false no abre pestañas nuevas', async () => {
    expect(root(await link({ external: false })).hasAttribute('target')).toBe(false);
  });

  test('tone: ink por defecto; ivory y forest se distinguen', async () => {
    const def = markers(root(await link()));
    expect(def).toBe(markers(root(await link({ tone: 'ink' }))));
    const ivory = root(await link({ tone: 'ivory' }));
    const forest = root(await link({ tone: 'forest' }));
    expect(hasMarker(ivory, 'ivory')).toBe(true);
    expect(hasMarker(forest, 'forest')).toBe(true);
    expect(new Set([def, markers(ivory), markers(forest)]).size).toBe(VARIANTS.length - 1);
  });
});
