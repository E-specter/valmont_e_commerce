// Ayudantes de T-126: backend falso por HTTP real, contexto de Astro y cookies falsas. Sin dependencias del entorno.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const ORIGIN = 'http://localhost:4321';
export const BEARER_VALUE = 'bearer-value-for-tests-0001';
export const SESSION = { userId: 'user-0001', email: 'cliente@example.com', accessToken: BEARER_VALUE, expiresAt: 4102444800 };

export type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string };
export type Reply = { status?: number; headers?: Record<string, string | string[]>; body?: string; delayMs?: number };

/** Servidor HTTP real que hace de backend (y de "destino hostil" en las pruebas de redirección). */
export class FakeServer {
  seen: Seen[] = [];
  reply: Reply | ((req: Seen) => Reply) = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  private server: Server;
  port = 0;

  constructor() {
    this.server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      this.seen.push(seen);
      const r = typeof this.reply === 'function' ? this.reply(seen) : this.reply;
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      res.writeHead(r.status ?? 200, r.headers ?? {});
      res.end(r.body ?? '');
    });
  }
  async start(): Promise<this> {
    await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  reset(): void {
    this.seen = [];
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }
}

export type CookieOp = { op: 'set' | 'delete'; name: string; value?: string; options?: Record<string, unknown> };

/** AstroCookies mínimo: registra las operaciones y expone `headers()` como los Set-Cookie pendientes. */
export function fakeCookies() {
  const ops: CookieOp[] = [];
  return {
    ops,
    set: (name: string, value: string, options?: Record<string, unknown>) => void ops.push({ op: 'set', name, value, options }),
    delete: (name: string, options?: Record<string, unknown>) => void ops.push({ op: 'delete', name, options }),
    headers: () => ops.map((o) => `${o.name}=${o.value ?? ''}`)[Symbol.iterator](),
    deleted: () => ops.filter((o) => o.op === 'delete').map((o) => o.name).sort(),
  };
}
