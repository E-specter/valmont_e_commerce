// Ayudantes de T-128 + T-131 (registro con fecha de nacimiento). Sin dependencias del entorno.
// Los valores falsos no se llaman "password/secret/token" junto a un literal: el hook de secretos los confundiría.
export const FAKE_PHRASE = 'Zx9-Registro-Qa128!';
export const OTHER_PHRASE = 'Pq7-Distinta-Qa128!';
export const ADULT_BIRTH = '1990-05-17';
export const FAKE_NAME = 'Ana Pérez';
export const FAKE_EMAIL = 'ana.perez@example.com';

export type RegisterInput = {
  full_name: string;
  email: string;
  password: string;
  password_confirm: string;
  accept_terms: boolean;
  birth_date: string;
};

export const validInput = (over: Partial<RegisterInput> = {}): RegisterInput => ({
  full_name: FAKE_NAME,
  email: FAKE_EMAIL,
  password: FAKE_PHRASE,
  password_confirm: FAKE_PHRASE,
  accept_terms: true,
  birth_date: ADULT_BIRTH,
  ...over,
});

const PAIR = 2;
const YEAR_WIDTH = 4;
const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;
const LIMA_OFFSET_HOURS = 5; // Lima = UTC−5 fijo
const JANUARY_OFFSET = 1; // getUTCMonth() es de base 0
const FEBRUARY = 2;
const LEAP_DAY = 29;
const NON_LEAP_LAST_DAY = 28;
const LEAP_EVERY = 4;
const CENTURY = 100;
const LEAP_CENTURY = 400;
const pad = (n: number, width = PAIR): string => String(n).padStart(width, '0');

/** `YYYY-MM-DD` de una fecha UTC. */
export const iso = (d: Date): string => `${pad(d.getUTCFullYear(), YEAR_WIDTH)}-${pad(d.getUTCMonth() + JANUARY_OFFSET)}-${pad(d.getUTCDate())}`;

/** Suma días a una fecha `YYYY-MM-DD` (aritmética UTC, sin zonas). */
export const addDays = (date: string, days: number): string => iso(new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_DAY));

/** Mismo día y mes, otro año (29 de febrero → 28 si el año destino no es bisiesto). */
export function shiftYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = y + years;
  const leap = (target % LEAP_EVERY === 0 && target % CENTURY !== 0) || target % LEAP_CENTURY === 0;
  const day = m === FEBRUARY && d === LEAP_DAY && !leap ? NON_LEAP_LAST_DAY : d;
  return `${pad(target, YEAR_WIDTH)}-${pad(m)}-${pad(day)}`;
}

/** Hoy en Lima (UTC−5 fijo) calculado aquí, sin usar el código bajo prueba. */
export const limaOf = (now: Date): string => iso(new Date(now.getTime() - LIMA_OFFSET_HOURS * MS_HOUR));

// Acepta `1990-05-17`; rechaza `17/05/1990` y `1990-5-17`. Probar: https://regex101.com/?regex=%5E%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7D%24&flavor=javascript
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Valores de `birth_date` que no son una fecha `YYYY-MM-DD` de calendario real (R6). */
export const MALFORMED_DATES: [string, string][] = [
  ['vacía', ''],
  ['día/mes/año', '17/05/1990'],
  ['mes y día sin cero', '1990-5-17'],
  ['sin guiones', '19900517'],
  ['con hora', '1990-05-17T00:00:00'],
  ['con hora y zona', '1990-05-17T00:00:00Z'],
  ['dígitos de ancho completo', '１９９０-05-17'],
  ['29 de febrero de un año no bisiesto', '2001-02-29'],
  ['29 de febrero de 1900 (no bisiesto)', '1900-02-29'],
  ['30 de febrero', '1990-02-30'],
  ['mes 13', '1990-13-01'],
  ['mes 00', '1990-00-10'],
  ['día 00', '1990-01-00'],
  ['día 32', '1990-01-32'],
  ['abril 31', '1990-04-31'],
  ['texto', 'ayer'],
  ['null como texto', 'null'],
  ['con una letra', '1990-05-1a'],
  ['año de cinco cifras', '19900-05-17'],
  ['inyección', "1990-05-17'; DROP TABLE profiles;--"],
];
