import type { Locator, Page } from '@playwright/test';

// T-143 · ayudantes del E2E del muestrario del backoffice.
// Los tokens y el bloque `[data-context="backoffice"]` los declara T-142 (STATUS §10.5, contrato 3.5). T-143 se verifica en su propia
// rama, que puede no traerlos aún: si faltan, se inyectan EXACTAMENTE los valores del contrato; si ya existen, no se toca nada.
// Así la prueba valida los componentes contra el contrato, con o sin T-142 integrado.
const PROBE_PROPERTY = '--color-forest-card';
const CONTRACT_CSS = `
:root {
  --color-forest-card: #002c18;
  --text-secondary-on-dark: #ebd394;
  --bg-surface-raised: var(--color-forest-mid);
  --stroke-control-on-dark: rgb(179 239 178 / 0.5);
  --stroke-soft-on-dark: rgb(179 239 178 / 0.2);
  --size-sidebar: 260px;
  --size-topbar: 72px;
  --size-control-sm: 40px;
  --size-control: 44px;
  --size-th: 44px;
  --size-row: 56px;
  --size-row-lg: 80px;
  --size-pill: 24px;
  --content-max-bo: 1180px;
  --radius-dialog: 12px;
}
[data-context="backoffice"] {
  color-scheme: dark;
  --bg-page: var(--color-forest);
  --bg-surface: var(--color-forest-card);
  --text-primary: var(--color-ivory);
  --text-secondary: var(--text-secondary-on-dark);
  --stroke-default: var(--stroke-on-dark);
  --stroke-soft: var(--stroke-soft-on-dark);
  --stroke-control: var(--stroke-control-on-dark);
  --stroke-strong: var(--color-mint);
  --focus-color: var(--color-yellow);
  --color-red-strong: var(--color-red);
}`;

/** Devuelve true si T-142 ya declara los tokens del contrato (no se inyecta nada). */
export function hasContractTokens(page: Page): Promise<boolean> {
  return page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim() !== '', PROBE_PROPERTY);
}

/** Garantiza los tokens del contrato 3.5 y el bloque de contexto; devuelve si hubo que inyectarlos. */
export async function ensureContractTokens(page: Page): Promise<boolean> {
  if (await hasContractTokens(page)) return false;
  await page.addStyleTag({ content: CONTRACT_CSS });
  return true;
}

/** Quita `data-context` de todo el documento: la misma página se pinta con los valores de la tienda. */
export function leaveBackoffice(page: Page): Promise<void> {
  return page.evaluate(() => document.querySelectorAll('[data-context]').forEach((e) => e.removeAttribute('data-context')));
}

type EdgeKind = 'border' | 'outline';

/**
 * Contraste (WCAG 1.4.11 y 2.4.11, no texto) del borde o del contorno de foco de un elemento contra el fondo efectivo de sus ancestros
 * (el anillo de foco se dibuja fuera del elemento). Devuelve 0 si no hay borde o contorno visible.
 */
export function edgeContrast(loc: Locator, kind: EdgeKind): Promise<number> {
  return loc.evaluate((el, which): number => {
    const K = { r: 0.2126, g: 0.7152, b: 0.0722, knee: 0.03928, lo: 12.92, off: 0.055, gain: 1.055, gamma: 2.4, flare: 0.05, byte: 255 };
    const parse = (c: string): number[] => {
      const inner = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replaceAll('/', ' ').replaceAll(',', ' ');
      const parts = inner.split(' ').filter(Boolean).map((p) => parseFloat(p));
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const cs = getComputedStyle(el);
    const width = parseFloat(which === 'border' ? cs.borderTopWidth : cs.outlineWidth);
    const style = which === 'border' ? cs.borderTopStyle : cs.outlineStyle;
    if (width === 0 || style === 'none') return 0;
    const layers: number[][] = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
    }
    const bg = [...layers].reverse().reduce((acc, l) => acc.map((v, i) => l[i] * l[3] + v * (1 - l[3])), [K.byte, K.byte, K.byte]);
    const raw = parse(which === 'border' ? cs.borderTopColor : cs.outlineColor);
    const fg = [0, 1, 2].map((i) => raw[i] * raw[3] + bg[i] * (1 - raw[3]));
    const lin = (v: number): number => {
      const s = v / K.byte;
      return s <= K.knee ? s / K.lo : ((s + K.off) / K.gain) ** K.gamma;
    };
    const lum = (c: number[]): number => K.r * lin(c[0]) + K.g * lin(c[1]) + K.b * lin(c[2]);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + K.flare) / (lo + K.flare);
  }, kind);
}

/** Atajo: contraste del borde (ver `edgeContrast`). */
export const borderContrast = (loc: Locator): Promise<number> => edgeContrast(loc, 'border');
