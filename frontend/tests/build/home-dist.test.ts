import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';

// T-121 · N-4: lo que llega al navegador (dist/client) no contiene la configuración del servidor.
// Se ejecuta sobre el resultado de `npm run build`; sin build previo se omite y el informe lo declara (no sustituye a la puerta de build).
const CLIENT = join(FRONTEND, 'dist', 'client');
const built = existsSync(CLIENT);
const BINARY = ['.woff', '.woff2', '.png', '.webp', '.jpg', '.jpeg', '.ico', '.avif', '.gif'];
const FORBIDDEN = ['API_BASE_URL', '127.0.0.1:8000', 'api/v1', 'SUPABASE_ANON_KEY', 'SUPABASE_URL', ':54321'];
const MIN_FILES = 3;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const textFiles = (): string[] => walk(CLIENT).filter((f) => !BINARY.some((ext) => f.toLowerCase().endsWith(ext)));

describe.skipIf(!built)('dist/client (N-4)', () => {
  test('hay archivos de texto que revisar (la prueba no es vacía)', () => {
    expect(textFiles().length).toBeGreaterThanOrEqual(MIN_FILES);
  });

  FORBIDDEN.forEach((needle) => {
    test(`ningún archivo del cliente contiene "${needle}"`, () => {
      const hits = textFiles().filter((f) => readFileSync(f, 'utf8').includes(needle));
      expect(hits).toEqual([]);
    });
  });

  test('la portada no se prerenderiza: no hay index.html estático con datos de la API', () => {
    expect(existsSync(join(CLIENT, 'index.html'))).toBe(false);
  });
});
