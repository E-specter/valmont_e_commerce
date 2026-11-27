/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// T-130 (D-042). Dos proyectos:
//  - `node`: componentes .astro con la Container API (Astro no los renderiza en happy-dom) y `lib/**`.
//  - `dom`:  islas y scripts de cliente con happy-dom.
// Playwright vive en `e2e/` y no entra aquí.
export default getViteConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/dom/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          include: ['tests/dom/**/*.test.ts'],
        },
      },
    ],
  },
});
