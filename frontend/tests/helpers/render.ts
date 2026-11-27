import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { Window } from 'happy-dom';

type Component = Parameters<AstroContainer['renderToString']>[0];
type Options = Parameters<AstroContainer['renderToString']>[1];

/** Renderiza un componente o layout `.astro` a HTML con la Container API (entorno `node`). */
export async function renderAstro(component: Component, options?: Options): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(component, options);
}

/** Analiza el HTML en un `Document` (happy-dom como analizador, sin ejecutar scripts) para consultar con selectores. */
export function parseHtml(html: string): Document {
  const win = new Window();
  const doc = new win.DOMParser().parseFromString(html, 'text/html');
  return doc as unknown as Document;
}

/** Atajo: renderizar y analizar. */
export async function renderDocument(component: Component, options?: Options): Promise<Document> {
  return parseHtml(await renderAstro(component, options));
}
