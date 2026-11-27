import type { Page } from '@playwright/test';

/** Recoge errores de consola y de página desde que se llama; sin PII ni cuerpos de respuesta. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Recoge las URL pedidas a hosts distintos del sitio (p. ej. fuentes de Google). */
export function collectExternalRequests(page: Page, ownOrigin = `http://localhost:${process.env.E2E_PORT ?? '4321'}`): string[] {
  const external: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (/^https?:/.test(url) && new URL(url).origin !== ownOrigin) external.push(url);
  });
  return external;
}

/**
 * T-134 · en < 800 px la barra de filtros va en un `<details>` cerrado sin filtros activos; en escritorio el resumen
 * está oculto y la barra siempre se ve. Abre el resumen solo si es visible y el plegable sigue cerrado.
 */
export async function openFilters(page: Page): Promise<void> {
  const details = page.locator('details:has(form)').first();
  const summary = details.locator('summary').first();
  if ((await summary.isVisible()) && !(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await summary.click();
}
