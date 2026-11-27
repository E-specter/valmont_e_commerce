import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';
import {
  FOCUS_RING_MIN,
  INTERACTIVE,
  MIN_TEXT_CONTRAST,
  MIN_UI_CONTRAST,
  TOUCH_TARGET,
  elementState,
  indices,
  openPage,
  sequence,
  textContrast,
} from './helpers/ui-a';

// T-117 · E2E de /dev/ui-a (muestrario del lote 1A de ui/, solo existe con `astro dev`) en 1280 y 375 (proyectos desktop y mobile).
// Las pruebas no conocen el marcado de la página de muestra: localizan por rol, atributos ARIA y estilos calculados.
const PAGE = '/dev/ui-a';
const RED_STRONG = [179, 38, 30]; // --color-red-strong #B3261E (BRIEF §11)
const SLOW = 180_000;
const SETTLE_MS = 120;
const TAB_LIMIT = 150;
const CLIP_PAD = 8;
const WIDTHS = [360, 375, 800, 1280];
const FAR_AWAY = 1;
const MAX_TEXT_CELL = 64; // altura máxima razonable de una franja de damero (BRIEF §1: 16–32 px)
const CHECKER_CELLS = [16, 24, 32, 48, 64];

const open = (page: Page): Promise<void> => openPage(page, PAGE);

const all = async (loc: Locator): Promise<Locator[]> => indices(await loc.count()).map((i) => loc.nth(i));
const interactive = async (page: Page): Promise<Locator[]> => all(page.locator(INTERACTIVE));

test.describe('página de muestra', () => {
  test('carga sin errores de consola ni peticiones a terceros; un h1 y un solo main#contenido', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const external = collectExternalRequests(page);
    await open(page);
    expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(1);
    await expect(page.locator('main#contenido')).toHaveCount(1);
  });

  test('accesibilidad (axe, WCAG 2.2 AA): 0 violaciones', async ({ page }) => {
    await open(page);
    await expectNoA11yViolations(page);
  });

  test('sin desplazamiento horizontal a 360, 375, 800 y 1280 px (RNF04)', async ({ page }) => {
    const overflows = await sequence(WIDTHS, async (width) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page);
      return { width, overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
    });
    expect(overflows.filter((o) => o.overflow > 0)).toEqual([]);
  });

  test('muestra todos los estados que pide el paquete (reposo, deshabilitado, cargando, pulsado, error, enlace externo, icono con nombre)', async ({ page }) => {
    await open(page);
    const count = (selector: string): Promise<number> => page.locator(selector).count();
    expect(await count('main button:disabled'), 'Button/IconButton deshabilitado').toBeGreaterThan(0);
    expect(await count('main [aria-busy="true"]'), 'Button cargando').toBeGreaterThan(0);
    expect(await count('main [aria-pressed="true"]'), 'IconButton pulsado').toBeGreaterThan(0);
    expect(await count('main [aria-pressed="false"]'), 'IconButton sin pulsar').toBeGreaterThan(0);
    expect(await count('main input[aria-invalid="true"]'), 'Field con error').toBeGreaterThan(0);
    expect(await count('main input:disabled'), 'Field deshabilitado').toBeGreaterThan(0);
    expect(await count('main input[readonly]'), 'Field de solo lectura').toBeGreaterThan(0);
    expect(await count('main input[type="password"]'), 'Field con contraseña y acción').toBeGreaterThan(0);
    expect(await count('main input[type="checkbox"]'), 'Checkbox').toBeGreaterThan(0);
    expect(await count('main a[target="_blank"]'), 'TextLink externo').toBeGreaterThan(0);
    expect(await count('main svg[role="img"][aria-label]'), 'Icon con nombre').toBeGreaterThan(0);
    expect(await count('main [aria-hidden="true"]'), 'Checkerboard y los iconos decorativos').toBeGreaterThan(0);
  });
});

test.describe('semántica en el navegador', () => {
  test('todo SVG es decorativo (aria-hidden) o tiene role="img" con nombre', async ({ page }) => {
    await open(page);
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('main svg')]
        .filter((s) => s.getAttribute('aria-hidden') !== 'true' && !(s.getAttribute('role') === 'img' && (s.getAttribute('aria-label') ?? '').trim() !== ''))
        .map((s) => s.outerHTML.slice(0, 80)),
    );
    expect(bad).toEqual([]);
  });

  test('todo control de formulario tiene una etiqueta asociada (for/id o envolvente)', async ({ page }) => {
    await open(page);
    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('main input:not([type="hidden"]), main select, main textarea')]
        .filter((i) => (i.labels?.length ?? 0) === 0 && !i.getAttribute('aria-label'))
        .map((i) => `${i.tagName} #${i.id}`),
    );
    expect(unlabeled).toEqual([]);
  });

  test('cada campo en error: aria-describedby resuelve a un texto visible con --color-red-strong y un icono', async ({ page }) => {
    await open(page);
    const invalid = await all(page.locator('main [aria-invalid="true"]'));
    expect(invalid.length).toBeGreaterThan(0);
    const reports = await sequence(invalid, (loc) =>
      loc.evaluate((el, expected) => {
        const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
        const targets = ids.map((id) => document.getElementById(id)).filter((t): t is HTMLElement => t !== null);
        const parse = (c: string): number[] => c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replaceAll(',', ' ').replaceAll('/', ' ').split(' ').filter(Boolean).map((p) => Math.round(parseFloat(p)));
        const redTexts = targets.filter((t) => {
          const [r, g, b] = parse(getComputedStyle(t).color);
          return r === expected[0] && g === expected[1] && b === expected[2];
        });
        const scope = el.closest('div, fieldset, label, p') ?? el.parentElement;
        return {
          id: el.id,
          resolved: targets.length === ids.length && ids.length > 0,
          visibleText: targets.some((t) => (t.textContent ?? '').trim() !== '' && t.getBoundingClientRect().height > 0),
          red: redTexts.length > 0,
          icon: targets.some((t) => t.querySelector('svg') !== null || t.parentElement?.querySelector(':scope > svg') != null) && scope !== null,
        };
      }, RED_STRONG),
    );
    expect(reports.filter((r) => !(r.resolved && r.visibleText && r.red && r.icon))).toEqual([]);
  });

  test('el borde de un campo normal alcanza 3:1 y el campo tiene fondo propio (BRIEF §12.3)', async ({ page }) => {
    await open(page);
    const field = page
      .locator('main input:not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]):not([aria-invalid="true"])')
      .first();
    const report = await field.evaluate((el, min) => {
      const K = { byte: 255, knee: 0.03928, lo: 12.92, off: 0.055, gain: 1.055, gamma: 2.4, flare: 0.05, r: 0.2126, g: 0.7152, b: 0.0722 };
      const parse = (c: string): number[] => {
        const parts = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replaceAll(',', ' ').replaceAll('/', ' ').split(' ').filter(Boolean).map((p) => parseFloat(p));
        return [parts[0], parts[1], parts[2], parts[3] ?? 1];
      };
      const chain = (n: Element | null): Element[] => (n ? [n, ...chain(n.parentElement)] : []);
      const effective = (n: Element | null): number[] => {
        const layers = chain(n).map((x) => parse(getComputedStyle(x).backgroundColor)).filter((l) => l[3] > 0);
        const first = layers.findIndex((l) => l[3] >= 1);
        const used = first === -1 ? layers : layers.slice(0, first + 1);
        return [...used].reverse().reduce((acc, l) => acc.map((v, i) => l[i] * l[3] + v * (1 - l[3])), [K.byte, K.byte, K.byte]);
      };
      const lin = (v: number): number => {
        const s = v / K.byte;
        return s <= K.knee ? s / K.lo : ((s + K.off) / K.gain) ** K.gamma;
      };
      const lum = (c: number[]): number => K.r * lin(c[0]) + K.g * lin(c[1]) + K.b * lin(c[2]);
      const ratio = (a: number[], b: number[]): number => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + K.flare) / (lo + K.flare);
      };
      // El borde puede dibujarse en el input o en su envoltorio (campos con icono): se toma el más cercano con borde.
      const bordered = chain(el).slice(0, 3).find((n) => parseFloat(getComputedStyle(n).borderTopWidth) > 0);
      if (!bordered) return { ok: false, why: 'ni el input ni sus envoltorios tienen borde' };
      const cs = getComputedStyle(bordered);
      const inside = effective(bordered);
      const outside = effective(bordered.parentElement);
      const raw = parse(cs.borderTopColor);
      const border = [0, 1, 2].map((i) => raw[i] * raw[3] + inside[i] * (1 - raw[3]));
      const hasFill = parse(cs.backgroundColor)[3] > 0 || parse(getComputedStyle(el).backgroundColor)[3] > 0;
      return {
        ok: hasFill && ratio(border, outside) >= min && ratio(border, inside) >= min,
        why: `fondo propio=${hasFill}; borde/exterior=${ratio(border, outside).toFixed(2)}; borde/interior=${ratio(border, inside).toFixed(2)}`,
      };
    }, MIN_UI_CONTRAST);
    expect(report.ok, report.why).toBe(true);
  });

  test('TextLink externo: rel con noopener y noreferrer', async ({ page }) => {
    await open(page);
    const rels = await page.locator('main a[target="_blank"]').evaluateAll((els) => els.map((a) => a.getAttribute('rel') ?? ''));
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.filter((r) => !(r.includes('noopener') && r.includes('noreferrer')))).toEqual([]);
  });

  test('Wordmark: texto "Valmont" en mayúsculas por CSS, con la familia de marca, y legible sobre su fondo', async ({ page }) => {
    await open(page);
    const marks = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() === 'Valmont')
        .map((e) => {
          const s = getComputedStyle(e);
          return { transform: s.textTransform, family: s.fontFamily.toLowerCase(), upper: (e as HTMLElement).innerText };
        }),
    );
    expect(marks.length, 'la muestra no incluye el Wordmark').toBeGreaterThan(0);
    marks.forEach((m) => {
      expect(m.transform).toBe('uppercase');
      expect(m.family).toContain('jaro');
      expect(m.upper).toBe('VALMONT');
    });
    const texts = await all(page.getByText('Valmont', { exact: true }));
    const ratios = await sequence(texts, async (t) => (await textContrast(t)).ratio);
    expect(ratios.filter((r) => r < MIN_TEXT_CONTRAST)).toEqual([]);
  });

  test('Checkerboard: decorativo, toca los bordes de su contenedor y su franja mide una celda', async ({ page }) => {
    await open(page);
    const boards = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main [aria-hidden="true"]')]
        .filter((e) => getComputedStyle(e).backgroundImage.includes('conic-gradient'))
        .map((e) => {
          const r = e.getBoundingClientRect();
          const p = (e.parentElement as HTMLElement).getBoundingClientRect();
          return { left: Math.abs(r.left - p.left), right: Math.abs(r.right - p.right), height: r.height, ownChildren: e.children.length };
        }),
    );
    expect(boards.length, 'no hay ningún Checkerboard (gradiente cónico) en la muestra').toBeGreaterThan(0);
    expect(boards.filter((b) => b.left > FAR_AWAY || b.right > FAR_AWAY), 'no toca los bordes laterales del contenedor').toEqual([]);
    expect(boards.filter((b) => b.height > MAX_TEXT_CELL || !CHECKER_CELLS.some((c) => b.height % c === 0)).map((b) => b.height)).toEqual([]);
    expect(boards.filter((b) => b.ownChildren > 0)).toEqual([]);
  });
});

test.describe('objetivos táctiles y contraste', () => {
  test('todo interactivo ofrece un objetivo de 44 × 44 (también los dibujos de 32 y las casillas de 20)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const els = await interactive(page);
    expect(els.length).toBeGreaterThan(0);
    const reports = await sequence(els, async (loc) => {
      const state = await elementState(loc);
      const result = await loc.evaluate((el, size) => {
        const input = el as HTMLInputElement;
        const target: Element = (input.type === 'checkbox' || input.type === 'radio') && input.labels?.[0] ? input.labels[0] : el;
        target.scrollIntoView({ block: 'center', inline: 'center' });
        const r = target.getBoundingClientRect();
        if (getComputedStyle(target).display === 'inline') return { skip: 'enlace en línea (excepción WCAG 2.5.8)', ok: true, detail: '' };
        if (r.width === 0 || r.height === 0) return { skip: 'sin caja', ok: true, detail: '' };
        const half = size / 2 - 1;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const probes = [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]];
        const misses = probes.filter(([dx, dy]) => {
          const hit = document.elementFromPoint(cx + dx, cy + dy);
          return !(hit && (target.contains(hit) || el.contains(hit) || hit === el));
        });
        return { skip: null, ok: misses.length === 0, detail: `${Math.round(r.width)}×${Math.round(r.height)}` };
      }, TOUCH_TARGET);
      return { who: `${state.tag}${state.type ? `[${state.type}]` : ''} "${state.text}"`, ...result };
    });
    expect(reports.filter((r) => !r.ok).map((r) => `${r.who} (${r.detail})`)).toEqual([]);
  });

  test('el texto de cada botón y enlace alcanza 4,5:1 en reposo y con hover (los deshabilitados están exentos)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const els = await all(page.locator('main button, main a[href]'));
    const reports = await sequence(els, async (loc) => {
      const state = await elementState(loc);
      if (state.disabled || state.text === '') return null;
      await loc.scrollIntoViewIfNeeded();
      await page.mouse.move(FAR_AWAY, FAR_AWAY);
      const rest = await textContrast(loc);
      await loc.hover();
      await page.waitForTimeout(SETTLE_MS);
      const hover = await textContrast(loc);
      return { who: `${state.tag} "${state.text}"`, rest: rest.ratio, hover: hover.ratio };
    });
    const checked = reports.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.filter((r) => r.rest < MIN_TEXT_CONTRAST || r.hover < MIN_TEXT_CONTRAST)).toEqual([]);
  });
});

test.describe('teclado y estados visibles', () => {
  /** Recorre con Tab los controles de `main` y comprueba, por píxeles, que el foco cambia lo que se ve. */
  async function walkTabs(page: Page, left: number, acc: Record<string, unknown>[] = []): Promise<Record<string, unknown>[]> {
    if (left === 0) return acc;
    // Los primeros Tab pueden caer en el enlace "Saltar al contenido" (fuera de main): no cuentan.
    await page.keyboard.press('Tab');
    const info = await page.evaluate((pad) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { end: true };
      if (!el.closest('main')) return { skip: true };
      const target = el.closest('label') ?? el;
      const r = target.getBoundingClientRect();
      const s = getComputedStyle(el);
      const x = Math.max(0, Math.floor(r.left - pad));
      const y = Math.max(0, Math.floor(r.top - pad));
      return {
        who: `${el.tagName.toLowerCase()}${(el as HTMLInputElement).type ? `[${(el as HTMLInputElement).type}]` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}"`,
        tag: el.tagName.toLowerCase(),
        // El kit de /dev fija el foco con la clase `is-focus`: ese anillo no cambia al desenfocar.
        forced: el.className.toString().includes('is-focus'),
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        clip: { x, y, width: Math.min(innerWidth - x, Math.ceil(r.width + pad * 2)), height: Math.min(innerHeight - y, Math.ceil(r.height + pad * 2)) },
        outlineWidth: parseFloat(s.outlineWidth),
        outlineStyle: s.outlineStyle,
        outlineOffset: parseFloat(s.outlineOffset),
      };
    }, CLIP_PAD);
    if ('end' in info) return acc;
    if ('skip' in info) return acc.length > 0 ? acc : walkTabs(page, left - 1, acc);
    const focused = await page.screenshot({ clip: info.clip, animations: 'disabled' });
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.waitForTimeout(SETTLE_MS);
    const blurred = await page.screenshot({ clip: info.clip, animations: 'disabled' });
    return walkTabs(page, left - 1, [...acc, { ...info, changed: !focused.equals(blurred) }]);
  }

  test('Tab recorre los controles habilitados y cada parada cambia lo que se ve (foco visible)', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const stops = (await walkTabs(page, TAB_LIMIT)) as { who: string; tag: string; disabled: boolean; forced: boolean; changed: boolean; outlineWidth: number; outlineStyle: string; outlineOffset: number }[];
    expect(stops.length, 'la muestra debería tener muchos controles tabulables').toBeGreaterThan(indices(10).length);
    expect(stops.filter((s) => s.disabled).map((s) => s.who), 'un control deshabilitado recibió el foco').toEqual([]);
    expect(stops.filter((s) => !s.changed && !s.forced).map((s) => s.who), 'paradas sin indicador de foco visible').toEqual([]);
    // BRIEF §7: anillo de 2 px con separación >= 2 en botones y enlaces.
    const rings = stops.filter((s) => s.tag === 'button' || s.tag === 'a');
    expect(rings.filter((s) => s.outlineStyle === 'none' || s.outlineWidth < FOCUS_RING_MIN || s.outlineOffset < FOCUS_RING_MIN).map((s) => s.who)).toEqual([]);
  });

  test('hover: cada interactivo habilitado cambia de aspecto al pasar el ratón', async ({ page }) => {
    test.setTimeout(SLOW);
    await open(page);
    const els = await interactive(page);
    const reports = await sequence(els, async (loc) => {
      const state = await elementState(loc);
      if (state.disabled || state.forced) return null;
      const target = state.hasLabelTarget ? (await loc.evaluateHandle((e) => (e as HTMLInputElement).labels![0])).asElement()! : loc.elementHandle();
      const handle = await target;
      await handle!.scrollIntoViewIfNeeded();
      const box = await handle!.boundingBox();
      if (!box || box.width === 0) return null;
      const clip = {
        x: Math.max(0, box.x - CLIP_PAD),
        y: Math.max(0, box.y - CLIP_PAD),
        width: box.width + CLIP_PAD * 2,
        height: box.height + CLIP_PAD * 2,
      };
      await page.mouse.move(FAR_AWAY, FAR_AWAY);
      await page.waitForTimeout(SETTLE_MS);
      const rest = await page.screenshot({ clip, animations: 'disabled' });
      await handle!.hover();
      await page.waitForTimeout(SETTLE_MS);
      const over = await page.screenshot({ clip, animations: 'disabled' });
      return { who: `${state.tag}${state.type ? `[${state.type}]` : ''} "${state.text}"`, changed: !rest.equals(over) };
    });
    const checked = reports.filter((r): r is NonNullable<typeof r> => r !== null);
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.filter((r) => !r.changed).map((r) => r.who)).toEqual([]);
  });

  test('Button: Enter y Espacio activan un <button>; Espacio alterna una casilla', async ({ page }) => {
    await open(page);
    const btn = page.locator('main button[type="button"]:not([disabled]):not([aria-busy="true"])').first();
    await btn.evaluate((el) => {
      (window as unknown as { __clicks: number }).__clicks = 0;
      el.addEventListener('click', () => ((window as unknown as { __clicks: number }).__clicks += 1));
    });
    await btn.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);

    const box = page.locator('main input[type="checkbox"]:not([disabled])').first();
    await box.focus();
    expect(await box.isChecked()).toBe(false);
    await page.keyboard.press('Space');
    expect(await box.isChecked()).toBe(true);
    await page.keyboard.press('Space');
    expect(await box.isChecked()).toBe(false);
  });

  test('clic en la etiqueta enfoca el campo (for/id) y en la de la casilla la alterna', async ({ page }) => {
    await open(page);
    const input = page.locator('main input[type="text"]:not([disabled]):not([readonly]), main input[type="email"]:not([disabled]):not([readonly])').first();
    const id = await input.getAttribute('id');
    await page.locator(`label[for="${id}"]`).click();
    await expect(input).toBeFocused();

    const box = page.locator('main input[type="checkbox"]:not([disabled])').first();
    const was = await box.isChecked();
    await box.evaluate((el) => (el as HTMLInputElement).labels![0].click());
    expect(await box.isChecked()).toBe(!was);
  });

  test('un Button cargando no se puede pulsar ni recibir foco con Tab, y anuncia "Cargando"', async ({ page }) => {
    await open(page);
    const busy = await all(page.locator('main button[aria-busy="true"]'));
    expect(busy.length).toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as unknown as { __busyClicks: number }).__busyClicks = 0;
      document.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button[aria-busy="true"]')) (window as unknown as { __busyClicks: number }).__busyClicks += 1;
      }, true);
    });
    await sequence(busy, (loc) => loc.click({ force: true }));
    expect(await page.evaluate(() => (window as unknown as { __busyClicks: number }).__busyClicks)).toBe(0);
    const texts = await sequence(busy, (loc) => loc.evaluate((el) => (el.textContent ?? '').toLowerCase()));
    expect(texts.filter((t) => !t.includes('cargando'))).toEqual([]);
  });

  test('prefers-reduced-motion: reduce deja todas las transiciones y animaciones en ~0', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const slow = await page.evaluate(() => {
      const longest = (value: string): number => Math.max(...value.split(',').map((v) => parseFloat(v)));
      return [...document.querySelectorAll('main, main *')]
        .map((e) => {
          const s = getComputedStyle(e);
          return { tag: e.tagName.toLowerCase(), t: longest(s.transitionDuration), a: longest(s.animationDuration) };
        })
        .filter((x) => x.t > 0.001 || x.a > 0.001)
        .map((x) => x.tag);
    });
    expect(slow).toEqual([]);
  });
});
