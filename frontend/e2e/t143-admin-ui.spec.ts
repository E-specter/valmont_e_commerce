import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { borderContrast, edgeContrast, ensureContractTokens, leaveBackoffice } from './helpers/backoffice';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { FOCUS_RING_MIN, MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, indices, openPage, sequence, textContrast } from './helpers/ui-a';

// T-143 · E2E del muestrario `/dev/admin-ui` (solo existe con `astro dev`), en 1280 y 375 (proyectos desktop y mobile).
// El paquete fija la ruta `/dev/admin-ui` y que todos los estados van bajo `data-context="backoffice"`. NO fija el marcado interno:
// las pruebas localizan por rol, texto, atributos ARIA y estilos calculados.
// Los tokens de T-142 (contrato 3.5) se inyectan solo si faltan (ver helpers/backoffice.ts).
const PAGE = '/dev/admin-ui';
const SLOW = 120_000;
const HTTP_OK = 200;
const CLICK_TIMEOUT_MS = 1_000;
const POLL_TIMEOUT_MS = 10_000;
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const SEVEN = 7;
const TAB_PRESSES = 8;
const WIDE = 1440;
const WIDE_HEIGHT = 900;
const SM_HEIGHT = 40; // --size-control-sm
const TH_HEIGHT = 44; // --size-th
const ROW_HEIGHT = 56; // --size-row
const PILL_HEIGHT = 24; // --size-pill
const DIALOG_RADIUS = 12; // --radius-dialog
const SIZE_TOLERANCE = 1;
const MIN_TARGET_AA = 24; // WCAG 2.2 SC 2.5.8
const BUSY_DELAY_MS = 1500;
const SETTLE_MS = 50;
const MARK = 'data-qa-text';
const PILL_LABELS = ['Pendiente de pago', 'Pagado', 'En preparación', 'Enviado', 'Entregado', 'Cancelado', 'Expirado'];

const main = (page: Page): Locator => page.locator('main#contenido');
const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));
// El muestrario trae un ConfirmDialog con `open`: con JavaScript la isla lo deja en modal y el resto de la página queda inerte.
// `open` lo descarta con Esc (así el resto de las pruebas miden la página); `openRaw` la deja tal como carga.
const openRaw = async (page: Page): Promise<void> => {
  await openPage(page, PAGE);
  await ensureContractTokens(page);
};
const open = async (page: Page): Promise<void> => {
  await openRaw(page);
  if (await page.evaluate(() => document.querySelector('dialog:modal') !== null)) {
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog:modal')).toHaveCount(NONE);
  }
};
const trigger = (page: Page): Locator => page.locator('button[command="show-modal"][commandfor]').first();
const dialogOf = async (page: Page, t: Locator): Promise<Locator> => page.locator(`dialog[id="${(await t.getAttribute('commandfor')) ?? ''}"]`);
const isModal = (dlg: Locator): Promise<boolean> => dlg.evaluate((d) => d.matches(':modal'));
const insideDialog = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('dialog') != null);
// Un diálogo modal deja el resto de la página inerte: el foco puede salir a la interfaz del navegador (body), nunca a un elemento de la página.
const notOutsideDialog = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement === document.body || document.activeElement?.closest('dialog') != null);

type ControlInfo = { text: string; height: number; width: number; bg: string; border: string; borderWidth: number; borderStyle: string; color: string; disabled: boolean };
const controlInfo = (loc: Locator): Promise<ControlInfo> =>
  loc.evaluate((el): ControlInfo => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? '').trim(),
      height: r.height,
      width: r.width,
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
      borderWidth: parseFloat(cs.borderTopWidth),
      borderStyle: cs.borderTopStyle,
      color: cs.color,
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-busy') === 'true',
    };
  });
// `rgb(255, 0, 0)` y `rgb(255 0 0 / 0.5)` → [255, 0, 0] y [255, 0, 0, 0.5]: separa por espacio, coma o barra.
const rgbParts = (c: string): number[] => c.slice(c.indexOf('(') + ONE, c.lastIndexOf(')')).replaceAll(',', ' ').replaceAll('/', ' ').split(' ').filter(Boolean).map(parseFloat);
const isTransparent = (c: string): boolean => (rgbParts(c)[THREE] ?? ONE) === NONE;
const isRed = (c: string): boolean => {
  const [r, g, b] = rgbParts(c);
  return r > g * TWO && r > b * TWO;
};

// -------------------------------------------------------------------------------------------------------- carga y accesibilidad
test.describe('muestrario /dev/admin-ui', () => {
  test('carga sin errores de consola ni peticiones a terceros; un h1; main#contenido; bajo data-context="backoffice"', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page);
    await open(page);
    expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
    await expect(page.locator('main#contenido')).toHaveCount(ONE);
    expect(await page.locator('[data-context="backoffice"]').count()).toBeGreaterThan(NONE);
    expect(await main(page).evaluate((m) => m.closest('[data-context="backoffice"]') !== null)).toBe(true);
  });

  test('accesibilidad (axe, WCAG 2.2 AA): 0 violaciones en el muestrario', async ({ page }) => {
    await open(page);
    await expectNoA11yViolations(page);
  });

  test('sin desplazamiento horizontal de la página (la tabla se desplaza dentro de su región)', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(NONE);
  });

  test('todo texto visible del muestrario alcanza 4,5:1 sobre su fondo efectivo en el contexto backoffice (los inactivos están exentos)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    await page.evaluate((mark) => {
      document.querySelectorAll('main *').forEach((e) => {
        const hasText = (e.textContent ?? '').trim() !== '';
        if (e.children.length === 0 && hasText && !e.closest('[aria-disabled="true"], [aria-hidden="true"], [disabled], [aria-busy="true"], svg, dialog:not([open]), .sr-only')) e.setAttribute(mark, 'true');
      });
    }, MARK);
    const leaves = await all(page.locator(`[${MARK}]:visible`));
    expect(leaves.length, 'el muestrario debería tener texto que medir').toBeGreaterThan(NONE);
    const reports = await sequence(leaves, async (loc) => ({ label: ((await loc.textContent()) ?? '').trim(), ratio: (await textContrast(loc)).ratio }));
    expect(reports.filter((r) => r.ratio < MIN_TEXT_CONTRAST).map((r) => `"${r.label}" ${String(r.ratio)}`)).toEqual([]);
  });

  test('con movimiento reducido no queda ninguna animación en marcha (spinner del botón cargando incluido)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect(running).toBe(NONE);
  });

  test('captura a 1440 px para la revisión de frontend-lead frente al frame (se adjunta al informe)', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: WIDE, height: WIDE_HEIGHT });
    await open(page);
    await testInfo.attach(`admin-ui-${testInfo.project.name}-1440`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
});

// -------------------------------------------------------------------------------------------------------- Button
test.describe('Button · danger, ghost y sm', () => {
  test('hay un botón sm de 40 px de alto, uno de contorno rojo (danger) y uno fantasma (sin fondo ni borde)', async ({ page }) => {
    await open(page);
    const infos = await sequence(await all(main(page).locator('button, a.btn, [class*="btn"]')), controlInfo);
    expect(infos.some((i) => Math.abs(i.height - SM_HEIGHT) <= SIZE_TOLERANCE), 'sin botón sm de 40 px').toBe(true);
    expect(infos.some((i) => i.borderWidth > NONE && isRed(i.border) && isTransparent(i.bg)), 'sin botón danger de contorno rojo').toBe(true);
    expect(infos.some((i) => isTransparent(i.bg) && (i.borderWidth === NONE || isTransparent(i.border) || i.borderStyle === 'none')), 'sin botón fantasma').toBe(true);
  });

  test('el texto de cada botón habilitado cumple 4,5:1 y el contorno de los botones sin relleno 3:1 (backoffice)', async ({ page }) => {
    await open(page);
    const buttons = await all(main(page).locator('button:not([disabled]):not([aria-busy="true"]):visible, a[class*="btn"]:visible'));
    const reports = await sequence(buttons, async (loc) => {
      const info = await controlInfo(loc);
      const bordered = info.borderWidth > NONE && !isTransparent(info.border) && isTransparent(info.bg);
      return { text: info.text, text_ratio: (await textContrast(loc)).ratio, border_ratio: bordered ? await borderContrast(loc) : null };
    });
    expect(reports.length).toBeGreaterThan(NONE);
    expect(reports.filter((r) => r.text_ratio < MIN_TEXT_CONTRAST || (r.border_ratio !== null && r.border_ratio < MIN_UI_CONTRAST))).toEqual([]);
  });

  test('con la misma página en contexto de tienda (sin data-context) los botones siguen cumpliendo 4,5:1 sobre fondo claro', async ({ page }) => {
    await open(page);
    await leaveBackoffice(page);
    const buttons = await all(main(page).locator('button:not([disabled]):not([aria-busy="true"]):visible, a[class*="btn"]:visible'));
    const reports = await sequence(buttons, async (loc) => ({ text: ((await loc.textContent()) ?? '').trim(), ratio: (await textContrast(loc)).ratio }));
    expect(reports.length).toBeGreaterThan(NONE);
    expect(reports.filter((r) => r.ratio < MIN_TEXT_CONTRAST)).toEqual([]);
  });

  test('con la misma página en contexto de tienda, los contornos de los botones sin relleno cumplen 3:1 y sm sigue midiendo 40 px', async ({ page }) => {
    await open(page);
    await leaveBackoffice(page);
    const buttons = await all(main(page).locator('button:not([disabled]):not([aria-busy="true"]):visible, a[class*="btn"]:visible'));
    const reports = await sequence(buttons, async (loc) => {
      const info = await controlInfo(loc);
      const bordered = info.borderWidth > NONE && !isTransparent(info.border) && isTransparent(info.bg);
      return { text: info.text, height: info.height, border_ratio: bordered ? await borderContrast(loc) : null };
    });
    expect(reports.filter((r) => r.border_ratio !== null && r.border_ratio < MIN_UI_CONTRAST)).toEqual([]);
    expect(reports.every((r) => Math.abs(r.height - SM_HEIGHT) <= SIZE_TOLERANCE)).toBe(true);
  });

  test('todo botón habilitado muestra un anillo de foco de 2 px con contraste 3:1 contra su entorno (backoffice; WCAG 2.4.11)', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Tab');
    const buttons = await all(main(page).locator('button:not([disabled]):not([aria-busy="true"]):visible'));
    const rings = await sequence(buttons, async (loc) => {
      await loc.focus();
      const ring = await loc.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { text: (el.textContent ?? '').trim(), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor };
      });
      const ratio = await edgeContrast(loc, 'outline');
      return { ...ring, ratio };
    });
    expect(rings.filter((r) => r.style === 'none' || r.width < FOCUS_RING_MIN)).toEqual([]);
    expect(rings.filter((r) => r.ratio < MIN_UI_CONTRAST).map((r) => `${r.text}: anillo ${r.color}`)).toEqual([]);
  });

  test('el deshabilitado y el cargando no son solo color: borde discontinuo o spinner y texto «Cargando»', async ({ page }) => {
    await open(page);
    const disabled = main(page).locator('button[disabled]:not([aria-busy="true"])').first();
    expect((await controlInfo(disabled)).borderStyle).toBe('dashed');
    const loading = main(page).locator('button[aria-busy="true"]').first();
    await expect(loading).toBeDisabled();
    await expect(loading.getByText('Cargando')).toHaveCount(ONE);
  });
});

// -------------------------------------------------------------------------------------------------------- StatusPill
test.describe('StatusPill · punto, texto y 7 tonos', () => {
  const pillOf = (label: string) => (page: Page): Locator => main(page).getByText(label, { exact: true }).first();
  type PillInfo = { height: number; dot: { w: number; h: number } | null; signature: string };
  const info = (loc: Locator): Promise<PillInfo> =>
    loc.evaluate((el): PillInfo => {
      const dotBox = (r: DOMRect | undefined, pseudo: boolean, before: CSSStyleDeclaration): { w: number; h: number } | null => {
        if (r) return { w: r.width, h: r.height };
        return pseudo ? { w: parseFloat(before.width), h: parseFloat(before.height) } : null;
      };
      const root = el.closest(':has(> [aria-hidden="true"])') ?? el;
      const dot = root.querySelector('[aria-hidden="true"]');
      const dr = dot?.getBoundingClientRect();
      const cs = getComputedStyle(root);
      const dotBefore = getComputedStyle(root, '::before');
      const hasPseudoDot = dotBefore.content !== 'none' && dotBefore.content !== 'normal';
      return {
        height: root.getBoundingClientRect().height,
        dot: dotBox(dr, hasPseudoDot, dotBefore),
        signature: [cs.backgroundColor, cs.color, cs.borderTopColor, cs.borderTopWidth].join('|'),
      };
    });

  PILL_LABELS.forEach((label) => {
    test(`«${label}» se ve con su texto, un punto con tamaño y 24 px de alto`, async ({ page }) => {
      await open(page);
      const loc = pillOf(label)(page);
      await expect(loc).toBeVisible();
      const i = await info(loc);
      expect(i.dot, 'sin punto').not.toBeNull();
      expect(i.dot!.w).toBeGreaterThan(NONE);
      expect(i.dot!.h).toBeGreaterThan(NONE);
      expect(Math.abs(i.height - PILL_HEIGHT)).toBeLessThanOrEqual(SIZE_TOLERANCE);
    });
  });

  test('los 7 tonos se distinguen entre sí por color (firma de fondo, texto y borde) y cada texto cumple 4,5:1', async ({ page }) => {
    await open(page);
    const reports = await sequence(PILL_LABELS, async (label) => {
      const loc = pillOf(label)(page);
      return { label, signature: (await info(loc)).signature, ratio: (await textContrast(loc)).ratio };
    });
    expect(new Set(reports.map((r) => r.signature)).size, JSON.stringify(reports)).toBe(SEVEN);
    expect(reports.filter((r) => r.ratio < MIN_TEXT_CONTRAST).map((r) => `${r.label} ${String(r.ratio)}`)).toEqual([]);
  });

  test('el texto del pill es la única información de estado exigida: el nombre accesible coincide con el texto visible', async ({ page }) => {
    await open(page);
    await sequence(PILL_LABELS, async (label) => {
      const loc = pillOf(label)(page);
      const name = await loc.evaluate((el) => (el.closest(':has(> [aria-hidden="true"])') ?? el).getAttribute('aria-label'));
      expect(name === null || name === label).toBe(true);
    });
  });
});

// -------------------------------------------------------------------------------------------------------- DataTable
test.describe('DataTable', () => {
  const table = (page: Page): Locator => main(page).getByRole('table').first();

  test('tabla con nombre (caption), cabecera con scope="col" y el caption no se ve pero lo leen los lectores', async ({ page }) => {
    await open(page);
    const t = table(page);
    await expect(t).toBeVisible();
    const caption = t.locator('caption');
    expect(((await caption.textContent()) ?? '').trim().length).toBeGreaterThan(NONE);
    await expect(main(page).getByRole('table', { name: ((await caption.textContent()) ?? '').trim() })).toHaveCount(ONE);
    const box = await caption.boundingBox();
    expect(box === null || (box.width <= ONE && box.height <= ONE), 'el caption se ve').toBe(true);
    const scopes = await t.locator('thead th').evaluateAll((ths) => ths.map((th) => th.getAttribute('scope')));
    expect(scopes.length).toBeGreaterThan(NONE);
    expect(scopes.every((s) => s === 'col')).toBe(true);
  });

  test('cabecera de 44 px sobre --bg-surface-dark y filas de 56 px', async ({ page }) => {
    await open(page);
    const t = table(page);
    const probe = await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.color = 'var(--bg-surface-dark)';
      document.body.append(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    });
    const th = t.locator('thead th').first();
    expect((await th.boundingBox())!.height).toBeGreaterThanOrEqual(TH_HEIGHT - SIZE_TOLERANCE);
    expect((await th.boundingBox())!.height).toBeLessThanOrEqual(TH_HEIGHT + SIZE_TOLERANCE);
    expect(await th.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(probe);
    const row = t.locator('tbody tr').first();
    const h = (await row.boundingBox())!.height;
    expect(Math.abs(h - ROW_HEIGHT)).toBeLessThanOrEqual(SIZE_TOLERANCE);
  });

  test('la columna numérica (Total) se alinea a la derecha con cifras tabulares', async ({ page }) => {
    await open(page);
    const t = table(page);
    const index = await t.locator('thead th').evaluateAll((ths) => ths.findIndex((th) => (th.textContent ?? '').trim() === 'Total'));
    expect(index).toBeGreaterThanOrEqual(NONE);
    const cell = t.locator('tbody tr').first().locator('td').nth(index);
    const cs = await cell.evaluate((e) => ({ align: getComputedStyle(e).textAlign, nums: getComputedStyle(e).fontVariantNumeric }));
    expect(['end', 'right']).toContain(cs.align);
    expect(cs.nums).toContain('tabular-nums');
  });

  test('la región de la tabla es enfocable con el teclado, con anillo de foco, y desplaza dentro de sí', async ({ page }) => {
    await open(page);
    const region = main(page).locator('[tabindex="0"]:has(table)').first();
    await expect(region).toHaveCount(ONE);
    await page.keyboard.press('Tab');
    await region.focus();
    expect(await page.evaluate(() => document.activeElement?.querySelector('table') != null)).toBe(true);
    const ring = await region.evaluate((e) => ({ style: getComputedStyle(e).outlineStyle, width: parseFloat(getComputedStyle(e).outlineWidth), overflow: getComputedStyle(e).overflowX }));
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(FOCUS_RING_MIN);
    expect(['auto', 'scroll']).toContain(ring.overflow);
  });

  test('el divisor entre filas es visible (borde inferior no transparente en la fila o su celda)', async ({ page }) => {
    await open(page);
    const row = table(page).locator('tbody tr').first();
    const edge = await row.evaluate((tr) => {
      const sides = [tr, ...tr.querySelectorAll('td')].flatMap((e) => {
        const cs = getComputedStyle(e);
        return [
          { w: parseFloat(cs.borderBottomWidth), c: cs.borderBottomColor },
          { w: parseFloat(cs.borderTopWidth), c: cs.borderTopColor },
        ];
      });
      return sides.some((x) => x.w > 0 && x.c !== 'rgba(0, 0, 0, 0)');
    });
    expect(edge).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------------- Timeline y KpiCard y Notice
test.describe('Timeline, KpiCard y Notice con acción', () => {
  test('Timeline: lista ordenada con nombre, eventos en orden, el actual marcado sin solo color y sin animación (sin pulso)', async ({ page }) => {
    await open(page);
    const list = main(page).locator('ol[aria-label], ol[aria-labelledby]').first();
    await expect(list).toBeVisible();
    const items = list.locator('> li');
    expect(await items.count()).toBeGreaterThanOrEqual(TWO);
    const current = await list.evaluate((ol) => [...ol.children].map((li) => li.hasAttribute('aria-current') || li.querySelector('[aria-current], .sr-only') !== null));
    expect(current.filter(Boolean).length).toBe(ONE);
    const animated = await list.evaluate((ol) => [ol, ...ol.querySelectorAll('*')].filter((e) => getComputedStyle(e).animationName !== 'none').length);
    expect(animated).toBe(NONE);
  });

  test('KpiCard: data (valor), pending («Sin contrato», borde discontinuo) y error («No disponible»)', async ({ page }) => {
    await open(page);
    await expect(main(page).getByText('Sin contrato')).toBeVisible();
    await expect(main(page).getByText('No disponible')).toBeVisible();
    const dashed = await main(page).getByText('Sin contrato').evaluate((el) => {
      const chain = (n: Element | null): Element[] => (n && n.tagName !== 'MAIN' ? [n, ...chain(n.parentElement)] : []);
      return chain(el).some((n) => getComputedStyle(n).borderTopStyle === 'dashed');
    });
    expect(dashed, 'pending sin borde discontinuo').toBe(true);
    const labelled = await main(page).locator('[aria-label*="Sin contrato"]').count();
    expect(labelled, 'pending sin aria-label completo').toBeGreaterThan(NONE);
  });

  test('KpiCard con enlace: objetivo de al menos 24 px y accesible por teclado', async ({ page }) => {
    await open(page);
    const link = main(page).getByRole('link', { name: 'Por preparar' }).first();
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET_AA);
    expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET_AA);
  });

  test('Notice con acción: el aviso de error es role="alert", trae su acción dentro y la acción es un botón alcanzable', async ({ page }) => {
    await open(page);
    const alert = main(page).locator('[role="alert"]').first();
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button')).toHaveCount(ONE);
    const notices = main(page).locator('[role="alert"], [role="status"]');
    expect(await notices.count()).toBeGreaterThanOrEqual(THREE);
  });
});

// -------------------------------------------------------------------------------------------------------- ConfirmDialog
test.describe('ConfirmDialog · con JavaScript', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('el disparador usa Invoker Commands (commandfor + command="show-modal") y apunta a un <dialog> con nombre', async ({ page }) => {
    const t = trigger(page);
    await expect(t).toHaveCount(ONE);
    const dlg = await dialogOf(page, t);
    await expect(dlg).toHaveCount(ONE);
    expect(await dlg.getAttribute('aria-labelledby')).not.toBeNull();
    const labelId = (await dlg.getAttribute('aria-labelledby')) ?? '';
    expect(((await page.locator(`[id="${labelId}"]`).textContent()) ?? '').trim().length).toBeGreaterThan(NONE);
  });

  test('abre en modal, el foco entra y queda atrapado, el fondo no recibe clics', async ({ page }) => {
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    await expect(dlg).toBeVisible();
    expect(await isModal(dlg), 'no es modal (:modal)').toBe(true);
    expect(await insideDialog(page), 'el foco no entró al diálogo').toBe(true);
    await sequence(indices(TAB_PRESSES), async () => {
      await page.keyboard.press('Tab');
      expect(await notOutsideDialog(page), 'el foco salió a un elemento de la página').toBe(true);
    });
    await sequence(indices(TAB_PRESSES), async () => {
      await page.keyboard.press('Shift+Tab');
      expect(await notOutsideDialog(page), 'el foco salió a un elemento de la página (hacia atrás)').toBe(true);
    });
    await expect(page.locator('button[data-busy], form[data-busy-on-submit] button').first().click({ trial: true, timeout: CLICK_TIMEOUT_MS })).rejects.toThrow();
  });

  test('Esc cierra el diálogo y el foco vuelve al disparador', async ({ page }) => {
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
    await expect(t).toBeFocused();
  });

  test('Cancelar cierra sin enviar nada (ninguna petición POST, misma URL)', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    const url = page.url();
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    await dlg.locator('button[formmethod="dialog"]').click();
    await expect(dlg).toBeHidden();
    expect(page.url()).toBe(url);
    expect(posts).toEqual([]);
  });

  test('Confirmar es el único botón que envía: un POST con los campos del formulario', async ({ page }) => {
    const bodies: string[] = [];
    await page.route('**/dev/admin-ui*', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      bodies.push(req.postData() ?? '');
      return route.fulfill({ status: HTTP_OK, contentType: 'text/html', body: '<!doctype html><title>ok</title><body>ok</body>' });
    });
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    const submit = dlg.locator('button[type="submit"]:not([formmethod="dialog"])');
    await expect(submit).toHaveCount(ONE);
    await submit.click();
    await expect.poll(() => bodies.length).toBe(ONE);
    expect(bodies[NONE]).toContain('to=cancelado');
  });

  test('el botón de peligro del diálogo tiene contorno rojo y texto con 4,5:1; el diálogo usa el radio de 12 px y un fondo de tarjeta', async ({ page }) => {
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    const danger = dlg.locator('button[type="submit"]:not([formmethod="dialog"])');
    const info = await controlInfo(danger);
    expect(isRed(info.border) || isRed(info.bg) || isRed(info.color), `sin rojo: ${JSON.stringify(info)}`).toBe(true);
    expect((await textContrast(danger)).ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    const frame = await dlg.evaluate((d) => ({ radius: parseFloat(getComputedStyle(d).borderTopLeftRadius), bg: getComputedStyle(d).backgroundColor, border: parseFloat(getComputedStyle(d).borderTopWidth) }));
    expect(frame.radius).toBe(DIALOG_RADIUS);
    expect(frame.border).toBeGreaterThan(NONE);
    expect(isTransparent(frame.bg)).toBe(false);
    const backdrop = await dlg.evaluate((d) => getComputedStyle(d, '::backdrop').backgroundColor);
    expect(isTransparent(backdrop)).toBe(false);
  });

  test('con el diálogo abierto no hay violaciones de accesibilidad (axe) y su texto cumple 4,5:1', async ({ page }) => {
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    await expectNoA11yViolations(page);
    const leaves = await all(dlg.locator('h2, h3, p, button, label'));
    const bad = await sequence(leaves, async (loc) => ({ text: ((await loc.textContent()) ?? '').trim(), ratio: (await textContrast(loc)).ratio }));
    expect(bad.filter((b) => b.ratio < MIN_TEXT_CONTRAST)).toEqual([]);
  });

  test('cabe en la pantalla: el diálogo abierto no desborda el ancho de la ventana', async ({ page }) => {
    const t = trigger(page);
    const dlg = await dialogOf(page, t);
    await t.click();
    const box = (await dlg.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(NONE);
    expect(box.x + box.width).toBeLessThanOrEqual(width + ONE);
  });
});

test.describe('ConfirmDialog con `open` en la carga', () => {
  test('con JavaScript la isla lo deja en modal (:modal), con el foco dentro, y Esc lo cierra', async ({ page }) => {
    await openRaw(page);
    const dlg = page.locator('dialog[id="open-dialog"]');
    await expect(dlg).toBeVisible();
    expect(await isModal(dlg), 'el diálogo con open no es modal').toBe(true);
    expect(await insideDialog(page), 'el foco no está dentro del diálogo abierto').toBe(true);
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });
});

test.describe('ConfirmDialog · SIN JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('abre con `command` y cierra con el botón de cancelar (formmethod="dialog")', async ({ page }) => {
    const res = await page.goto(PAGE);
    expect(res?.status()).toBe(HTTP_OK);
    const t = trigger(page);
    const id = await t.getAttribute('commandfor');
    const dlg = page.locator(`dialog[id="${id ?? ''}"]`);
    await expect(dlg).toBeHidden();
    await t.click();
    await expect(dlg).toBeVisible();
    await dlg.locator('button[formmethod="dialog"]').click();
    await expect(dlg).toBeHidden();
  });

  test('Esc cierra el diálogo también sin JavaScript', async ({ page }) => {
    await page.goto(PAGE);
    const t = trigger(page);
    const dlg = page.locator(`dialog[id="${(await t.getAttribute('commandfor')) ?? ''}"]`);
    await t.click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  });

  test('si hay un <dialog open> en la carga, se pinta visible sin JavaScript', async ({ page }) => {
    await page.goto(PAGE);
    const opened = page.locator('dialog[open]');
    const n = await opened.count();
    await sequence(indices(n), async (i) => expect(opened.nth(i)).toBeVisible());
  });
});

// -------------------------------------------------------------------------------------------------------- form-busy
test.describe('form-busy', () => {
  type Busy = { formBusy: string | null; disabled: boolean; buttonBusy: string | null; loading: boolean };

  test('al enviar, el botón queda deshabilitado, cargando y aria-busy; un segundo clic no envía de nuevo', async ({ page }) => {
    await open(page);
    let posts = NONE;
    await page.route('**/dev/admin-ui*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += ONE;
      await new Promise((resolve) => setTimeout(resolve, BUSY_DELAY_MS));
      return route.fulfill({ status: HTTP_OK, contentType: 'text/html', body: '<!doctype html><title>ok</title><body>ok</body>' });
    });
    // `click()` espera a que termine la navegación del envío: el estado se mide desde la propia página, justo tras el envío.
    const states: Busy[] = [];
    await page.exposeFunction('qaReport', (s: Busy) => states.push(s));
    await page.evaluate((settle) => {
      const f = document.querySelector('form[data-busy-on-submit]') as HTMLFormElement;
      const b = f.querySelector('button[type="submit"]') as HTMLButtonElement;
      f.addEventListener('submit', () =>
        setTimeout(() => (window as unknown as { qaReport: (s: Busy) => void }).qaReport({ formBusy: f.getAttribute('aria-busy'), disabled: b.disabled, buttonBusy: b.getAttribute('aria-busy'), loading: b.hasAttribute('data-loading') }), settle),
      );
    }, SETTLE_MS);
    const button = main(page).locator('form[data-busy-on-submit] button[type="submit"]');
    await expect(button).toBeEnabled();
    const first = button.click();
    await expect.poll(() => states.length, { timeout: POLL_TIMEOUT_MS }).toBe(ONE);
    await button.click({ force: true, timeout: CLICK_TIMEOUT_MS }).catch(() => undefined);
    await first;
    expect(states[NONE]).toEqual({ formBusy: 'true', disabled: true, buttonBusy: 'true', loading: true });
    expect(posts).toBe(ONE);
  });
});
