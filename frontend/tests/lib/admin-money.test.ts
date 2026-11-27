import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { formatMoney } from '../../src/lib/format';
import { parseSoles, solesInput } from '../../src/lib/admin/money';

// T-144 · lib/admin/money.ts (STATUS ui §10.5 3.8, H-B6): se escribe en soles y viaja en céntimos enteros.
// Aritmética entera, sin coma flotante. Sin miles ni coma decimal; ≤ 9 enteros; 0 no válido.
// Las tablas viven en un JSON (datos) para no esparcir números sueltos.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../helpers/fixtures/t144-money.json');
const data = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  accept: [string, number][];
  reject: string[];
  canonical: [string, string][];
  solesInput: [number, string][];
  roundTrip: number[];
};
const FAIL = { ok: false } as const;
const HUGE_LENGTH = 100_000;
const DIGITS = '0123456789.';
const EOL = '\n';

describe('parseSoles · acepta', () => {
  test.each(data.accept)('%j → %i céntimos', (text, cents) => {
    expect(parseSoles(text)).toEqual({ ok: true, cents });
  });

  test('los céntimos son siempre un entero seguro (nunca 28.999999999999996)', () => {
    data.accept.forEach(([text]) => {
      const r = parseSoles(text);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Number.isSafeInteger(r.cents)).toBe(true);
        expect(r.cents).toBeGreaterThan(0);
      }
    });
  });
});

describe('parseSoles · rechaza', () => {
  test.each(data.reject)('%j → { ok: false }', (text) => {
    expect(parseSoles(text)).toEqual(FAIL);
  });

  test('el resultado inválido no trae céntimos ni mensaje del motor (sin NaN ni Infinity)', () => {
    const r = parseSoles('1e3') as Record<string, unknown>;
    expect(Object.keys(r)).toEqual(['ok']);
  });

  test('una entrada que no es texto no lanza: es inválida', () => {
    const hostile = [undefined, null, {}, []] as unknown as string[];
    hostile.forEach((v) => expect(parseSoles(v)).toEqual(FAIL));
  });

  test('una cadena enorme (100 000 dígitos) se rechaza sin colgarse ni lanzar', () => {
    const huge = '9'.repeat(HUGE_LENGTH);
    expect(parseSoles(huge)).toEqual(FAIL);
    expect(parseSoles(`${huge}.99`)).toEqual(FAIL);
  });
});

describe('solesInput', () => {
  test.each(data.solesInput)('%i céntimos → %j', (cents, text) => {
    expect(solesInput(cents)).toBe(text);
  });

  test('solo usa dígitos y, a lo sumo, un punto con dos decimales (sin separador de miles ni símbolo)', () => {
    data.roundTrip.forEach((cents) => {
      const s = solesInput(cents);
      // Acepta '1250' y '1250.50'; rechaza '1,250.50', 'S/ 1250' y '1250.5'. Probador: https://regex101.com/?regex=%5E%5Cd%2B(%5C.%5Cd%7B2%7D)%3F%24&testString=1250.50
      expect(s).toMatch(/^\d+(\.\d{2})?$/);
    });
  });
});

describe('ida y vuelta', () => {
  test.each(data.canonical)('solesInput(parseSoles(%j).cents) → %j (entero o decimal canónico)', (text, canonical) => {
    const r = parseSoles(text);
    expect(r.ok).toBe(true);
    expect(r.ok && solesInput(r.cents)).toBe(canonical);
  });

  test.each(data.roundTrip)('parseSoles(solesInput(%i)) devuelve el mismo importe', (cents) => {
    expect(parseSoles(solesInput(cents))).toEqual({ ok: true, cents });
  });

  test('es idempotente: la forma canónica se vuelve a leer igual', () => {
    data.canonical.forEach(([, canonical]) => {
      const once = parseSoles(canonical);
      expect(once.ok).toBe(true);
      expect(once.ok && solesInput(once.cents)).toBe(canonical);
    });
  });
});

describe('coherencia con formatMoney (D-B6 = B: igual que la tienda)', () => {
  test('las cifras de solesInput son las que muestra formatMoney (sin .00 fijo)', () => {
    data.roundTrip.forEach((amount) => {
      const shown = formatMoney({ amount, currency: 'PEN' });
      // Quita "S/", el espacio y los separadores de miles; deja dígitos y el punto decimal.
      const digits = [...shown].filter((c) => DIGITS.includes(c)).join('');
      expect(digits).toBe(solesInput(amount));
    });
  });
});

describe('fuente: sin coma flotante (RN-09, D-015)', () => {
  // Solo líneas de código: se descartan las de comentario.
  const src = readFileSync(join(HERE, '../../src/lib/admin/money.ts'), 'utf8')
    .split(EOL)
    .filter((l) => !['//', '/*', '*'].some((c) => l.trimStart().startsWith(c)))
    .join(EOL);

  test.each(['parseFloat', 'toFixed', 'Math.round', 'toLocaleString', 'Intl.'])(
    'money.ts no usa %s',
    (banned) => {
      expect(src.includes(banned)).toBe(false);
    },
  );
});
