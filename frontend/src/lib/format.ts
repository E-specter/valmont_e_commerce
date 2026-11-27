// Formato de importes y fechas en es-PE (D-041 P-3, D-037). Solo formatea: nunca calcula (RN-09).
import type { Money } from './api/http';

export type { Money };

const TIME_ZONE = 'America/Lima';

const moneyFmt = (fractionDigits: 0 | 2) =>
  new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
const moneyWhole = moneyFmt(0);
const moneyCents = moneyFmt(2);

/** Céntimos enteros → "S/ 84,500" (sin decimales si es entero) o "S/ 10,625.50". Aritmética entera, sin coma flotante. */
export function formatMoney(m: Money): string {
  const abs = BigInt(Math.abs(m.amount));
  const cents = abs % 100n;
  // Intl acepta una cadena decimal y la formatea de forma exacta.
  const decimal = `${m.amount < 0 ? '-' : ''}${abs / 100n}${cents === 0n ? '' : `.${cents.toString().padStart(2, '0')}`}` as `${number}`;
  return (cents === 0n ? moneyWhole : moneyCents).format(decimal);
}

const dateFmt = new Intl.DateTimeFormat('es-PE', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('es-PE', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

/** Instante ISO (UTC) → fecha en hora de Lima: "15 de agosto de 2026" o "15 de agosto de 2026, 3:04 p. m.". */
export function formatDate(iso: string, style: 'date' | 'datetime' = 'date'): string {
  const at = new Date(iso);
  // Intl une fecha y hora con "a las"; el contrato pide coma.
  return style === 'datetime' ? `${dateFmt.format(at)}, ${timeFmt.format(at)}` : dateFmt.format(at);
}

/** Fecha de calendario 'YYYY-MM-DD' → "10 de diciembre de 2026", sin desplazamiento de zona. */
export function formatDateOnly(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}
