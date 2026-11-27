import { describe, expect, test } from 'vitest';
import type { AttributeValue, Category } from '../../src/lib/api/catalog';
import { formatMoney } from '../../src/lib/format';
import { activeChips, catalogHref, parseCatalogQuery, type CatalogQuery } from '../../src/lib/catalog/query';

// T-124 · parseCatalogQuery / catalogHref / activeChips (STATUS "T-124 › Firmas públicas", N-3).
// parseCatalogQuery es la frontera de confianza: lo que sale de aquí es lo único que llega a la API.
// Se prueba contra la firma pública, con URLSearchParams reales, sin depender del interior.
const PAGE_SIZE = 24;
const CENTS = 100;
const MAX_Q = 100;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const SIX = 6;
const LONG = 200;
const HUGE_Q = 500;
const MANY_KEYS = 60;
const MIN_SOLES = 1500;
const MID_SOLES = 5000;
const SAMPLE_SOLES = 12750;
const HI_SOLES = 9000;
const TOP_SOLES = 20000;
const MIN_CENTS = 150000;
const SAMPLE_CENTS = 1275000;
const LIMIT_CENTS = 10_000_000_000;
const parse = (qs: string) => parseCatalogQuery(new URLSearchParams(qs));
const parseUrl = (href: string) => parseCatalogQuery(new URL(href, 'http://localhost').searchParams);
const norm = (s: string): string => s.replaceAll(' ', ' ');

// Fragmentos que nunca deben sobrevivir: parámetros ajenos y trozos de inyección.
const LEAKED = ['utm_source', 'admin', 'is_published', 'status', 'limit', '9999', '1000'];
const SQL_FRAGMENT = ['DROP', '--', ';'];
const hasAny = (text: string, parts: string[]): boolean => parts.some((p) => text.includes(p));
const CTRL_MAX = 0x1f;
const DEL = 0x7f;
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) <= CTRL_MAX || c.charCodeAt(0) === DEL);
const isCatalogPath = (href: string): boolean => href === '/relojes' || href.startsWith('/relojes?');

// Lista cerrada: lo único que puede salir hacia la API y hacia el estado de la página.
const FILTER_KEYS = ['q', 'category', 'movement', 'case_material', 'price_min', 'price_max', 'available', 'sort', 'page', 'page_size'];
const QUERY_KEYS = ['q', 'category', 'movement', 'case_material', 'price_min_soles', 'price_max_soles', 'available', 'sort', 'page'];
const expectClosed = (r: ReturnType<typeof parse>): void => {
  expect(Object.keys(r.filters).filter((k) => !FILTER_KEYS.includes(k))).toEqual([]);
  expect(Object.keys(r.query).filter((k) => !QUERY_KEYS.includes(k))).toEqual([]);
};

describe('T-124 · parseCatalogQuery · claves válidas', () => {
  test('sin parámetros: página 1, tamaño 24, sin filtros y sin marcar invalid', () => {
    const r = parse('');
    expect(r.invalid).toBe(false);
    expect(r.query).toEqual({ page: ONE });
    expect(r.filters).toEqual({ page: ONE, page_size: PAGE_SIZE });
  });

  test('cada clave válida se acepta y llega a la API con el nombre de la API', () => {
    const r = parse('q=tourbillon&category=demo-buceo&movement=automatic&case_material=gold-18k&sort=price_asc&available=1&page=3');
    expect(r.invalid).toBe(false);
    expect(r.query).toMatchObject({
      q: 'tourbillon',
      category: 'demo-buceo',
      movement: 'automatic',
      case_material: 'gold-18k',
      sort: 'price_asc',
      available: true,
      page: THREE,
    });
    expect(r.filters).toMatchObject({
      q: 'tourbillon',
      category: 'demo-buceo',
      movement: 'automatic',
      case_material: 'gold-18k',
      sort: 'price_asc',
      available: true,
      page: THREE,
      page_size: PAGE_SIZE,
    });
  });

  test.each(['newest', 'price_asc', 'price_desc'])('sort=%s se acepta', (sort) => {
    const r = parse(`sort=${sort}`);
    expect(r.query.sort).toBe(sort);
    expect(r.filters.sort).toBe(sort);
    expect(r.invalid).toBe(false);
  });

  test('relevance con q se acepta', () => {
    const r = parse('q=oro&sort=relevance');
    expect(r.query.sort).toBe('relevance');
    expect(r.filters.sort).toBe('relevance');
    expect(r.invalid).toBe(false);
  });

  test('available=1 es true; available=0 o ausente no envía el filtro', () => {
    expect(parse('available=1').filters.available).toBe(true);
    expect(parse('available=0').filters.available).toBeUndefined();
    expect(parse('').filters.available).toBeUndefined();
  });

  test('los campos vacíos que envía el formulario GET sin tocar NO son una URL inválida', () => {
    // El <form> manda `name=` por cada campo en blanco, incluido sort= (primera opción).
    const r = parse('category=&movement=&case_material=&price_min=&price_max=&sort=');
    expect(r.invalid).toBe(false);
    expect(r.query).toEqual({ page: ONE });
    expect(r.filters).toEqual({ page: ONE, page_size: PAGE_SIZE });
  });

  test('un q con solo espacios es como no tener q', () => {
    const r = parse(`q=${encodeURIComponent('    ')}`);
    expect(r.query.q).toBeUndefined();
    expect(r.filters.q).toBeUndefined();
  });

  test('slugs típicos de la semilla y de atributos pasan (guion, dígitos)', () => {
    expect(parse('category=demo-aviador').query.category).toBe('demo-aviador');
    expect(parse('case_material=gold-18k').query.case_material).toBe('gold-18k');
    expect(parse('movement=automatic').query.movement).toBe('automatic');
  });
});

describe('T-124 · parseCatalogQuery · lista cerrada (N-3)', () => {
  test('una clave desconocida se descarta: no aparece ni en query ni en filters', () => {
    const r = parse('category=demo-buceo&utm_source=x&admin=1&is_published=false&status=draft&limit=9999&page_size=1000&price_min_cents=1');
    expectClosed(r);
    expect(r.filters.page_size).toBe(PAGE_SIZE); // el tamaño de página no lo elige el visitante
    expect(r.filters.category).toBe('demo-buceo');
    expect(hasAny(JSON.stringify(r), LEAKED)).toBe(false);
  });

  test('page_size de la URL se ignora y siempre es 24', () => {
    expect(parse('page_size=1').filters.page_size).toBe(PAGE_SIZE);
    expect(parse('page_size=100000').filters.page_size).toBe(PAGE_SIZE);
  });

  test.each(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', '__proto__[polluted]', 'constructor[prototype][polluted]'])(
    'la clave %s no contamina ni entra en el resultado',
    (key) => {
      const r = parse(`${encodeURIComponent(key)}=yes&category=demo-buceo`);
      expectClosed(r);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(r.filters)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(r.query)).toBe(Object.prototype);
      expect(r.filters.category).toBe('demo-buceo');
    },
  );

  test('el resultado nunca contiene claves fuera de la lista (URL hostil con muchas claves)', () => {
    const hostile = [
      'q=a',
      'category=demo-buceo',
      ...Array.from({ length: MANY_KEYS }, (_, i) => `x${i}=y${i}`),
      'category[]=a',
      'sort[]=newest',
      'filter[price]=1',
      'price_min=10',
      'page=2',
      'order_by=id',
      'select=*',
    ].join('&');
    expectClosed(parse(hostile));
  });

  test('no modifica los URLSearchParams recibidos', () => {
    const sp = new URLSearchParams('category=Bad&x=1&page=-3');
    const before = sp.toString();
    parseCatalogQuery(sp);
    expect(sp.toString()).toBe(before);
  });
});

describe('T-124 · parseCatalogQuery · slugs (category, movement, case_material)', () => {
  const HOSTILE: [string, string][] = [
    ['mayúsculas', 'Demo-Buceo'],
    ['espacio', 'oro rosa'],
    ['barra', 'demo/buceo'],
    ['barra inversa', 'demo\\buceo'],
    ['dos puntos', '..'],
    ['recorrido de ruta', '../../etc/passwd'],
    ['punto simple', '.'],
    ['ruta codificada', '%2e%2e%2fadmin'],
    ['demasiado largo', 'a'.repeat(LONG)],
    ['inyección SQL', "x'; DROP TABLE products;--"],
    ['inyección SQL con OR', "a' OR '1'='1"],
    ['HTML', '<script>alert(1)</script>'],
    ['etiqueta img', '"><img src=x onerror=alert(1)>'],
    ['salto de línea', 'demo\nbuceo'],
    ['byte nulo', 'demo\u0000'],
    ['encabezado inyectado', 'x\r\nSet-Cookie: a=b'],
    ['unicode', 'relój'],
    ['ancho completo', 'ａｂｃ'],
    ['empieza por guion', '-demo'],
    ['signo más', 'a+b'],
    ['punto y coma', 'a;b'],
    ['esquema', 'javascript:alert(1)'],
  ];
  const KEYS = ['category', 'movement', 'case_material'] as const;

  KEYS.forEach((key) => {
    test.each(HOSTILE)(`${key}: rechaza %s`, (_name, value) => {
      const r = parseCatalogQuery(new URLSearchParams([[key, value]]));
      expect(r.query[key]).toBeUndefined();
      expect(r.filters[key]).toBeUndefined();
      expect(r.invalid).toBe(true);
      expectClosed(r);
    });
  });

  test('un slug rechazado no impide aplicar el resto de filtros válidos', () => {
    const r = parse(`category=BAD%20SLUG&movement=automatic&price_max=${MID_SOLES}`);
    expect(r.invalid).toBe(true);
    expect(r.filters.category).toBeUndefined();
    expect(r.filters.movement).toBe('automatic');
    expect(r.filters.price_max).toBe(MID_SOLES * CENTS);
  });

  test('ningún valor hostil sobrevive en ninguna parte del resultado', () => {
    const r = parseCatalogQuery(new URLSearchParams([['category', "x'; DROP TABLE products;--"]]));
    expect(hasAny(JSON.stringify(r), SQL_FRAGMENT)).toBe(false);
  });
});

describe('T-124 · parseCatalogQuery · precios en soles → céntimos', () => {
  test('soles enteros se convierten a céntimos (D-015) y la URL conserva soles', () => {
    const r = parse(`price_min=${MIN_SOLES}&price_max=${SAMPLE_SOLES}`);
    expect(r.query.price_min_soles).toBe(MIN_SOLES);
    expect(r.query.price_max_soles).toBe(SAMPLE_SOLES);
    expect(r.filters.price_min).toBe(MIN_CENTS);
    expect(r.filters.price_max).toBe(SAMPLE_CENTS);
    expect(r.invalid).toBe(false);
  });

  test('0 es un precio válido (no se confunde con "sin filtro")', () => {
    const r = parse('price_min=0');
    expect(r.query.price_min_soles).toBe(NONE);
    expect(r.filters.price_min).toBe(NONE);
    expect(r.invalid).toBe(false);
  });

  test('1 sol son 100 céntimos', () => {
    expect(parse('price_max=1').filters.price_max).toBe(CENTS);
  });

  test('el límite superior (1e8 soles) se acepta y se convierte sin perder exactitud', () => {
    const r = parse('price_max=100000000');
    expect(r.filters.price_max).toBe(LIMIT_CENTS);
    expect(Number.isSafeInteger(r.filters.price_max)).toBe(true);
    expect(r.invalid).toBe(false);
  });

  const BAD_PRICES: [string, string][] = [
    ['negativo', '-5'],
    ['negativo cero', '-0'],
    ['decimal con punto', '15.5'],
    ['decimal con coma', '15,5'],
    ['notación científica', '1e3'],
    ['hexadecimal', '0x10'],
    ['texto', 'abc'],
    ['texto con número', '12abc'],
    ['más', '+5'],
    ['infinito', 'Infinity'],
    ['NaN', 'NaN'],
    ['fuera de rango', '100000001'],
    ['enorme', '99999999999999999999'],
    ['ancho completo', '１２'],
    ['con separador de miles', '1,500'],
    ['inyección', '1 OR 1=1'],
    ['HTML', '<b>1</b>'],
  ];
  const PRICE_KEYS = [
    ['price_min', 'price_min_soles'],
    ['price_max', 'price_max_soles'],
  ] as const;
  PRICE_KEYS.forEach(([key, camel]) => {
    test.each(BAD_PRICES)(`${key}: rechaza %s`, (_n, value) => {
      const r = parseCatalogQuery(new URLSearchParams([[key, value]]));
      expect(r.query[camel]).toBeUndefined();
      expect(r.filters[key]).toBeUndefined();
      expect(r.invalid).toBe(true);
    });
  });

  test('ningún importe que salga hacia la API es negativo, decimal ni NaN', () => {
    ['-1', '1.5', 'x', '100000001', '', '0', '7', '99999999'].forEach((v) => {
      const r = parseCatalogQuery(new URLSearchParams([['price_min', v], ['price_max', v]]));
      [r.filters.price_min, r.filters.price_max].forEach((n) => {
        if (n !== undefined) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(NONE);
          expect(n % CENTS).toBe(NONE);
        }
      });
    });
  });

  test('price_min > price_max no lanza (la página decide no pedir nada)', () => {
    expect(() => parse('price_min=9000&price_max=100')).not.toThrow();
  });
});

describe('T-124 · parseCatalogQuery · q', () => {
  test('q de exactamente 100 caracteres se conserva', () => {
    const q = 'a'.repeat(MAX_Q);
    expect(parse(`q=${q}`).filters.q).toBe(q);
  });

  test('q de más de 100 caracteres se recorta a 100 (el servidor respondería 422)', () => {
    const r = parse(`q=${'b'.repeat(HUGE_Q)}`);
    expect(r.filters.q).toBe('b'.repeat(MAX_Q));
    expect(r.query.q).toBe('b'.repeat(MAX_Q));
  });

  test('q con espacios alrededor se recorta (trim) y conserva los interiores', () => {
    expect(parse(`q=${encodeURIComponent('  oro rosa  ')}`).filters.q).toBe('oro rosa');
  });

  test('q con caracteres de control nunca llega a la API (el backend responde 422)', () => {
    ['reloj\u0000x', 'a\u0007b', 'oro\u001brosa', 'x\ry', 'a\nb', 'a\tb', '\u0000'].forEach((q) => {
      const r = parseCatalogQuery(new URLSearchParams([['q', q]]));
      expect(hasControl(r.filters.q ?? ''), JSON.stringify(q)).toBe(false);
      expect(hasControl(r.query.q ?? ''), JSON.stringify(q)).toBe(false);
    });
  });

  test('q con comillas, apóstrofos o HTML viaja como texto sin interpretar (la página lo escapa y la API lo parametriza)', () => {
    const q = `o'ro "rosa" <b>&</b>`;
    expect(parseCatalogQuery(new URLSearchParams([['q', q]])).filters.q).toBe(q);
  });

  test('el recorte de q no parte un emoji por la mitad', () => {
    const r = parse(`q=${encodeURIComponent('😀'.repeat(MAX_Q))}`);
    const out = r.filters.q ?? '';
    expect(out.length).toBeLessThanOrEqual(MAX_Q);
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('T-124 · parseCatalogQuery · sort', () => {
  test.each(['hacked', 'PRICE_ASC', 'Price_Desc', 'price', 'price_asc;drop', '1', 'null', 'undefined', '__proto__', 'oldest'])(
    'sort=%s se descarta y marca invalid',
    (sort) => {
      const r = parse(`sort=${encodeURIComponent(sort)}`);
      expect(r.query.sort).toBeUndefined();
      expect(r.filters.sort).toBeUndefined();
      expect(r.invalid).toBe(true);
    },
  );

  test('relevance sin q se descarta (el servidor respondería 422, CATALOG-R8)', () => {
    const r = parse('sort=relevance');
    expect(r.query.sort).toBeUndefined();
    expect(r.filters.sort).toBeUndefined();
  });

  test('relevance con q de solo espacios también se descarta', () => {
    const r = parse(`q=${encodeURIComponent('   ')}&sort=relevance`);
    expect(r.filters.sort).toBeUndefined();
  });
});

describe('T-124 · parseCatalogQuery · page', () => {
  test.each([
    ['cero', '0'],
    ['negativa', '-1'],
    ['negativa grande', '-999'],
    ['texto', 'abc'],
    ['decimal', '1.5'],
    ['notación científica', '1e2'],
    ['con signo', '+2'],
    ['infinito', 'Infinity'],
    ['NaN', 'NaN'],
    ['enorme', '99999999999999999999'],
    ['inyección', '1;DROP'],
  ])('page %s (%s) vuelve a 1 y marca invalid', (_n, value) => {
    const r = parseCatalogQuery(new URLSearchParams([['page', value]]));
    expect(r.query.page).toBe(ONE);
    expect(r.filters.page).toBe(ONE);
    expect(r.invalid).toBe(true);
  });

  test('page válida se respeta', () => {
    expect(parse('page=2').filters.page).toBe(TWO);
    expect(parse('page=2').query.page).toBe(TWO);
  });

  test('page vacío vuelve a 1 sin marcar invalid', () => {
    const r = parse('page=');
    expect(r.query.page).toBe(ONE);
    expect(r.invalid).toBe(false);
  });

  test('page siempre sale como entero seguro >= 1', () => {
    ['0', '-4', 'x', '1.1', '7', '100', '999999999999'].forEach((v) => {
      const r = parseCatalogQuery(new URLSearchParams([['page', v]]));
      expect(Number.isSafeInteger(r.filters.page)).toBe(true);
      expect(r.filters.page).toBeGreaterThanOrEqual(ONE);
    });
  });
});

describe('T-124 · parseCatalogQuery · repeticiones y arrays', () => {
  test('una clave repetida no produce un array: sale un único valor válido o nada', () => {
    const r = parse(
      'category=demo-buceo&category=demo-vestir&movement=manual&movement=automatic&price_min=1&price_min=2&page=2&page=3&sort=price_asc&sort=price_desc',
    );
    expectClosed(r);
    expect(Array.isArray(r.filters.category)).toBe(false);
    expect(['demo-buceo', 'demo-vestir', undefined]).toContain(r.filters.category);
    expect(['manual', 'automatic', undefined]).toContain(r.filters.movement);
    expect(typeof (r.filters.price_min ?? NONE)).toBe('number');
    expect(typeof r.filters.page).toBe('number');
    expect(['price_asc', 'price_desc', undefined]).toContain(r.filters.sort);
  });

  test('si un valor repetido es hostil, no llega a la API aunque el primero fuera válido', () => {
    const r = parseCatalogQuery(new URLSearchParams([['category', 'demo-buceo'], ['category', "x'; DROP TABLE a;--"]]));
    expect(hasAny(JSON.stringify(r), SQL_FRAGMENT)).toBe(false);
  });

  test('notación de array (key[]) es una clave desconocida y se descarta', () => {
    const r = parse('category[]=demo-buceo&movement[0]=automatic&sort[]=price_asc');
    expect(r.filters.category).toBeUndefined();
    expect(r.filters.movement).toBeUndefined();
    expect(r.filters.sort).toBeUndefined();
    expectClosed(r);
  });
});

describe('T-124 · catalogHref', () => {
  test('sin filtros: /relojes limpio', () => {
    expect(catalogHref({})).toBe('/relojes');
    expect(catalogHref({ page: ONE })).toBe('/relojes');
  });

  test('omite valores vacíos y page=1; incluye page>1', () => {
    expect(catalogHref({ q: '', category: undefined, available: false, page: ONE })).toBe('/relojes');
    expect(catalogHref({ page: TWO })).toBe('/relojes?page=2');
  });

  test('los precios van en soles (nombre de la URL, no de la API)', () => {
    const u = new URL(catalogHref({ price_min_soles: MIN_SOLES, price_max_soles: HI_SOLES }), 'http://x');
    expect(u.searchParams.get('price_min')).toBe(String(MIN_SOLES));
    expect(u.searchParams.get('price_max')).toBe(String(HI_SOLES));
    expect(u.searchParams.has('price_min_soles')).toBe(false);
  });

  test('available va como available=1', () => {
    expect(new URL(catalogHref({ available: true }), 'http://x').searchParams.get('available')).toBe('1');
  });

  test('es determinista: el mismo objeto con las claves en otro orden da la misma URL', () => {
    const a = catalogHref({ category: 'demo-buceo', movement: 'automatic', page: THREE });
    const b = catalogHref({ page: THREE, movement: 'automatic', category: 'demo-buceo' });
    expect(a).toBe(b);
  });

  test('un q con & = # y espacios no inyecta parámetros', () => {
    const u = new URL(catalogHref({ q: 'a&sort=price_desc&category=x#frag', page: ONE }), 'http://x');
    expect(u.searchParams.get('q')).toBe('a&sort=price_desc&category=x#frag');
    expect(u.searchParams.has('sort')).toBe(false);
    expect(u.searchParams.has('category')).toBe(false);
    expect(u.hash).toBe('');
    expect(u.pathname).toBe('/relojes');
  });

  test('siempre es una ruta relativa al sitio (nunca //host ni https:)', () => {
    [{}, { q: '//evil.com' }, { category: 'x' }].forEach((q) => expect(isCatalogPath(catalogHref(q as Partial<CatalogQuery>))).toBe(true));
  });

  test('ida y vuelta: parse(catalogHref(q)) devuelve q y no marca invalid', () => {
    const full: CatalogQuery = {
      q: 'oro rosa & "plata"',
      category: 'demo-buceo',
      movement: 'automatic',
      case_material: 'gold-18k',
      price_min_soles: MIN_SOLES,
      price_max_soles: TOP_SOLES,
      available: true,
      sort: 'relevance',
      page: THREE,
    };
    const r = parseUrl(catalogHref(full));
    expect(r.invalid).toBe(false);
    expect(r.query).toEqual(full);
  });

  test('ida y vuelta de la URL: href(parse(href).query) es idempotente', () => {
    const href = catalogHref({ category: 'demo-vestir', price_max_soles: MID_SOLES, sort: 'price_asc', page: TWO });
    expect(catalogHref(parseUrl(href).query)).toBe(href);
  });

  test('ida y vuelta con 0 soles conserva el 0', () => {
    expect(parseUrl(catalogHref({ price_min_soles: NONE, page: ONE })).query.price_min_soles).toBe(NONE);
  });
});

describe('T-124 · activeChips', () => {
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
  const lookups = { categories, movements, case_materials: materials };
  const FULL: CatalogQuery = {
    category: 'demo-buceo',
    movement: 'automatic',
    case_material: 'gold-18k',
    price_min_soles: MIN_SOLES,
    price_max_soles: HI_SOLES,
    available: true,
    sort: 'price_asc',
    page: THREE,
  };
  const paramsOf = (href: string): URLSearchParams => new URL(href, 'http://x').searchParams;
  const FILTER_PARAMS = ['category', 'movement', 'case_material', 'price_min', 'price_max', 'available'];

  test('sin filtros activos: ningún chip (ni el orden ni la página son filtros)', () => {
    expect(activeChips({ page: ONE }, lookups)).toEqual([]);
    expect(activeChips({ page: THREE, sort: 'price_desc' }, lookups)).toEqual([]);
  });

  test('un chip por filtro activo: colección, movimiento, material, desde, hasta y disponibles', () => {
    expect(activeChips(FULL, lookups)).toHaveLength(SIX);
  });

  test('el chip muestra el nombre del atributo (label), no el código', () => {
    const labels = activeChips(FULL, lookups).map((c) => c.label).join(' | ');
    expect(labels).toContain('Buceo (demo)');
    expect(labels).toContain('Automático');
    expect(labels).toContain('Oro de 18 k');
    expect(labels).not.toContain('demo-buceo');
    expect(labels).not.toContain('gold-18k');
  });

  test('si el código no está en los lookups, el chip no se pierde (cae al código)', () => {
    const chips = activeChips({ category: 'desconocida', page: ONE }, lookups);
    expect(chips).toHaveLength(ONE);
    expect(chips[0].label).toContain('desconocida');
  });

  test('los chips de precio muestran soles con formato es-PE vía formatMoney', () => {
    const labels = activeChips(FULL, lookups).map((c) => norm(c.label));
    expect(labels.some((l) => l.includes(norm(formatMoney({ amount: MIN_SOLES * CENTS, currency: 'PEN' }))))).toBe(true);
    expect(labels.some((l) => l.includes(norm(formatMoney({ amount: HI_SOLES * CENTS, currency: 'PEN' }))))).toBe(true);
  });

  test('cada "Quitar" quita solo su filtro, conserva los demás y reinicia page', () => {
    const removed = activeChips(FULL, lookups).map((c) => {
      const sp = paramsOf(c.removeHref);
      const left = FILTER_PARAMS.filter((k) => sp.has(k));
      expect(left, `${c.label} -> ${c.removeHref}`).toHaveLength(FILTER_PARAMS.length - ONE);
      expect(sp.has('page'), 'page se reinicia').toBe(false);
      expect(sp.get('sort'), 'el orden se conserva').toBe('price_asc');
      expect(c.removeHref.startsWith('/relojes')).toBe(true);
      return FILTER_PARAMS.find((k) => !left.includes(k));
    });
    expect(new Set(removed).size).toBe(FILTER_PARAMS.length); // no hay dos chips que quiten lo mismo
  });

  test('los valores de los filtros que se conservan no cambian al quitar otro', () => {
    const chip = activeChips(FULL, lookups).find((c) => c.label.includes('Buceo'));
    const sp = paramsOf(chip!.removeHref);
    expect(sp.has('category')).toBe(false);
    expect(sp.get('movement')).toBe('automatic');
    expect(sp.get('case_material')).toBe('gold-18k');
    expect(sp.get('price_min')).toBe(String(MIN_SOLES));
    expect(sp.get('price_max')).toBe(String(HI_SOLES));
    expect(sp.get('available')).toBe('1');
  });

  test('chip de q: existe, quitarlo conserva los demás y no deja un sort=relevance huérfano', () => {
    const chips = activeChips({ q: 'oro', category: 'demo-buceo', sort: 'relevance', page: TWO }, lookups);
    expect(chips).toHaveLength(TWO);
    const chip = chips.find((c) => c.label.includes('oro'))!;
    const sp = paramsOf(chip.removeHref);
    expect(sp.has('q')).toBe(false);
    expect(sp.get('category')).toBe('demo-buceo');
    expect(sp.has('page')).toBe(false);
    // relevance sin q sería una URL inválida generada por nosotros mismos.
    expect(parseUrl(chip.removeHref).invalid).toBe(false);
  });

  test('toda URL de "Quitar" es válida para parseCatalogQuery (sin invalid) y no envía claves ajenas', () => {
    activeChips(FULL, lookups).forEach((c) => {
      const r = parseUrl(c.removeHref);
      expect(r.invalid, c.removeHref).toBe(false);
      expectClosed(r);
    });
  });

  test('un q con & en el chip no rompe la URL de quitar de otro filtro', () => {
    const chip = activeChips({ q: 'a&category=evil', category: 'demo-buceo', page: ONE }, lookups).find((c) => c.label.includes('Buceo'))!;
    const sp = paramsOf(chip.removeHref);
    expect(sp.get('q')).toBe('a&category=evil');
    expect(sp.has('category')).toBe(false);
  });
});
