import { defineConfig, devices } from '@playwright/test';
import { liveEnv } from './tests/helpers/supabase-live';

// T-130 (D-042). E2E y accesibilidad sobre el sitio en :4321.
// Reutiliza el servidor ya levantado (p. ej. por scripts/review-up.sh); si no hay, levanta `astro dev`
// (las páginas /dev/* solo existen en desarrollo). Chromium se descarga fuera del repo (`npx playwright install chromium`).
// E2E_PORT: en un worktree, usa otro puerto para no reutilizar por error el servidor de `main` (`E2E_PORT=4322 npm run test:e2e`).
const port = process.env.E2E_PORT ?? '4321';
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: { baseURL, trace: 'retain-on-failure', locale: 'es-PE' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
  webServer: {
    command: `npx astro dev --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    // T-126: el servidor de desarrollo necesita la clave anónima del Supabase local (en memoria; nunca se escribe en un archivo).
    env: { ...(process.env as Record<string, string>), ...(liveEnv() ? { SUPABASE_URL: liveEnv()!.url, SUPABASE_ANON_KEY: liveEnv()!.anon } : {}) },
    timeout: 120_000,
  },
});
