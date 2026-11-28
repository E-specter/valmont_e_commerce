// Reordenar imágenes arrastrando (HTML5). Sin JavaScript quedan los botones «Subir»/«Bajar» (WCAG 2.5.7).
// Al soltar: reordena el DOM, rellena `ids` del formulario image-order, anuncia la posición y lo envía.
// Idempotente.
const ITEM = '[data-image-id]';
const HALF = 2;

function bind(root: HTMLElement): void {
  if (root.dataset.imageSortReady !== undefined) return;
  const list = root.querySelector<HTMLElement>('[data-image-list]');
  const form = root.querySelector<HTMLFormElement>('[data-image-order-form]');
  const field = form?.querySelector<HTMLInputElement>('input[name="ids"]');
  if (!list || !form || !field) return;
  root.setAttribute('data-image-sort-ready', '');
  const live = root.querySelector<HTMLElement>('[data-image-live]');

  const items = () => Array.from(list.querySelectorAll<HTMLElement>(`:scope > ${ITEM}`));
  const ids = () => items().map((li) => li.dataset.imageId ?? '');
  let dragged: HTMLElement | null = null;
  let dropped = false;
  let startIds = '';
  let startOrder: HTMLElement[] = [];

  const sync = () => {
    const all = items();
    all.forEach((li, i) => {
      li.querySelectorAll('[data-image-pos]').forEach((n) => n.replaceChildren(String(i + 1)));
      const main = li.querySelector<HTMLElement>('[data-image-main]');
      main?.toggleAttribute('hidden', i !== 0);
    });
  };

  // `draggable` solo en las filas (JS lo activa) y no mientras se edita un campo: así se puede seleccionar texto.
  items().forEach((li) => li.setAttribute('draggable', 'true'));
  list.addEventListener('focusin', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    if (li && (e.target as HTMLElement).matches('input, textarea')) li.setAttribute('draggable', 'false');
  });
  list.addEventListener('focusout', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    li?.setAttribute('draggable', 'true');
  });

  const place = (target: HTMLElement, clientY: number) => {
    if (!dragged || target === dragged) return;
    const r = target.getBoundingClientRect();
    const after = Number.isFinite(clientY) && clientY > r.top + r.height / HALF;
    list.insertBefore(dragged, after ? target.nextElementSibling : target);
  };

  const finish = () => {
    const li = dragged;
    dragged = null;
    if (!li) return;
    li.classList.remove('is-dragging');
    // Cancelado (Esc o fuera de la lista): sin `drop`, se restaura el orden original y no se envía nada.
    if (!dropped) {
      startOrder.forEach((n) => list.appendChild(n));
      return;
    }
    const now = ids().join(',');
    if (now === startIds) return;
    sync();
    field.value = now;
    const pos = items().indexOf(li) + 1;
    if (live) live.textContent = `Imagen movida a la posición ${pos}`;
    form.requestSubmit();
  };

  list.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    if (!li) return;
    dragged = li;
    startIds = ids().join(',');
    startOrder = items();
    dropped = false;
    li.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', li.dataset.imageId ?? '');
    }
  });
  list.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    if (target) place(target, e.clientY);
  });
  list.addEventListener('drop', (e) => {
    if (!dragged) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>(ITEM);
    if (target) place(target, e.clientY);
    dropped = true;
    finish();
  });
  list.addEventListener('dragend', finish);
}

export function initImageSort(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-image-manager]').forEach(bind);
}
