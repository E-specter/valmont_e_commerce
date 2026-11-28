// Avisa al salir con cambios sin guardar en los formularios con [data-unsaved-guard] (T-147).
// Compara con el estado inicial, así que deshacer el cambio apaga el aviso. Idempotente.
const snapshot = (form: HTMLFormElement) =>
  JSON.stringify(Array.from(new FormData(form).entries()).filter(([, v]) => typeof v === 'string'));

function bind(form: HTMLFormElement): void {
  if (form.dataset.unsavedReady !== undefined) return;
  form.dataset.unsavedReady = '';
  const initial = snapshot(form);
  let submitting = false;
  form.addEventListener('submit', () => {
    submitting = true;
  });
  window.addEventListener('beforeunload', (event) => {
    if (submitting || snapshot(form) === initial) return;
    event.preventDefault(); // el texto del aviso lo fija el navegador
  });
}

export function initUnsavedChanges(root: ParentNode = document): void {
  root.querySelectorAll<HTMLFormElement>('form[data-unsaved-guard]').forEach(bind);
}
