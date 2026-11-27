import { describe, expect, test, vi } from 'vitest';
import Breadcrumb from '../../src/components/ui/Breadcrumb.astro';
import DefinitionList from '../../src/components/ui/DefinitionList.astro';
import Pagination from '../../src/components/ui/Pagination.astro';
import { text, ui, markers } from '../helpers/ui';

// T-123 · Breadcrumb, Pagination y DefinitionList (STATUS "T-123 › Criterios de aceptación y firmas") con la Container API.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;

// ------------------------------------------------------------------------------------------------ Breadcrumb

describe('Breadcrumb', () => {
  const ITEMS = [{ label: 'Inicio', href: '/' }, { label: 'Relojes', href: '/relojes' }, { label: 'Tourbillon Aurora' }];
  const crumbs = (items: { label: string; href?: string }[] = ITEMS): Promise<HTMLElement> => ui(Breadcrumb, { items });

  test('es un nav con aria-label no vacío que contiene una lista ordenada con un li por elemento', async () => {
    const body = await crumbs();
    const nav = body.querySelector('nav');
    expect(nav).not.toBeNull();
    expect((nav?.getAttribute('aria-label') ?? '').trim()).not.toBe('');
    expect(nav?.querySelectorAll('ol')).toHaveLength(ONE);
    expect(body.querySelectorAll('ol > li')).toHaveLength(ITEMS.length);
    expect(body.querySelectorAll('ul')).toHaveLength(NONE);
  });

  test('el último elemento no es un enlace y lleva aria-current="page"', async () => {
    const body = await crumbs();
    const lis = [...body.querySelectorAll('ol > li')];
    const last = lis[lis.length - ONE];
    expect(last.querySelector('a')).toBeNull();
    expect(text(last)).toBe('Tourbillon Aurora');
    const current = body.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(ONE);
    expect(current[NONE].getAttribute('aria-current')).toBe('page');
    expect(last.contains(current[NONE])).toBe(true);
  });

  test('los elementos intermedios con href son enlaces al destino y en orden', async () => {
    const body = await crumbs();
    const links = [...body.querySelectorAll('a')];
    expect(links.map((a) => [text(a), a.getAttribute('href')])).toEqual([
      ['Inicio', '/'],
      ['Relojes', '/relojes'],
    ]);
    expect([...body.querySelectorAll('ol > li')].map((li) => text(li))).toEqual(['Inicio', 'Relojes', 'Tourbillon Aurora']);
  });

  test('un elemento intermedio sin href no es enlace', async () => {
    const body = await crumbs([{ label: 'Inicio', href: '/' }, { label: 'Sin enlace' }, { label: 'Fin' }]);
    expect([...body.querySelectorAll('a')].map(text)).toEqual(['Inicio']);
    expect(body.querySelectorAll('ol > li')).toHaveLength(THREE);
  });

  test('aunque el último elemento traiga href, no se enlaza (es la página actual)', async () => {
    const body = await crumbs([{ label: 'Inicio', href: '/' }, { label: 'Aquí', href: '/aqui' }]);
    expect([...body.querySelectorAll('a')].map(text)).toEqual(['Inicio']);
    expect(body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Aquí');
  });

  test('un solo elemento: es la página actual, sin enlaces', async () => {
    const body = await crumbs([{ label: 'Inicio' }]);
    expect(body.querySelectorAll('a')).toHaveLength(NONE);
    expect(body.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Inicio');
  });

  test('el texto de las migas se escapa (no se interpreta como HTML)', async () => {
    const body = await crumbs([{ label: '<b id="x">negrita</b>', href: '/' }, { label: '<img src=x onerror=alert(1)>' }]);
    expect(body.querySelector('b#x')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<b id="x">negrita</b>');
  });
});

// ------------------------------------------------------------------------------------------------ Pagination

describe('Pagination', () => {
  const PAGE_SIZE = 12;
  const SHORT = PAGE_SIZE * THREE; // 3 páginas
  const LONG = PAGE_SIZE * PAGE_SIZE; // 12 páginas
  const LONG_PAGES = PAGE_SIZE;
  const AT_MIDDLE = 6;
  const AT_START = THREE;
  const hrefFor = (n: number): string => `?page=${n}`;
  const render = (page: number, total: number, extra: Record<string, unknown> = {}): Promise<HTMLElement> =>
    ui(Pagination, { page, pageSize: PAGE_SIZE, total, hrefFor, ...extra });
  const numbers = (body: HTMLElement): number[] =>
    [...body.querySelectorAll('a[aria-label^="Página "]')].map((a) => Number(a.getAttribute('aria-label')?.replace('Página ', '')));
  const gaps = (body: HTMLElement): Element[] => [...body.querySelectorAll('[aria-hidden="true"]')].filter((e) => text(e) === '…');
  const step = (body: HTMLElement, label: 'Anterior' | 'Siguiente'): Element | undefined =>
    [...body.querySelectorAll('a, span')].find((e) => text(e) === label && (e.tagName === 'A' || e.getAttribute('aria-disabled') === 'true'));
  /** Entre dos números consecutivos mostrados nunca hay un hueco de exactamente una página (se rellenaría con su número). */
  const singleGaps = (nums: number[]): number[] => nums.filter((n, i) => i > NONE && n - nums[i - ONE] === TWO);
  const list = (s: string): number[] => s.split(' ').map(Number);
  const MID_EXPECTED = list('1 5 6 7 12');
  const START_EXPECTED = list('1 2 3 4 12');
  const END_EXPECTED = list('1 11 12');
  const WIDE_EXPECTED = list('4 5 6 7 8');
  const ALL_SHORT = [1, TWO, THREE];

  test.each([
    ['sin elementos', NONE],
    ['menos que una página', PAGE_SIZE - ONE],
    ['exactamente una página (total == pageSize)', PAGE_SIZE],
  ])('no se pinta si total <= pageSize: %s', async (_n, total) => {
    const body = await render(ONE, total);
    expect(body.querySelector('nav')).toBeNull();
    expect(body.querySelector('a')).toBeNull();
    expect(text(body)).toBe('');
  });

  test('con total = pageSize + 1 ya hay dos páginas', async () => {
    const body = await render(ONE, PAGE_SIZE + ONE);
    expect(numbers(body)).toEqual([ONE, TWO]);
  });

  test('es un nav con aria-label y una lista; cada página es un <a> con href de hrefFor (funciona sin JS)', async () => {
    const body = await render(TWO, SHORT);
    const nav = body.querySelector('nav');
    expect((nav?.getAttribute('aria-label') ?? '').trim()).not.toBe('');
    expect(nav?.querySelector('ul, ol')).not.toBeNull();
    expect(body.querySelectorAll('script')).toHaveLength(NONE);
    [...body.querySelectorAll('a[aria-label^="Página "]')].forEach((a) => {
      expect(a.getAttribute('href')).toBe(hrefFor(Number(a.textContent?.trim())));
    });
  });

  test('la página actual lleva aria-current="page", es única, y cada número tiene aria-label "Página n"', async () => {
    const body = await render(TWO, SHORT);
    const current = body.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(ONE);
    expect(current[NONE].getAttribute('aria-current')).toBe('page');
    expect(current[NONE].getAttribute('aria-label')).toBe('Página 2');
    expect(text(current[NONE])).toBe('2');
    expect(numbers(body)).toEqual(ALL_SHORT);
  });

  test('primera página: "Anterior" es un span aria-disabled sin enlace; "Siguiente" es <a rel="next">', async () => {
    const body = await render(ONE, SHORT);
    const prev = step(body, 'Anterior');
    expect(prev?.tagName).toBe('SPAN');
    expect(prev?.getAttribute('aria-disabled')).toBe('true');
    expect(prev?.hasAttribute('href')).toBe(false);
    expect(prev?.closest('a')).toBeNull();
    expect(prev?.hasAttribute('tabindex')).toBe(false);
    const next = step(body, 'Siguiente') as Element;
    expect(next.tagName).toBe('A');
    expect(next.getAttribute('rel')).toBe('next');
    expect(next.getAttribute('href')).toBe(hrefFor(TWO));
    expect(body.querySelector('[rel~="prev"]')).toBeNull();
  });

  test('última página: "Siguiente" es span aria-disabled; "Anterior" es <a rel="prev"> a la página previa', async () => {
    const body = await render(THREE, SHORT);
    const next = step(body, 'Siguiente');
    expect(next?.tagName).toBe('SPAN');
    expect(next?.getAttribute('aria-disabled')).toBe('true');
    expect(next?.hasAttribute('href')).toBe(false);
    const prev = step(body, 'Anterior') as Element;
    expect(prev.tagName).toBe('A');
    expect(prev.getAttribute('rel')).toBe('prev');
    expect(prev.getAttribute('href')).toBe(hrefFor(TWO));
    expect(body.querySelector('[rel~="next"]')).toBeNull();
  });

  test('página intermedia: ambos son enlaces con rel y destino correctos', async () => {
    const body = await render(TWO, SHORT);
    const prev = step(body, 'Anterior') as Element;
    const next = step(body, 'Siguiente') as Element;
    expect([prev.tagName, prev.getAttribute('rel'), prev.getAttribute('href')]).toEqual(['A', 'prev', hrefFor(ONE)]);
    expect([next.tagName, next.getAttribute('rel'), next.getAttribute('href')]).toEqual(['A', 'next', hrefFor(THREE)]);
    expect(body.querySelectorAll('[aria-disabled="true"]')).toHaveLength(NONE);
  });

  test('muchas páginas, intermedia: primera, última y vecinos con elipsis aria-hidden; sin huecos de una sola página', async () => {
    const body = await render(AT_MIDDLE, LONG);
    const nums = numbers(body);
    expect(nums).toEqual(expect.arrayContaining(MID_EXPECTED));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(new Set(nums).size).toBe(nums.length);
    expect(nums).not.toContain(THREE);
    expect(gaps(body).length).toBeGreaterThanOrEqual(TWO);
    gaps(body).forEach((g) => {
      expect(g.getAttribute('aria-hidden')).toBe('true');
      expect(g.closest('a')).toBeNull();
      expect(g.querySelector('a, button')).toBeNull();
    });
    expect(singleGaps(nums)).toEqual([]);
  });

  test('muchas páginas, cerca del inicio: la ventana no deja una elipsis para una sola página', async () => {
    const body = await render(AT_START, LONG);
    const nums = numbers(body);
    expect(nums).toEqual(expect.arrayContaining(START_EXPECTED));
    expect(nums[nums.length - ONE]).toBe(LONG_PAGES);
    expect(gaps(body)).toHaveLength(ONE);
    expect(singleGaps(nums)).toEqual([]);
  });

  test('muchas páginas, última: una sola elipsis y la última marcada como actual', async () => {
    const body = await render(LONG_PAGES, LONG);
    expect(numbers(body)).toEqual(expect.arrayContaining(END_EXPECTED));
    expect(body.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(`Página ${LONG_PAGES}`);
    expect(gaps(body)).toHaveLength(ONE);
  });

  test('siblings amplía la ventana de páginas', async () => {
    const narrow = numbers(await render(AT_MIDDLE, LONG, { siblings: ONE }));
    const wide = numbers(await render(AT_MIDDLE, LONG, { siblings: TWO }));
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(wide).toEqual(expect.arrayContaining(WIDE_EXPECTED));
  });

  test.each([
    ['por encima del máximo', '99', THREE],
    ['cero', '0', ONE],
    ['negativa', '-4', ONE],
    ['NaN', 'NaN', ONE],
  ])('página fuera de rango se acota (%s)', async (_n, page, expected) => {
    const body = await render(Number(page), SHORT);
    expect(body.querySelectorAll('[aria-current="page"]')).toHaveLength(ONE);
    expect(body.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(`Página ${expected}`);
    expect(numbers(body)).toEqual(ALL_SHORT);
  });

  test('hrefFor se llama con cada número mostrado y con el anterior y el siguiente; nunca fuera de 1..N', async () => {
    const hf = vi.fn((n: number) => `/c?page=${n}`);
    const body = await ui(Pagination, { page: AT_MIDDLE, pageSize: PAGE_SIZE, total: LONG, hrefFor: hf });
    const called = new Set(hf.mock.calls.map((c) => c[NONE]));
    numbers(body).forEach((n) => expect(called.has(n)).toBe(true));
    expect(called.has(AT_MIDDLE - ONE) && called.has(AT_MIDDLE + ONE)).toBe(true);
    [...called].forEach((n) => expect(n >= ONE && n <= LONG_PAGES && Number.isInteger(n)).toBe(true));
  });

  test('el href se usa tal cual lo devuelve hrefFor (conserva los demás parámetros que ponga quien llama)', async () => {
    const body = await ui(Pagination, {
      page: TWO,
      pageSize: PAGE_SIZE,
      total: SHORT,
      hrefFor: (n: number) => `/relojes?q=oro&sort=newest&page=${n}`,
    });
    const hrefs = [...body.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(NONE);
    hrefs.forEach((h) => expect(h?.startsWith('/relojes?q=oro&sort=newest&page=')).toBe(true));
  });

  test('solo la página actual lleva aria-current', async () => {
    const body = await render(TWO, SHORT);
    const cur = body.querySelector('[aria-current="page"]') as Element;
    const others = [...body.querySelectorAll('a[aria-label^="Página "]')].filter((a) => a !== cur);
    expect(others).toHaveLength(TWO);
    others.forEach((o) => expect(o.hasAttribute('aria-current')).toBe(false));
  });
});

// ------------------------------------------------------------------------------------------------ DefinitionList

describe('DefinitionList', () => {
  const ITEMS = [
    { term: 'Calibre', description: 'Automático 9001' },
    { term: 'Caja', description: 'Oro Amarillo 18K, 40 mm' },
    { term: 'Resistencia al agua', description: '100 m' },
  ];

  test('genera un <dl> con un <dt> y un <dd> por elemento, en orden', async () => {
    const body = await ui(DefinitionList, { items: ITEMS });
    expect(body.querySelectorAll('dl')).toHaveLength(ONE);
    expect([...body.querySelectorAll('dl dt')].map(text)).toEqual(ITEMS.map((i) => i.term));
    expect([...body.querySelectorAll('dl dd')].map(text)).toEqual(ITEMS.map((i) => i.description));
  });

  test('cada <dt> va seguido de su <dd> y ambos cuelgan de dl (o de un div hijo directo de dl)', async () => {
    const body = await ui(DefinitionList, { items: ITEMS });
    [...body.querySelectorAll('dt')].forEach((dt) => {
      const dd = dt.nextElementSibling;
      expect(dd?.tagName).toBe('DD');
      expect(ITEMS.find((i) => i.term === text(dt))?.description).toBe(text(dd));
    });
    [...body.querySelectorAll('dt, dd')].forEach((el) => {
      const p = el.parentElement;
      expect(p?.tagName === 'DL' || (p?.tagName === 'DIV' && p.parentElement?.tagName === 'DL')).toBe(true);
    });
  });

  test('sin elementos no produce pares ni errores', async () => {
    const body = await ui(DefinitionList, { items: [] });
    expect(body.querySelectorAll('dt, dd')).toHaveLength(NONE);
  });

  test('columns 1 y 2 se distinguen en el marcado; por defecto es 1', async () => {
    const wrapper = async (props: Record<string, unknown>): Promise<string> =>
      markers((await ui(DefinitionList, { items: ITEMS, ...props })).querySelector('dl')?.parentElement as Element);
    const one = await wrapper({ columns: ONE });
    expect(await wrapper({ columns: TWO })).not.toBe(one);
    expect(await wrapper({})).toBe(one);
  });

  test('términos y descripciones se escapan (nunca HTML)', async () => {
    const body = await ui(DefinitionList, { items: [{ term: '<i id="t">x</i>', description: '<script>window.__x=1</script>' }] });
    expect(body.querySelector('i#t')).toBeNull();
    expect(body.querySelector('dl script')).toBeNull();
    expect(text(body.querySelector('dd'))).toBe('<script>window.__x=1</script>');
  });
});
