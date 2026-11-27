import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { openPage } from './helpers/ui-a';

// T-135 · corrección visual C (D-10; REVIEW-2026-11-27): pie de tarjeta homogéneo en una fila.
// Contra el backend real (:8000, semilla `seed_dev`). Comprueba el resultado visible (geometría y estilos calculados), no el código.
// `/dev/products` trae nombres largos y precios con y sin descuento; `/relojes` los datos reales.
const SLOW = 180_000;
const NONE = 0;
const ONE = 1;
const WIDTH_SMALL = 360;
const WIDTH_PHONE = 375;
const WIDTH_TABLET = 800;
const WIDTH_DESKTOP = 1280;
const WIDTHS = [WIDTH_SMALL, WIDTH_PHONE, WIDTH_TABLET, WIDTH_DESKTOP];
const ALIGN_WIDTHS = [WIDTH_TABLET, WIDTH_DESKTOP];
const COLUMNS = 2;
const NARROWER_STEP_PX = 40;
const SETTLE_MS = 100;
const VIEWPORT_HEIGHT = 900;
const TOLERANCE_PX = 1;
const CLS_LIMIT = 0.001;
const NARROW_CARD_PX = 240;
const REAL_MIN_CARD_PX = 288;
const GRID_GAP_PX = 24;
const VARIANTS = ['store', 'related', 'wishlist'] as const;

type Rect = { top: number; bottom: number; left: number; right: number };
type CardGeometry = {
  slug: string;
  top: number;
  hasDiscount: boolean;
  name: string;
  foot: Rect;
  price: Rect;
  more: Rect | null;
  cta: Rect | null;
  availability: (Rect & { text: string; inFoot: boolean; visible: boolean; hasDot: boolean }) | null;
  card: Rect & { scrollWidth: number; clientWidth: number };
};
type Row = CardGeometry[];

async function openAt(page: Page, path: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await openPage(page, path);
}

/** Geometría de cada tarjeta de las rejillas de `main` (una lista por `ul[aria-label]`), agrupadas por fila visual. */
async function measureGrids(page: Page): Promise<{ variant: string; rows: Row[] }[]> {
  return page.evaluate(() => {
    const r = (e: Element): { top: number; bottom: number; left: number; right: number } => {
      const b = e.getBoundingClientRect();
      return { top: b.top + window.scrollY, bottom: b.bottom + window.scrollY, left: b.left, right: b.right };
    };
    const grids = [...document.querySelectorAll('main .product-grid')];
    return grids.map((g) => {
      const cards: CardGeometry[] = [...g.querySelectorAll('article.product-card')].map((a) => {
        const foot = a.querySelector('.foot') as HTMLElement;
        const price = foot.querySelector('.price') as HTMLElement;
        const more = foot.querySelector('.more');
        const cta = foot.querySelector('.cta');
        const av = a.querySelector('.availability') as HTMLElement | null;
        const avText = av?.querySelector('span:not(.dot)');
        const cs = av ? getComputedStyle(av) : null;
        const ab = av?.getBoundingClientRect();
        return {
          slug: (a.querySelector('a')?.getAttribute('href') ?? '').split('/').pop() ?? '',
          top: r(a).top,
          hasDiscount: price.querySelector('del, .saving') !== null,
          name: a.querySelector('.name')?.textContent?.trim() ?? '',
          foot: r(foot),
          price: r(price),
          more: more ? r(more) : null,
          cta: cta ? r(cta) : null,
          availability: av
            ? {
                ...r(av),
                text: (avText?.textContent ?? '').trim(),
                inFoot: foot.contains(av),
                visible: !!cs && !!ab && cs.display !== 'none' && cs.visibility !== 'hidden' && ab.width > 0 && ab.height > 0,
                hasDot: av.querySelector('.dot') !== null,
              }
            : null,
          card: { ...r(a), scrollWidth: (a as HTMLElement).scrollWidth, clientWidth: (a as HTMLElement).clientWidth },
        };
      });
      const rows = new Map<number, CardGeometry[]>();
      cards.forEach((c) => {
        const key = [...rows.keys()].find((k) => Math.abs(k - c.top) <= 1) ?? c.top;
        rows.set(key, [...(rows.get(key) ?? []), c]);
      });
      return { variant: g.getAttribute('data-variant') ?? '', rows: [...rows.values()] };
    });
  });
}

type CardGeometryAlias = CardGeometry; // (el tipo se usa dentro de evaluate solo como forma; se declara arriba)
void (null as unknown as CardGeometryAlias);

const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);

/** Diferencia máxima, dentro de una fila, de cada eje que debe quedar alineado. */
function rowSpreads(row: Row): Record<string, number> {
  const out: Record<string, number> = {
    foot: spread(row.map((c) => c.foot.top)),
    price: spread(row.map((c) => c.price.top)),
    bottom: spread(row.map((c) => c.card.bottom)),
  };
  const mores = row.map((c) => c.more?.top).filter((v): v is number => v !== undefined);
  if (mores.length === row.length) out.more = spread(mores);
  const ctas = row.map((c) => c.cta?.top).filter((v): v is number => v !== undefined);
  if (ctas.length === row.length) out.cta = spread(ctas);
  return out;
}

function expectAligned(rows: Row[], label: string): void {
  const multi = rows.filter((row) => row.length > ONE);
  expect(multi.length, `${label}: hay filas con varias tarjetas`).toBeGreaterThan(NONE);
  multi.forEach((row) => {
    const s = rowSpreads(row);
    Object.entries(s).forEach(([axis, diff]) => {
      expect(diff, `${label}: eje ${axis} con diferencia de ${String(diff)} px en la fila [${row.map((c) => c.slug).join(', ')}]`).toBeLessThanOrEqual(TOLERANCE_PX);
    });
  });
}

test.describe('T-135 · pie de tarjeta alineado entre las tarjetas de una fila', () => {
  test.describe.configure({ timeout: SLOW });

  ALIGN_WIDTHS.forEach((width) => {
    test(`/relojes a ${String(width)} px: top de pie, precio y "Ver detalles" coinciden en cada fila (±1 px)`, async ({ page }) => {
      await openAt(page, '/relojes', width);
      const grids = await measureGrids(page);
      expect(grids.length).toBeGreaterThan(NONE);
      const all = grids.flatMap((g) => g.rows);
      expect(all.flat().length, 'hay tarjetas reales').toBeGreaterThan(ONE);
      // El catálogo real mezcla con y sin descuento y disponibilidades distintas: se exige que el dato lo permita o se avisa.
      expectAligned(all, `/relojes ${String(width)}`);
      const rowsWithMore = all.filter((row) => row.length > ONE && row.every((c) => c.more !== null));
      expect(rowsWithMore.length, 'en store se compara también "Ver detalles"').toBeGreaterThan(NONE);
    });

    test(`/dev/products a ${String(width)} px: store, related y wishlist alinean pie, precio y CTA con y sin descuento y nombres largos`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const grids = await measureGrids(page);
      VARIANTS.forEach((variant) => {
        const grid = grids.find((g) => g.variant === variant);
        expect(grid, `rejilla ${variant}`).toBeDefined();
        const rows = grid?.rows ?? [];
        // La muestra mezcla descuento, nombre largo y disponibilidad larga ("Bajo pedido, entrega estimada en 45 días").
        const cards = rows.flat();
        expect(cards.some((c) => c.hasDiscount)).toBe(true);
        expect(cards.some((c) => !c.hasDiscount)).toBe(true);
        expect(cards.some((c) => c.name.includes('nombre largo'))).toBe(true);
        expect(cards.some((c) => c.availability?.text.includes('entrega estimada'))).toBe(true);
        expectAligned(rows, `/dev/products ${variant} ${String(width)}`);
        // Una fila debe mezclar tarjetas con y sin descuento (si no, la prueba no discrimina).
        expect(rows.some((row) => row.some((c) => c.hasDiscount) && row.some((c) => !c.hasDiscount)), `${variant}: una fila mezcla con/sin descuento`).toBe(true);
      });
    });

    test(`/dev/products a ${String(width)} px: el precio queda a la izquierda y "Ver detalles" a la derecha, en la misma línea`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const grids = await measureGrids(page);
      ['store', 'related'].forEach((variant) => {
        const cards = (grids.find((g) => g.variant === variant)?.rows ?? []).flat();
        expect(cards.length).toBeGreaterThan(NONE);
        cards.forEach((c) => {
          expect(c.more, `${variant} ${c.slug}`).not.toBeNull();
          const more = c.more as Rect;
          expect(more.left, `${c.slug}: el precio queda a la izquierda`).toBeGreaterThan(c.price.left);
          expect(more.left, `${c.slug}: "Ver detalles" a la derecha del precio, sin salto de línea`).toBeGreaterThanOrEqual(c.price.right - TOLERANCE_PX);
          expect(Math.abs(more.top - c.price.top), `${c.slug}: misma altura de arranque`).toBeLessThanOrEqual(TOLERANCE_PX);
          // "Ver detalles" pegado al borde derecho del pie.
          expect(c.foot.right - more.right, `${c.slug}: a la derecha`).toBeLessThanOrEqual(c.foot.right - c.foot.left);
        });
      });
    });
  });
});

test.describe('T-135 · Availability, enlace extendido y contenido de la tarjeta', () => {
  test.describe.configure({ timeout: SLOW });

  WIDTHS.forEach((width) => {
    test(`a ${String(width)} px: Availability visible, con texto y punto, en su propia línea sobre el pie (D-023)`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const grids = await measureGrids(page);
      VARIANTS.forEach((variant) => {
        const cards = (grids.find((g) => g.variant === variant)?.rows ?? []).flat();
        expect(cards.length).toBeGreaterThan(NONE);
        cards.forEach((c) => {
          const av = c.availability;
          expect(av, `${variant} ${c.slug}: tiene disponibilidad`).not.toBeNull();
          const a = av as NonNullable<CardGeometry['availability']>;
          expect(a.visible, `${c.slug}: visible`).toBe(true);
          expect(a.text.length, `${c.slug}: con texto, no solo color`).toBeGreaterThan(NONE);
          expect(a.hasDot, `${c.slug}: con punto`).toBe(true);
          expect(a.inFoot, `${c.slug}: ya no va en el pie`).toBe(false);
          expect(a.bottom, `${c.slug}: sobre el divisor del pie`).toBeLessThanOrEqual(c.foot.top + TOLERANCE_PX);
          expect(a.bottom, `${c.slug}: no se solapa con el precio`).toBeLessThanOrEqual(c.price.top + TOLERANCE_PX);
        });
      });
    });

    test(`a ${String(width)} px: compact sin Availability y sin reserva de pie; la tarjeta no se sale de su contenedor`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const grids = await measureGrids(page);
      const compact = (grids.find((g) => g.variant === 'compact')?.rows ?? []).flat();
      expect(compact.length).toBeGreaterThan(NONE);
      compact.forEach((c) => expect(c.availability, c.slug).toBeNull());
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(NONE);
    });

    test(`a ${String(width)} px: cada tarjeta conserva un único enlace y todo su área (imagen, disponibilidad, pie, precio) lo activa`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const result = await page.evaluate(() =>
        [...document.querySelectorAll('main article.product-card')]
          .filter((a) => a.getAttribute('data-variant') !== 'compact')
          .map((a) => {
            const links = a.querySelectorAll('a');
            const link = links[0];
            const hit = (sel: string): boolean | null => {
              const el = a.querySelector(sel);
              if (!el) return null;
              el.scrollIntoView({ block: 'center' });
              const b = el.getBoundingClientRect();
              const [halfW, halfH] = [b.width / 2, b.height / 2];
              const top = document.elementFromPoint(b.left + halfW, b.top + halfH);
              return top === link;
            };
            return {
              variant: a.getAttribute('data-variant'),
              links: links.length,
              media: hit('.media'),
              availability: hit('.availability'),
              foot: hit('.foot'),
              price: hit('.price .current'),
              more: hit('.more'),
            };
          }),
      );
      expect(result.length).toBeGreaterThan(NONE);
      result.forEach((r) => {
        expect(r.links, JSON.stringify(r)).toBe(ONE);
        // El enlace extendido (::after con inset 0) debe quedar por encima de todo el pie: precio, "Ver detalles" y disponibilidad.
        [r.media, r.availability, r.foot, r.price].forEach((v) => expect(v, JSON.stringify(r)).toBe(true));
        if (r.more !== null) expect(r.more, JSON.stringify(r)).toBe(true);
      });
    });
  });

  test('en /relojes, pulsar en el pie (zona del precio) de la primera tarjeta navega a su ficha', async ({ page }) => {
    await openAt(page, '/relojes', WIDTH_DESKTOP);
    const first = page.locator('main article.product-card').first();
    const href = await first.locator('a').first().getAttribute('href');
    expect(href).toContain('/relojes/');
    await expect(first.locator('a')).toHaveCount(ONE);
    // El enlace extendido cubre el precio: se pulsa con el ratón en sus coordenadas (Playwright rechaza el clic directo porque el <a> intercepta).
    await first.locator('.foot .price').scrollIntoViewIfNeeded();
    const box = await first.locator('.foot .price').boundingBox();
    expect(box).not.toBeNull();
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number };
    await page.mouse.click(x + width / 2, y + height / 2);
    await page.waitForURL(`**${href}`);
    expect(new URL(page.url()).pathname).toBe(href);
  });

  test('/relojes a 1280: el nombre accesible del enlace sigue siendo solo el del producto y la disponibilidad se lee en el texto de la tarjeta', async ({ page }) => {
    await openAt(page, '/relojes', WIDTH_DESKTOP);
    const cards = page.locator('main article.product-card');
    const n = await cards.count();
    expect(n).toBeGreaterThan(ONE);
    const texts = await cards.evaluateAll((els) =>
      els.map((a) => ({
        link: a.querySelector('a')?.textContent?.trim() ?? '',
        name: a.querySelector('.name')?.textContent?.trim() ?? '',
        av: (a.querySelector('.availability') as HTMLElement | null)?.innerText.trim() ?? '',
      })),
    );
    texts.forEach((t) => {
      expect(t.link).toBe(t.name);
      expect(t.av.length).toBeGreaterThan(NONE);
    });
  });
});

test.describe('T-135 · anchos intermedios de ventana (el contenedor cambia de 1 a 2 y 3 columnas)', () => {
  test.describe.configure({ timeout: SLOW });

  // 660 px: 2 columnas de ~290 px, el caso real más estrecho; con descuento y "Ahorras…" el precio envuelve y el pie se desalinea (hallazgo MENOR, solo se informa).
  const MID_WIDTHS = [{ width: 700, hard: true }, { width: 760, hard: true }, { width: 900, hard: true }, { width: 1000, hard: true }, { width: 1100, hard: true }, { width: 660, hard: false }];
  MID_WIDTHS.forEach(({ width, hard }) => {
    test(`a ${String(width)} px: /dev/products y /relojes alinean pie, precio y "Ver detalles" en cada fila${hard ? '' : ' (informe, MENOR)'}`, async ({ page }) => {
      await openAt(page, '/dev/products', width);
      const dev = (await measureGrids(page)).filter((g) => g.variant === 'store' || g.variant === 'related');
      await openAt(page, '/relojes', width);
      const real = (await measureGrids(page)).flatMap((g) => g.rows);
      const rows = [...dev.flatMap((g) => g.rows), ...real].filter((row) => row.length > ONE);
      if (hard) {
        rows.forEach((row) => expectAligned([row], `${String(width)} px`));
      } else {
        const report = rows.map((row) => `${String(Math.round(row[NONE].card.right - row[NONE].card.left))}px:${JSON.stringify(rowSpreads(row))}`);
        test.info().annotations.push({ type: `ancho ${String(width)}`, description: report.join(' | ') });
        console.log(`T135-INFO ${String(width)} ${report.join(' | ')}`);
      }
    });
  });
});

test.describe('T-135 · tarjeta muy estrecha (riesgo del dev: precio original a 3 líneas)', () => {
  test.describe.configure({ timeout: SLOW });

  // 288 px es la tarjeta más estrecha de una rejilla real (contenedor de 600 px en 2 columnas) y 240 px el riesgo citado por el dev:
  // en ambas la alineación solo se informa (hallazgo MENOR: el precio envuelve), pero no puede haber desbordamiento. 200 px solo se informa.
  const CASES = [
    { cardWidth: REAL_MIN_CARD_PX, hardAlign: false, hardOverflow: true },
    { cardWidth: NARROW_CARD_PX, hardAlign: false, hardOverflow: true },
    { cardWidth: NARROW_CARD_PX - NARROWER_STEP_PX, hardAlign: false, hardOverflow: false },
  ];

  CASES.forEach(({ cardWidth, hardAlign, hardOverflow }) => {
    test(`dos columnas de ${String(cardWidth)} px (store y related): ${hardOverflow ? 'la tarjeta no se desborda' : 'informe de desbordamiento'}; ${hardAlign ? 'pie alineado' : 'informe de alineación'}`, async ({ page }) => {
      await openAt(page, '/dev/products', WIDTH_DESKTOP);
      await page.evaluate(
        ({ w, gap, cols }) => {
          document.querySelectorAll<HTMLElement>('main .product-grid').forEach((g) => {
            g.setAttribute('style', `width: ${String(w * cols + gap)}px`);
            g.querySelector('ul')?.setAttribute('style', `grid-template-columns: repeat(${String(cols)}, 1fr); gap: ${String(gap)}px`);
          });
        },
        { w: cardWidth, gap: GRID_GAP_PX, cols: COLUMNS },
      );
      await page.waitForTimeout(SETTLE_MS);
      const grids = (await measureGrids(page)).filter((g) => g.variant === 'store' || g.variant === 'related');
      const overflow = grids
        .flatMap((g) => g.rows.flat())
        .filter((c) => c.card.scrollWidth > c.card.clientWidth + TOLERANCE_PX || (c.more !== null && c.more.right > c.card.right + TOLERANCE_PX))
        .map((c) => c.slug);
      const misaligned = grids.flatMap((g) =>
        g.rows.filter((row) => row.length > ONE && Object.values(rowSpreads(row)).some((d) => d > TOLERANCE_PX)).map((row) => `${g.variant}:${JSON.stringify(rowSpreads(row))}`),
      );
      console.log(`T135-INFO tarjeta ${String(cardWidth)} desbordadas=${JSON.stringify(overflow)} desalineadas=${JSON.stringify(misaligned)}`);
      test.info().annotations.push({ type: `ancho ${String(cardWidth)}`, description: `desbordadas=${JSON.stringify(overflow)} desalineadas=${JSON.stringify(misaligned)}` });
      if (hardOverflow) expect(overflow, `tarjetas desbordadas a ${String(cardWidth)} px`).toEqual([]);
      if (hardAlign) expect(misaligned, `filas desalineadas a ${String(cardWidth)} px`).toEqual([]);
      if (hardOverflow) {
        const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        // La rejilla forzada puede ser más ancha que el viewport de 1280 solo si el caso lo exige: no con 2 x 288.
        expect(docOverflow).toBeLessThanOrEqual(NONE);
      }
    });
  });
});

test.describe('T-135 · estabilidad visual y accesibilidad', () => {
  test.describe.configure({ timeout: SLOW });

  ['/relojes', '/dev/products'].forEach((path) => {
    test(`${path}: sin desplazamiento de diseño (CLS) al cargar y recorrer la página`, async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __shifts: { value: number; at: number; vertical: boolean }[] };
        w.__shifts = [];
        new PerformanceObserver((list) => {
          list.getEntries().forEach((e) => {
            const s = e as unknown as { value: number; hadRecentInput: boolean; sources?: { previousRect: DOMRect; currentRect: DOMRect }[] };
            if (s.hadRecentInput) return;
            const vertical = (s.sources ?? []).some(
              (src) => Math.abs(src.previousRect.y - src.currentRect.y) > 0.5 || Math.abs(src.previousRect.height - src.currentRect.height) > 0.5,
            );
            w.__shifts.push({ value: s.value, at: e.startTime, vertical });
          });
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await openAt(page, path, WIDTH_DESKTOP);
      const settledAt = await page.evaluate(() => performance.now());
      await page.evaluate(async () => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => setTimeout(r, 500));
        window.scrollTo(0, 0);
        await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
      });
      const shifts = await page.evaluate(() => (window as unknown as { __shifts: { value: number; at: number; vertical: boolean }[] }).__shifts);
      const total = shifts.filter((s) => s.at > settledAt && s.vertical).reduce((sum, s) => sum + s.value, NONE);
      expect(total, JSON.stringify(shifts)).toBeLessThan(CLS_LIMIT);
    });
  });

  ['/relojes', '/dev/products'].forEach((path) => {
    WIDTHS.forEach((width) => {
      test(`${path} a ${String(width)} px: axe (WCAG 2.2 AA) sin violaciones y sin desbordamiento horizontal`, async ({ page }) => {
        await openAt(page, path, width);
        await expectNoA11yViolations(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(NONE);
        const cards = await measureGrids(page);
        cards.flatMap((g) => g.rows.flat()).forEach((c) => {
          expect(c.card.right, `${c.slug}: dentro del viewport`).toBeLessThanOrEqual(width + COLUMNS);
          expect(c.card.scrollWidth, `${c.slug}: sin desbordar la tarjeta`).toBeLessThanOrEqual(c.card.clientWidth + TOLERANCE_PX);
        });
      });
    });
  });
});
