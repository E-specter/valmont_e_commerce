import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FRONTEND = resolve(import.meta.dirname, '../..');
export const read = (rel: string): string => readFileSync(resolve(FRONTEND, rel), 'utf8');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (v: string): string => v.trim().replace(/\s+/g, ' ');

/** Todas las declaraciones `--nombre: valor;` de un CSS (si se repite, gana la última). */
export function customProperties(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) out.set(m[1], squash(m[2]));
  return out;
}

/** Sustituye `var(--x)` por su valor (recursivo). */
export function resolveVar(props: Map<string, string>, name: string, depth = 0): string {
  const raw = props.get(name);
  if (raw === undefined) throw new Error(`Variable no declarada: ${name}`);
  if (depth > 10) throw new Error(`Ciclo de variables en ${name}`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, n: string) => resolveVar(props, n, depth + 1));
}

export type RGBA = { r: number; g: number; b: number; a: number };

/** `#rrggbb`, `#rgb` o `rgb(r g b / a)` (también con comas). */
export function parseColor(value: string): RGBA {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  throw new Error(`Color no reconocido: ${value}`);
}

/** Compone `fg` (con alfa) sobre `bg` opaco. */
export function over(fg: RGBA, bg: RGBA): RGBA {
  const mix = (f: number, b: number): number => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: RGBA): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

/** Contraste WCAG 2.x. */
export function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `12px`, `0.75rem` → px (1rem = 16px). */
export function toPx(len: string): number {
  const m = /^(-?[\d.]+)(px|rem)$/.exec(len.trim());
  if (!m) throw new Error(`Longitud no reconocida: ${len}`);
  return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

/** Argumentos de primer nivel de `clamp(min, pref, max)`. */
export function clampArgs(value: string): [string, string, string] {
  const inner = /^clamp\((.*)\)$/.exec(value.trim())?.[1];
  if (inner === undefined) throw new Error(`No es clamp(): ${value}`);
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  args.push(cur.trim());
  if (args.length !== 3) throw new Error(`clamp() con ${args.length} argumentos: ${value}`);
  return args as [string, string, string];
}
