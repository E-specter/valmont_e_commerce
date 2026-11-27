// Validación del formulario de registro (T-128, T-131). Corre en el servidor, antes de llamar a Auth.
const NAME_MAX = 120;
const EMAIL_MAX = 320;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 1024;
export const MAJORITY_AGE = 18;
const MAX_AGE = 120;
const MIN_BIRTH_DATE = '1900-01-01';
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000; // Lima = UTC-5 fijo (SPEC identity §13.3)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MSG_NAME_REQUIRED = 'Ingresa tu nombre completo';
const MSG_NAME_LONG = 'El nombre admite hasta 120 caracteres';
const MSG_EMAIL_REQUIRED = 'Ingresa tu correo';
const MSG_EMAIL_INVALID = 'Ingresa un correo válido';
const MSG_PASSWORD_SHORT = 'La contraseña debe tener al menos 6 caracteres';
const MSG_PASSWORD_LONG = 'La contraseña es demasiado larga';
const MSG_PASSWORD_MISMATCH = 'Las contraseñas no coinciden';
const MSG_TERMS = 'Debes aceptar los términos y la política de privacidad';
const MSG_BIRTH_REQUIRED = 'Ingresa tu fecha de nacimiento';
const MSG_BIRTH_INVALID = 'Ingresa una fecha válida';
export const MSG_UNDERAGE = 'Debes tener 18 años o más';

export interface RegisterInput {
  full_name: string;
  email: string;
  password: string;
  password_confirm: string;
  accept_terms: boolean;
  birth_date: string;
}

// Fecha de hoy en Lima (YYYY-MM-DD).
export function limaToday(now: Date = new Date()): string {
  return new Date(now.getTime() - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

function parts(date: string): [number, number, number] | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? [y, mo, d] : null;
}

// Años cumplidos; quien nació un 29 de febrero cumple el 1 de marzo en años no bisiestos (SPEC §13.3 R8).
function ageOn(birth: [number, number, number], today: [number, number, number]): number {
  const before = today[1] < birth[1] || (today[1] === birth[1] && today[2] < birth[2]);
  return today[0] - birth[0] - (before ? 1 : 0);
}

export function isAdult(birthDate: string, today: string): boolean {
  const b = parts(birthDate);
  const t = parts(today);
  return b !== null && t !== null && ageOn(b, t) >= MAJORITY_AGE;
}

// Fecha real del calendario con formato YYYY-MM-DD (rechaza 2001-02-29, 1990-13-01, 1990-04-31).
export function isCalendarDate(date: string): boolean {
  return parts(date) !== null;
}

function birthDateError(birthDate: string, today: string): string | undefined {
  if (!birthDate) return MSG_BIRTH_REQUIRED;
  const b = parts(birthDate);
  const t = parts(today);
  if (!b || !t || birthDate > today || birthDate < MIN_BIRTH_DATE || ageOn(b, t) > MAX_AGE) return MSG_BIRTH_INVALID;
  return isAdult(birthDate, today) ? undefined : MSG_UNDERAGE;
}

export function validateRegister(
  input: RegisterInput,
  today: string = limaToday(),
): { ok: true } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = input.full_name.trim();
  if (!name) errors.full_name = MSG_NAME_REQUIRED;
  else if (name.length > NAME_MAX) errors.full_name = MSG_NAME_LONG;
  if (!input.email) errors.email = MSG_EMAIL_REQUIRED;
  else if (input.email.length > EMAIL_MAX || !EMAIL_RE.test(input.email)) errors.email = MSG_EMAIL_INVALID;
  if (input.password.length < PASSWORD_MIN) errors.password = MSG_PASSWORD_SHORT;
  else if (input.password.length > PASSWORD_MAX) errors.password = MSG_PASSWORD_LONG;
  if (input.password_confirm !== input.password) errors.password_confirm = MSG_PASSWORD_MISMATCH;
  if (!input.accept_terms) errors.accept_terms = MSG_TERMS;
  const birth = birthDateError(input.birth_date, today);
  if (birth) errors.birth_date = birth;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true };
}
