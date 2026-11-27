import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { Money as FromHttp } from '../../src/lib/api/http';
import { formatMoney, type Money as FromFormat } from '../../src/lib/format';
import { FRONTEND, read } from '../helpers/css';

// T-123 · N-1: `Money` se declara una sola vez, en lib/api/http.ts; format.ts lo importa y lo reexporta.
// El comportamiento de formatMoney lo fijan las pruebas de T-118 (tests/lib/format.test.ts), que no se modifican.
const SRC = join(FRONTEND, 'src');
const SAMPLE_CENTS = 1062550;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const sources = walk(SRC).filter((f) => f.endsWith('.ts') || f.endsWith('.astro'));
const EOL = '\n';
const HEADS = ['type Money =', 'export type Money =', 'interface Money ', 'export interface Money '];
/** Una línea que empieza como una declaración de Money (no cuenta "import type { Money }" ni "export type { Money }"). */
const declares = (src: string): boolean => src.split(EOL).some((l) => HEADS.some((h) => l.trim().startsWith(h)));

describe('N-1 · Money declarado una sola vez', () => {
  test('solo lib/api/http.ts declara el tipo Money', () => {
    const declaring = sources
      .filter((f) => declares(readFileSync(f, 'utf8')))
      .map((f) => f.split(sep).join('/').split('/src/')[1]);
    expect(declaring).toEqual(['lib/api/http.ts']);
  });

  test('format.ts no vuelve a declararlo: lo importa de ./api/http y lo reexporta', () => {
    const src = read('src/lib/format.ts');
    expect(declares(src)).toBe(false);
    expect(src.includes("from './api/http'")).toBe(true);
    expect(src.includes('import type { Money }')).toBe(true);
    expect(src.includes('export type { Money }')).toBe(true);
  });

  test('los dos nombres son el mismo tipo y formatMoney lo acepta', () => {
    expectTypeOf<FromFormat>().toEqualTypeOf<FromHttp>();
    const m: FromHttp = { amount: SAMPLE_CENTS, currency: 'PEN' };
    expect(formatMoney(m)).toContain('10');
  });
});
