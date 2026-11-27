import { renderDocument } from './render';

type Component = Parameters<typeof renderDocument>[0];

/** Renderiza un componente `ui/` y devuelve el `<body>` analizado (los fragmentos quedan dentro de él). */
export async function ui(
  component: Component,
  props: Record<string, unknown> = {},
  slots: Record<string, string> = {},
): Promise<HTMLElement> {
  const doc = await renderDocument(component, { props, slots });
  return doc.body;
}

/** Primer elemento real del cuerpo (ignora <style>, <script> y <link> que pueda emitir el renderizado). */
export function root(body: HTMLElement): Element {
  const el = [...body.children].find((e) => !['STYLE', 'SCRIPT', 'LINK'].includes(e.tagName));
  if (!el) throw new Error(`El componente no produjo ningún elemento: ${body.innerHTML}`);
  return el;
}

/**
 * "Marcas" de variante de un elemento: clases (sin las de ámbito de Astro), atributos `data-*` (sin `data-astro-cid`) y `style`.
 * El paquete T-117 no fija CÓMO se expresa una variante (clase o atributo), solo que debe distinguirse: las pruebas
 * usan estas marcas para no depender de un nombre de clase concreto.
 */
export function markers(el: Element): string {
  const out: string[] = [...el.classList].filter((c) => !/^astro-/.test(c));
  for (const a of [...el.attributes]) {
    if (a.name === 'style') out.push(`style:${a.value}`);
    else if (a.name.startsWith('data-') && !a.name.startsWith('data-astro-cid')) out.push(`${a.name}=${a.value}`);
  }
  return out.join(' ').toLowerCase();
}

/** Las marcas del elemento mencionan `word` (p. ej. la variante `mint`). */
export const hasMarker = (el: Element, word: string): boolean => markers(el).includes(word.toLowerCase());

/** Texto de los elementos a los que apunta `aria-describedby` (en orden), o `[]` si no hay atributo. */
export function describedBy(scope: ParentNode, el: Element): { id: string; text: string }[] {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => ({
    id,
    text: (scope.querySelector(`[id="${id}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

export const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
