import { expect, test, type Locator, type Page } from '@playwright/test';
import { ensureContractTokens } from './helpers/backoffice';
import { MIN_TEXT_CONTRAST, indices, openPage, sequence, textContrast } from './helpers/ui-a';

// T-143 · AUDITORÍA DE ROLES, vista desde el navegador: los `ui/` de la tienda (muestrarios /dev/ui-a y /dev/ui-b, que los pintan todos
// con sus estados) se re-tematizan por ROL al poner `data-context="backoffice"` en <html> (como hará AdminLayout, AB-4).
// Todo texto visible debe seguir cumpliendo 4,5:1. Un componente con un color directo (--color-*) que no cambie con el contexto falla aquí:
// o se sustituye por su rol, o el desarrollador lo anota en el traspaso (lista de excepciones, que QA incorpora a EXCEPTIONS al verificar).
const SLOW = 180_000;
const NONE = 0;
const MARK = 'data-qa-text';
const VIEWS = ['/dev/ui-a', '/dev/ui-b'];
// Excepciones aceptadas: variantes de TONO FIJO que quien usa el componente elige a propósito para una superficie concreta de la tienda
// (el logotipo `ink`, el enlace `forest` y el badge `red` con relleno rojo y texto blanco; el backoffice usa Wordmark `ivory` y StatusPill).
// Lo demás (Button, Chip, Price, Notice, Card, Field…) debe re-tematizarse por rol o el desarrollador lo anota en el traspaso y QA lo suma aquí.
const EXCEPTIONS: string[] = ['.wordmark[data-tone="ink"]', '.textlink[data-tone="forest"]', '.badge[data-tone="red"]'];

const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));

async function enter(page: Page, path: string): Promise<void> {
  await openPage(page, path);
  await ensureContractTokens(page);
  await page.evaluate(() => document.documentElement.setAttribute('data-context', 'backoffice'));
}

test.describe('ui/ existentes bajo data-context="backoffice" (por rol)', () => {
  VIEWS.forEach((path) => {
    test(`${path}: todo texto visible (no inactivo) alcanza 4,5:1`, async ({ page }) => {
      test.setTimeout(SLOW);
      await enter(page, path);
      await page.evaluate(
        ([mark, skip]) => {
          document.querySelectorAll('main *').forEach((e) => {
            const hasText = (e.textContent ?? '').trim() !== '';
            const exempt = e.closest('[aria-disabled="true"], [aria-hidden="true"], [disabled], svg, del, .sr-only') ?? (skip ? e.closest(skip) : null);
            if (e.children.length === 0 && hasText && !exempt) e.setAttribute(mark, 'true');
          });
        },
        [MARK, EXCEPTIONS.join(', ')] as const,
      );
      const leaves = await all(page.locator(`[${MARK}]:visible`));
      expect(leaves.length).toBeGreaterThan(NONE);
      const reports = await sequence(leaves, async (loc) => ({
        label: ((await loc.textContent()) ?? '').trim().slice(0, 40),
        tag: await loc.evaluate((e) => {
          const v = e.closest('[data-variant], [data-tone], [data-kind]');
          const marks = v ? [...v.attributes].filter((a) => a.name.startsWith('data-') && !a.name.startsWith('data-astro')).map((a) => `${a.name.slice(5)}=${a.value}`).join(',') : '';
          return `${e.tagName.toLowerCase()}${e.className ? `.${e.className.toString().split(' ')[0]}` : ''}[${marks}]`;
        }),
        ratio: (await textContrast(loc)).ratio,
      }));
      expect(reports.filter((r) => r.ratio < MIN_TEXT_CONTRAST).map((r) => `${r.tag} «${r.label}» ${r.ratio.toFixed(2)}`)).toEqual([]);
    });
  });
});
