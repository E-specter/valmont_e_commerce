import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';

// T-143 · huella de estilos calculados de una página: la usa la regresión de la tienda (e2e/t143-store-regression.spec.ts).
// Cada elemento del <body> se identifica por su camino (etiqueta:posición entre las de su tipo, sin clases: el hash de ámbito de Astro
// cambia entre ramas) y guarda una cadena con las propiedades que definen su aspecto. Sin geometría (anchos y altos dependen de la
// carga de imágenes y fuentes): colores, bordes, tipografía, espaciado, disposición, sombras y contornos.
export const STYLE_PROPS = [
  'color', 'background-color', 'background-image', 'opacity',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'outline-color', 'outline-style', 'outline-width', 'box-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align', 'font-variant-numeric',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'display', 'position', 'flex-direction', 'justify-content', 'align-items', 'gap', 'min-height', 'cursor', 'text-shadow', 'visibility', 'accent-color', 'color-scheme',
] as const;

const NONE = 0;
const LINE = String.fromCharCode(10);
const SETTLE_MS = 300;
export type Fingerprint = { styles: string[]; elements: Record<string, number> };

/** Calcula la huella de la página abierta (espera a las fuentes y quita las animaciones: movimiento reducido). */
export async function fingerprint(page: Page): Promise<Fingerprint> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Las islas (p. ej. mostrar/ocultar contraseña) se hidratan tras la carga: se espera a la red inactiva para medir siempre el mismo estado.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate((props): Fingerprint => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'META']);
    const styles: string[] = [];
    const index = new Map<string, number>();
    const elements: Record<string, number> = {};
    const pathOf = (el: Element): string => {
      const siblings = el.parentElement ? [...el.parentElement.children].filter((s) => s.tagName === el.tagName) : [el];
      const here = `${el.tagName.toLowerCase()}:${String(siblings.indexOf(el))}`;
      return el.parentElement && el.parentElement !== document.documentElement ? `${pathOf(el.parentElement)}>${here}` : here;
    };
    const intern = (value: string): number => {
      const known = index.get(value);
      if (known !== undefined) return known;
      index.set(value, styles.length);
      styles.push(value);
      return styles.length - 1;
    };
    const describe = (cs: CSSStyleDeclaration): string => props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
    document.body.querySelectorAll('*').forEach((el) => {
      if (SKIP.has(el.tagName) || el.tagName.startsWith('ASTRO-DEV') || el.closest('astro-dev-toolbar') || el.closest('svg') !== null && el.tagName !== 'svg') return;
      const path = pathOf(el);
      elements[path] = intern(describe(getComputedStyle(el)));
      ['::before', '::after'].forEach((pseudo) => {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content !== 'none' && cs.content !== 'normal') elements[`${path}${pseudo}`] = intern(`content:${cs.content};${describe(cs)}`);
      });
    });
    return { styles, elements };
  }, [...STYLE_PROPS]);
}

const REGION_DEPTH = 5;
const HASH_LENGTH = 16;
export type Summary = { elements: number; total: string; regions: Record<string, string> };

const sha = (text: string): string => createHash('sha1').update(text).digest('hex').slice(NONE, HASH_LENGTH);

/**
 * Resumen compacto y estricto de una huella: un hash por región (los primeros 5 niveles del camino) y uno total. Cualquier cambio en
 * cualquier propiedad de cualquier elemento cambia el hash de su región; la región localiza el cambio sin guardar el volcado completo.
 */
export function summarize(fp: Fingerprint): Summary {
  const byRegion = new Map<string, string[]>();
  Object.keys(fp.elements).sort().forEach((path) => {
    const region = path.split('>').slice(NONE, REGION_DEPTH).join('>');
    const list = byRegion.get(region) ?? [];
    list.push(`${path}=${fp.styles[fp.elements[path]]}`);
    byRegion.set(region, list);
  });
  const regions = Object.fromEntries([...byRegion].map(([region, list]) => [region, `${String(list.length)}:${sha(list.join(LINE))}`]));
  return { elements: Object.keys(fp.elements).length, total: sha(JSON.stringify(regions)), regions };
}

/** Regiones que cambiaron, aparecieron o desaparecieron respecto del resumen de main. */
export function diffSummaries(before: Summary, now: Summary): string[] {
  const keys = new Set([...Object.keys(before.regions), ...Object.keys(now.regions)]);
  return [...keys].sort().flatMap((k) => (before.regions[k] === now.regions[k] ? [] : [`${k}: ${before.regions[k] ?? 'ausente'} → ${now.regions[k] ?? 'ausente'}`]));
}
