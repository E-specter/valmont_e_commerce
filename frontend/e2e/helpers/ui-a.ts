import type { Locator, Page } from '@playwright/test';

/** Controles interactivos de la página de muestra (dentro de `main`; la barra de desarrollo de Astro queda fuera). */
export const INTERACTIVE =
  'main a[href], main button, main input:not([type="hidden"]), main select, main textarea, main [role="button"]';

export const TOUCH_TARGET = 44; // BRIEF §7/§11: objetivo táctil mínimo
export const MIN_TEXT_CONTRAST = 4.5; // WCAG 1.4.3
export const MIN_UI_CONTRAST = 3; // WCAG 1.4.11
export const FOCUS_RING_MIN = 2; // BRIEF §7: anillo de 2 px con separación >= 2

/** Ejecuta `fn` sobre cada elemento en orden y devuelve los resultados (sin bucles: cada paso espera al anterior). */
export function sequence<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  return items.reduce<Promise<R[]>>(async (prev, item, i) => [...(await prev), await fn(item, i)], Promise.resolve([]));
}

export const indices = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export async function openPage(page: Page, path: string): Promise<void> {
  const res = await page.goto(path);
  if (res?.status() !== 200) throw new Error(`${path} respondió ${res?.status()}`);
  await page.evaluate(() => document.fonts.ready);
}

export type ElementState = {
  tag: string;
  type: string | null;
  text: string;
  disabled: boolean;
  forced: boolean;
  /** Los controles de casilla se miden y se pasan por encima desde su etiqueta (la casilla propia puede ser un dibujo). */
  hasLabelTarget: boolean;
};

/** Estado de un interactivo; `forced` marca los que el kit de /dev fuerza con clases (hover/foco simulado). */
export function elementState(loc: Locator): Promise<ElementState> {
  return loc.evaluate((el): ElementState => {
    const chain = (n: Element | null): Element[] => (n ? [n, ...chain(n.parentElement)] : []);
    const marks = chain(el)
      .flatMap((n) => [n.className.toString(), ...[...n.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`)])
      .join(' ')
      .toLowerCase();
    const forcedWords = ['force', 'simul', 'is-hover', 'is-focus', 'is-active', 'demo-state'];
    const input = el as HTMLInputElement;
    const isCheck = input.type === 'checkbox' || input.type === 'radio';
    return {
      tag: el.tagName.toLowerCase(),
      type: input.type ?? null,
      text: (el.getAttribute('aria-label') ?? el.textContent ?? '').split('\n').join(' ').trim().slice(0, 40),
      disabled:
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.getAttribute('aria-busy') === 'true',
      // El Wordmark enlazado NO cambia de aspecto (BRIEF §1: no se recolorea): queda exento del hover.
      // Un control ya en estado pulsado (aria-pressed) o en error (aria-invalid) puede mantener su aspecto al pasar el ratón (ambigüedad del paquete).
      forced:
        forcedWords.some((w) => marks.includes(w)) ||
        el.getAttribute('aria-label') === 'Valmont, inicio' ||
        el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-invalid') === 'true',
      hasLabelTarget: isCheck && (input.labels?.length ?? 0) > 0,
    };
  });
}

export type Contrast = { ratio: number; fg: number[]; bg: number[] };

/** Contraste del texto de un elemento contra su fondo efectivo (capas con transparencia compuestas sobre blanco). */
export function textContrast(loc: Locator): Promise<Contrast> {
  return loc.evaluate((el): Contrast => {
    const K = { r: 0.2126, g: 0.7152, b: 0.0722, knee: 0.03928, lo: 12.92, off: 0.055, gain: 1.055, gamma: 2.4, flare: 0.05, byte: 255 };
    const parse = (c: string): number[] => {
      const inner = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replaceAll('/', ' ').replaceAll(',', ' ');
      const parts = inner.split(' ').filter(Boolean);
      const nums = c.startsWith('color(')
        ? parts.slice(1).map((p, i) => (i < 3 ? parseFloat(p) * K.byte : parseFloat(p)))
        : parts.map((p) => parseFloat(p));
      return [nums[0], nums[1], nums[2], nums[3] ?? 1];
    };
    const chain = (n: Element | null): Element[] => (n ? [n, ...chain(n.parentElement)] : []);
    const layers = chain(el).map((n) => parse(getComputedStyle(n).backgroundColor)).filter((l) => l[3] > 0);
    const firstOpaque = layers.findIndex((l) => l[3] >= 1);
    const used = firstOpaque === -1 ? layers : layers.slice(0, firstOpaque + 1);
    const bg = [...used].reverse().reduce((acc, l) => acc.map((v, i) => l[i] * l[3] + v * (1 - l[3])), [K.byte, K.byte, K.byte]);
    const raw = parse(getComputedStyle(el).color);
    const fg = [0, 1, 2].map((i) => raw[i] * raw[3] + bg[i] * (1 - raw[3]));
    const lin = (v: number): number => {
      const s = v / K.byte;
      return s <= K.knee ? s / K.lo : ((s + K.off) / K.gain) ** K.gamma;
    };
    const lum = (c: number[]): number => K.r * lin(c[0]) + K.g * lin(c[1]) + K.b * lin(c[2]);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return { ratio: (hi + K.flare) / (lo + K.flare), fg, bg };
  });
}
