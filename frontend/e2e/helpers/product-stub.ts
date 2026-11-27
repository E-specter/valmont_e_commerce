import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';

// T-125 · API simulada del catálogo + servidor de producción de Astro propio apuntando a ella (API_BASE_URL).
// Sirve para lo que la semilla real no ofrece: varias imágenes por producto, descripciones hostiles, errores 5xx, respuestas lentas,
// contar las llamadas a la API (N-2) y apagar la API (502). La semilla real (`demo-…`) se prueba aparte, contra :8000.
// Los valores son ficticios y no imitan secretos (N-5).
const FRONTEND = resolve(import.meta.dirname, '../..');
const SERVER_ENTRY = resolve(FRONTEND, 'dist/server/entry.mjs');
const READY_TIMEOUT_MS = 150_000;
const POLL_MS = 400;
const OK = 200;
const NOT_FOUND = 404;
const TAIL = 1500;
const IMG_W = 800;
const IMG_H = 600;
const REL_PRICE = 5_000_000;
const REL_DIAMETER = 40;
const REL_WATER = 100;

export type Money = { amount: number; currency: 'PEN' };
export type Img = { id: string; url: string; alt: string };
export type Summary = {
  id: string;
  slug: string;
  sku: string;
  name: string;
  category: { slug: string; name: string };
  price: Money;
  original_price: Money | null;
  discount_amount: Money | null;
  movement: { code: string; label: string } | null;
  case_material: { code: string; label: string } | null;
  case_diameter_mm: number | null;
  water_resistance_m: number | null;
  main_image: Img;
  availability: { status: 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_request'; lead_time_days: number | null };
};
export type Detail = Summary & { description: string; specs: { label: string; value: string }[]; images: Img[]; related: Summary[] };

export type Reply = { status: number; body: unknown; delayMs?: number; raw?: string };

export type Stub = {
  /** Origen del stub, p. ej. http://127.0.0.1:5555 */
  origin: string;
  port: number;
  /** Rutas de la API pedidas desde el arranque (para comprobar que NO se llamó a la API). */
  apiHits: string[];
  replies: Map<string, Reply>;
  reply: (slug: string, r: Reply) => void;
  /** URL absoluta de una imagen SVG del stub (w x h px; `delayMs` retrasa la respuesta). */
  imageUrl: (n: number, opts?: { w?: number; h?: number; delayMs?: number }) => string;
  stop: () => Promise<void>;
  start: () => Promise<void>;
};

const COLORS = ['gray', 'teal', 'orange', 'purple', 'brown', 'navy'];

export const pen = (amount: number): Money => ({ amount, currency: 'PEN' });

function sendJson(res: ServerResponse, status: number, body: unknown, raw?: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(raw ?? JSON.stringify(body));
}

export async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

export async function startStub(): Promise<Stub> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const apiHits: string[] = [];
  const replies = new Map<string, Reply>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/img/') && url.pathname.endsWith('.svg')) {
      const n = Number(url.pathname.slice('/img/'.length, -'.svg'.length)); // /img/3.svg → imagen número 3
      const w = Number(url.searchParams.get('w') ?? IMG_W);
      const h = Number(url.searchParams.get('h') ?? IMG_H);
      const delay = Number(url.searchParams.get('delay') ?? '0');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${COLORS[n % COLORS.length]}"/><text x="20" y="60" font-size="48" fill="white">${n}</text></svg>`;
      setTimeout(() => {
        res.writeHead(OK, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
        res.end(svg);
      }, delay);
      return;
    }
    if (url.pathname.startsWith('/api/v1/')) {
      apiHits.push(url.pathname + url.search);
      const slug = url.pathname.startsWith('/api/v1/catalog/products/') ? decodeURIComponent(url.pathname.slice('/api/v1/catalog/products/'.length)) : null;
      const r = slug === null ? undefined : replies.get(slug);
      const answer = (): void => {
        if (!r) return sendJson(res, NOT_FOUND, { error: { code: 'product_not_found', message: 'Producto no encontrado.', details: null } });
        sendJson(res, r.status, r.body, r.raw);
      };
      if (r?.delayMs) setTimeout(answer, r.delayMs);
      else answer();
      return;
    }
    res.writeHead(NOT_FOUND).end();
  };

  let server: Server | null = null;
  const start = (): Promise<void> =>
    new Promise((ok, fail) => {
      server = createServer(handle);
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => ok());
    });
  const stop = (): Promise<void> =>
    new Promise((ok) => {
      if (!server) return ok();
      const s = server;
      server = null;
      s.closeAllConnections();
      s.close(() => ok());
    });
  await start();

  return {
    origin,
    port,
    apiHits,
    replies,
    reply: (slug, r) => void replies.set(slug, r),
    imageUrl: (n, opts = {}) => `${origin}/img/${n}.svg?w=${opts.w ?? IMG_W}&h=${opts.h ?? IMG_H}&delay=${opts.delayMs ?? 0}`,
    stop,
    start,
  };
}

export type Site = { origin: string; stop: () => void; log: () => string };

/**
 * Arranca el servidor de producción de Astro (`dist/server/entry.mjs`, requiere `npm run build` antes) en un puerto libre con
 * API_BASE_URL apuntando a `apiBase`. No se usa `astro dev`: Astro 7 solo admite un `astro dev` por proyecto y el E2E ya usa uno.
 * SUPABASE_ANON_KEY ficticia si el entorno no la trae.
 */
export async function startSite(apiBase: string): Promise<Site> {
  if (!existsSync(SERVER_ENTRY)) throw new Error('Falta dist/server/entry.mjs: ejecuta `npm run build` antes de este E2E.');
  const port = await freePort();
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: FRONTEND,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), API_BASE_URL: apiBase, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const waitReady = async (): Promise<void> => {
    if (child.exitCode !== null) throw new Error(`el servidor terminó (${child.exitCode}):
${output.slice(-TAIL)}`);
    const up = await fetch(`${origin}/relojes/calentamiento-no-existe`).then(
      () => true,
      () => false, // aún no escucha
    );
    if (up) return;
    if (Date.now() > deadline) throw new Error(`el servidor no arrancó a tiempo:
${output.slice(-TAIL)}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    return waitReady();
  };
  await waitReady();
  return { origin, stop: () => void child.kill(), log: () => output };
}

/** GET con la ruta tal cual (sin normalizar `.` ni `..`), como `curl --path-as-is`. */
export function rawGet(origin: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { hostname, port } = new URL(origin);
  return new Promise((ok, fail) => {
    const req = httpRequest({ host: hostname, port: Number(port), path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once('error', fail);
    req.end();
  });
}

const summary = (over: Partial<Summary> = {}): Summary => ({
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'stub-relacionado',
  sku: 'ST-REL',
  name: 'Relacionado Uno',
  category: { slug: 'stub-clasica', name: 'Clásica (stub)' },
  price: pen(REL_PRICE),
  original_price: null,
  discount_amount: null,
  movement: { code: 'automatic', label: 'Automático' },
  case_material: { code: 'steel', label: 'Acero' },
  case_diameter_mm: REL_DIAMETER,
  water_resistance_m: REL_WATER,
  main_image: { id: 'rel-1', url: '', alt: 'Relacionado, vista frontal' },
  availability: { status: 'in_stock', lead_time_days: null },
  ...over,
});

/** Producto completo del stub con `n` imágenes distintas (la primera es `main_image`). */
export function product(stub: Stub, slug: string, over: Partial<Detail> = {}, imageCount = 1): Detail {
  const images: Img[] = Array.from({ length: imageCount }, (_, i) => ({
    id: `${slug}-img-${i + 1}`,
    url: stub.imageUrl(i + 1),
    alt: `${slug}, vista ${i + 1}`,
  }));
  const main = images[0] ?? { id: `${slug}-main`, url: stub.imageUrl(1), alt: `${slug}, principal` };
  return {
    ...summary({ slug, id: '33333333-3333-4333-8333-333333333333', sku: 'ST-0001', name: 'Reloj de Prueba Aurora', main_image: main }),
    description: 'Un reloj ficticio para las pruebas.\nSegunda línea de la descripción.',
    specs: [
      { label: 'Calibre', value: 'ST-100' },
      { label: 'Cristal', value: 'Zafiro' },
    ],
    images,
    related: [
      summary({ slug: 'stub-rel-a', name: 'Relacionado Uno', main_image: { ...main, id: 'rel-a', alt: 'Relacionado Uno' } }),
      summary({ slug: 'stub-rel-b', name: 'Relacionado Dos', main_image: { ...main, id: 'rel-b', alt: 'Relacionado Dos' } }),
    ],
    ...over,
  };
}
