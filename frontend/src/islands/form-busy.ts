// Formularios con [data-busy-on-submit]: al enviar, aria-busy y el botón de envío en «cargando».
// Se aplica tras el envío (microtarea) para que el valor del botón viaje; idempotente.
function bind(form: HTMLFormElement): void {
  if (form.dataset.busyReady !== undefined) return;
  form.setAttribute('data-busy-ready', '');
  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const submitter = (event as SubmitEvent).submitter;
    queueMicrotask(() => {
      form.setAttribute('aria-busy', 'true');
      const btn = submitter instanceof HTMLButtonElement ? submitter : form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (btn) {
        btn.setAttribute('data-loading', '');
        btn.setAttribute('aria-busy', 'true');
        btn.disabled = true;
      }
    });
  });
}

export function initFormBusy(root: ParentNode = document): void {
  root.querySelectorAll<HTMLFormElement>('form[data-busy-on-submit]').forEach(bind);
}
