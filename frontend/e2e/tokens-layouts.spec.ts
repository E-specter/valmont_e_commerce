import { expect, test, type Page } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors, collectExternalRequests } from './helpers/page';

// T-116 · E2E ligero de /dev/tokens (usa StoreLayout) en 1280 y 375: sin errores de consola, sin fuentes de terceros,
// layout con lang/main/skip link, tokens aplicados, accesibilidad con axe. Las páginas /dev/* solo existen con `astro dev`.
const PAGE = '/dev/tokens';

async function open(page: Page): Promise<void> {
  const res = await page.goto(PAGE);
  expect(res?.status()).toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

test('carga sin errores de consola y sin peticiones a terceros (fuentes alojadas en el propio sitio)', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  const external = collectExternalRequests(page);
  await open(page);
  expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
  expect(errors).toEqual([]);
});

test('layout: lang="es", un título de página, un h1 y un solo main#contenido', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  expect(await page.title()).not.toBe('');
  // querySelectorAll no atraviesa shadow DOM: la barra de desarrollo de Astro trae sus propios h1 en móvil.
  expect(await page.evaluate(() => document.querySelectorAll('h1').length)).toBe(1);
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('main#contenido')).toHaveCount(1);
});

test('"Saltar al contenido": primer Tab lo hace visible y Enter lleva el foco a main#contenido', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /saltar al contenido/i });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport({ ratio: 1 });
  // Foco visible (WCAG 2.4.7): contorno de al menos 2 px.
  const outline = await skip.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#contenido$/);
  await expect(page.locator('main#contenido')).toBeFocused();
});

test('los tokens llegan a la página: paleta, fondo marfil y tipografía base', async ({ page }, info) => {
  await open(page);
  const t = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      ivory: root.getPropertyValue('--color-ivory').trim().toLowerCase(),
      redStrong: root.getPropertyValue('--color-red-strong').trim().toLowerCase(),
      bg: body.backgroundColor,
      fontSize: body.fontSize,
      lineHeight: body.lineHeight,
      family: body.fontFamily,
    };
  });
  expect(t.ivory).toBe('#fffde4');
  expect(t.redStrong).toBe('#b3261e');
  expect(t.bg).toBe('rgb(255, 253, 228)');
  expect(t.family).toMatch(/geist/i);
  // Geist 16/24 en escritorio (BRIEF §3); en móvil la escala baja a 15/22 con clamp().
  if ((page.viewportSize()?.width ?? 0) >= 1280) {
    expect(t.fontSize).toBe('16px');
    expect(t.lineHeight).toBe('24px');
  } else {
    expect(parseFloat(t.fontSize), info.project.name).toBeGreaterThanOrEqual(15);
  }
});

test('las cuatro familias se cargan desde el propio origen', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'font') fontRequests.push(r.url());
  });
  await open(page);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')),
  );
  // Astro nombra las caras `Familia-<hash>` (y `Familia-<hash> fallback: Arial` para la métrica de reserva).
  for (const family of ['Jaro', 'Phudu', 'Staatliches', 'Geist']) {
    expect(loaded.some((f) => f.startsWith(`${family}-`) && !f.includes('fallback')), `${family} no cargada: ${loaded}`).toBe(true);
  }
  expect(fontRequests.length).toBeGreaterThanOrEqual(4);
  expect(fontRequests.filter((u) => !u.startsWith(page.url().split('/dev')[0]))).toEqual([]);
});

test('sin desplazamiento horizontal (RNF04: desde 360 px)', async ({ page }) => {
  for (const width of [360, 375, 800, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `desborda ${overflow}px a ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('prefers-reduced-motion: reduce anula transiciones y animaciones (también las que declare un componente)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  // La página de tokens no anima nada: se añade un elemento con transición y animación de 1 s para probar la regla global.
  const durations = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'motion-probe'; // la barra de desarrollo de Astro se añade después al body: no usar lastElementChild
    probe.style.cssText = 'transition: opacity 1s; animation: spin 1s infinite';
    document.body.append(probe);
    const s = getComputedStyle(probe);
    return [s.transitionDuration, s.animationDuration].map(parseFloat);
  });
  expect(Math.max(...durations)).toBeLessThanOrEqual(0.001);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Sin la preferencia, la transición declarada se respeta (la regla solo actúa con `reduce`).
  await expect
    .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('motion-probe')!).transitionDuration)))
    .toBe(1);
});

test('accesibilidad (axe, WCAG 2.2 AA)', async ({ page }) => {
  await open(page);
  await expectNoA11yViolations(page);
});

test('la tabulación recorre solo elementos con foco visible', async ({ page }) => {
  await open(page);
  const lacking: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const state = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body || el.tagName === 'ASTRO-DEV-TOOLBAR') return null; // la barra es del servidor de desarrollo
      const s = getComputedStyle(el);
      const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
      return { tag: el.tagName.toLowerCase(), label: (el.textContent ?? '').trim().slice(0, 30), visible: ring || s.boxShadow !== 'none' };
    });
    if (state && !state.visible) lacking.push(`${state.tag} "${state.label}"`);
  }
  expect(lacking).toEqual([]);
});
