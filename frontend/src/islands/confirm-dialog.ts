// Respaldo del diálogo de confirmación: abre en modal el <dialog> que llega con `open`
// (el atributo `open` solo lo pinta sin modo modal, sin foco atrapado ni Esc) y cubre los
// navegadores sin Invoker Commands. Idempotente.
function bind(dialog: HTMLDialogElement): void {
  if (dialog.dataset.ready !== undefined) return;
  dialog.setAttribute('data-ready', '');
  if (dialog.open) {
    dialog.close();
    dialog.showModal();
  }
}

function bindTrigger(button: HTMLButtonElement): void {
  if (button.dataset.ready !== undefined || 'commandForElement' in (button as object)) return;
  button.setAttribute('data-ready', '');
  button.addEventListener('click', () => {
    const target = document.getElementById(button.getAttribute('commandfor') ?? '');
    if (target instanceof HTMLDialogElement && !target.open) target.showModal();
  });
}

export function initConfirmDialog(root: ParentNode = document): void {
  root.querySelectorAll<HTMLDialogElement>('dialog.dialog').forEach(bind);
  root.querySelectorAll<HTMLButtonElement>('button[command="show-modal"][commandfor]').forEach(bindTrigger);
}
