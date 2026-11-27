import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AuthForm from '../../src/components/auth/AuthForm.astro';
import { initPasswordToggle } from '../../src/islands/password-toggle';
import { renderAstro } from '../helpers/render';

// T-127 · `initPasswordToggle(root?)` con happy-dom. El HTML es el que produce el AuthForm real (Container API), así la prueba
// no depende de qué atributo use la isla para enlazar el botón: lo que importa es el comportamiento observable.
// Las islas leen `document` e `HTMLInputElement` globales: se enlazan a una ventana de happy-dom solo durante cada prueba.
const SHOW = 'Mostrar contraseña';
const HIDE = 'Ocultar contraseña';
const TYPED = 'frase-de-prueba-qa127';

let win: Window;
let doc: Document;
let html: string;

beforeEach(async () => {
  html ??= await renderAstro(AuthForm, { props: { mode: 'login', email: 'ana@example.com' } });
  win = new Window({ settings: { disableJavaScriptEvaluation: true } });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = html;
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLInputElement', win.HTMLInputElement);
  vi.stubGlobal('HTMLButtonElement', win.HTMLButtonElement);
  vi.stubGlobal('HTMLElement', win.HTMLElement);
});
afterEach(() => vi.unstubAllGlobals());

const input = (): HTMLInputElement => doc.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
const eye = (): HTMLButtonElement => doc.querySelector(`button[aria-label="${SHOW}"], button[aria-label="${HIDE}"]`) as HTMLButtonElement;
const click = (b: HTMLElement): void => void b.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event);

describe('initPasswordToggle · comportamiento', () => {
  test('el HTML de partida tiene el campo oculto y el botón "Mostrar contraseña" sin pulsar', () => {
    expect(input().type).toBe('password');
    expect(eye().getAttribute('aria-label')).toBe(SHOW);
    expect(eye().getAttribute('aria-pressed')).toBe('false');
  });

  test('un clic muestra la contraseña: type="text" y aria-pressed="true"', () => {
    initPasswordToggle(doc);
    click(eye());
    expect(input().type).toBe('text');
    expect(eye().getAttribute('aria-pressed')).toBe('true');
  });

  test('un segundo clic la vuelve a ocultar: type="password" y aria-pressed="false"', () => {
    initPasswordToggle(doc);
    click(eye());
    click(eye());
    expect(input().type).toBe('password');
    expect(eye().getAttribute('aria-pressed')).toBe('false');
  });

  test('el nombre accesible acompaña al estado: "Ocultar contraseña" al mostrar y "Mostrar contraseña" al ocultar', () => {
    initPasswordToggle(doc);
    click(eye());
    expect(eye().getAttribute('aria-label')).toBe(HIDE);
    click(eye());
    expect(eye().getAttribute('aria-label')).toBe(SHOW);
  });

  test('alternar no borra lo que el usuario escribió', () => {
    initPasswordToggle(doc);
    input().value = TYPED;
    click(eye());
    expect(input().value).toBe(TYPED);
    click(eye());
    expect(input().value).toBe(TYPED);
  });

  test('el botón es type="button" (no envía el formulario) y no es un enlace', () => {
    expect(eye().tagName).toBe('BUTTON');
    expect(eye().getAttribute('type')).toBe('button');
  });

  test('el clic no se propaga como envío del formulario', () => {
    initPasswordToggle(doc);
    const submit = vi.fn();
    doc.querySelector('form')!.addEventListener('submit', submit);
    click(eye());
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('initPasswordToggle · idempotencia y alcance', () => {
  test('llamarla varias veces no apila oyentes: tres inicializaciones y un clic = un solo cambio', () => {
    initPasswordToggle(doc);
    initPasswordToggle(doc);
    initPasswordToggle(doc);
    click(eye());
    expect(input().type).toBe('text');
    expect(eye().getAttribute('aria-pressed')).toBe('true');
  });

  test('inicializar con el formulario como raíz también enlaza el botón', () => {
    initPasswordToggle(doc.querySelector('form')!);
    click(eye());
    expect(input().type).toBe('text');
  });

  test('sin argumento usa el documento', () => {
    initPasswordToggle();
    click(eye());
    expect(input().type).toBe('text');
  });

  test('una raíz sin el botón no lanza ni cambia nada', () => {
    const empty = doc.createElement('div');
    expect(() => initPasswordToggle(empty)).not.toThrow();
    expect(input().type).toBe('password');
  });

  test('sin inicializar, el HTML no cambia por sí solo (el sitio funciona sin JavaScript: el campo queda oculto)', () => {
    click(eye());
    expect(input().type).toBe('password');
  });
});
