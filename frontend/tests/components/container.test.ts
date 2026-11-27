import { describe, expect, test } from 'vitest';
import Hello from '../helpers/fixtures/Hello.astro';
import { renderAstro, renderDocument } from '../helpers/render';

// T-130: el entorno `node` renderiza un .astro con la Container API.
describe('infraestructura: Container API', () => {
  test('renderiza props y slot', async () => {
    const html = await renderAstro(Hello, { props: { name: 'Valmont' }, slots: { default: 'Contenido' } });
    expect(html).toContain('Hola, Valmont');
    expect(html).toContain('Contenido');
  });

  test('parseHtml permite consultar con selectores', async () => {
    const doc = await renderDocument(Hello, { props: { name: 'Ñandú ¿¡' } });
    expect(doc.querySelector('[data-testid="hello"] h1')?.textContent).toBe('Hola, Ñandú ¿¡');
  });
});
