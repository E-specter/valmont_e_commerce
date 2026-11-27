import { beforeEach, expect, test } from 'vitest';
import { mountToggle } from '../helpers/fixtures/toggle';

// T-130: happy-dom ejecuta el script de una isla (eventos y DOM).
beforeEach(() => {
  document.body.innerHTML = `
    <button data-toggle aria-expanded="false">Abrir</button>
    <div data-panel hidden>Panel</div>`;
});

test('el script alterna el panel y aria-expanded', () => {
  mountToggle();
  const button = document.querySelector<HTMLButtonElement>('[data-toggle]')!;
  const panel = document.querySelector<HTMLElement>('[data-panel]')!;

  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(panel.hidden).toBe(false);

  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(panel.hidden).toBe(true);
});
