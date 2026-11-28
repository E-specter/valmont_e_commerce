import { Window } from 'happy-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ImageManager from '../../src/components/admin/ImageManager.astro';
import { initImageSort } from '../../src/islands/image-sort';
import { renderAstro } from '../helpers/render';
import { IMAGES, IMG_A, IMG_B, IMG_C, PRODUCT_ID, actionOf } from '../helpers/t148';
import { RE_POSITION_MSG, RE_UUID_G } from '../helpers/t148-re';
import { text } from '../helpers/ui';

// T-148 · isla `image-sort` (arrastrar y soltar con HTML5) sobre el marcado REAL de ImageManager, con happy-dom. Se simulan dragstart, dragover,
// drop y dragend como los dispara un navegador, con una maqueta fija (cada fila mide 80 px y empieza a i × 100 px). Las islas usan los globales del
// navegador: se les presta una ventana mientras dura la prueba (como en T-143 y T-147).
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const ROW_STEP = 100;
const ROW_HEIGHT = 80;
const UPPER_HALF = 10; // dentro de la mitad superior de la fila
const LOWER_HALF = 70; // dentro de la mitad inferior de la fila
const GLOBALS = [
  'document', 'window', 'FormData', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLSelectElement', 'Element', 'Node', 'Event',
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

type Win = Window;
function mount(html: string): Win {
  const win = new Window();
  win.document.body.innerHTML = html;
  GLOBALS.forEach((g) => vi.stubGlobal(g, (win as unknown as Record<string, unknown>)[g]));
  return win;
}
const html = (images = IMAGES) => renderAstro(ImageManager, { props: { productId: PRODUCT_ID, images, published: false } });
const doc = (win: Win): Document => win.document as unknown as Document;
const rows = (win: Win): HTMLElement[] => ([...win.document.querySelectorAll('ol > li, ul > li')] as unknown as HTMLElement[]).filter((li) => li.querySelector('img, svg'));
const idOfRow = (li: HTMLElement): string => {
  const hidden = [...li.querySelectorAll('input[type="hidden"]')] as unknown as HTMLInputElement[];
  return hidden.map((i) => i.getAttribute('value') ?? '').find((v) => [IMG_A, IMG_B, IMG_C].includes(v)) ?? '';
};
const order = (win: Win): string[] => rows(win).map(idOfRow);
const orderForm = (win: Win): HTMLFormElement =>
  ([...win.document.querySelectorAll('form')] as unknown as HTMLFormElement[]).find((f) => actionOf(f as unknown as Element) === 'image-order') as HTMLFormElement;
const idsField = (win: Win): HTMLInputElement => orderForm(win).querySelector('input[name="ids"]') as unknown as HTMLInputElement;
const idsValue = (win: Win): string[] => idsField(win).value.match(RE_UUID_G) ?? [];
const live = (win: Win): string => text(win.document.querySelector('[aria-live]') as unknown as Element);
const hasHidden = (el: Element): boolean => [el, ...ancestors(el)].some((n) => n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true');
const ancestors = (el: Element): Element[] => (el.parentElement ? [el.parentElement, ...ancestors(el.parentElement)] : []);
const mainRow = (win: Win): HTMLElement[] =>
  rows(win).filter((li) => ([...li.querySelectorAll('*')] as unknown as Element[]).some((e) => e.children.length === NONE && text(e) === 'Principal' && !hasHidden(e)));

/** Cuenta los envíos del formulario de orden (y los cancela, como si el navegador no navegara). */
function countSubmits(win: Win): { count: () => number; actions: () => string[] } {
  const form = orderForm(win);
  const seen: string[] = [];
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    seen.push(actionOf(form as unknown as Element));
  });
  return { count: () => seen.length, actions: () => seen };
}

/** Da a cada fila su maqueta según su posición actual en la lista. */
function layout(win: Win): void {
  rows(win).forEach((li) => {
    Object.defineProperty(li, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const at = rows(win).indexOf(li);
        return { top: at * ROW_STEP, height: ROW_HEIGHT, bottom: at * ROW_STEP + ROW_HEIGHT, left: NONE, right: ROW_HEIGHT, width: ROW_HEIGHT, x: NONE, y: at * ROW_STEP };
      },
    });
  });
}

function fire(win: Win, el: Element, type: string, extra: Record<string, unknown> = {}): Event {
  const ev = new win.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
  const dt = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: 'move', dropEffect: 'move', types: [] as string[], files: [] as unknown[] };
  Object.defineProperty(ev, 'dataTransfer', { value: { ...dt, ...(extra.dataTransfer as object | undefined) } });
  Object.entries(extra)
    .filter(([k]) => k !== 'dataTransfer')
    .forEach(([k, v]) => Object.defineProperty(ev, k, { value: v }));
  el.dispatchEvent(ev);
  return ev;
}

/** Arrastra la fila `from` y la suelta sobre la fila `to` a la altura `y` (relativa a esa fila), con la secuencia completa. */
function drag(win: Win, from: number, to: number, y: number): void {
  layout(win);
  const [source, target] = [rows(win)[from], rows(win)[to]];
  const targetTop = to * ROW_STEP;
  fire(win, source as unknown as Element, 'dragstart');
  fire(win, target as unknown as Element, 'dragenter', { clientY: targetTop + y });
  fire(win, target as unknown as Element, 'dragover', { clientY: targetTop + y });
  fire(win, target as unknown as Element, 'drop', { clientY: targetTop + y });
  fire(win, source as unknown as Element, 'dragend');
}

async function ready(images = IMAGES): Promise<Win> {
  const win = mount(await html(images));
  initImageSort(doc(win));
  return win;
}

describe('image-sort · activación', () => {
  test('al iniciar, cada fila es arrastrable (draggable="true"); antes, ninguna', async () => {
    const win = mount(await html());
    rows(win).forEach((li) => expect(li.getAttribute('draggable')).not.toBe('true'));
    initImageSort(doc(win));
    expect(rows(win)).toHaveLength(IMAGES.length);
    rows(win).forEach((li) => expect(li.getAttribute('draggable')).toBe('true'));
  });

  test('iniciar sobre una lista vacía, sin gestor o con una sola imagen no falla', async () => {
    const empty = mount(await html([]));
    expect(() => initImageSort(doc(empty))).not.toThrow();
    vi.unstubAllGlobals();
    const one = mount(await html([IMAGES[NONE]]));
    expect(() => initImageSort(doc(one))).not.toThrow();
    vi.unstubAllGlobals();
    const none = mount('<p>nada</p>');
    expect(() => initImageSort(doc(none))).not.toThrow();
  });

  test('la isla no llama a la API ni a ninguna red', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const win = await ready();
    drag(win, NONE, TWO, LOWER_HALF);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('image-sort · soltar', () => {
  test('soltar la primera en la mitad inferior de la última → [B, C, A]; el campo ids lleva ese orden en una sola cadena', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    drag(win, NONE, TWO, LOWER_HALF);
    expect(order(win)).toEqual([IMG_B, IMG_C, IMG_A]);
    expect(idsValue(win)).toEqual([IMG_B, IMG_C, IMG_A]);
    expect(idsField(win).value.match(RE_UUID_G)).toHaveLength(THREE);
    expect(submits.count()).toBe(ONE);
    expect(submits.actions()).toEqual(['image-order']);
  });

  test('soltar la última en la mitad superior de la primera → [C, A, B]', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    drag(win, TWO, NONE, UPPER_HALF);
    expect(order(win)).toEqual([IMG_C, IMG_A, IMG_B]);
    expect(idsValue(win)).toEqual([IMG_C, IMG_A, IMG_B]);
    expect(submits.count()).toBe(ONE);
  });

  test('el nuevo conjunto de ids es exactamente el de antes: sin repetidos, sin pérdidas', async () => {
    const win = await ready();
    drag(win, NONE, ONE, LOWER_HALF);
    expect([...idsValue(win)].sort()).toEqual([IMG_A, IMG_B, IMG_C].sort());
    expect(new Set(idsValue(win)).size).toBe(THREE);
  });

  test('el aria-live anuncia «Imagen movida a la posición N» con la posición final (1-based)', async () => {
    const win = await ready();
    expect(live(win)).toBe('');
    drag(win, NONE, TWO, LOWER_HALF);
    const found = RE_POSITION_MSG.exec(live(win));
    expect(found, `anuncio: «${live(win)}»`).not.toBeNull();
    expect(Number(found?.[ONE])).toBe(THREE);
  });

  test('al subir la última a la primera el anuncio dice la posición 1', async () => {
    const win = await ready();
    drag(win, TWO, NONE, UPPER_HALF);
    expect(Number(RE_POSITION_MSG.exec(live(win))?.[ONE])).toBe(ONE);
  });

  test('«Principal» pasa a la nueva primera fila y solo se ve en una', async () => {
    const win = await ready();
    expect(mainRow(win).map(idOfRow)).toEqual([IMG_A]);
    drag(win, TWO, NONE, UPPER_HALF);
    expect(mainRow(win).map(idOfRow)).toEqual([IMG_C]);
  });

  test('soltar en la misma posición no envía nada, no cambia ids y no anuncia', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    const before = idsField(win).value;
    drag(win, ONE, ONE, UPPER_HALF);
    expect(submits.count()).toBe(NONE);
    expect(idsField(win).value).toBe(before);
    expect(order(win)).toEqual([IMG_A, IMG_B, IMG_C]);
    expect(live(win)).toBe('');
  });

  test('dos arrastres seguidos acumulan: el segundo parte del orden que dejó el primero', async () => {
    const win = await ready();
    drag(win, NONE, TWO, LOWER_HALF); // [B, C, A]
    drag(win, TWO, NONE, UPPER_HALF); // A al principio → [A, B, C]
    expect(order(win)).toEqual([IMG_A, IMG_B, IMG_C]);
    expect(idsValue(win)).toEqual([IMG_A, IMG_B, IMG_C]);
  });
});

describe('image-sort · idempotencia y robustez', () => {
  test('iniciar dos veces no duplica los manejadores: un arrastre, un envío y el orden correcto', async () => {
    const win = mount(await html());
    initImageSort(doc(win));
    initImageSort(doc(win));
    const submits = countSubmits(win);
    drag(win, NONE, TWO, LOWER_HALF);
    expect(order(win)).toEqual([IMG_B, IMG_C, IMG_A]);
    expect(submits.count()).toBe(ONE);
    expect(live(win)).not.toBe('');
  });

  test('un arrastre ajeno (un archivo del escritorio sobre la lista) no se secuestra: sin preventDefault y sin envío', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    layout(win);
    const over = fire(win, rows(win)[ONE] as unknown as Element, 'dragover', { clientY: ROW_STEP + UPPER_HALF, dataTransfer: { types: ['Files'] } });
    const drop = fire(win, rows(win)[ONE] as unknown as Element, 'drop', { clientY: ROW_STEP + UPPER_HALF, dataTransfer: { types: ['Files'] } });
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(submits.count()).toBe(NONE);
    expect(order(win)).toEqual([IMG_A, IMG_B, IMG_C]);
  });

  test('un drop seguido de dragend (la secuencia normal del navegador) envía una sola vez', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    drag(win, ONE, NONE, UPPER_HALF); // incluye dragend tras drop
    expect(submits.count()).toBe(ONE);
  });

  test('el texto del anuncio no incluye el alt de la imagen ni su URL (sin datos de más)', async () => {
    const win = await ready();
    drag(win, NONE, TWO, LOWER_HALF);
    IMAGES.forEach((i) => {
      expect(live(win)).not.toContain(i.alt);
      expect(live(win)).not.toContain(i.url);
    });
  });
});

describe('image-sort · cancelar el arrastre', () => {
  // Opinión de QA (WCAG 2.5.7 / 3.2.2): un arrastre cancelado (Esc, o soltar fuera de la lista) llega como `dragend` con dropEffect «none» y sin `drop`:
  // no debe guardar el orden que se vio en la vista previa.
  test('dragend con dropEffect "none" y sin drop → sin envío y el orden original', async () => {
    const win = await ready();
    const submits = countSubmits(win);
    layout(win);
    const [source, target] = [rows(win)[NONE], rows(win)[TWO]];
    fire(win, source as unknown as Element, 'dragstart');
    fire(win, target as unknown as Element, 'dragover', { clientY: TWO * ROW_STEP + LOWER_HALF });
    fire(win, source as unknown as Element, 'dragend', { dataTransfer: { dropEffect: 'none' } });
    expect(submits.count()).toBe(NONE);
    expect(order(win)).toEqual([IMG_A, IMG_B, IMG_C]);
  });
});
