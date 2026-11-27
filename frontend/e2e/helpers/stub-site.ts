import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

// Soporte E2E de T-124: una API de catálogo SIMULADA (para forzar paginación, 422, 5xx y JSON roto, que el backend real no
// produce con 12 productos) y el servidor de producción de Astro (`dist/server/entry.mjs`) apuntando a ella.
// Requiere `npm run build` previo. Nada de esto toca el stack real ni la base de datos.
const FRONTEND = resolve(import.meta.dirname, '../..');
const ENTRY = resolve(FRONTEND, 'dist/server/entry.mjs');
const LOOPBACK = '127.0.0.1';
const FAKE_ANON = 'x'; // valor ficticio corto: no encaja con el patrón del hook de secretos (N-5)
const READY_TRIES = 120;
const READY_WAIT_MS = 250;
const TOTAL = 60;
const PRICE_STEP = 10000; // S/ 100 por producto
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const ID_DIGITS = 12;
const TWO = 2;
const HTTP_UNPROCESSABLE = 422;
const HTTP_ERROR = 500;
const NONE = 0;
const ONE = 1;
const FAKE_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="5"><rect width="4" height="5" fill="gray"/></svg>')}`;
/** Texto que NUNCA debe llegar al navegador (traza del servidor). */
export const LEAK = 'Traceback (most recent call last) SECRET-DB-PASSWORD-LEAK';

export type Mode = 'ok' | 'validation' | 'server-error' | 'bad-json' | 'categories-down';
export type Hit = { path: string; query: URLSearchParams };
export type Stub = {
  url: string;
  hits: Hit[];
  setMode(mode: Mode): void;
  productHits(): Hit[];
  close(): Promise<void>;
};

const CATEGORIES = [
  { slug: 'cat-a', name: 'Colección Alfa', description: null },
  { slug: 'cat-b', name: 'Colección Beta', description: null },
  { slug: 'vacia', name: 'Colección Vacía', description: null },
];
const ATTRIBUTES = {
  movements: [{ code: 'automatic', label: 'Automático' }],
  case_materials: [{ code: 'steel', label: 'Acero' }],
};
const CAT_A_SIZE = 30;
const CAT_B_SIZE = 5;

const product = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(ID_DIGITS, '0')}`,
  slug: `reloj-${i}`,
  sku: `SKU-${i}`,
  name: `Reloj ${String(i).padStart(TWO, '0')}`,
  category: i < CAT_A_SIZE ? { slug: 'cat-a', name: 'Colección Alfa' } : { slug: 'cat-b', name: 'Colección Beta' },
  price: { amount: (i + ONE) * PRICE_STEP, currency: 'PEN' },
  original_price: null,
  discount_amount: null,
  movement: null,
  case_material: null,
  case_diameter_mm: null,
  water_resistance_m: null,
  main_image: { id: `img-${i}`, url: FAKE_IMAGE, alt: `Imagen de Reloj ${i}` },
  availability: { status: 'in_stock', lead_time_days: null },
});

const all = Array.from({ length: TOTAL }, (_, i) => product(i));

function select(q: URLSearchParams): typeof all {
  const category = q.get('category');
  const min = q.get('price_min');
  const max = q.get('price_max');
  const bySlug: Record<string, typeof all> = {
    'cat-a': all.slice(NONE, CAT_A_SIZE),
    'cat-b': all.slice(CAT_A_SIZE, CAT_A_SIZE + CAT_B_SIZE),
    vacia: [],
  };
  const base = (category !== null && bySlug[category]) || all;
  const ranged = base.filter((p) => (min === null || p.price.amount >= Number(min)) && (max === null || p.price.amount <= Number(max)));
  const sort = q.get('sort');
  return sort === 'price_desc' ? [...ranged].reverse() : ranged;
}

export function startStub(): Promise<Stub> {
  const hits: Hit[] = [];
  let mode: Mode = 'ok';
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    hits.push({ path: url.pathname, query: url.searchParams });
    if (url.pathname.endsWith('/catalog/categories')) {
      return mode === 'categories-down' ? json(res, HTTP_ERROR, { error: { code: 'internal', message: LEAK, details: null } }) : json(res, HTTP_OK, CATEGORIES);
    }
    if (url.pathname.endsWith('/catalog/attributes')) return json(res, HTTP_OK, ATTRIBUTES);
    if (!url.pathname.endsWith('/catalog/products')) return json(res, HTTP_NOT_FOUND, { error: { code: 'not_found', message: 'x', details: null } });
    if (mode === 'validation') {
      return json(res, HTTP_UNPROCESSABLE, { error: { code: 'validation_error', message: 'Datos de entrada no válidos.', details: [{ loc: ['query', 'q'], msg: LEAK }] } });
    }
    if (mode === 'server-error') {
      res.writeHead(HTTP_ERROR, { 'content-type': 'text/plain' });
      return void res.end(LEAK);
    }
    if (mode === 'bad-json') {
      res.writeHead(HTTP_OK, { 'content-type': 'application/json' });
      return void res.end(`{"items": [ ${LEAK}`);
    }
    const rows = select(url.searchParams);
    const size = Number(url.searchParams.get('page_size') ?? '20');
    const page = Number(url.searchParams.get('page') ?? '1');
    return json(res, HTTP_OK, { items: rows.slice((page - ONE) * size, page * size), total: rows.length, page, page_size: size });
  });
  return new Promise((ok) =>
    server.listen(NONE, LOOPBACK, () =>
      ok({
        url: `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`,
        hits,
        setMode: (m) => void (mode = m),
        productHits: () => hits.filter((h) => h.path.endsWith('/catalog/products')),
        close: () => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))),
      }),
    ),
  );
}

export type Site = { url: string; stop(): void };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitReady = async (url: string, tries = READY_TRIES): Promise<void> => {
  const ok = await fetch(url).then((r) => r.status < HTTP_ERROR, () => false);
  if (ok) return;
  if (tries <= ONE) throw new Error(`El servidor de Astro no arrancó en ${url}`);
  await sleep(READY_WAIT_MS);
  return waitReady(url, tries - ONE);
};

/** Levanta el servidor de producción de Astro (dist/) con `API_BASE_URL` apuntando a `apiBase`. */
export async function startSite(port: number, apiBase: string): Promise<Site> {
  if (!existsSync(ENTRY)) throw new Error('Falta dist/server/entry.mjs: ejecuta `npm run build` antes de este E2E.');
  const child: ChildProcess = spawn(process.execPath, [ENTRY], {
    cwd: FRONTEND,
    env: { ...process.env, HOST: LOOPBACK, PORT: String(port), API_BASE_URL: apiBase, SUPABASE_ANON_KEY: FAKE_ANON },
    stdio: 'ignore',
  });
  const url = `http://${LOOPBACK}:${port}`;
  await waitReady(`${url}/`);
  return { url, stop: () => void child.kill() };
}
