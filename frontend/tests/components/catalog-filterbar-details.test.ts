import { describe, expect, test } from 'vitest';
import FilterBar from '../../src/components/catalog/FilterBar.astro';
import type { AttributeValue, Category } from '../../src/lib/api/catalog';
import type { CatalogQuery } from '../../src/lib/catalog/query';
import { text, ui } from '../helpers/ui';

// T-134 · FilterBar como plegable nativo sin JavaScript (D-014): <details> + <summary> con el recuento de filtros activos,
// abierto con filtros activos o con la prop opcional `open`. Se consulta por etiqueta y atributos, no por clases internas.
const ONE = 1;
const THREE = 3;
const MIN_SOLES = 1500;
const MAX_SOLES = 9000;

const categories: Category[] = [{ slug: 'demo-buceo', name: 'Buceo (demo)', description: '' }];
const movements: AttributeValue[] = [{ code: 'automatic', label: 'Automático' }];
const materials: AttributeValue[] = [{ code: 'steel', label: 'Acero' }];
const EMPTY: CatalogQuery = { page: ONE };
const render = (query: CatalogQuery = EMPTY, extra: Record<string, unknown> = {}) => ui(FilterBar, { categories, movements, materials, query, ...extra });
const parts = async (query?: CatalogQuery, extra?: Record<string, unknown>) => {
  const body = await render(query, extra);
  const details = body.querySelector('details');
  if (!details) throw new Error('FilterBar debe envolver el formulario en un <details>');
  return { body, details, summary: details.querySelector('summary') };
};

describe('T-134 · FilterBar · plegable nativo', () => {
  test('el formulario va dentro de un <details> con un <summary> como primer hijo', async () => {
    const { details, summary } = await parts();
    expect(summary).not.toBeNull();
    expect(details.firstElementChild?.tagName).toBe('SUMMARY');
    expect(details.querySelector('form')).not.toBeNull();
    expect(details.querySelectorAll('form')).toHaveLength(ONE);
  });

  test('todos los controles y las acciones siguen dentro del formulario', async () => {
    const { details } = await parts();
    const form = details.querySelector('form') as HTMLFormElement;
    ['category', 'movement', 'case_material', 'price_min', 'price_max', 'sort', 'available'].forEach((n) => expect(form.querySelector(`[name="${n}"]`), n).not.toBeNull());
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
    expect([...form.querySelectorAll('a')].some((a) => text(a) === 'Limpiar filtros' && a.getAttribute('href') === '/relojes')).toBe(true);
  });

  test('sin filtros activos nace cerrado y el resumen dice "Filtros" sin recuento', async () => {
    const { details, summary } = await parts();
    expect(details.hasAttribute('open')).toBe(false);
    expect(text(summary)).toContain('Filtros');
    expect(text(summary)).not.toContain('activo');
  });

  test('la búsqueda (q) y la página no son filtros de la barra: sigue cerrado', async () => {
    const { details, summary } = await parts({ q: 'reloj', page: THREE });
    expect(details.hasAttribute('open')).toBe(false);
    expect(text(summary)).not.toContain('activo');
  });

  test('con un filtro activo abre y dice "1 activo" (singular)', async () => {
    const { details, summary } = await parts({ category: 'demo-buceo', page: ONE });
    expect(details.hasAttribute('open')).toBe(true);
    expect(text(summary)).toMatch(/1 activo(?!s)/);
  });

  test('con varios filtros activos dice "N activos" con el número exacto', async () => {
    const { summary } = await parts({ category: 'demo-buceo', movement: 'automatic', price_min_soles: MIN_SOLES, price_max_soles: MAX_SOLES, available: true, page: ONE });
    expect(text(summary)).toMatch(/5 activos/);
    const two = await parts({ category: 'demo-buceo', available: true, page: ONE });
    expect(text(two.summary)).toMatch(/2 activos/);
  });

  test('un precio 0 cuenta como filtro activo (0 S/ es un valor, no ausencia)', async () => {
    const { details, summary } = await parts({ price_min_soles: 0, page: ONE });
    expect(details.hasAttribute('open')).toBe(true);
    expect(text(summary)).toMatch(/1 activo/);
  });

  test('la prop opcional `open` abre el plegable aunque no haya filtros, sin inventar recuento', async () => {
    const { details, summary } = await parts(EMPTY, { open: true });
    expect(details.hasAttribute('open')).toBe(true);
    expect(text(summary)).not.toContain('activo');
  });

  test('`open: false` explícito no cierra un plegable con filtros activos', async () => {
    const { details } = await parts({ available: true, page: ONE }, { open: false });
    expect(details.hasAttribute('open')).toBe(true);
  });

  test('el <summary> no es un botón ni lleva JavaScript: sin <script> ni manejadores en línea', async () => {
    const { body, details } = await parts({ category: 'demo-buceo', page: ONE });
    expect(details.querySelector('button[type="button"]')).toBeNull();
    expect(body.querySelectorAll('script')).toHaveLength(0);
    expect([...details.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on')))).toEqual([]);
  });

  test('con búsqueda activa se conserva q como campo oculto dentro del formulario plegado', async () => {
    const { details } = await parts({ q: 'demo', page: ONE });
    expect(details.querySelector('form input[type="hidden"][name="q"]')?.getAttribute('value')).toBe('demo');
  });

  test('el recuento y el resumen no exponen el texto de un filtro (solo números)', async () => {
    const { summary } = await parts({ category: 'demo-buceo', page: ONE });
    expect(text(summary)).not.toContain('demo-buceo');
  });
});
