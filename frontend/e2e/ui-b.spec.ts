import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import { FOCUS_RING_MIN, INTERACTIVE, MIN_TEXT_CONTRAST, TOUCH_TARGET, indices, openPage, sequence, textContrast } from './helpers/ui-a';

// T-118 · E2E de /dev/ui-b (muestrario del lote 1B de ui/, solo existe con `astro dev`) en 1280 y 375 (proyectos desktop y mobile).
// Las pruebas no conocen el marcado de la página de muestra: localizan por texto, rol, atributos ARIA y estilos calculados.
const PAGE = '/dev/ui-b';
const SLOW = 180_000;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const VIEWPORT_HEIGHT = 800;
const TAB_LIMIT = 150;
const NONE = 0;
const ONE = 1;
const TINY_BOX = 1; // un texto "sr-only" mide 1 × 1 px
const MOTION_EPSILON = 0.001;
const OVERLAP_TOLERANCE = 1; // px
const MIN_TARGET_AA = 24; // WCAG 2.2 SC 2.5.8
const MARK = 'data-qa-text';

const open = (page: Page): Promise<void> => openPage(page, PAGE);
const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));
const main = (page: Page): Locator => page.locator('main#contenido');

test.describe('página de muestra', () => {
  test('carga sin errores de consola ni peticiones a terceros; un h1 y un solo main#contenido', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page);
    await open(page);
    expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
    await expect(page.locator('main#contenido')).toHaveCount(ONE);
  });

  test('accesibilidad (axe, WCAG 2.2 AA): 0 violaciones', async ({ page }) => {
    await open(page);
    await expectNoA11yViolations(page);
  });

  test('sin desplazamiento horizontal a 360, 375, 800 y 1280 px (RNF04)', async ({ page }) => {
    const overflows = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await open(page);
      return { width, overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
    });
    expect(overflows.filter((o) => o.overflow > NONE)).toEqual([]);
  });

  test('todo SVG de la muestra es decorativo (aria-hidden) o tiene role="img" con nombre', async ({ page }) => {
    await open(page);
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('main svg')]
        .filter((s) => s.getAttribute('aria-hidden') !== 'true' && !(s.getAttribute('role') === 'img' && (s.getAttribute('aria-label') ?? '').trim() !== ''))
        .map((s) => s.outerHTML.split('>')[0]),
    );
    expect(bad).toEqual([]);
  });
});

test.describe('contraste y superficies', () => {
  test('todo texto visible de la muestra alcanza 4,5:1 sobre su fondo efectivo (los inactivos están exentos)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    await page.evaluate((mark) => {
      document.querySelectorAll('main *').forEach((e) => {
        const hasText = (e.textContent ?? '').trim() !== '';
        if (e.children.length === 0 && hasText && !e.closest('[aria-disabled="true"], [aria-hidden="true"], svg, del')) e.setAttribute(mark, 'true');
      });
    }, MARK);
    const leaves = await all(page.locator(`[${MARK}]`));
    expect(leaves.length, 'la muestra debería tener texto que medir').toBeGreaterThan(NONE);
    const reports = await sequence(leaves, async (loc) => {
      const label = ((await loc.textContent()) ?? '').trim();
      return { label, ratio: (await textContrast(loc)).ratio };
    });
    expect(reports.filter((r) => r.ratio < MIN_TEXT_CONTRAST).map((r) => `"${r.label}" ${String(r.ratio)}`)).toEqual([]);
  });

  test('ninguna superficie dibuja sombra (BRIEF §4: planas con borde)', async ({ page }) => {
    await open(page);
    const shadows = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => getComputedStyle(e).boxShadow !== 'none')
        .map((e) => `${e.tagName.toLowerCase()}.${e.className.toString()}`),
    );
    expect(shadows).toEqual([]);
  });
});

test.describe('Availability', () => {
  const dotNear = (loc: Locator): Promise<boolean> =>
    loc.first().evaluate((el) => {
      const hasDot = (n: Element | null): boolean =>
        n !== null &&
        (n.querySelector('[aria-hidden="true"]') !== null ||
          ['::before', '::after'].some((p) => !['none', 'normal'].includes(getComputedStyle(n, p).content)));
      return [el, el.parentElement].some(hasDot);
    });

  test('los 4 estados se muestran con su texto visible (D-023) y un punto, no solo con color', async ({ page }) => {
    await open(page);
    const m = main(page);
    const states = [
      m.getByText('En stock', { exact: true }),
      m.getByText('Quedan pocas unidades', { exact: true }),
      m.getByText('Agotado', { exact: true }),
      m.getByText('Bajo pedido, entrega estimada en', { exact: false }),
      m.getByText('Bajo pedido', { exact: true }),
    ];
    await sequence(states, async (loc) => {
      await expect(loc.first()).toBeVisible();
      expect(await dotNear(loc), 'sin punto junto al texto').toBe(true);
    });
  });

  test('"Bajo pedido" con plazo nombra los días ("… en N días") y nunca hay cantidades de stock', async ({ page }) => {
    await open(page);
    const lead = main(page).getByText('Bajo pedido, entrega estimada en', { exact: false }).first();
    const out = ((await lead.textContent()) ?? '').trim();
    expect(out.endsWith('días') || out.endsWith('día')).toBe(true);
    const bare = await main(page).getByText('Quedan pocas unidades', { exact: true }).first().textContent();
    expect(bare?.trim()).toBe('Quedan pocas unidades');
  });
});

test.describe('Price', () => {
  test('los importes enteros no llevan ".00" (P-3)', async ({ page }) => {
    await open(page);
    const text = (await main(page).innerText()).replaceAll(' ', ' ');
    expect(text.includes('.00')).toBe(false);
  });

  test('hay precios con fracción (dos decimales) y sin ella', async ({ page }) => {
    await open(page);
    const prices = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => e.children.length === 0 && (e.textContent ?? '').trim().startsWith('S/'))
        .map((e) => (e.textContent ?? '').trim()),
    );
    expect(prices.length).toBeGreaterThan(NONE);
    expect(prices.some((p) => p.includes('.')), 'falta un precio con decimales').toBe(true);
    expect(prices.some((p) => !p.includes('.')), 'falta un precio entero').toBe(true);
  });

  test('con promoción: el original va tachado (<del>, line-through) y el texto "Precio original" está oculto a la vista', async ({ page }) => {
    await open(page);
    const dels = await all(page.locator('main del'));
    expect(dels.length, 'la muestra debe incluir un precio con promoción').toBeGreaterThan(NONE);
    const lines = await sequence(dels, (d) => d.evaluate((el) => getComputedStyle(el).textDecorationLine));
    lines.forEach((l) => expect(l).toContain('line-through'));
    const hidden = main(page).getByText('Precio original', { exact: false }).first();
    const box = await hidden.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    expect(box.w).toBeLessThanOrEqual(TINY_BOX);
    expect(box.h).toBeLessThanOrEqual(TINY_BOX);
  });

  test('"Ahorras S/ X" es visible y no está tachado', async ({ page }) => {
    await open(page);
    const saving = main(page).getByText('Ahorras', { exact: false }).first();
    await expect(saving).toBeVisible();
    expect(await saving.evaluate((el) => el.closest('del') === null)).toBe(true);
  });

  test('los importes usan cifras tabulares (tabular-nums)', async ({ page }) => {
    await open(page);
    const variants = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => e.children.length === 0 && (e.textContent ?? '').trim().startsWith('S/'))
        .map((e) => getComputedStyle(e).fontVariantNumeric),
    );
    expect(variants.length).toBeGreaterThan(NONE);
    expect(variants.filter((v) => !v.includes('tabular-nums'))).toEqual([]);
  });
});

test.describe('Notice, EmptyState y Skeleton', () => {
  test('hay avisos con role="alert" (error) y role="status" (los demás), cada uno con icono y texto', async ({ page }) => {
    await open(page);
    const alerts = await all(main(page).locator('[role="alert"]'));
    const statuses = await all(main(page).locator('[role="status"]'));
    expect(alerts.length, 'falta el aviso de error').toBeGreaterThan(NONE);
    expect(statuses.length, 'faltan los avisos informativos').toBeGreaterThan(NONE);
    const checks = await sequence([...alerts, ...statuses], (n) =>
      n.evaluate((el) => ({
        icon: el.querySelector('svg[aria-hidden="true"]') !== null,
        text: (el.textContent ?? '').trim() !== '',
      })),
    );
    expect(checks.filter((c) => !c.icon || !c.text)).toEqual([]);
  });

  test('hay un estado vacío con encabezado (h2 a h4) y nunca un segundo h1', async ({ page }) => {
    await open(page);
    expect(await main(page).locator('h2, h3, h4').count()).toBeGreaterThan(NONE);
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(ONE);
  });

  test('el esqueleto es aria-hidden, está animado y se detiene con prefers-reduced-motion', async ({ page }) => {
    const running = (): Promise<number> =>
      page.evaluate((eps) => {
        const seconds = (v: string): number => Math.max(...v.split(',').map((x) => parseFloat(x)));
        return [...document.querySelectorAll('main *')].filter((e) => {
          const s = getComputedStyle(e);
          return s.animationName !== 'none' && seconds(s.animationDuration) > eps;
        }).length;
      }, MOTION_EPSILON);
    await open(page);
    expect(await running(), 'ningún esqueleto animado en la muestra').toBeGreaterThan(NONE);
    const exposed = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => getComputedStyle(e).animationName !== 'none' && e.closest('[aria-hidden="true"]') === null)
        .map((e) => e.tagName.toLowerCase()),
    );
    expect(exposed, 'elementos animados visibles para lectores de pantalla').toEqual([]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    expect(await running()).toBe(NONE);
  });
});

test.describe('Chip', () => {
  test('hay un chip activo con aria-current="true" y otros sin él', async ({ page }) => {
    await open(page);
    expect(await main(page).locator('a[aria-current="true"]').count()).toBeGreaterThan(NONE);
    expect(await main(page).locator('a[href]:not([aria-current])').count()).toBeGreaterThan(NONE);
  });

  test('el chip no interactivo (aria-disabled) no es enlace ni botón ni entra en la tabulación', async ({ page }) => {
    await open(page);
    const inert = await all(main(page).locator('[aria-disabled="true"]'));
    expect(inert.length, 'la muestra debe incluir un chip as="span"').toBeGreaterThan(NONE);
    const reports = await sequence(inert, (loc) =>
      loc.evaluate((el) => ({ tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), focusable: el.matches('a[href], button, input, select, textarea') })),
    );
    expect(reports.filter((r) => r.focusable || r.tabindex !== null)).toEqual([]);
  });

  test('los chips removibles ofrecen un enlace "Quitar filtro {etiqueta}"', async ({ page }) => {
    await open(page);
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('main a[href]')]
        .map((a) => a.getAttribute('aria-label') ?? (a.textContent ?? '').trim())
        .filter((n) => n.startsWith('Quitar filtro ')),
    );
    expect(names.length).toBeGreaterThan(NONE);
    names.forEach((n) => expect(n.length).toBeGreaterThan('Quitar filtro '.length));
  });

  test('no hay enlaces anidados en los chips removibles', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.querySelectorAll('main a a').length)).toBe(NONE);
  });
});

test.describe('teclado y objetivos', () => {
  async function walkTabs(page: Page, left: number, acc: Record<string, unknown>[] = []): Promise<Record<string, unknown>[]> {
    if (left === NONE) return acc;
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { end: true };
      if (!el.closest('main')) return { skip: true };
      const s = getComputedStyle(el);
      return {
        who: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}"`,
        inert: el.getAttribute('aria-disabled') === 'true',
        outlineWidth: parseFloat(s.outlineWidth),
        outlineStyle: s.outlineStyle,
        outlineOffset: parseFloat(s.outlineOffset),
      };
    });
    if ('end' in info) return acc;
    return walkTabs(page, left - ONE, 'skip' in info ? acc : [...acc, info]);
  }

  test('Tab recorre los enlaces y botones; ninguno inactivo recibe el foco y cada parada tiene anillo de 2 px', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const stops = (await walkTabs(page, TAB_LIMIT)) as { who: string; inert: boolean; outlineWidth: number; outlineStyle: string; outlineOffset: number }[];
    expect(stops.length, 'la muestra debería tener controles tabulables').toBeGreaterThan(NONE);
    expect(stops.filter((s) => s.inert).map((s) => s.who), 'un chip inactivo recibió el foco').toEqual([]);
    expect(stops.filter((s) => s.outlineStyle === 'none' || s.outlineWidth < FOCUS_RING_MIN || s.outlineOffset < FOCUS_RING_MIN).map((s) => s.who)).toEqual([]);
  });

  test('todo enlace o botón que no sea texto en línea mide al menos 24 × 24 (WCAG 2.2 AA, 2.5.8)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const els = await all(page.locator(INTERACTIVE));
    expect(els.length).toBeGreaterThan(NONE);
    const reports = await sequence(els, (loc) =>
      loc.evaluate((el, size) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const inline = getComputedStyle(el).display === 'inline';
        const small = r.width < size || r.height < size;
        return { who: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}"`, bad: !inline && r.width > 0 && small, size: `${Math.round(r.width)}×${Math.round(r.height)}` };
      }, MIN_TARGET_AA),
    );
    expect(reports.filter((r) => r.bad).map((r) => `${r.who} (${r.size})`)).toEqual([]);
  });


  test('todo enlace o botón que no sea texto en línea ofrece un objetivo de 44 × 44 (RT-4)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const els = await all(page.locator(INTERACTIVE));
    expect(els.length).toBeGreaterThan(NONE);
    const reports = await sequence(els, (loc) =>
      loc.evaluate((el, size) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const inline = getComputedStyle(el).display === 'inline';
        const small = r.width < size || r.height < size;
        return { who: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}"`, bad: !inline && r.width > 0 && small, size: `${Math.round(r.width)}×${Math.round(r.height)}` };
      }, TOUCH_TARGET),
    );
    expect(reports.filter((r) => r.bad).map((r) => `${r.who} (${r.size})`)).toEqual([]);
  });

  test('los objetivos de una misma fila de chips no se solapan y cada centro pulsa su propio control', async ({ page }) => {
    await open(page);
    const boxes = await page.evaluate((sel) =>
      [...document.querySelectorAll(sel)].map((el, i) => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { i, who: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(), l: r.left, t: r.top + scrollY, r: r.right, b: r.bottom + scrollY, own: hit !== null && (el === hit || el.contains(hit)) };
      }),
    INTERACTIVE);
    const overlaps = boxes.flatMap((a) => boxes.filter((b) => b.i > a.i && Math.abs((a.t + a.b) / 2 - (b.t + b.b) / 2) < OVERLAP_TOLERANCE * 4 && Math.min(a.r, b.r) - Math.max(a.l, b.l) > OVERLAP_TOLERANCE && Math.min(a.b, b.b) - Math.max(a.t, b.t) > OVERLAP_TOLERANCE).map((b) => `"${a.who}" × "${b.who}"`));
    expect(overlaps).toEqual([]);
    expect(boxes.filter((b) => !b.own).map((b) => b.who), 'el centro de estos controles lo recibe otro elemento').toEqual([]);
  });
});
