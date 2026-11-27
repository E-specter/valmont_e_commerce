import { afterEach, describe, expect, test, vi } from 'vitest';
import { isAdult, limaToday, validateRegister } from '../../src/lib/server/register';
import { ADULT_BIRTH, FAKE_PHRASE, ISO_DATE, MALFORMED_DATES, OTHER_PHRASE, addDays, limaOf, shiftYears, validInput, type RegisterInput } from '../helpers/t128';

// T-128 + T-131 · `validateRegister`, `isAdult` y `limaToday` (D-045; identity SPEC §13 R6, R7, R7b, R8).
// Con `today` inyectado: nada depende del reloj de la máquina.
const TODAY = '2026-11-27';
const NAME_MAX = 120;
const EMAIL_MAX = 320;
const PASSWORD_MIN = 6;
const HUGE = 10_000;
const ADULT_AGE = 18;
const MAX_AGE = 120;
const ONE_DAY = 1;
const NONE = 0;
const NOTHING = '';
const FIELDS = ['full_name', 'email', 'password', 'password_confirm', 'accept_terms', 'birth_date'] as const;
type Field = (typeof FIELDS)[number];
const NUMERIC_DATE = 19_900_517;
const SWEEP_HOURS = 120;
const MS_HOUR = 3_600_000;
// Acepta texto con `17` como palabra ("tienes 17 años"); rechaza "117" (https://regex101.com/?regex=%5Cb17%5Cb).
const AGE_SEVENTEEN = /\b17\b/;
// Acepta texto con `18` ("Debes tener 18 años"); rechaza "Fecha inválida" (https://regex101.com/?regex=18).
const MENTIONS_EIGHTEEN = /18/;
// Acepta restos de fallo ("undefined", "Error: x", "a.ts:3"); rechaza "Revisa la fecha" (https://regex101.com/?regex=undefined%7CError%3A).
const INTERNAL_TRACE = /undefined|\[object|Error:|\.ts:/;
const HOURS_ODD = 'Pacific/Auckland';
const HOURS_WEST = 'America/Los_Angeles';

const run = (over: Partial<RegisterInput> = {}, today: string = TODAY) => validateRegister(validInput(over), today);
/** Campos con error (solo los del formulario; ignora claves de resumen como `form`). */
const failing = (r: ReturnType<typeof run>): Field[] => (r.ok ? [] : FIELDS.filter((f) => r.errors[f]));
const message = (r: ReturnType<typeof run>, field: Field): string => (r.ok ? '' : (r.errors[field] ?? ''));

afterEach(() => {
  vi.useRealTimers();
});

describe('validateRegister · entrada válida', () => {
  test('todo correcto → { ok: true }', () => {
    expect(run()).toEqual({ ok: true });
  });

  test('sin `today` usa el reloj de Lima: un adulto de 1990 sigue siendo válido', () => {
    expect(validateRegister(validInput())).toEqual({ ok: true });
  });

  test('nombre con tildes, eñe y apóstrofo', () => {
    expect(run({ full_name: "José Núñez O'Brien" })).toEqual({ ok: true });
  });
});

describe('validateRegister · nombre completo (1–120)', () => {
  test.each([
    ['vacío', NOTHING],
    ['solo espacios', '     '],
    ['solo tabuladores y saltos', '\t \n'],
  ])('%s → error en full_name', (_n, full_name) => {
    expect(failing(run({ full_name }))).toEqual(['full_name']);
  });

  test('1 carácter es válido', () => {
    expect(run({ full_name: 'A' })).toEqual({ ok: true });
  });

  test('120 caracteres es válido; 121 no', () => {
    expect(run({ full_name: 'a'.repeat(NAME_MAX) })).toEqual({ ok: true });
    expect(failing(run({ full_name: 'a'.repeat(NAME_MAX + ONE_DAY) }))).toEqual(['full_name']);
  });

  test('un nombre enorme no revienta', () => {
    expect(failing(run({ full_name: 'a'.repeat(HUGE) }))).toEqual(['full_name']);
  });
});

describe('validateRegister · correo', () => {
  test.each([
    ['vacío', NOTHING],
    ['sin arroba', 'ana.perez'],
    ['sin dominio', 'ana@'],
    ['sin usuario', '@example.com'],
    ['sin punto en el dominio', 'ana@example'],
    ['con espacios', 'ana perez@example.com'],
    ['doble arroba', 'ana@@example.com'],
  ])('%s → error en email', (_n, email) => {
    expect(failing(run({ email }))).toEqual(['email']);
  });

  test('más de 320 caracteres → error en email', () => {
    const email = `${'a'.repeat(EMAIL_MAX)}@example.com`;
    expect(failing(run({ email }))).toEqual(['email']);
  });
});

describe('validateRegister · contraseña (mínimo 6, repetición idéntica)', () => {
  test('5 caracteres → error en password; 6 → válido', () => {
    const five = 'a'.repeat(PASSWORD_MIN - ONE_DAY);
    const six = 'a'.repeat(PASSWORD_MIN);
    expect(failing(run({ password: five, password_confirm: five }))).toContain('password');
    expect(run({ password: six, password_confirm: six })).toEqual({ ok: true });
  });

  test('vacía (y su repetición vacía) → error en password', () => {
    expect(failing(run({ password: NOTHING, password_confirm: NOTHING }))).toContain('password');
  });

  test('una contraseña enorme se rechaza sin lanzar', () => {
    const huge = 'p'.repeat(HUGE);
    expect(failing(run({ password: huge, password_confirm: huge }))).toContain('password');
  });

  test.each([
    ['un carácter distinto', `${FAKE_PHRASE}x`],
    ['mayúsculas distintas', FAKE_PHRASE.toUpperCase()],
    ['un espacio al final', `${FAKE_PHRASE} `],
    ['otra contraseña', OTHER_PHRASE],
    ['repetición vacía', NOTHING],
  ])('repetición con %s → error solo en password_confirm', (_n, password_confirm) => {
    expect(failing(run({ password_confirm }))).toEqual(['password_confirm']);
  });

  test('los espacios cuentan: no se recortan antes de comparar', () => {
    const spaced = `  ${FAKE_PHRASE}  `;
    expect(run({ password: spaced, password_confirm: spaced })).toEqual({ ok: true });
  });

  test('los mensajes de error nunca repiten la contraseña', () => {
    const r = run({ password: 'abc', password_confirm: OTHER_PHRASE });
    expect(JSON.stringify(r)).not.toContain(OTHER_PHRASE);
    expect(JSON.stringify(r)).not.toContain('abc"');
  });
});

describe('validateRegister · casilla de términos', () => {
  test('sin marcar → error solo en accept_terms', () => {
    expect(failing(run({ accept_terms: false }))).toEqual(['accept_terms']);
  });

  test('un valor no booleano (undefined) cuenta como sin marcar y no lanza', () => {
    expect(failing(run({ accept_terms: undefined as unknown as boolean }))).toEqual(['accept_terms']);
  });
});

describe('validateRegister · fecha de nacimiento: formato (R6) y obligatoriedad', () => {
  test.each(MALFORMED_DATES)('%s (%j) → error en birth_date', (_n, birth_date) => {
    expect(failing(run({ birth_date }))).toEqual(['birth_date']);
  });

  test('la fecha es obligatoria: undefined y null no lanzan y dan error', () => {
    expect(failing(run({ birth_date: undefined as unknown as string }))).toEqual(['birth_date']);
    expect(failing(run({ birth_date: null as unknown as string }))).toEqual(['birth_date']);
  });

  test('un número no es una fecha', () => {
    expect(failing(run({ birth_date: NUMERIC_DATE as unknown as string }))).toEqual(['birth_date']);
  });

  test('un 29 de febrero real (año bisiesto) es una fecha válida', () => {
    expect(run({ birth_date: '2004-02-29' })).toEqual({ ok: true });
    expect(run({ birth_date: '2000-02-29' })).toEqual({ ok: true });
  });

  test('el mensaje nunca repite el valor recibido (dato personal, RNF10)', () => {
    const hostile = '17/05/1990';
    const r = run({ birth_date: hostile });
    expect(JSON.stringify(r)).not.toContain(hostile);
  });
});

describe('validateRegister · fecha de nacimiento: rango (R7) y mayoría de edad (R7b, R8)', () => {
  test('mañana (fecha futura) → error; el mismo día → error (un recién nacido es menor)', () => {
    expect(failing(run({ birth_date: addDays(TODAY, ONE_DAY) }))).toEqual(['birth_date']);
    expect(failing(run({ birth_date: TODAY }))).toEqual(['birth_date']);
  });

  test('un año futuro lejano → error', () => {
    expect(failing(run({ birth_date: '2999-01-01' }))).toEqual(['birth_date']);
  });

  test('menor de 18 → error en birth_date con el aviso de los 18 años', () => {
    const r = run({ birth_date: shiftYears(TODAY, -(ADULT_AGE - ONE_DAY)) });
    expect(failing(r)).toEqual(['birth_date']);
    expect(message(r, 'birth_date')).toMatch(MENTIONS_EIGHTEEN);
  });

  test('frontera exacta: 18 años cumplidos HOY (en Lima) → válido', () => {
    expect(run({ birth_date: shiftYears(TODAY, -ADULT_AGE) }, TODAY)).toEqual({ ok: true });
  });

  test('frontera exacta: cumple 18 MAÑANA → error; ayer los cumplió → válido', () => {
    expect(failing(run({ birth_date: shiftYears(addDays(TODAY, ONE_DAY), -ADULT_AGE) }, TODAY))).toEqual(['birth_date']);
    expect(run({ birth_date: shiftYears(addDays(TODAY, -ONE_DAY), -ADULT_AGE) }, TODAY)).toEqual({ ok: true });
  });

  test('la frontera sigue la fecha inyectada: el mismo nacimiento pasa de menor a adulto al cambiar `today`', () => {
    const birth_date = '2008-11-28';
    expect(failing(run({ birth_date }, '2026-11-27'))).toEqual(['birth_date']);
    expect(run({ birth_date }, '2026-11-28')).toEqual({ ok: true });
  });

  test('cambio de año: nacido el 31-12-2008 es menor el 30-12-2026 y adulto el 31-12-2026', () => {
    expect(failing(run({ birth_date: '2008-12-31' }, '2026-12-30'))).toEqual(['birth_date']);
    expect(run({ birth_date: '2008-12-31' }, '2026-12-31')).toEqual({ ok: true });
  });

  test('29 de febrero (R8): nacido el 29-02-2008 es menor el 28-02-2026 y adulto el 01-03-2026', () => {
    expect(failing(run({ birth_date: '2008-02-29' }, '2026-02-28'))).toEqual(['birth_date']);
    expect(run({ birth_date: '2008-02-29' }, '2026-03-01')).toEqual({ ok: true });
  });

  test('29 de febrero en año bisiesto: el 29-02-2028 cumple 20 (adulto) y el 28-02-2028 también lo es', () => {
    expect(run({ birth_date: '2008-02-29' }, '2028-02-29')).toEqual({ ok: true });
    expect(run({ birth_date: '2008-02-29' }, '2028-02-28')).toEqual({ ok: true });
  });

  test('exactamente 120 años cumplidos hoy → válido; 121 → error', () => {
    expect(run({ birth_date: shiftYears(TODAY, -MAX_AGE) })).toEqual({ ok: true });
    expect(failing(run({ birth_date: shiftYears(TODAY, -(MAX_AGE + ONE_DAY)) }))).toEqual(['birth_date']);
  });

  test('120 años y 364 días (aún no cumple 121) → válido; el día que cumple 121 → error', () => {
    expect(run({ birth_date: addDays(shiftYears(TODAY, -(MAX_AGE + ONE_DAY)), ONE_DAY) })).toEqual({ ok: true });
    expect(failing(run({ birth_date: shiftYears(TODAY, -(MAX_AGE + ONE_DAY)) }))).toEqual(['birth_date']);
  });

  test('antes de 1900 → error', () => {
    expect(failing(run({ birth_date: '1899-12-31' }))).toEqual(['birth_date']);
    expect(failing(run({ birth_date: '0001-01-01' }))).toEqual(['birth_date']);
  });

  test('el mensaje de menor de edad no revela la edad ni la fecha', () => {
    const birth_date = shiftYears(TODAY, -(ADULT_AGE - ONE_DAY));
    const msg = message(run({ birth_date }), 'birth_date');
    expect(msg).not.toContain(birth_date);
    expect(msg).not.toMatch(AGE_SEVENTEEN);
  });
});

describe('validateRegister · varios errores a la vez', () => {
  test('todo mal → un error por campo, sin lanzar', () => {
    const r = validateRegister(
      { full_name: NOTHING, email: 'x', password: 'a', password_confirm: 'b', accept_terms: false, birth_date: NOTHING },
      TODAY,
    );
    expect(failing(r)).toEqual([...FIELDS]);
  });

  test('los errores son texto no vacío en español (sin trazas ni códigos internos)', () => {
    const r = validateRegister({ full_name: NOTHING, email: 'x', password: 'a', password_confirm: 'b', accept_terms: false, birth_date: NOTHING }, TODAY);
    if (r.ok) throw new Error('debía fallar');
    FIELDS.forEach((f) => {
      expect(typeof r.errors[f]).toBe('string');
      expect(r.errors[f].trim().length).toBeGreaterThan(NONE);
      expect(r.errors[f]).not.toMatch(INTERNAL_TRACE);
    });
  });

  test('la validación no muta la entrada', () => {
    const input = validInput({ birth_date: 'x' });
    const copy = { ...input };
    validateRegister(input, TODAY);
    expect(input).toEqual(copy);
  });
});

describe('isAdult(birthDate, today)', () => {
  test.each([
    ['cumple 18 hoy', '2008-11-27', '2026-11-27', true],
    ['cumplió 18 ayer', '2008-11-26', '2026-11-27', true],
    ['cumple 18 mañana', '2008-11-28', '2026-11-27', false],
    ['cumple 18 el mes siguiente', '2008-12-01', '2026-11-27', false],
    ['cumplió 18 el mes pasado', '2008-10-31', '2026-11-27', true],
    ['17 años (primer día del año)', '2009-01-01', '2026-11-27', false],
    ['17 años casi 18', '2008-11-28', '2026-11-27', false],
    ['adulto de 36', '1990-05-17', '2026-11-27', true],
    ['nació hoy', '2026-11-27', '2026-11-27', false],
    ['fecha futura', '2026-11-28', '2026-11-27', false],
    ['último día del año (víspera)', '2008-12-31', '2026-12-30', false],
    ['último día del año (el día)', '2008-12-31', '2026-12-31', true],
    ['primer día del año (el día)', '2008-01-01', '2026-01-01', true],
    ['primer día del año (víspera)', '2008-01-01', '2025-12-31', false],
    ['29-feb-2008 el 27-feb-2026', '2008-02-29', '2026-02-27', false],
    ['29-feb-2008 el 28-feb-2026', '2008-02-29', '2026-02-28', false],
    ['29-feb-2008 el 01-mar-2026', '2008-02-29', '2026-03-01', true],
    ['29-feb-2008 el 29-feb-2028 (bisiesto)', '2008-02-29', '2028-02-29', true],
    ['29-feb-2004 el 28-feb-2022', '2004-02-29', '2022-02-28', false],
    ['29-feb-2004 el 01-mar-2022', '2004-02-29', '2022-03-01', true],
    ['29-feb-2004 el 28-feb-2023 (19 años)', '2004-02-29', '2023-02-28', true],
    ['muy anciano (isAdult no valida el máximo)', '1906-01-01', '2026-11-27', true],
  ])('%s: %s con hoy %s → %s', (_n, birth, today, expected) => {
    expect(isAdult(birth, today)).toBe(expected);
  });

  test('es exacta en la frontera de los 18 para cualquier año', () => {
    ['2026-11-27', '2027-02-28', '2028-02-29', '2030-12-31', '2100-03-01'].forEach((today) => {
      expect(isAdult(shiftYears(today, -ADULT_AGE), today), `18 hoy ${today}`).toBe(true);
      expect(isAdult(shiftYears(addDays(today, ONE_DAY), -ADULT_AGE), today), `18 mañana ${today}`).toBe(false);
    });
  });
});

describe('limaToday(now?) · fecha de Lima (UTC−5 fijo, sin horario de verano)', () => {
  test.each([
    ['04:59:59Z sigue siendo el día anterior en Lima', '2026-11-28T04:59:59Z', '2026-11-27'],
    ['05:00:00Z ya es el día siguiente en Lima', '2026-11-28T05:00:00Z', '2026-11-28'],
    ['medianoche UTC todavía es el día anterior', '2026-11-28T00:00:00Z', '2026-11-27'],
    ['mediodía UTC', '2026-11-27T12:00:00Z', '2026-11-27'],
    ['fin de año: 04:59:59Z del 1 de enero', '2027-01-01T04:59:59Z', '2026-12-31'],
    ['fin de año: 05:00:00Z del 1 de enero', '2027-01-01T05:00:00Z', '2027-01-01'],
    ['29 de febrero: 04:59:59Z del 1 de marzo', '2028-03-01T04:59:59Z', '2028-02-29'],
    ['29 de febrero: 05:00:00Z del 1 de marzo', '2028-03-01T05:00:00Z', '2028-03-01'],
    ['milisegundo antes del corte', '2026-11-28T04:59:59.999Z', '2026-11-27'],
  ])('%s', (_n, utc, expected) => {
    expect(limaToday(new Date(utc))).toBe(expected);
  });

  test('devuelve siempre YYYY-MM-DD', () => {
    expect(limaToday(new Date('2026-01-05T10:00:00Z'))).toMatch(ISO_DATE);
    expect(limaToday()).toMatch(ISO_DATE);
  });

  test('sin argumento usa el reloj actual', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-06-15T04:59:59Z'));
    expect(limaToday()).toBe('2030-06-14');
    vi.setSystemTime(new Date('2030-06-15T05:00:00Z'));
    expect(limaToday()).toBe('2030-06-15');
  });

  test('no depende de la zona horaria de la máquina (Auckland y Los Ángeles dan lo mismo)', () => {
    const before = process.env.TZ;
    try {
      [HOURS_ODD, HOURS_WEST, 'UTC'].forEach((tz) => {
        process.env.TZ = tz;
        expect(limaToday(new Date('2026-11-28T04:59:59Z')), tz).toBe('2026-11-27');
        expect(limaToday(new Date('2026-11-28T05:00:00Z')), tz).toBe('2026-11-28');
      });
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  test('coincide con un cálculo independiente en una barrido de horas', () => {
    const start = Date.parse('2026-02-27T00:00:00Z');
    Array.from({ length: SWEEP_HOURS }, (_v, i) => new Date(start + i * MS_HOUR)).forEach((now) => {
      expect(limaToday(now)).toBe(limaOf(now));
    });
  });

  test('en la frontera de Lima, el mismo nacimiento pasa de menor a adulto (limaToday + isAdult)', () => {
    const birth = '2008-11-28';
    expect(isAdult(birth, limaToday(new Date('2026-11-28T04:59:59Z')))).toBe(false);
    expect(isAdult(birth, limaToday(new Date('2026-11-28T05:00:00Z')))).toBe(true);
  });
});

describe('contrato de la fecha de ejemplo del propio helper', () => {
  test('ADULT_BIRTH es un adulto hoy y siempre (1990)', () => {
    expect(isAdult(ADULT_BIRTH, TODAY)).toBe(true);
  });
});
