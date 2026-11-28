// Ayudantes de las pruebas de página de T-147: un contenedor de Astro con las rutas a las que reescribe la guardia, la petición y la lectura
// del formulario tal como lo enviaría el navegador. La lógica de las páginas no se simula: solo el backend (`fetch`) y Supabase.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { vi } from 'vitest';
import NoDisponible from '../../src/pages/admin/no-disponible.astro';
import SinPermiso from '../../src/pages/admin/sin-permiso.astro';
import NotFound from '../../src/pages/404.astro';
import { parseHtml } from './render';
import { ORIGIN, ST } from './t142';
import { SESSION } from './t129';
import { serialize, specEntries, type Entry } from './t147';
import { text } from './ui';

export { ORIGIN, ST };

export type Init = {
  method?: string;
  query?: string;
  params?: Record<string, string>;
  entries?: readonly Entry[];
  rawBody?: string;
  contentType?: string;
  /** `undefined` = el del sitio; `null` = sin cabecera `Origin`. */
  origin?: string | null;
  headers?: Record<string, string>;
  session?: unknown;
  cookie?: string;
};

export const COOKIE = 'sb-127-auth-token=base64-QUJD; sb-127-auth-token.1=REVG; theme=dark';

export function supabaseMock() {
  const signOut = vi.fn(async () => ({ error: null }));
  return { auth: { signOut }, signOut };
}
export type SupabaseMock = ReturnType<typeof supabaseMock>;

type PageComponent = Parameters<AstroContainer['renderToResponse']>[0];

/** Renderiza una página con la Container API (y las rutas a las que la guardia puede reescribir). */
export async function openPage(page: PageComponent, path: string, sb: SupabaseMock, init: Init = {}) {
  const method = init.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? (init.rawBody ?? new URLSearchParams([...(init.entries ?? [])]).toString()) : undefined;
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'content-type': init.contentType ?? 'application/x-www-form-urlencoded' } : {}),
    ...(hasBody && origin !== null ? { origin } : {}),
    cookie: init.cookie ?? COOKIE,
    ...init.headers,
  };
  const request = new Request(`${ORIGIN}${path}${init.query ?? ''}`, { method, headers, body });
  const container = await AstroContainer.create();
  container.insertPageRoute('/admin/sin-permiso', SinPermiso);
  container.insertPageRoute('/admin/no-disponible', NoDisponible);
  container.insertPageRoute('/404', NotFound);
  const session = 'session' in init ? init.session : SESSION;
  const res = await container.renderToResponse(page, {
    request,
    params: init.params,
    locals: { session: session as App.Locals['session'], supabase: sb as unknown as App.Locals['supabase'] },
    routeType: 'page',
  });
  const html = await res.clone().text();
  return { res, html, doc: parseHtml(html) };
}

export const formOf = (doc: Document): HTMLFormElement => doc.querySelector('form#product-form') as HTMLFormElement;
/** Lo que enviaría el navegador al pulsar el botón principal: los campos del formulario (sin la acción). */
export const entriesOf = (doc: Document): Entry[] => serialize(formOf(doc)).filter(([k]) => k !== '_action');
export const withAction = (entries: readonly Entry[], action: string): Entry[] => [...entries.filter(([k]) => k !== '_action'), ['_action', action]];

/** Sustituye todas las especificaciones por `specs`, con los nombres de control que usa el editor (los de las dos primeras entradas del par). */
export function withSpecs(entries: readonly Entry[], specs: readonly { label: string; value: string }[], specNames: readonly [string, string]): Entry[] {
  const scalars = entries.filter(([k]) => k !== specNames[0] && k !== specNames[1] && k !== '_action');
  const action = entries.filter(([k]) => k === '_action');
  return [...scalars, ...specs.flatMap((s): Entry[] => [[specNames[0], s.label], [specNames[1], s.value]]), ...action];
}
/** Nombres de los dos controles de una fila de especificación, leídos del propio formulario (las dos primeras entradas que no son escalares). */
export function specNamesOf(doc: Document): [string, string] {
  const names = specEntries(serialize(formOf(doc))).map(([k]) => k);
  return [names[0], names.find((n) => n !== names[0]) ?? names[1]];
}

export const isRedirect =(res: Response): boolean => [ST.FOUND, ST.SEE_OTHER].includes(res.status as never);
export const alertText = (doc: Document): string => [...doc.querySelectorAll('[role="alert"]')].map((e) => text(e)).join(' | ');
export const field = (doc: Document, name: string): Element | null => formOf(doc).querySelector(`[name="${name}"]`);
export const invalid = (doc: Document, name: string): boolean => field(doc, name)?.getAttribute('aria-invalid') === 'true';
/** Texto de lo que apunta `aria-describedby` de un campo (ayuda y error). */
export function describedText(doc: Document, el: Element | null): string {
  return (el?.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => text(doc.querySelector(`[id="${id}"]`)))
    .join(' ');
}
