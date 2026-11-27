// Entrada de importes del formulario (H-B6): aritmética entera, sin coma flotante.
// Solo convierte lo escrito; el servidor valida y es el dueño del precio (RN-09).
const CENTS_PER_SOL = 100;
const DECIMALS = 2;

// Soles con punto decimal y hasta 2 decimales, solo dígitos ASCII, hasta 9 enteros.
// Acepta "1250" y "1250.5"; rechaza "1,250", "1250,50", "12.505" y "1e3".
// https://regex101.com/?regex=%5E(%5B0-9%5D%7B1%2C9%7D)(%3F%3A%5C.(%5B0-9%5D%7B1%2C2%7D))%3F%24&testString=1250.5
const SOLES = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/;

/** '1250' · '1250.5' · '1250.50' → céntimos. Sin miles ni coma decimal; ≤ 9 enteros; 0 no es válido. */
export function parseSoles(text: string): { ok: true; cents: number } | { ok: false } {
  const m = SOLES.exec(text);
  if (!m) return { ok: false };
  const cents = parseInt(m[1], 10) * CENTS_PER_SOL + parseInt((m[2] ?? '').padEnd(DECIMALS, '0') || '0', 10);
  return cents > 0 ? { ok: true, cents } : { ok: false };
}

/** 125000 → '1250'; 125050 → '1250.50'. */
export function solesInput(cents: number): string {
  const whole = Math.trunc(cents / CENTS_PER_SOL);
  const frac = cents % CENTS_PER_SOL;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(DECIMALS, '0')}`;
}
