import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND } from '../helpers/css';

// T-148 · resultado de `npm run build`: nada de la API ni del backoffice llega a dist/client (grep de `api/v1`), y la isla image-sort viaja empaquetada.
// Sin build previo se omite y el informe lo declara (no sustituye a la puerta `npm run build`).
const CLIENT = join(FRONTEND, 'dist', 'client');
const built = existsSync(CLIENT);
const NONE = 0;
const TEXT_EXT = ['.js', '.mjs', '.html', '.css', '.json', '.txt', '.map'];

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const textFiles = (): string[] => (built ? walk(CLIENT).filter((f) => TEXT_EXT.some((e) => f.endsWith(e))) : []);

describe.skipIf(!built)('dist/client de T-148', () => {
  test('ningún archivo del cliente nombra la API (`api/v1`): las imágenes se suben por el servidor de Astro, no desde el navegador', () => {
    const offenders = textFiles().filter((f) => readFileSync(f, 'utf8').includes('api/v1'));
    expect(offenders).toEqual([]);
  });

  test('ningún archivo del cliente contiene rutas del backoffice de imágenes ni nombres de campo del backend de administración', () => {
    const words = ['catalog/admin', '/images/order', 'storage_unavailable', 'last_image'];
    const offenders = textFiles().filter((f) => words.some((w) => readFileSync(f, 'utf8').includes(w)));
    expect(offenders).toEqual([]);
  });

  test('la isla image-sort está empaquetada (incluye su anuncio) y no hay referencias a lib/server', () => {
    const js = textFiles().filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    const holders = js.filter((f) => readFileSync(f, 'utf8').includes('Imagen movida a la posición'));
    expect(holders.length).toBeGreaterThan(NONE);
    js.forEach((f) => expect(readFileSync(f, 'utf8'), f).not.toContain('lib/server'));
  });

  test('el cliente no incluye archivos de prueba ni nombres de archivo de usuarios', () => {
    expect(walk(CLIENT).filter((f) => f.includes('QXNAME') || f.includes('qa-t148'))).toEqual([]);
  });
});
