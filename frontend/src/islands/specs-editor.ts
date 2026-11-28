// Editor de especificaciones: añade y quita filas. Sin JavaScript el servidor ya pinta las filas (T-147).
// Idempotente. Al quitar la última fila solo se vacía, para que siempre haya una que clonar.
const DEFAULT_MAX = 40;

function bind(root: HTMLElement): void {
  if (root.dataset.specsReady !== undefined) return;
  root.dataset.specsReady = '';
  const list = root.querySelector<HTMLElement>('[data-specs-rows]');
  const add = root.querySelector<HTMLButtonElement>('[data-specs-add]');
  const live = root.querySelector<HTMLElement>('[data-specs-live]');
  if (!list || !add) return;
  const max = Number(root.dataset.max) || DEFAULT_MAX;
  const rows = () => Array.from(list.children) as HTMLElement[];

  const sync = () => {
    rows().forEach((row, i) => {
      const n = i + 1;
      row.querySelector('[data-spec-label]')?.setAttribute('aria-label', `Característica ${n}`);
      row.querySelector('[data-spec-value]')?.setAttribute('aria-label', `Valor ${n}`);
      row.querySelector('[data-specs-remove]')?.setAttribute('aria-label', `Quitar especificación ${n}`);
    });
    add.disabled = rows().length >= max;
    const filled = rows().filter((r) => Array.from(r.querySelectorAll('input')).some((i) => i.value.trim())).length;
    document.querySelectorAll('[data-specs-count]').forEach((c) => (c.textContent = String(filled)));
  };
  const say = (msg: string) => {
    if (live) live.textContent = msg;
  };

  root.querySelectorAll<HTMLElement>('[hidden][data-specs-js]').forEach((el) => (el.hidden = false));
  sync();

  list.addEventListener('input', sync);
  add.addEventListener('click', () => {
    const last = rows().at(-1);
    if (!last || rows().length >= max) return;
    const row = last.cloneNode(true) as HTMLElement;
    row.querySelectorAll('input').forEach((i) => {
      i.value = '';
      i.removeAttribute('aria-invalid');
      i.removeAttribute('aria-describedby');
    });
    row.querySelector('.error')?.remove();
    list.append(row);
    sync();
    row.querySelector<HTMLInputElement>('[data-spec-label]')?.focus();
    say(`Fila ${rows().length} añadida`);
  });

  list.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('[data-specs-remove]');
    const row = btn?.closest<HTMLElement>('[data-specs-rows] > *');
    if (!btn || !row) return;
    if (rows().length === 1) {
      row.querySelectorAll('input').forEach((i) => (i.value = ''));
      say('Fila vaciada');
    } else {
      row.remove();
      say('Fila quitada');
    }
    sync();
    add.focus();
  });
}

export function initSpecsEditor(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-specs-editor]').forEach(bind);
}
