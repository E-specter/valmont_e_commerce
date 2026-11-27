import { describe, expect, test } from 'vitest';
import { formatDate, formatDateOnly, formatMoney } from '../../src/lib/format';

// T-118 · lib/format.ts (STATUS "T-118 › Firmas públicas", 3.4; D-015, D-037, D-041 P-3, H-26).
// Los céntimos llegan del servidor: formatMoney solo presenta, nunca calcula ni redondea (RN-09).
// Los importes de las tablas son cadenas de céntimos (`'8450000'`) para no esparcir números sueltos.

const PEN = { style: 'currency', currency: 'PEN' } as const;
const nf = (digits: number): Intl.NumberFormat => new Intl.NumberFormat('es-PE', { ...PEN, minimumFractionDigits: digits, maximumFractionDigits: digits });
const NO_DECIMALS = 0;
const TWO_DECIMALS = 2;
const CENTS_PER_SOL = 100;
const CENTS_PER_SOL_BIG = BigInt(CENTS_PER_SOL);
const ZERO_BIG = BigInt(0);
const SAMPLE_SOL = 1;
const SWEEP_LENGTH = 200;
const INT31 = 2147483648;
const INT32 = 4294967296;
const INT40 = 1099511627776;
const INT50 = 1125899906842624;
const GROUP = 3;
const OFFSET_SMALL = 55;
const OFFSET_TINY = 7;
const SIGN_TEST = -500;

/** El espacio entre "S/" y la cifra es el que emite Intl (U+00A0): se compara contra Intl, no contra un literal. */
const GAP = nf(NO_DECIMALS).formatToParts(SAMPLE_SOL).find((p) => p.type === 'literal')?.value ?? ' ';
const money = (amount: number): string => formatMoney({ amount, currency: 'PEN' });
const cents = (s: string): number => Number(s);

/** Los huecos de Unicode que emite Intl (U+00A0, U+202F) pasan a espacios normales para comparar con literales. */
const plain = (s: string): string => s.replaceAll(' ', ' ').replaceAll(' ', ' ');
const decimalsOf = (s: string): number => (s.includes('.') ? s.length - s.lastIndexOf('.') - 1 : 0);
const hasMinus = (s: string): boolean => s.includes('-') || s.includes('−');
const hasClock = (s: string): boolean => s.includes(':');
const hasClockOrMeridiem = (s: string): boolean => hasClock(s) || s.includes('a. m.') || s.includes('p. m.');
/** Agrupa de tres en tres desde la derecha: "1234567" → "1,234,567". */
const group = (digits: string): string =>
  [...digits].reverse().reduce((acc, d, i) => (i > 0 && i % GROUP === 0 ? `${d},${acc}` : `${d}${acc}`), '');

/** Referencia independiente en aritmética entera (BigInt): "S/ 1,250" o "S/ 1,250.05", con las reglas de P-3. */
function reference(amount: number): string {
  const abs = BigInt(Math.abs(amount));
  const units = group((abs / CENTS_PER_SOL_BIG).toString());
  const frac = abs % CENTS_PER_SOL_BIG;
  const body = frac === ZERO_BIG ? units : `${units}.${frac.toString().padStart(TWO_DECIMALS, '0')}`;
  return `${amount < 0 ? '-' : ''}S/${GAP}${body}`;
}

describe('formatMoney · P-3: sin ".00" en importes enteros, dos decimales si no', () => {
  test.each([
    ['8450000', 'S/ 84,500'],
    ['1062550', 'S/ 10,625.50'],
    ['5', 'S/ 0.05'],
    ['0', 'S/ 0'],
    ['1', 'S/ 0.01'],
    ['10', 'S/ 0.10'],
    ['99', 'S/ 0.99'],
    ['100', 'S/ 1'],
    ['101', 'S/ 1.01'],
    ['125000', 'S/ 1,250'],
    ['100000', 'S/ 1,000'],
    ['999999', 'S/ 9,999.99'],
    ['1250010', 'S/ 12,500.10'],
    ['100000000', 'S/ 1,000,000'],
  ])('%s céntimos → "%s"', (amount, expected) => {
    expect(plain(money(cents(amount)))).toBe(expected);
  });

  test('el separador entre "S/" y la cifra es el que emite Intl para es-PE', () => {
    expect(money(cents('8450000'))).toBe(`S/${GAP}84,500`);
    expect(money(cents('5'))).toBe(`S/${GAP}0.05`);
  });

  test('coincide con Intl.NumberFormat("es-PE", PEN): 0 decimales si es entero, 2 si no', () => {
    ['0', '1', '5', '99', '100', '150', '100000', '123456', '8450000', '1062550'].map(cents).forEach((amount) => {
      const digits = amount % CENTS_PER_SOL === 0 ? NO_DECIMALS : TWO_DECIMALS;
      expect(money(amount), `${amount}`).toBe(nf(digits).format(amount / CENTS_PER_SOL));
    });
  });

  test('nunca muestra ".00" (importe entero) ni un solo decimal (".5")', () => {
    ['0', '100', '200', '8450000', '214748364800'].map(cents).forEach((amount) => expect(decimalsOf(money(amount)), `${amount}`).toBe(NO_DECIMALS));
    ['1', '10', '50', '150', '1062550'].map(cents).forEach((amount) => expect(decimalsOf(money(amount)), `${amount}`).toBe(TWO_DECIMALS));
  });
});

describe('formatMoney · bordes y exactitud', () => {
  test('agrupa de tres en tres incluso desde 4 cifras ("S/ 1,000", no "S/ 1000")', () => {
    expect(plain(money(cents('100000')))).toBe('S/ 1,000');
    expect(plain(money(cents('123456')))).toBe('S/ 1,234.56');
  });

  test.each([
    [INT31 * CENTS_PER_SOL, 'S/ 2,147,483,648'],
    [INT31 * CENTS_PER_SOL + SAMPLE_SOL, 'S/ 2,147,483,648.01'],
    [INT31, 'S/ 21,474,836.48'],
    [INT31 + SAMPLE_SOL, 'S/ 21,474,836.49'],
    [INT32 + OFFSET_TINY, 'S/ 42,949,673.03'],
    [INT50 + SAMPLE_SOL, 'S/ 11,258,999,068,426.25'],
    [Number.MAX_SAFE_INTEGER, 'S/ 90,071,992,547,409.91'],
  ])('importes por encima de 2^31 céntimos: %i → "%s"', (amount, expected) => {
    expect(plain(money(amount))).toBe(expected);
  });

  test('no redondea por su cuenta: los 0..199 céntimos y varios importes coinciden con la referencia entera', () => {
    const sweep = Array.from({ length: SWEEP_LENGTH }, (_, i) => i);
    const extras = ['123457', '999901', '1000099', '7777777'].map(cents);
    const amounts = [...sweep, ...extras, INT31 + OFFSET_SMALL, INT40 + OFFSET_TINY];
    const wrong = amounts.filter((a) => money(a) !== reference(a)).map((a) => `${a}: ${money(a)} ≠ ${reference(a)}`);
    expect(wrong).toEqual([]);
  });

  test('un céntimo no se pierde ni se sube: 1 → 0.01, 99 → 0.99, 8450001 → 84,500.01, 8449999 → 84,499.99', () => {
    expect(plain(money(cents('1')))).toBe('S/ 0.01');
    expect(plain(money(cents('99')))).toBe('S/ 0.99');
    expect(plain(money(cents('8450001')))).toBe('S/ 84,500.01');
    expect(plain(money(cents('8449999')))).toBe('S/ 84,499.99');
  });

  test('es pura: no muta la entrada y devuelve lo mismo cada vez', () => {
    const original = { amount: cents('1062550'), currency: 'PEN' as const };
    const input = Object.freeze({ ...original });
    const first = formatMoney(input);
    expect(formatMoney(input)).toBe(first);
    expect(input).toEqual(original);
  });

  test('importes negativos (no los define el paquete): conservan el signo y la cifra, sin NaN', () => {
    const out = plain(money(SIGN_TEST));
    expect(out).not.toContain('NaN');
    expect(hasMinus(out)).toBe(true);
    expect(out).toContain('5');
  });
});

describe('formatDate · UTC → America/Lima, es-PE (H-26)', () => {
  test.each([
    ['2026-08-15T20:04:00Z', '15 de agosto de 2026'],
    ['2026-08-16T03:00:00Z', '15 de agosto de 2026'], // 22:00 en Lima: sigue siendo el día 15
    ['2026-08-16T04:59:59Z', '15 de agosto de 2026'], // 23:59:59 en Lima
    ['2026-08-16T05:00:00Z', '16 de agosto de 2026'], // 00:00 en Lima
    ['2027-01-01T04:59:00Z', '31 de diciembre de 2026'], // el borde de año también cruza
    ['2026-03-01T00:00:00Z', '28 de febrero de 2026'],
    ['2026-12-10T12:00:00Z', '10 de diciembre de 2026'],
    ['2026-01-05T15:00:00Z', '5 de enero de 2026'], // día sin cero a la izquierda
  ])('date: %s → "%s"', (iso, expected) => {
    expect(plain(formatDate(iso, 'date'))).toBe(expected);
  });

  test('un instante con desplazamiento explícito se convierte a la misma hora de Lima', () => {
    expect(plain(formatDate('2026-08-16T05:00:00+02:00', 'date'))).toBe('15 de agosto de 2026'); // = 03:00Z
  });

  test('datetime: fecha y hora en Lima, en 12 horas con "p. m." (3:04 p. m.)', () => {
    const out = plain(formatDate('2026-08-15T20:04:00Z', 'datetime'));
    expect(out.startsWith('15 de agosto de 2026')).toBe(true);
    expect(out.endsWith('3:04 p. m.')).toBe(true);
  });

  test('datetime: usa la coma del paquete como separador ("15 de agosto de 2026, 3:04 p. m.")', () => {
    expect(plain(formatDate('2026-08-15T20:04:00Z', 'datetime'))).toBe('15 de agosto de 2026, 3:04 p. m.');
  });

  test.each([
    ['2026-08-16T03:00:00Z', '15 de agosto de 2026', '10:00 p. m.'],
    ['2026-08-16T05:00:00Z', '16 de agosto de 2026', '12:00 a. m.'],
    ['2026-08-15T17:30:00Z', '15 de agosto de 2026', '12:30 p. m.'],
  ])('datetime en el borde de día: %s → %s %s', (iso, day, hour) => {
    const out = plain(formatDate(iso, 'datetime'));
    expect(out.startsWith(day)).toBe(true);
    expect(out.endsWith(hour)).toBe(true);
  });

  test('sin style equivale a "date" (decisión del Leader)', () => {
    expect(formatDate('2026-08-16T03:00:00Z')).toBe(formatDate('2026-08-16T03:00:00Z', 'date'));
    expect(plain(formatDate('2026-08-16T03:00:00Z'))).toBe('15 de agosto de 2026');
  });

  test('date no incluye la hora', () => {
    expect(hasClock(plain(formatDate('2026-08-15T20:04:00Z', 'date')))).toBe(false);
  });
});

describe('formatDateOnly · fecha sin hora (estimated_delivery_on), sin desplazamiento de zona', () => {
  test.each([
    ['2026-12-10', '10 de diciembre de 2026'],
    ['2026-01-01', '1 de enero de 2026'], // un desplazamiento UTC→Lima lo mostraría como 31 de diciembre
    ['2026-03-31', '31 de marzo de 2026'],
    ['2028-02-29', '29 de febrero de 2028'],
    ['2026-08-16', '16 de agosto de 2026'],
  ])('%s → "%s"', (iso, expected) => {
    expect(plain(formatDateOnly(iso))).toBe(expected);
  });

  test('nunca incluye una hora', () => {
    expect(hasClockOrMeridiem(plain(formatDateOnly('2026-12-10')))).toBe(false);
  });
});
