import { describe, expect, test } from 'vitest';
import { formatDateTimeNumeric } from '../../src/lib/format';

// T-142 · formatDateTimeNumeric (D-B5, AB-7): `dd/mm/aaaa hh:mm`, 24 h, America/Lima (UTC-5 todo el año, sin horario de verano).
const SHAPE = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/; // "27/11/2026 15:04" sí; "27/11/2026 3:04 p. m." no
const MERIDIEM = /[ap]\.?\s?m\./i; // "a. m." y "p. m." (formato de 12 h)
const NO_BREAK_SPACES = /[  ]/;
const SWEEP = 500;
const STEP_MS = 7 * 3_600_000 + 13 * 60_000 + 17_000;
const START = Date.UTC(2026, 0, 1);
const LAST_HOUR = 23;
const HOUR_AT = 11;
const HOUR_END = 13;

describe('formatDateTimeNumeric', () => {
  test.each([
    ['2026-11-27T20:04:00Z', '27/11/2026 15:04'], // ejemplo del contrato
    ['2026-11-28T05:00:00Z', '28/11/2026 00:00'], // medianoche de Lima: 00:00, nunca 24:00 ni 12:00 a. m.
    ['2026-11-28T05:05:00Z', '28/11/2026 00:05'], // 00:05 sin «a. m.»
    ['2026-11-28T04:59:00Z', '27/11/2026 23:59'], // un minuto antes: el día anterior en Lima
    ['2026-11-27T23:59:00Z', '27/11/2026 18:59'], // 24 h: 18, no 6 p. m.
    ['2026-11-27T17:00:00Z', '27/11/2026 12:00'], // mediodía
    ['2026-11-27T18:00:00Z', '27/11/2026 13:00'],
    ['2027-01-01T04:59:00Z', '31/12/2026 23:59'], // cambio de año hacia atrás
    ['2026-01-01T05:00:00Z', '01/01/2026 00:00'], // día y mes con cero a la izquierda
    ['2026-03-05T17:09:00Z', '05/03/2026 12:09'],
    ['2026-07-15T12:00:00Z', '15/07/2026 07:00'], // sin horario de verano en Lima
    ['2026-02-28T23:59:00Z', '28/02/2026 18:59'],
    ['2028-02-29T10:30:00Z', '29/02/2028 05:30'], // bisiesto
    ['2026-11-27T20:04:59.999Z', '27/11/2026 15:04'], // los segundos no se redondean ni se muestran
    ['2026-11-27T15:04:00-05:00', '27/11/2026 15:04'], // con desplazamiento explícito
    ['2026-11-27T20:04:00+00:00', '27/11/2026 15:04'],
    ['2026-11-27T20:04:00.000000Z', '27/11/2026 15:04'], // microsegundos como los emite Postgres
  ])('%s → %s', (iso, expected) => {
    expect(formatDateTimeNumeric(iso)).toBe(expected);
  });

  test('forma estable en un barrido de instantes: sin a. m./p. m., sin espacios no separables, 24 h', () => {
    const outs = Array.from({ length: SWEEP }, (_, i) => formatDateTimeNumeric(new Date(START + i * STEP_MS).toISOString()));
    outs.forEach((o) => {
      expect(o).toMatch(SHAPE);
      expect(o).not.toMatch(MERIDIEM);
      expect(o).not.toMatch(NO_BREAK_SPACES);
    });
    const hours = outs.map((o) => Number(o.slice(HOUR_AT, HOUR_END)));
    expect(Math.max(...hours)).toBeLessThanOrEqual(LAST_HOUR);
    expect(Math.min(...hours)).toBe(0);
  });

  test('dos instantes del mismo día de Lima comparten fecha aunque cambien de día en UTC', () => {
    expect(formatDateTimeNumeric('2026-11-27T04:00:00Z').slice(0, 10)).toBe('26/11/2026');
    expect(formatDateTimeNumeric('2026-11-27T23:00:00Z').slice(0, 10)).toBe('27/11/2026');
    expect(formatDateTimeNumeric('2026-11-28T04:59:59Z').slice(0, 10)).toBe('27/11/2026');
  });
});
