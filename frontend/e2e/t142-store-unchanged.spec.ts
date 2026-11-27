import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { browserCookies, createQaUser, deleteQaUser, type QaUser } from './helpers/admin';

// T-142 · «las páginas de la tienda no cambian»: estilo calculado de varios elementos y valores de los roles en portada, catálogo, ficha, ingreso,
// registro, nosotros y cuenta, a 1280 y 375, comparados con una línea base capturada en `main` ANTES del cambio (d352052).
// Regenerar la línea base (solo contra un servidor con el código ANTERIOR): `STORE_BASELINE=write E2E_PORT=4321 npx playwright test e2e/t142-store-unchanged.spec.ts --project=desktop`.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'helpers', 'fixtures', 'store-style-baseline.json');
const WRITE = process.env.STORE_BASELINE === 'write';
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 120_000;
const PAGES = ['/', '/relojes', '/relojes/demo-lira-37', '/ingresar', '/registro', '/nosotros', '/cuenta'];
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
];
const ROLES = [
  '--bg-page', '--bg-inverse', '--bg-surface', '--bg-surface-dark', '--text-primary', '--text-secondary', '--text-on-dark', '--text-accent', '--stroke-default',
  '--stroke-soft', '--stroke-strong', '--stroke-control', '--stroke-on-dark', '--state-active', '--state-success', '--state-error', '--state-cancelled',
  '--focus-color', '--focus-ring', '--color-red-strong', '--color-forest', '--color-forest-deep', '--color-forest-mid', '--color-mint', '--color-yellow',
  '--color-ivory', '--radius-lg', '--shadow-overlay', '--touch-target', '--container-max',
];
const SELECTORS = ['html', 'body', 'main', 'header', 'footer', 'nav', 'h1', 'h2', 'p', 'label', 'img', 'button', 'input:not([type="hidden"])', 'a[href]:not(.skip-link)', '.skip-link'];
const PROPS = [
  'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'textDecorationLine', 'borderTopColor',
  'borderTopWidth', 'borderRadius', 'outlineColor', 'boxShadow', 'paddingTop', 'paddingLeft', 'minHeight', 'colorScheme',
];

type Signature = { dataContext: string | null; roles: Record<string, string>; elements: Record<string, Record<string, string> | null> };
// Línea base compacta: un hash del estilo calculado por selector (y de los roles) más un resumen legible. Mismo rigor que el volcado completo
// (cualquier propiedad que cambie cambia el hash); el volcado completo actual se escribe en test-results/ cuando una comparación falla.
type Compact = { roles: string; elements: Record<string, string | null>; summary: Record<string, string | undefined> };
type Baseline = Record<string, Compact>;
const HASH_LEN = 24;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, HASH_LEN);
const compact = (sig: Signature): Compact => ({
  roles: hash(sig.roles),
  elements: Object.fromEntries(Object.entries(sig.elements).map(([sel, props]) => [sel, props === null ? null : hash(props)])),
  summary: {
    bg: sig.roles['--bg-page'],
    text: sig.roles['--text-primary'],
    surface: sig.roles['--bg-surface'],
    body: sig.elements.body ? `${sig.elements.body.backgroundColor} ${sig.elements.body.color} ${sig.elements.body.fontSize}` : undefined,
    h1: sig.elements.h1 ? `${sig.elements.h1.color} ${sig.elements.h1.fontSize} ${sig.elements.h1.fontWeight}` : undefined,
  },
});

/** Valores de los roles en <html> y estilo calculado del primer elemento de cada selector. */
const signature = (page: Page): Promise<Signature> =>
  page.evaluate(
    ({ roles, selectors, props }) => {
      const root = getComputedStyle(document.documentElement);
      const elements: Record<string, Record<string, string> | null> = {};
      selectors.forEach((sel) => {
        const el = document.querySelector(sel);
        elements[sel] = el ? Object.fromEntries(props.map((p) => [p, (getComputedStyle(el) as unknown as Record<string, string>)[p]])) : null;
      });
      return {
        dataContext: document.documentElement.getAttribute('data-context'),
        roles: Object.fromEntries(roles.map((r) => [r, root.getPropertyValue(r).trim()])),
        elements,
      };
    },
    { roles: ROLES, selectors: SELECTORS, props: PROPS },
  );

let env: LiveEnv;
let customer: QaUser | undefined;
const collected: Baseline = {};
const DUMP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results');

test.describe('tienda · estilos sin cambios (T-142)', () => {
  test.describe.configure({ mode: 'default' });
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'se mide una vez (escritorio); los dos anchos se fijan dentro de la prueba'));
  test.beforeAll(async ({}, info) => {
    test.setTimeout(HOOK_TIMEOUT);
    const e = liveEnv();
    if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
    env = e;
    if (info.project.name === 'desktop') customer = await createQaUser(env, 'tienda', 'customer');
  });
  test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    if (WRITE) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(collected, null, 2)}\n`);
    }
    await deleteQaUser(env, customer);
  });

  VIEWPORTS.forEach(({ width, height }) =>
    PAGES.forEach((path) =>
      test(`${path} a ${width} px: sin data-context y con el mismo estilo que antes`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        if (path === '/cuenta') await page.context().addCookies(browserCookies(customer!.cookies));
        const res = await page.goto(`${BASE}${path}`);
        expect(res?.status()).toBe(200);
        await page.evaluate(() => document.fonts.ready);
        const now = await signature(page);
        // Siempre: la tienda nunca declara el contexto del backoffice y los roles son los de la tienda (marfil, tinta, blanco).
        expect(now.dataContext).toBeNull();
        expect(now.roles['--bg-page']).toBe('#fffde4');
        expect(now.roles['--text-primary']).toBe('#0f0f0f');
        expect(now.roles['--bg-surface']).toBe('#ffffff');
        expect(now.roles['--color-red-strong']).toBe('#b3261e');
        expect(now.roles['--bg-surface-dark']).toBe('#001a0b');
        if (WRITE) {
          collected[`${path}@${width}`] = compact(now);
          return;
        }
        const baseline = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Baseline;
        expect(baseline[`${path}@${width}`], 'la línea base no tiene esta página').toBeDefined();
        const expected = baseline[`${path}@${width}`];
        const got = compact(now);
        const changed = [...(got.roles === expected.roles ? [] : ['roles']), ...Object.keys(expected.elements).filter((sel) => got.elements[sel] !== expected.elements[sel])];
        if (changed.length > 0) {
          mkdirSync(DUMP_DIR, { recursive: true });
          writeFileSync(join(DUMP_DIR, `t142-store-${path.replaceAll('/', '_')}-${width}.json`), JSON.stringify({ changed, now }, null, 2));
        }
        expect(changed, 'cambió el estilo calculado de la tienda (volcado en test-results/)').toEqual([]);
      }),
    ),
  );

  test('el foco de la tienda sigue siendo tinta (el amarillo es solo del contexto del backoffice y de .on-dark)', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(`${BASE}/ingresar`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineColor);
    expect(ring).toBe('rgb(15, 15, 15)');
  });
});
