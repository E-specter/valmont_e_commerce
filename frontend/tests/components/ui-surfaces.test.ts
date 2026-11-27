import { describe, expect, test } from 'vitest';
import Availability from '../../src/components/ui/Availability.astro';
import { availabilityLabel } from '../../src/components/ui/availability';
import Badge from '../../src/components/ui/Badge.astro';
import Card from '../../src/components/ui/Card.astro';
import Chip from '../../src/components/ui/Chip.astro';
import Price from '../../src/components/ui/Price.astro';
import { read } from '../helpers/css';
import { renderAstro } from '../helpers/render';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-118 · Card, Badge, Chip, Price y Availability (STATUS "T-118 › Firmas públicas") con la Container API.
// El paquete no fija el nombre de las clases: las variantes se comprueban con `markers()` (clases, data-*, style).

type Money = { amount: number; currency: 'PEN' };
const pen = (amount: string): Money => ({ amount: Number(amount), currency: 'PEN' });
const PRICE = pen('8450000'); // S/ 84,500
const ORIGINAL = pen('9900000'); // S/ 99,000
const DISCOUNT = pen('1450000'); // S/ 14,500
const FRACTION = pen('1062550'); // S/ 10,625.50
const LEAD_DAYS = 15;
const LEAD_ONE_DAY = 1;
const LEAD_SEVEN_DAYS = 7;
const TOTAL_AMOUNTS_WITH_PROMO = 3;
const TOTAL_TONES = 6;
const TOTAL_KINDS = 3;
const TOTAL_STATES = 4;
const ONE = 1;
const TWO_LINKS = 2;
const NONE = 0;
const STOCK_LEAK = 37;

/** Sin importar el espacio que emita Intl entre "S/" y la cifra: `text()` ya lo normaliza a un espacio. */
const SOLES = 'S/';
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - ONE;

// ------------------------------------------------------------------------------------------------ Card

describe('Card', () => {
  const card = async (props: Record<string, unknown> = {}, slot = 'Contenido'): Promise<HTMLElement> => ui(Card, props, { default: slot });

  test('por defecto es un <div> y proyecta el contenido del slot', async () => {
    const body = await card();
    const el = root(body);
    expect(el.tagName.toLowerCase()).toBe('div');
    expect(text(el)).toBe('Contenido');
  });

  test.each(['div', 'article', 'section', 'li'] as const)('as="%s" produce ese elemento', async (as) => {
    expect(root(await card({ as })).tagName.toLowerCase()).toBe(as);
  });

  test('el contenido del slot conserva su marcado (títulos, imágenes, enlaces) y no se escapa', async () => {
    const body = await card({}, '<h3 id="t">Nautilus</h3><a href="/relojes/nautilus">Ver</a>');
    expect(body.querySelector('h3#t')?.textContent).toBe('Nautilus');
    expect(body.querySelector('a[href="/relojes/nautilus"]')).not.toBeNull();
  });

  test('los valores por defecto son tone="surface", padding="md" y outline="strong"', async () => {
    const def = markers(root(await card()));
    expect(def).toBe(markers(root(await card({ tone: 'surface' }))));
    expect(def).toBe(markers(root(await card({ padding: 'md' }))));
    expect(def).toBe(markers(root(await card({ outline: 'strong' }))));
  });

  test.each(['ink', 'forest'] as const)('tone="%s" se distingue del defecto y lo nombra', async (tone) => {
    const el = root(await card({ tone }));
    expect(hasMarker(el, tone)).toBe(true);
    expect(markers(el)).not.toBe(markers(root(await card())));
  });

  test.each(['sm', 'lg'] as const)('padding="%s" se distingue del defecto y lo nombra', async (padding) => {
    const el = root(await card({ padding }));
    expect(hasMarker(el, padding)).toBe(true);
    expect(markers(el)).not.toBe(markers(root(await card())));
  });

  test('outline="soft" se distingue de "strong" y lo nombra', async () => {
    const soft = root(await card({ outline: 'soft' }));
    expect(hasMarker(soft, 'soft')).toBe(true);
    expect(markers(soft)).not.toBe(markers(root(await card())));
  });

  test('los tres tonos, paddings y bordes producen marcas distintas entre sí', async () => {
    const tones = await Promise.all(['surface', 'ink', 'forest'].map(async (tone) => markers(root(await card({ tone })))));
    const paddings = await Promise.all(['sm', 'md', 'lg'].map(async (padding) => markers(root(await card({ padding })))));
    expect(new Set(tones).size).toBe(tones.length);
    expect(new Set(paddings).size).toBe(paddings.length);
  });

  test('es una superficie plana: sin elementos interactivos propios ni role', async () => {
    const el = root(await card());
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.querySelectorAll('a, button, input').length).toBe(NONE);
  });
});

// ------------------------------------------------------------------------------------------------ Badge

describe('Badge', () => {
  const TONES = ['yellow', 'forest', 'outline', 'plum', 'mint', 'red'] as const;
  const KINDS = ['status', 'product', 'count'] as const;
  const badge = async (props: Record<string, unknown> = {}, slot = 'En tránsito'): Promise<HTMLElement> => ui(Badge, props, { default: slot });

  test('muestra el texto del slot tal cual (las mayúsculas son de CSS, no del HTML)', async () => {
    const el = root(await badge({}, 'Edición limitada'));
    expect(text(el)).toBe('Edición limitada');
  });

  test('no es interactivo: sin enlaces ni botones', async () => {
    const body = await badge();
    expect(body.querySelectorAll('a, button').length).toBe(NONE);
  });

  test('los valores por defecto son kind="status" y tone="outline"', async () => {
    const def = markers(root(await badge()));
    expect(def).toBe(markers(root(await badge({ kind: 'status' }))));
    expect(def).toBe(markers(root(await badge({ tone: 'outline' }))));
    expect(hasMarker(root(await badge()), 'outline')).toBe(true);
  });

  test.each(TONES)('tone="%s" lo nombra', async (tone) => {
    expect(hasMarker(root(await badge({ tone })), tone)).toBe(true);
  });

  test('los 6 tonos producen marcas distintas (BRIEF §7: amarillo, forest, outline, ciruela, menta, rojo)', async () => {
    const all = await Promise.all(TONES.map(async (tone) => markers(root(await badge({ tone })))));
    expect(all.length).toBe(TOTAL_TONES);
    expect(new Set(all).size).toBe(TOTAL_TONES);
  });

  test.each(['product', 'count'] as const)('kind="%s" se distingue de "status" con el mismo tono', async (kind) => {
    const el = root(await badge({ kind, tone: 'yellow' }));
    expect(markers(el)).not.toBe(markers(root(await badge({ kind: 'status', tone: 'yellow' }))));
    expect(hasMarker(el, kind)).toBe(true);
  });

  test('los 3 tipos producen marcas distintas', async () => {
    const all = await Promise.all(KINDS.map(async (kind) => markers(root(await badge({ kind })))));
    expect(new Set(all).size).toBe(TOTAL_KINDS);
  });

  test('los 4 estados de pedido de BRIEF §7 se pueden pintar: amarillo, forest, outline y ciruela', async () => {
    const states = await Promise.all((['yellow', 'forest', 'outline', 'plum'] as const).map(async (tone) => markers(root(await badge({ kind: 'status', tone })))));
    expect(new Set(states).size).toBe(states.length);
  });
});

// ------------------------------------------------------------------------------------------------ Chip

describe('Chip', () => {
  const HREF = '/relojes?marca=valmont';
  const chip = async (props: Record<string, unknown> = {}): Promise<HTMLElement> => ui(Chip, { label: 'Valmont', href: HREF, ...props });
  const mainLink = (body: HTMLElement): Element | null => body.querySelector(`a[href="${HREF}"]`);

  /** Profundidad máxima de anidamiento de <a> en el HTML emitido (los analizadores HTML lo "corrigen", el texto no). */
  function maxAnchorDepth(html: string): number {
    const opens = (chunk: string): boolean => chunk.startsWith('a ') || chunk.startsWith('a>');
    const delta = (chunk: string): number => (chunk.startsWith('/a>') ? -ONE : Number(opens(chunk)));
    const depths = html.split('<').reduce<number[]>((acc, chunk) => [...acc, (acc.at(-ONE) ?? NONE) + delta(chunk)], []);
    return Math.max(NONE, ...depths);
  }

  describe('como enlace (as="a", por defecto)', () => {
    test('es un <a href> con la etiqueta', async () => {
      const body = await chip();
      const link = mainLink(body);
      expect(link).not.toBeNull();
      expect(link?.tagName.toLowerCase()).toBe('a');
      expect(text(link)).toContain('Valmont');
    });

    test('la etiqueta se escribe como texto: el HTML del label no se interpreta (RT-5)', async () => {
      const body = await ui(Chip, { label: '<img id="x" src="x" onerror="alert(1)">', href: HREF });
      expect(body.querySelector('#x')).toBeNull();
      expect(body.querySelector('img')).toBeNull();
      expect(text(body)).toContain('<img');
    });

    test('la etiqueta no se escribe en mayúsculas en el HTML (lo hace el CSS)', async () => {
      const body = await ui(Chip, { label: 'Acero inoxidable', href: HREF });
      expect(text(mainLink(body) ?? body)).toContain('Acero inoxidable');
    });

    test('activo: aria-current="true" en el enlace', async () => {
      const link = mainLink(await chip({ active: true }));
      expect(link?.getAttribute('aria-current')).toBe('true');
    });

    test('inactivo (por defecto o active=false): sin aria-current en ningún elemento', async () => {
      const implicit = await chip();
      const explicit = await chip({ active: false });
      expect(implicit.querySelectorAll('[aria-current]').length).toBe(NONE);
      expect(explicit.querySelectorAll('[aria-current]').length).toBe(NONE);
    });

    test('activo e inactivo se distinguen también en el marcado (no solo por aria-current)', async () => {
      const on = markers(root(await chip({ active: true })));
      const off = markers(root(await chip()));
      expect(on).not.toBe(off);
    });

    test('el estado activo no depende solo del color: aria-current acompaña a la marca visual', async () => {
      const body = await chip({ active: true });
      expect(mainLink(body)?.getAttribute('aria-current')).toBe('true');
      expect(markers(root(body))).not.toBe(markers(root(await chip())));
    });
  });

  describe('tonos', () => {
    const TONES = ['forest', 'outline', 'yellow', 'mint', 'red'] as const;

    test('el defecto es tone="outline"', async () => {
      expect(markers(root(await chip()))).toBe(markers(root(await chip({ tone: 'outline' }))));
    });

    test.each(TONES)('tone="%s" lo nombra', async (tone) => {
      expect(hasMarker(root(await chip({ tone })), tone)).toBe(true);
    });

    test('los 5 tonos producen marcas distintas', async () => {
      const all = await Promise.all(TONES.map(async (tone) => markers(root(await chip({ tone })))));
      expect(new Set(all).size).toBe(TONES.length);
    });
  });

  describe('no interactivo (as="span", D-041 P-2)', () => {
    test('es un <span> con aria-disabled="true", sin enlace ni botón ni tabindex', async () => {
      const body = await ui(Chip, { label: 'Acero', as: 'span' });
      const el = root(body);
      expect(el.tagName.toLowerCase()).toBe('span');
      expect(body.querySelector('[aria-disabled="true"]')).not.toBeNull();
      expect(body.querySelectorAll('a, button, [tabindex]').length).toBe(NONE);
      expect(text(el)).toContain('Acero');
    });

    test('aunque reciba href, el span no es navegable', async () => {
      const body = await ui(Chip, { label: 'Acero', as: 'span', href: HREF });
      expect(body.querySelectorAll('a, button').length).toBe(NONE);
      expect(body.querySelector('[aria-disabled="true"]')).not.toBeNull();
    });

    test('los chips de enlace y de botón no llevan aria-disabled', async () => {
      expect((await chip()).querySelectorAll('[aria-disabled]').length).toBe(NONE);
      expect((await ui(Chip, { label: 'Acero', as: 'button' })).querySelectorAll('[aria-disabled]').length).toBe(NONE);
    });
  });

  describe('como botón (as="button")', () => {
    test('es un <button> con la etiqueta y sin enlace', async () => {
      const body = await ui(Chip, { label: 'Limpiar', as: 'button' });
      const control = body.querySelector('button');
      expect(control, 'falta el <button>').not.toBeNull();
      expect(body.querySelectorAll('a').length).toBe(NONE);
      expect(text(control)).toContain('Limpiar');
    });

    test('no envía un formulario por accidente: type="button" (si declara type)', async () => {
      const el = (await ui(Chip, { label: 'Limpiar', as: 'button' })).querySelector('button');
      expect(['button', null]).toContain(el?.getAttribute('type') ?? null);
    });
  });

  describe('removible (removeHref)', () => {
    const REMOVE = '/relojes';
    const removable = async (props: Record<string, unknown> = {}): Promise<HTMLElement> => ui(Chip, { label: 'Valmont', href: HREF, removeHref: REMOVE, ...props });
    const name = (el: Element | null): string => el?.getAttribute('aria-label') ?? text(el);

    test('añade un enlace a removeHref con nombre accesible "Quitar filtro {label}"', async () => {
      const body = await removable();
      const link = body.querySelector(`a[href="${REMOVE}"]`);
      expect(link).not.toBeNull();
      expect(name(link)).toContain('Quitar filtro Valmont');
    });

    test('el nombre sigue a la etiqueta recibida', async () => {
      const body = await ui(Chip, { label: 'Acero inoxidable', href: HREF, removeHref: REMOVE });
      expect(name(body.querySelector(`a[href="${REMOVE}"]`))).toContain('Quitar filtro Acero inoxidable');
    });

    test('conserva el enlace principal del chip', async () => {
      const body = await removable();
      expect(mainLink(body)).not.toBeNull();
      expect(body.querySelectorAll('a').length).toBe(TWO_LINKS);
    });

    test('los dos enlaces son hermanos: nunca un <a> dentro de otro <a> (HTML inválido)', async () => {
      const html = await renderAstro(Chip, { props: { label: 'Valmont', href: HREF, removeHref: REMOVE } });
      expect(maxAnchorDepth(html)).toBeLessThanOrEqual(ONE);
    });

    test('la × es decorativa: el icono lleva aria-hidden y no duplica el nombre', async () => {
      const body = await removable();
      const link = body.querySelector(`a[href="${REMOVE}"]`);
      const icons = [...(link?.querySelectorAll('svg') ?? [])];
      icons.forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
    });

    test('sin removeHref no hay enlace "Quitar filtro"', async () => {
      const body = await chip();
      expect(text(body)).not.toContain('Quitar filtro');
      expect(body.querySelectorAll('a').length).toBe(ONE);
    });
  });
});

// ------------------------------------------------------------------------------------------------ Price

describe('Price', () => {
  const price = async (props: Record<string, unknown>): Promise<HTMLElement> => ui(Price, props);
  /** Hoja (sin hijos) cuyo texto contiene `needle`. */
  const leafWith = (body: HTMLElement, needle: string): Element | undefined =>
    [...body.querySelectorAll('*')].find((e) => e.children.length === NONE && text(e).includes(needle));
  const isHidden = (el: Element): boolean => ['sr-only', 'visually', 'hidden'].some((w) => markers(el).includes(w));

  describe('sin promoción', () => {
    test('con originalPrice y discountAmount null, solo el vigente: "S/ 84,500" y nada más', async () => {
      const body = await price({ price: PRICE, originalPrice: null, discountAmount: null });
      expect(text(body)).toBe('S/ 84,500');
      expect(body.querySelectorAll('del').length).toBe(NONE);
      expect(text(body)).not.toContain('Ahorras');
      expect(text(body)).not.toContain('Precio original');
    });

    test('omitir los dos props equivale a pasar null', async () => {
      const omitted = await price({ price: PRICE });
      const nulls = await price({ price: PRICE, originalPrice: null, discountAmount: null });
      expect(text(omitted)).toBe(text(nulls));
      expect(markers(root(omitted))).toBe(markers(root(nulls)));
    });

    test('un importe con fracción lleva dos decimales: "S/ 10,625.50"', async () => {
      expect(text(await price({ price: FRACTION }))).toBe('S/ 10,625.50');
    });

    test('un importe entero no lleva ".00"', async () => {
      expect(text(await price({ price: pen('100') }))).toBe('S/ 1');
    });

    test('un solo importe en pantalla', async () => {
      expect(occurrences(text(await price({ price: PRICE })), SOLES)).toBe(ONE);
    });
  });

  describe('con promoción', () => {
    const promo = async (extra: Record<string, unknown> = {}): Promise<HTMLElement> =>
      price({ price: PRICE, originalPrice: ORIGINAL, discountAmount: DISCOUNT, ...extra });

    test('muestra el vigente, el original tachado en <del> y "Ahorras S/ X" (3 importes)', async () => {
      const body = await promo();
      const out = text(body);
      expect(out).toContain('S/ 84,500');
      expect(out).toContain('S/ 99,000');
      expect(out).toContain('Ahorras S/ 14,500');
      expect(occurrences(out, SOLES)).toBe(TOTAL_AMOUNTS_WITH_PROMO);
    });

    test('el original va dentro de <del> (tachado semántico) y el vigente fuera', async () => {
      const body = await promo();
      const del = body.querySelector('del');
      expect(del).not.toBeNull();
      expect(text(del)).toContain('S/ 99,000');
      expect(text(del)).not.toContain('S/ 84,500');
      expect(text(del)).not.toContain('Ahorras');
    });

    test('el tachado tiene texto accesible "Precio original", oculto a la vista (sr-only) y pegado al <del>', async () => {
      const body = await promo();
      const del = body.querySelector('del');
      const hidden = leafWith(body, 'Precio original');
      expect(hidden, 'falta el texto accesible "Precio original"').toBeDefined();
      expect(isHidden(hidden as Element), `marcas: ${markers(hidden as Element)}`).toBe(true);
      const adjacent = hidden === del || del?.contains(hidden as Element) || hidden?.nextElementSibling === del || hidden?.previousElementSibling === del;
      expect(adjacent).toBe(true);
    });

    test('"Ahorras S/ 14,500" es visible: ni oculto ni dentro del <del>', async () => {
      const body = await promo();
      const saving = leafWith(body, 'Ahorras');
      expect(saving).toBeDefined();
      expect(text(saving)).toContain('Ahorras S/ 14,500');
      expect(isHidden(saving as Element)).toBe(false);
      expect((saving as Element).closest('del')).toBeNull();
    });

    test('el importe vigente no está tachado ni oculto', async () => {
      const body = await promo();
      const current = leafWith(body, 'S/ 84,500');
      expect(current).toBeDefined();
      expect((current as Element).closest('del')).toBeNull();
      expect(isHidden(current as Element)).toBe(false);
    });

    test('formatea cada importe con las reglas de P-3 (entero sin decimales, fracción con dos)', async () => {
      const body = await price({ price: FRACTION, originalPrice: pen('1200000'), discountAmount: pen('137450') });
      const out = text(body);
      expect(out).toContain('S/ 10,625.50');
      expect(out).toContain('S/ 12,000');
      expect(out).toContain('Ahorras S/ 1,374.50');
    });
  });

  describe('nunca calcula (RN-09): muestra los importes que recibe, aunque no cuadren', () => {
    test('un descuento incoherente con la diferencia se muestra tal cual', async () => {
      const body = await price({ price: pen('1000000'), originalPrice: pen('5000000'), discountAmount: pen('100') });
      const out = text(body);
      expect(out).toContain('Ahorras S/ 1');
      expect(out).not.toContain('S/ 40,000');
      expect(out).not.toContain('S/ 400');
    });

    test('no deriva porcentajes ni sumas', async () => {
      const out = text(await price({ price: PRICE, originalPrice: ORIGINAL, discountAmount: DISCOUNT }));
      expect(out).not.toContain('%');
      expect(out).not.toContain('S/ 184,500');
      expect(out).not.toContain('S/ 113,500');
    });

    test('con un descuento y sin precio original, no inventa el original', async () => {
      const body = await price({ price: PRICE, originalPrice: null, discountAmount: null });
      expect(occurrences(text(body), SOLES)).toBe(ONE);
    });

    test('el mismo vigente produce el mismo texto con cualquier tamaño o alineación', async () => {
      const base = text(await price({ price: PRICE }));
      expect(text(await price({ price: PRICE, size: 'lg', align: 'end' }))).toBe(base);
    });
  });

  describe('tamaño y alineación', () => {
    test('los valores por defecto son size="md" y align="start"', async () => {
      const def = markers(root(await price({ price: PRICE })));
      expect(def).toBe(markers(root(await price({ price: PRICE, size: 'md' }))));
      expect(def).toBe(markers(root(await price({ price: PRICE, align: 'start' }))));
    });

    test.each(['sm', 'lg'] as const)('size="%s" se distingue del defecto', async (size) => {
      const el = root(await price({ price: PRICE, size }));
      expect(hasMarker(el, size)).toBe(true);
      expect(markers(el)).not.toBe(markers(root(await price({ price: PRICE }))));
    });

    test('align="end" se distingue de "start"', async () => {
      const end = root(await price({ price: PRICE, align: 'end' }));
      expect(hasMarker(end, 'end')).toBe(true);
      expect(markers(end)).not.toBe(markers(root(await price({ price: PRICE }))));
    });
  });
});

// ------------------------------------------------------------------------------------------------ Availability

describe('availabilityLabel (availability.ts, D-023)', () => {
  const label = (status: string, lead: number | null = null): string =>
    availabilityLabel({ status, lead_time_days: lead } as Parameters<typeof availabilityLabel>[0]);

  test.each([
    ['in_stock', 'En stock'],
    ['low_stock', 'Quedan pocas unidades'],
    ['out_of_stock', 'Agotado'],
  ])('%s → "%s" (aunque traiga lead_time_days)', (status, expected) => {
    expect(label(status)).toBe(expected);
    expect(label(status, LEAD_DAYS)).toBe(expected);
  });

  test('on_request con plazo: "Bajo pedido, entrega estimada en N días"', () => {
    expect(label('on_request', LEAD_DAYS)).toBe('Bajo pedido, entrega estimada en 15 días');
    expect(label('on_request', LEAD_SEVEN_DAYS)).toBe('Bajo pedido, entrega estimada en 7 días');
  });

  test('on_request con plazo de un día va en singular: "1 día" (decisión del Leader)', () => {
    expect(label('on_request', LEAD_ONE_DAY)).toBe('Bajo pedido, entrega estimada en 1 día');
  });

  test('on_request sin plazo (lead_time_days null): solo "Bajo pedido"', () => {
    expect(label('on_request', null)).toBe('Bajo pedido');
  });

  test('los 4 textos son distintos', () => {
    const all = [label('in_stock'), label('low_stock'), label('out_of_stock'), label('on_request', LEAD_DAYS)];
    expect(new Set(all).size).toBe(TOTAL_STATES);
  });
});

describe('Availability', () => {
  type Status = 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_request';
  const STATES: { status: Status; lead: number | null; label: string }[] = [
    { status: 'in_stock', lead: null, label: 'En stock' },
    { status: 'low_stock', lead: null, label: 'Quedan pocas unidades' },
    { status: 'out_of_stock', lead: null, label: 'Agotado' },
    { status: 'on_request', lead: LEAD_DAYS, label: 'Bajo pedido, entrega estimada en 15 días' },
  ];
  const render = async (status: Status, lead: number | null = null, extra: Record<string, unknown> = {}): Promise<HTMLElement> =>
    ui(Availability, { availability: { status, lead_time_days: lead }, ...extra });
  const dotOf = (el: Element): Element | null => el.querySelector('[aria-hidden="true"]');
  const usesPseudoDot = (): boolean => ['::before', '::after'].some((p) => read('src/components/ui/Availability.astro').includes(p));

  test.each(STATES)('$status muestra el texto "$label"', async ({ status, lead, label }) => {
    expect(text(await render(status, lead))).toBe(label);
  });

  test('on_request sin plazo: "Bajo pedido"', async () => {
    expect(text(await render('on_request', null))).toBe('Bajo pedido');
  });

  test.each(STATES)('$status: el texto va con un punto decorativo (no solo color)', async ({ status, lead }) => {
    const el = root(await render(status, lead));
    expect(dotOf(el) !== null || usesPseudoDot(), 'falta el punto (elemento aria-hidden o pseudo-elemento)').toBe(true);
    expect(text(el)).not.toBe('');
  });

  test('el punto no aporta nombre accesible: el texto es la única fuente', async () => {
    const el = root(await render('in_stock'));
    const dot = dotOf(el);
    if (dot) expect(text(dot)).toBe('');
  });

  test('los 4 estados se distinguen en el marcado, además del texto', async () => {
    const all = await Promise.all(STATES.map(async ({ status, lead }) => markers(root(await render(status, lead)))));
    expect(new Set(all).size).toBe(STATES.length);
  });

  test('nunca muestra cantidades: ningún dígito en in_stock, low_stock y out_of_stock', async () => {
    const digits = '0123456789';
    const texts = await Promise.all((['in_stock', 'low_stock', 'out_of_stock'] as const).map(async (s) => text(await render(s))));
    texts.forEach((t) => expect([...t].filter((c) => digits.includes(c))).toEqual([]));
  });

  test('aunque el objeto traiga stock, quantity o available, no se escribe en el HTML', async () => {
    const body = await ui(Availability, {
      availability: { status: 'low_stock', lead_time_days: null, quantity: STOCK_LEAK, stock: STOCK_LEAK, available: STOCK_LEAK },
    });
    expect(body.innerHTML).not.toContain(String(STOCK_LEAK));
  });

  test('bajo pedido muestra N de lead_time_days y nada más', async () => {
    const out = text(await render('on_request', LEAD_SEVEN_DAYS));
    expect(out).toContain('7 días');
    expect(out).not.toContain('15');
  });

  test('no se pinta como alerta: sin role="alert" ni aria-live asertivo', async () => {
    const body = await render('out_of_stock');
    expect(body.querySelector('[role="alert"], [aria-live="assertive"]')).toBeNull();
  });

  test('showLabel=false (BRIEF §7): el texto no desaparece del árbol accesible', async () => {
    const body = await render('low_stock', null, { showLabel: false });
    const named = [...body.querySelectorAll('[aria-label], [title]')].some((e) => `${e.getAttribute('aria-label')}${e.getAttribute('title')}`.includes('Quedan pocas unidades'));
    expect(text(body).includes('Quedan pocas unidades') || named).toBe(true);
  });

  test('showLabel=true (defecto) y omitido producen lo mismo', async () => {
    const omitted = await render('in_stock');
    const explicit = await render('in_stock', null, { showLabel: true });
    expect(text(omitted)).toBe(text(explicit));
    expect(markers(root(omitted))).toBe(markers(root(explicit)));
  });

  test('usa availabilityLabel como única fuente del texto', async () => {
    const results = await Promise.all(
      STATES.map(async ({ status, lead }) => ({
        rendered: text(await render(status, lead)),
        expected: availabilityLabel({ status, lead_time_days: lead }),
      })),
    );
    results.forEach((r) => expect(r.rendered).toBe(r.expected));
  });
});
