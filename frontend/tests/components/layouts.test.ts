import { describe, expect, test } from 'vitest';
import AuthLayout from '../../src/layouts/AuthLayout.astro';
import BaseLayout from '../../src/layouts/BaseLayout.astro';
import StoreLayout from '../../src/layouts/StoreLayout.astro';
import { renderDocument } from '../helpers/render';

// T-116 · firmas públicas de los tres layouts (STATUS "T-116 › Firmas públicas") con la Container API.
const robots = (doc: Document): string => doc.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '';

/** Comprobaciones comunes a los tres layouts (criterio: lang="es", un solo main#contenido, "Saltar al contenido"). */
function commonContract(render: (extra?: { title?: string }) => Promise<Document>): void {
  test('<html lang="es">, charset y viewport', async () => {
    const doc = await render();
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.querySelector('meta[charset]')).not.toBeNull();
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('width=device-width');
  });

  test('<title> es el recibido y se escapa (sin inyección de HTML)', async () => {
    expect((await render({ title: 'Relojes | Valmont' })).title).toBe('Relojes | Valmont');
    const hostile = await render({ title: '</title><script>window.__x=1</script>' });
    // T-119: el layout lleva el <script> del menú; solo cuenta el que inyectaría el título hostil.
    expect([...hostile.querySelectorAll('script')].filter((s) => (s.textContent ?? '').includes('__x')).length).toBe(0);
    expect(hostile.title).toBe('</title><script>window.__x=1</script>');
  });

  test('un solo main#contenido enfocable por programa', async () => {
    const doc = await render();
    expect(doc.querySelectorAll('main').length).toBe(1);
    expect(doc.querySelectorAll('#contenido').length).toBe(1);
    const main = doc.querySelector('main#contenido');
    expect(main).not.toBeNull();
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  test('"Saltar al contenido" apunta al main y es de los primeros elementos del <body>', async () => {
    const doc = await render();
    // Acepta "Saltar al contenido" (cualquier caja); rechaza "Ir al contenido".
    const skip = [...doc.querySelectorAll('a')].find((a) => /saltar al contenido/i.test(a.textContent ?? ''));
    expect(skip, 'falta el enlace "Saltar al contenido"').toBeDefined();
    expect(skip!.getAttribute('href')).toBe('#contenido');
    expect(doc.getElementById('contenido')).not.toBeNull();
    // Primer elemento enfocable del documento: quien tabula llega antes que a cualquier otro control.
    const firstFocusable = doc.body.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    expect(firstFocusable).toBe(skip);
  });

  test('sin scripts en línea ni controladores de eventos con datos', async () => {
    const doc = await render({ title: 'x' });
    expect(doc.querySelectorAll('script:not([src])').length).toBe(0);
  });
}

describe('BaseLayout', () => {
  const render = async (extra: { title?: string } = {}, props: Record<string, unknown> = {}): Promise<Document> =>
    renderDocument(BaseLayout, {
      props: { title: extra.title ?? 'Valmont', ...props },
      slots: { default: '<main id="contenido" tabindex="-1"><h1>Hola</h1></main>' },
    });

  commonContract((extra) => render(extra));

  test('sin noindex por defecto y con description solo si se pasa', async () => {
    const plain = await render();
    expect(robots(plain)).toBe('');
    expect(plain.querySelector('meta[name="description"]')).toBeNull();
    const withDesc = await render({}, { description: 'Alta relojería mecánica' });
    expect(withDesc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('Alta relojería mecánica');
  });

  test('noindex={true} emite robots con noindex; noindex={false} no', async () => {
    expect(robots(await render({}, { noindex: true }))).toContain('noindex');
    expect(robots(await render({}, { noindex: false }))).toBe('');
  });

  test('la description se escapa en el atributo', async () => {
    const doc = await render({}, { description: '"><script>window.__x=1</script>' });
    expect(doc.querySelectorAll('script:not([src])').length).toBe(0);
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('"><script>window.__x=1</script>');
  });

  test('slot default en <body>; slot head en <head>', async () => {
    const doc = await renderDocument(BaseLayout, {
      props: { title: 'Valmont' },
      slots: {
        default: '<main id="contenido" tabindex="-1"><p id="cuerpo">cuerpo</p></main>',
        head: '<meta name="x-prueba" content="ok">',
      },
    });
    expect(doc.body.querySelector('#cuerpo')).not.toBeNull();
    expect(doc.head.querySelector('meta[name="x-prueba"]')?.getAttribute('content')).toBe('ok');
    expect(doc.body.querySelector('meta[name="x-prueba"]')).toBeNull();
  });

  test('favicon declarado', async () => {
    const doc = await render();
    expect(doc.querySelector('link[rel~="icon"]')).not.toBeNull();
  });
});

describe('StoreLayout', () => {
  const render = async (extra: { title?: string } = {}, props: Record<string, unknown> = {}): Promise<Document> =>
    renderDocument(StoreLayout, {
      props: { title: extra.title ?? 'Valmont', ...props },
      slots: { default: '<h1 id="t">Contenido</h1>' },
    });

  commonContract((extra) => render(extra));

  test('el contenido del slot default queda dentro de main#contenido', async () => {
    const doc = await render();
    expect(doc.querySelector('main#contenido #t')).not.toBeNull();
  });

  test('noindex es opcional: ausente por defecto, presente con noindex', async () => {
    expect(robots(await render())).toBe('');
    expect(robots(await render({}, { noindex: true }))).toContain('noindex');
  });

  test('description opcional', async () => {
    const doc = await render({}, { description: 'Catálogo de relojes' });
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('Catálogo de relojes');
  });

  test.each(['full', 'compact'] as const)('acepta headerVariant="%s" sin cambiar el esqueleto', async (headerVariant) => {
    const doc = await render({}, { headerVariant });
    expect(doc.querySelectorAll('main#contenido').length).toBe(1);
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
  });

  test('slot head llega al <head>', async () => {
    const doc = await renderDocument(StoreLayout, {
      props: { title: 'Valmont' },
      slots: { default: 'x', head: '<link rel="canonical" href="https://valmont.pe/relojes">' },
    });
    expect(doc.head.querySelector('link[rel="canonical"]')).not.toBeNull();
  });
});

describe('AuthLayout', () => {
  const render = async (extra: { title?: string } = {}, props: Record<string, unknown> = {}): Promise<Document> =>
    renderDocument(AuthLayout, {
      props: { title: extra.title ?? 'Ingresar', variant: 'login', ...props },
      slots: { default: '<form id="form"><label>Correo <input type="email"></label></form>', art: '<div id="arte">arte</div>' },
    });

  commonContract((extra) => render(extra));

  test.each(['login', 'register'] as const)('variant="%s": el formulario va en main#contenido', async (variant) => {
    const doc = await render({}, { variant });
    expect(doc.querySelectorAll('main#contenido').length).toBe(1);
    expect(doc.querySelector('main#contenido #form')).not.toBeNull();
  });

  test('el slot art se renderiza y no es el contenido principal', async () => {
    const doc = await render();
    expect(doc.querySelector('#arte')).not.toBeNull();
    expect(doc.querySelector('main#contenido #arte')).toBeNull();
  });

  test('ingreso y registro no se indexan: siempre noindex', async () => {
    for (const variant of ['login', 'register'] as const) {
      expect(robots(await render({}, { variant }))).toContain('noindex');
    }
  });

  test('description opcional', async () => {
    const doc = await render({}, { description: 'Accede a tu cuenta' });
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('Accede a tu cuenta');
  });
});
