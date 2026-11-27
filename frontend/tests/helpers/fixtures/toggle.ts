/** Script de isla de ejemplo: alterna `aria-expanded` y `hidden` del panel. */
export function mountToggle(root: ParentNode = document): void {
  const button = root.querySelector<HTMLButtonElement>('[data-toggle]');
  const panel = root.querySelector<HTMLElement>('[data-panel]');
  if (!button || !panel) return;
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  });
}
