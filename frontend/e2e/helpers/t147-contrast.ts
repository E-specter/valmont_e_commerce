import type { Locator } from '@playwright/test';

const WEIGHT_R = 0.2126;
const WEIGHT_G = 0.7152;
const WEIGHT_B = 0.0722;
const KNEE = 0.03928;
const LOW_SLOPE = 12.92;
const OFFSET = 0.055;
const GAIN = 1.055;
const GAMMA = 2.4;
const FLARE = 0.05;
const BYTE = 255;
const BLUE = 2;
const CHANNELS = [0, 1, BLUE];

/**
 * Contraste (WCAG 1.4.3, texto) del color de un elemento contra su fondo efectivo: compone el fondo del propio elemento y el de sus
 * ancestros sobre blanco. Sirve para medir el mismo control en el contexto de la tienda y en el del backoffice.
 */
export function textContrast(loc: Locator): Promise<number> {
  const K = { r: WEIGHT_R, g: WEIGHT_G, b: WEIGHT_B, knee: KNEE, lo: LOW_SLOPE, off: OFFSET, gain: GAIN, gamma: GAMMA, flare: FLARE, byte: BYTE, ch: CHANNELS };
  return loc.evaluate((el, k): number => {
    const parse = (c: string): number[] => {
      const inner = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replaceAll('/', ' ').replaceAll(',', ' ');
      const parts = inner.split(' ').filter(Boolean).map((p) => parseFloat(p));
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const chain = (n: Element | null): Element[] => (n ? [n, ...chain(n.parentElement)] : []);
    const layers = chain(el).map((n) => parse(getComputedStyle(n).backgroundColor)).filter((c) => c[3] > 0);
    const bg = [...layers].reverse().reduce((acc, l) => acc.map((v, i) => l[i] * l[3] + v * (1 - l[3])), [k.byte, k.byte, k.byte]);
    const raw = parse(getComputedStyle(el).color);
    const fg = k.ch.map((i) => raw[i] * raw[3] + bg[i] * (1 - raw[3]));
    const lin = (v: number): number => {
      const s = v / k.byte;
      return s <= k.knee ? s / k.lo : ((s + k.off) / k.gain) ** k.gamma;
    };
    const lum = (c: number[]): number => k.r * lin(c[0]) + k.g * lin(c[1]) + k.b * lin(c[2]);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + k.flare) / (lo + k.flare);
  }, K);
}
