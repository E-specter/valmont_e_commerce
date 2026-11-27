import { describe, expect, test } from 'vitest';
import ActiveFilters from '../../src/components/catalog/ActiveFilters.astro';
import FeaturedBanner from '../../src/components/catalog/FeaturedBanner.astro';
import FilterBar from '../../src/components/catalog/FilterBar.astro';
import { featured } from '../../src/data/featured';
import type { AttributeValue, Category } from '../../src/lib/api/catalog';
import { formatMoney } from '../../src/lib/format';
import { activeChips, type CatalogQuery } from '../../src/lib/catalog/query';
import { renderAstro, parseHtml } from '../helpers/render';
import { text, ui } from '../helpers/ui';

// T-124 · FilterBar, ActiveFilters y FeaturedBanner con la Container API (STATUS "T-124 › Resultado esperado y firmas").
// Se localiza por rol, nombre accesible y atributos, no por clases internas.
const NONE = 0;
const SNIPPET = 80;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const SIX = 6;
const MIN_SOLES = 1500;
const MAX_SOLES = 9000;
const SAMPLE_CENTS = 12750000;
const norm = (s: string): string => s.replaceAll(' ', ' ');

const categories: Category[] = [
  { slug: 'demo-buceo', name: 'Buceo (demo)', description: '' },
  { slug: 'demo-vestir', name: 'Vestir (demo)', description: '' },
];
const movements: AttributeValue[] = [
  { code: 'automatic', label: 'Automático' },
  { code: 'manual', label: 'Manual' },
];
const materials: AttributeValue[] = [
  { code: 'steel', label: 'Acero' },
  { code: 'gold-18k', label: 'Oro de 18 k' },
];
const EMPTY: CatalogQuery = { page: ONE };
const props = (query: CatalogQuery = EMPTY, extra: Record<string, unknown> = {}) => ({ categories, movements, materials, query, ...extra });
const bar = (query: CatalogQuery = EMPTY, extra: Record<string, unknown> = {}) => ui(FilterBar, props(query, extra));

const FULL: CatalogQuery = {
  category: 'demo-vestir',
  movement: 'manual',
  case_material: 'gold-18k',
  price_min_soles: MIN_SOLES,
  price_max_soles: MAX_SOLES,
  available: true,
  sort: 'price_desc',
  page: THREE,
};

const control = (body: ParentNode, name: string): HTMLInputElement | HTMLSelectElement => {
  const el = body.querySelector(`form [name="${name}"]`);
  if (!el) throw new Error(`No hay campo "${name}" dentro del formulario`);
  return el as HTMLInputElement | HTMLSelectElement;
};
const selected = (sel: Element): string[] => [...sel.querySelectorAll('option')].filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value') ?? '');
const optionValues = (sel: Element): string[] => [...sel.querySelectorAll('option')].map((o) => o.getAttribute('value') ?? '');
const labelOf = (body: ParentNode, el: Element): string => {
  const id = el.getAttribute('id');
  const forLabel = id ? body.querySelector(`label[for="${id}"]`) : null;
  return text(forLabel ?? el.closest('label'));
};

describe('T-124 · FilterBar · estructura del formulario', () => {
  test('un solo <form method="get" action="/relojes"> (funciona sin JavaScript)', async () => {
    const body = await bar();
    const forms = body.querySelectorAll('form');
    expect(forms).toHaveLength(ONE);
    expect(forms[0].getAttribute('method')?.toLowerCase()).toBe('get');
    expect(forms[0].getAttribute('action')).toBe('/relojes');
  });

  test('action configurable', async () => {
    const body = await bar(EMPTY, { action: '/relojes/otra' });
    expect(body.querySelector('form')?.getAttribute('action')).toBe('/relojes/otra');
  });

  test('fieldset con legend dentro del formulario', async () => {
    const body = await bar();
    const fs = body.querySelector('form fieldset');
    expect(fs).not.toBeNull();
    expect(text(fs?.querySelector('legend')).length).toBeGreaterThan(0);
  });

  test('cada campo visible tiene un label asociado con texto (nunca solo placeholder)', async () => {
    const body = await bar();
    const fields = [...body.querySelectorAll('form input:not([type="hidden"]):not([type="submit"]), form select')];
    expect(fields.length).toBeGreaterThanOrEqual(SIX);
    fields.forEach((f) => expect(labelOf(body, f).length, f.outerHTML).toBeGreaterThan(0));
  });

  test('los id de los campos son únicos', async () => {
    const body = await bar();
    const ids = [...body.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('expone los campos del contrato: category, movement, case_material, price_min, price_max, available y sort', async () => {
    const body = await bar();
    const names = [...body.querySelectorAll('form [name]')].map((e) => e.getAttribute('name'));
    ['category', 'movement', 'case_material', 'price_min', 'price_max', 'available', 'sort'].forEach((n) => expect(names).toContain(n));
  });

  test('ningún campo del formulario fuera de la lista cerrada (nada se cuela en la URL)', async () => {
    const body = await bar({ ...FULL, q: 'oro' });
    const names = [...body.querySelectorAll('form [name]')].map((e) => e.getAttribute('name'));
    const allowed = ['q', 'category', 'movement', 'case_material', 'price_min', 'price_max', 'available', 'sort'];
    expect(names.filter((n) => !allowed.includes(n ?? ''))).toEqual([]);
  });

  test('los select nativos tienen "todas" como primera opción vacía y las opciones de la API', async () => {
    const body = await bar();
    expect(optionValues(control(body, 'category'))).toEqual(['', 'demo-buceo', 'demo-vestir']);
    expect(optionValues(control(body, 'movement'))).toEqual(['', 'automatic', 'manual']);
    expect(optionValues(control(body, 'case_material'))).toEqual(['', 'steel', 'gold-18k']);
  });

  test('las opciones muestran el nombre (label) y no el código', async () => {
    const body = await bar();
    const labels = [...control(body, 'case_material').querySelectorAll('option')].map((o) => text(o));
    expect(labels).toContain('Oro de 18 k');
    expect(labels).toContain('Acero');
  });

  test('ordenar: precio ascendente, descendente y el orden por defecto', async () => {
    const body = await bar();
    const values = optionValues(control(body, 'sort'));
    expect(values).toContain('price_asc');
    expect(values).toContain('price_desc');
    expect(values).toContain(''); // más recientes (sin parámetro)
  });

  test('relevance solo se ofrece con una búsqueda activa (sin q el servidor respondería 422)', async () => {
    expect(optionValues(control(await bar(), 'sort'))).not.toContain('relevance');
    expect(optionValues(control(await bar({ q: 'oro', page: ONE }), 'sort'))).toContain('relevance');
  });

  test('botón "Aplicar" de tipo submit y enlace "Limpiar filtros" a /relojes', async () => {
    const body = await bar();
    const submit = [...body.querySelectorAll('form button')].find((b) => text(b) === 'Aplicar');
    expect(submit?.getAttribute('type')).toBe('submit');
    const clear = [...body.querySelectorAll('a')].find((a) => text(a) === 'Limpiar filtros');
    expect(clear?.getAttribute('href')).toBe('/relojes');
  });

  test('sin envío automático al cambiar (WCAG 3.2.2): sin onchange, onsubmit ni <script>', async () => {
    const html = await renderAstro(FilterBar, { props: props(FULL) });
    expect(html).not.toMatch(/\son(change|input|submit|click)\s*=/i);
    expect(html).not.toContain('<script');
  });

  test('"Solo disponibles" es una casilla con valor 1', async () => {
    const body = await bar();
    const box = control(body, 'available') as HTMLInputElement;
    expect(box.getAttribute('type')).toBe('checkbox');
    expect(box.getAttribute('value')).toBe('1');
    expect(labelOf(body, box)).toContain('Solo disponibles');
  });

  test('los campos de precio son numéricos, enteros y no negativos', async () => {
    const body = await bar();
    ['price_min', 'price_max'].forEach((n) => {
      const f = control(body, n);
      expect(f.getAttribute('type')).toBe('number');
      expect(f.getAttribute('min')).toBe('0');
      expect(labelOf(body, f)).toContain('S/');
    });
  });
});

describe('T-124 · FilterBar · valores precargados desde la URL', () => {
  test('sin filtros: nada preseleccionado salvo la primera opción y la casilla sin marcar', async () => {
    const body = await bar();
    expect(control(body, 'price_min').getAttribute('value') ?? '').toBe('');
    expect(control(body, 'price_max').getAttribute('value') ?? '').toBe('');
    expect(control(body, 'available').hasAttribute('checked')).toBe(false);
    ['category', 'movement', 'case_material'].forEach((n) => {
      const sel = selected(control(body, n));
      expect(sel.length === 0 || sel[0] === '').toBe(true);
    });
  });

  test('con todos los filtros activos, cada control los muestra', async () => {
    const body = await bar(FULL);
    expect(selected(control(body, 'category'))).toEqual(['demo-vestir']);
    expect(selected(control(body, 'movement'))).toEqual(['manual']);
    expect(selected(control(body, 'case_material'))).toEqual(['gold-18k']);
    expect(selected(control(body, 'sort'))).toEqual(['price_desc']);
    expect(control(body, 'price_min').getAttribute('value')).toBe(String(MIN_SOLES));
    expect(control(body, 'price_max').getAttribute('value')).toBe(String(MAX_SOLES));
    expect(control(body, 'available').hasAttribute('checked')).toBe(true);
  });

  test('un precio 0 se precarga como 0 (no se pierde por falsy)', async () => {
    const body = await bar({ price_min_soles: 0, page: ONE });
    expect(control(body, 'price_min').getAttribute('value')).toBe('0');
  });

  test('la búsqueda activa (q) viaja con el formulario para que "Aplicar" no la pierda', async () => {
    const body = await bar({ q: 'tourbillon', page: ONE });
    expect(control(body, 'q').getAttribute('value')).toBe('tourbillon');
    expect(control(body, 'q').getAttribute('type')).toBe('hidden');
  });

  test('sin q no hay campo q', async () => {
    expect((await bar()).querySelector('form [name="q"]')).toBeNull();
  });

  test('el valor de q se escapa: no se interpreta como HTML', async () => {
    const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const html = await renderAstro(FilterBar, { props: props({ q: hostile, page: ONE }) });
    const doc = parseHtml(html);
    expect(doc.querySelectorAll('script, img'), 'el valor no debe crear elementos').toHaveLength(NONE);
    expect(control(doc.body, 'q').getAttribute('value')).toBe(hostile);
  });

  test('un valor de categoría desconocido no rompe el render ni se interpreta como HTML', async () => {
    const hostile = '"><script>alert(3)</script>';
    const html = await renderAstro(FilterBar, { props: props({ category: hostile, page: ONE }) });
    expect(parseHtml(html).querySelectorAll('script, img')).toHaveLength(NONE);
  });

  test('page no se envía en el formulario (cambiar un filtro reinicia a la página 1)', async () => {
    const body = await bar(FULL);
    expect(body.querySelector('form [name="page"]')).toBeNull();
  });
});

describe('T-124 · FilterBar · controles estáticos (D-041 P-2)', () => {
  test('"Complicación" existe, fuera de todo <form>, con aria-disabled="true"', async () => {
    const body = await bar();
    const node = [...body.querySelectorAll('*')].find((e) => e.children.length <= THREE && text(e).startsWith('Complicación') && text(e).length < 'Complicación'.length + FOUR);
    expect(node, 'no se encontró el desplegable "Complicación"').toBeDefined();
    expect(node?.closest('form')).toBeNull();
    const inert = node?.closest('[aria-disabled="true"]') ?? node?.querySelector('[aria-disabled="true"]');
    expect(inert).not.toBeNull();
  });

  test('"Complicación" no es un campo: ningún input, select o button lleva ese nombre', async () => {
    const body = await bar();
    const named = [...body.querySelectorAll('select, input, button')].filter((e) => e.outerHTML.toLowerCase().includes('complicaci'));
    expect(named).toEqual([]);
  });

  test('los controles estáticos no son enfocables ni enviables (fuera del orden de tabulación)', async () => {
    const body = await bar();
    const form = body.querySelector('form')!;
    const outside = [...body.querySelectorAll('*')].filter((e) => !form.contains(e) && e !== form && !e.contains(form));
    const focusable = outside.filter((e) => {
      const tag = e.tagName.toLowerCase();
      const tab = e.getAttribute('tabindex');
      return ['a', 'button', 'input', 'select', 'textarea'].includes(tag) ? !e.hasAttribute('disabled') && tab !== '-1' : tab !== null && Number(tab) >= 0;
    });
    expect(focusable.map((e) => e.outerHTML)).toEqual([]);
  });

  test('el conmutador cuadrícula/lista existe fuera del formulario y es inerte (aria-disabled o aria-hidden)', async () => {
    const body = await bar();
    const form = body.querySelector('form')!;
    const svgs = [...body.querySelectorAll('svg')].filter((s) => !form.contains(s));
    expect(svgs.length).toBeGreaterThanOrEqual(TWO);
    svgs.forEach((s) => expect(s.closest('[aria-hidden="true"], [aria-disabled="true"]'), s.outerHTML.slice(NONE, SNIPPET)).not.toBeNull());
  });

  test('lo estático está marcado como contenido de demostración (data-demo-content)', async () => {
    const body = await bar();
    expect(body.querySelector('[data-demo-content]')).not.toBeNull();
  });

  test('"Complicación" sigue ahí con cualquier combinación de filtros', async () => {
    const body = await bar(FULL);
    expect(text(body)).toContain('Complicación');
  });
});

describe('T-124 · ActiveFilters', () => {
  const lookups = { categories, movements, case_materials: materials };
  const chips = activeChips(FULL, lookups);
  const render = (c = chips, clearHref = '/relojes') => ui(ActiveFilters, { chips: c, clearHref });
  const removeLinks = (body: ParentNode): HTMLAnchorElement[] =>
    [...body.querySelectorAll('a')].filter((a) => `${a.getAttribute('aria-label') ?? ''} ${text(a)}`.toLowerCase().includes('quitar')) as HTMLAnchorElement[];

  test('un enlace "Quitar" por cada filtro activo, con el href que se le pasó', async () => {
    const body = await render();
    const links = removeLinks(body);
    expect(links).toHaveLength(chips.length);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(chips.map((c) => c.removeHref));
  });

  test('cada chip muestra el nombre del filtro y su "Quitar" lo nombra (accesible)', async () => {
    const body = await render();
    const visible = text(body);
    chips.forEach((c) => expect(norm(visible)).toContain(norm(c.label)));
    removeLinks(body).forEach((a, i) => expect(norm(a.getAttribute('aria-label') ?? text(a))).toContain(norm(chips[i].label)));
  });

  test('los chips están en una lista y no hay enlaces sueltos de más: solo "Quitar" y "Limpiar todo"', async () => {
    const body = await render();
    expect(body.querySelectorAll('li').length).toBeGreaterThanOrEqual(chips.length);
    const others = [...body.querySelectorAll('a')].filter((a) => !removeLinks(body).includes(a as HTMLAnchorElement));
    expect(others.map((a) => text(a))).toEqual(['Limpiar todo']);
  });

  test('"Limpiar todo" lleva a clearHref', async () => {
    const body = await render(chips, '/relojes');
    const clear = [...body.querySelectorAll('a')].find((a) => text(a) === 'Limpiar todo');
    expect(clear?.getAttribute('href')).toBe('/relojes');
  });

  test('el "Quitar" de cada chip conserva los demás filtros (integración con activeChips)', async () => {
    const body = await render();
    const filterKeys = ['category', 'movement', 'case_material', 'price_min', 'price_max', 'available'];
    removeLinks(body).forEach((a) => {
      const sp = new URL(a.getAttribute('href') ?? '', 'http://x').searchParams;
      expect(filterKeys.filter((k) => sp.has(k)), a.getAttribute('href') ?? '').toHaveLength(filterKeys.length - ONE);
      expect(sp.has('page')).toBe(false);
    });
  });

  test('sin filtros activos no pinta chips, "Quitar" ni "Limpiar todo"', async () => {
    const body = await render([]);
    expect(removeLinks(body)).toEqual([]);
    expect([...body.querySelectorAll('a')].some((a) => text(a) === 'Limpiar todo')).toBe(false);
  });

  test('un solo filtro activo: un único chip', async () => {
    const one = activeChips({ available: true, page: ONE }, lookups);
    const body = await render(one);
    expect(removeLinks(body)).toHaveLength(ONE);
    expect(text(body)).toContain('Solo disponibles');
  });

  test('los textos de los chips se escapan', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = await renderAstro(ActiveFilters, { props: { chips: [{ label: hostile, removeHref: '/relojes' }], clearHref: '/relojes' } });
    expect(parseHtml(html).querySelectorAll('img')).toHaveLength(NONE);
  });

  test('un removeHref con & y = se conserva intacto en el atributo', async () => {
    const href = '/relojes?category=demo-buceo&price_min=1500&sort=price_asc';
    const body = await render([{ label: 'Buceo', removeHref: href }]);
    expect(removeLinks(body)[0].getAttribute('href')).toBe(href);
  });
});

describe('T-124 · FeaturedBanner', () => {
  const money = { amount: SAMPLE_CENTS, currency: 'PEN' as const };
  const full = { kicker: 'Destacado del mes', title: 'Tourbillon Classique', description: 'Solo 50 piezas en el mundo.', price: money };
  const render = (p: Record<string, unknown> = full) => ui(FeaturedBanner, p);

  test('muestra el kicker, el título, la descripción y el precio con formato es-PE', async () => {
    const body = await render();
    const t = norm(text(body));
    expect(t).toContain('Destacado del mes');
    expect(t).toContain('Tourbillon Classique');
    expect(t).toContain('Solo 50 piezas en el mundo.');
    expect(t).toContain(norm(formatMoney(money)));
  });

  test('marcado como contenido de demostración: atributo data-demo-content y texto visible', async () => {
    const body = await render();
    expect(body.querySelector('[data-demo-content]')).not.toBeNull();
    expect(text(body)).toContain('Contenido de demostración');
  });

  test('sin botón ni enlace ni control (D-041 P-2)', async () => {
    const body = await render();
    expect(body.querySelectorAll('a, button, input, select, form, [tabindex]')).toHaveLength(0);
  });

  test('no introduce un h1 (la página tiene el suyo) ni compite con la jerarquía de encabezados', async () => {
    const body = await render();
    expect(body.querySelectorAll('h1')).toHaveLength(0);
  });

  test('description y price son opcionales', async () => {
    const body = await render({ kicker: 'Destacado', title: 'Solo título' });
    expect(text(body)).toContain('Solo título');
    expect(text(body)).not.toContain('S/');
  });

  test('el texto se escapa (no se interpreta HTML)', async () => {
    const html = await renderAstro(FeaturedBanner, { props: { kicker: 'k', title: '<img src=x onerror=alert(1)>' } });
    expect(parseHtml(html).querySelectorAll('img')).toHaveLength(NONE);
  });

  test('data/featured.ts: contenido de demostración completo y con precio en céntimos enteros (PEN)', () => {
    expect(featured.kicker.length).toBeGreaterThan(0);
    expect(featured.title.length).toBeGreaterThan(0);
    expect(featured.price.currency).toBe('PEN');
    expect(Number.isInteger(featured.price.amount)).toBe(true);
    expect(featured.price.amount).toBeGreaterThan(0);
  });

  test('con los datos reales de data/featured.ts se renderiza el precio formateado', async () => {
    const body = await render(featured);
    expect(norm(text(body))).toContain(norm(formatMoney(featured.price)));
  });
});
