import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe';
import { collectConsoleErrors } from './helpers/page';

// T-130: el ejemplo mínimo E2E (portada actual) y axe funcionan en 1280 y 375.
test('la portada carga sin errores y sin violaciones de accesibilidad', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoA11yViolations(page);
  expect(errors).toEqual([]);
});

// Rojo deliberado: el ayudante de axe falla ante una violación real (imagen sin alt, sin lang ni título).
test('expectNoA11yViolations falla si la página tiene violaciones', async ({ page }) => {
  await page.setContent('<img src="x.png"><button></button>');
  await expect(expectNoA11yViolations(page)).rejects.toThrow(/image-alt|button-name/);
});
