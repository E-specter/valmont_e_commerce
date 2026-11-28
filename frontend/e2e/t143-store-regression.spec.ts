import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { asBrowserCookies, createActor, deleteActor, type Actor } from '../tests/helpers/t129-live';
import { expectNoA11yViolations } from './helpers/axe';
import { diffSummaries, fingerprint, summarize, type Summary } from './helpers/style-fingerprint';
import { openPage } from './helpers/ui-a';

// T-143 · RIESGO PRINCIPAL: las vistas de la tienda no cambian en estilo calculado ni en accesibilidad.
// `e2e/helpers/fixtures/before-t143/*.json` es el resumen (hash por región y total) de cada vista capturada en main antes de T-143.
// Captura (solo QA, contra el servidor de main): `T143_CAPTURE=1 npx playwright test e2e/t143-store-regression.spec.ts`.
// Comparación (por defecto): la misma huella en la rama; cualquier diferencia de estilo calculado falla y se lista.
const CAPTURE = process.env.T143_CAPTURE === '1';
const FIXTURES = join(import.meta.dirname, 'helpers', 'fixtures', 'before-t143');
const SLOW = 180_000;
const HOOK_TIMEOUT = 120_000;
const NONE = 0;
const PRODUCT = '/relojes/demo-jade-39';
const PUBLIC_VIEWS: [name: string, path: string][] = [
  ['portada', '/'],
  ['catalogo', '/relojes'],
  ['ficha', PRODUCT],
  ['ingreso', '/ingresar'],
  ['registro', '/registro'],
  ['muestrario-ui-a', '/dev/ui-a'],
  ['muestrario-ui-b', '/dev/ui-b'],
];
const NAME = 'Ana QA Torres';
const PHONE = '+51987654321';
const LIVE_ENV_MESSAGE = 'Supabase local no disponible (npm run db:start)';

const fixtureFile = (view: string, project: string): string => join(FIXTURES, `${view}-${project}.json`);

async function check(page: Page, view: string, project: string): Promise<void> {
  const full = await fingerprint(page);
  const now = summarize(full);
  const file = fixtureFile(view, project);
  if (CAPTURE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(now, null, 1));
    return;
  }
  expect(existsSync(file), `falta el resumen de main para ${view} (${project}); captúralo contra main con T143_CAPTURE=1`).toBe(true);
  const before = JSON.parse(readFileSync(file, 'utf8')) as Summary;
  const changed = diffSummaries(before, now);
  if (changed.length > NONE) {
    // Volcado completo solo si falla (para comparar con una captura de main y ver qué propiedad cambió).
    mkdirSync('test-results', { recursive: true });
    writeFileSync(join('test-results', `t143-huella-${view}-${project}.json`), JSON.stringify(full));
  }
  expect(changed, `${view} (${project}) cambió de estilo calculado respecto de main (volcado en test-results/)`).toEqual([]);
  expect(before.total).toBe(now.total);
  expect(now.elements, 'la huella no puede estar vacía').toBeGreaterThan(NONE);
}

test.describe('T-143 · la tienda no cambia (estilo calculado igual al de main y axe sin violaciones)', () => {
  test.describe.configure({ timeout: SLOW });

  PUBLIC_VIEWS.forEach(([view, path]) => {
    test(`${view} (${path})`, async ({ page }, testInfo) => {
      await openPage(page, path);
      await check(page, view, testInfo.project.name);
      if (!CAPTURE) await expectNoA11yViolations(page);
    });
  });

  test.describe('cuenta (con sesión)', () => {
    let env: LiveEnv;
    let actor: Actor | undefined;
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(HOOK_TIMEOUT);
      const e = liveEnv();
      if (!e) throw new Error(LIVE_ENV_MESSAGE);
      env = e;
      actor = await createActor(env, 't143', { full_name: NAME, phone: PHONE });
    });
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(HOOK_TIMEOUT);
      await deleteActor(env, actor);
    });

    test('cuenta (/cuenta)', async ({ page }, testInfo) => {
      await page.context().addCookies(asBrowserCookies(actor!.cookies));
      await openPage(page, '/cuenta');
      await check(page, 'cuenta', testInfo.project.name);
      if (!CAPTURE) await expectNoA11yViolations(page);
    });
  });
});
