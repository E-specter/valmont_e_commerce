// Alterna la visibilidad de un campo de contraseña. Botón: [data-password-toggle][aria-controls=<id del input>].
const SHOW = 'Mostrar contraseña';
const HIDE = 'Ocultar contraseña';

function bind(button: HTMLButtonElement): void {
  if (button.dataset.ready !== undefined) return; // idempotente: un solo oyente por botón
  const input = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (!(input instanceof HTMLInputElement)) return;
  button.setAttribute('data-ready', '');
  button.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(reveal));
    const label = reveal ? HIDE : SHOW;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  });
}

export function initPasswordToggle(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-password-toggle]').forEach(bind);
}
