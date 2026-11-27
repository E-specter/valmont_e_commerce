import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.2 AA (RNF07). `astro-dev-toolbar` es del servidor de desarrollo, no de la página. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Falla si axe encuentra violaciones; el mensaje lista regla, impacto y nodos. */
export async function expectNoA11yViolations(page: Page, opts: { exclude?: string[] } = {}): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(TAGS).exclude('astro-dev-toolbar');
  for (const selector of opts.exclude ?? []) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();
  const report = violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
  );
  expect(report, `Violaciones de accesibilidad:\n${report.join('\n')}`).toEqual([]);
}
