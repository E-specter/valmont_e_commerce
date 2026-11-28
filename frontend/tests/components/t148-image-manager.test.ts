import { describe, expect, test } from 'vitest';
import ImageManager from '../../src/components/admin/ImageManager.astro';
import FileDropzone from '../../src/components/ui/FileDropzone.astro';
import { parseHtml, renderAstro } from '../helpers/render';
import {
  HOSTILE_ALT, IMAGES, IMG_A, IMG_B, IMG_C, PRODUCT_ID, STORAGE, actionOf, formsFor, imageForms, imageIdIn, imageOf, nameOf, submitterOf, uploadForm,
} from '../helpers/t148';
import { serialize } from '../helpers/t147';
import { FIVE_MIB } from '../helpers/t148-files';
import { RE_BACK_WORD, RE_CONFIRM_WORD, RE_HAS_DIGIT, RE_IMAGES_WORD, RE_LIVE_IMG_EVENT, RE_MAX_WORD, RE_UUID_G } from '../helpers/t148-re';
import { describedBy, text } from '../helpers/ui';

// T-148 · ImageManager y FileDropzone (Container API): lista, alt editable, «Subir»/«Bajar» siempre presentes, borrar con confirmación,
// subida, errores por campo y accesibilidad. El marcado se lee por contrato (`_action`, controles con nombre); no se suponen nombres de campo.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const ALT_MAX = 150;
const ACCEPT = 'image/jpeg,image/png,image/webp';
const ACCEPT_SET = ['image/jpeg', 'image/png', 'image/webp'];
const HOSTILE_ERROR = '"><img src=x onerror=alert(1)>';
const MANY = 30;
const ID_DIGITS = 8;

type Props = Record<string, unknown>;
const managerProps = (over: Props = {}): Props => ({ productId: PRODUCT_ID, images: IMAGES, published: false, ...over });
const renderManager = async (over: Props = {}): Promise<Document> => parseHtml(await renderAstro(ImageManager, { props: managerProps(over) }));
const dropzoneProps = (over: Props = {}): Props => ({ id: 'dz-1', name: 'file', label: 'Imagen', accept: ACCEPT, maxBytes: FIVE_MIB, ...over });
const renderDropzone = async (over: Props = {}): Promise<Document> => parseHtml(await renderAstro(FileDropzone, { props: dropzoneProps(over) }));

const items = (doc: ParentNode): Element[] => [...doc.querySelectorAll('li')].filter((li) => li.querySelector('img, svg'));
const itemOf = (doc: ParentNode, id: string): Element | undefined => items(doc).find((li) => [...li.querySelectorAll('form')].some((f) => imageIdIn(serialize(f)) === id));
const hiddenDeep = (el: Element): boolean => [el, ...parents(el)].some((n) => n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true');
const parents = (el: Element): Element[] => (el.parentElement ? [el.parentElement, ...parents(el.parentElement)] : []);
const fileInput = (doc: ParentNode): HTMLInputElement | null => doc.querySelector('input[type="file"]');
const enabledFileInputs = (doc: ParentNode): Element[] => [...doc.querySelectorAll('input[type="file"]')].filter((i) => !i.hasAttribute('disabled'));
const errorsOf = (doc: Document, el: Element | null): string => describedBy(doc, el as Element).map((d) => d.text).join(' ');
/** Texto «Principal» visible (no `hidden`, ni en un ancestro oculto). */
const visibleMain = (doc: ParentNode): Element[] => [...doc.querySelectorAll('*')].filter((e) => e.children.length === NONE && text(e) === 'Principal' && !hiddenDeep(e));
const labelFor = (doc: ParentNode, el: Element): string => text(doc.querySelector(`label[for="${el.getAttribute('id')}"]`));

describe('FileDropzone', () => {
  test('un <input type="file"> nativo con id, name y accept recibidos, etiquetado con <label for>', async () => {
    const doc = await renderDropzone({ label: 'Imagen del producto' });
    const input = fileInput(doc) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.getAttribute('id')).toBe('dz-1');
    expect(input.getAttribute('name')).toBe('file');
    expect((input.getAttribute('accept') ?? '').split(',').map((s) => s.trim()).sort()).toEqual([...ACCEPT_SET].sort());
    expect(labelFor(doc, input)).toContain('Imagen del producto');
  });

  test('es una sola imagen por vez (sin `multiple`) y no está deshabilitada ni oculta: sirve con teclado y sin JavaScript', async () => {
    const input = fileInput(await renderDropzone()) as HTMLInputElement;
    expect(input.hasAttribute('multiple')).toBe(false);
    expect(input.hasAttribute('disabled')).toBe(false);
    expect(input.hasAttribute('hidden')).toBe(false);
    expect(['-1']).not.toContain(input.getAttribute('tabindex'));
  });

  test('maxBytes se anota para quien lo lea (atributo o texto), sin que el cliente sea la autoridad', async () => {
    const html = await renderAstro(FileDropzone, { props: dropzoneProps() });
    expect(html.includes(String(FIVE_MIB)) || html.includes('5 MiB')).toBe(true);
  });

  test('sin error no hay aria-invalid; la ayuda se vincula con aria-describedby', async () => {
    const doc = await renderDropzone({ hint: 'JPEG, PNG o WebP, hasta 5 MiB.' });
    const input = fileInput(doc) as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(errorsOf(doc, input)).toContain('hasta 5 MiB');
  });

  test('con error: aria-invalid="true", el mensaje visible y vinculado, junto con la ayuda', async () => {
    const doc = await renderDropzone({ hint: 'Ayuda del archivo', error: 'El archivo supera los 5 MiB' });
    const input = fileInput(doc) as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = errorsOf(doc, input);
    expect(described).toContain('El archivo supera los 5 MiB');
    expect(described).toContain('Ayuda del archivo');
    expect(text(doc.body)).toContain('El archivo supera los 5 MiB');
  });

  test('un error no puede ser solo color: lleva texto visible', async () => {
    const doc = await renderDropzone({ error: 'Formato no admitido: usa JPEG, PNG o WebP' });
    expect(text(doc.body)).toContain('Formato no admitido');
  });

  test('el texto de etiqueta, ayuda y error se escapa (sin set:html)', async () => {
    const html = await renderAstro(FileDropzone, { props: dropzoneProps({ label: HOSTILE_ERROR, hint: HOSTILE_ERROR, error: HOSTILE_ERROR }) });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(RE_LIVE_IMG_EVENT);
    expect(html).toContain('&lt;img');
  });
});

describe('ImageManager · lista', () => {
  test('una miniatura por imagen, en el orden recibido, con su URL y su alt', async () => {
    const doc = await renderManager();
    const thumbs = [...doc.querySelectorAll('img')];
    expect(thumbs.map((i) => i.getAttribute('src'))).toEqual(IMAGES.map((i) => i.url));
    expect(thumbs.map((i) => i.getAttribute('alt'))).toEqual(IMAGES.map((i) => i.alt));
    expect(items(doc)).toHaveLength(IMAGES.length);
  });

  test('la lista es una lista semántica (ol/ul > li), no una tabla ni divs sueltos', async () => {
    const doc = await renderManager();
    const list = doc.querySelector('ol, ul');
    expect(list).not.toBeNull();
    expect([...(list as Element).children].filter((c) => c.tagName === 'LI')).toHaveLength(IMAGES.length);
  });

  test('«Principal» se rotula solo en la primera imagen', async () => {
    const doc = await renderManager();
    const main = visibleMain(doc);
    expect(main).toHaveLength(ONE);
    expect(items(doc)[NONE].contains(main[NONE])).toBe(true);
  });

  test('con una sola imagen, esa es la principal', async () => {
    const doc = await renderManager({ images: [IMAGES[NONE]] });
    expect(visibleMain(doc)).toHaveLength(ONE);
  });

  test('sin imágenes: sin lista de elementos, sin «Principal», con un mensaje y la zona de subida', async () => {
    const doc = await renderManager({ images: [] });
    expect(items(doc)).toHaveLength(NONE);
    expect(visibleMain(doc)).toHaveLength(NONE);
    expect(text(doc.body)).toMatch(RE_IMAGES_WORD);
    expect(enabledFileInputs(doc)).toHaveLength(ONE);
  });

  test('el alt de cada imagen es un campo de texto editable con su valor, etiqueta propia y límite de 150', async () => {
    const doc = await renderManager();
    IMAGES.forEach((img) => {
      const li = itemOf(doc, img.id) as Element;
      const input = li.querySelector('input[type="text"]') as HTMLInputElement;
      expect(input, img.id).not.toBeNull();
      expect(input.getAttribute('value')).toBe(img.alt);
      expect(input.hasAttribute('required')).toBe(true);
      expect(input.getAttribute('maxlength')).toBe(String(ALT_MAX));
      expect(labelFor(doc, input).toLowerCase()).toContain('texto alternativo');
    });
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('el alt y el texto del servidor se pintan como texto: sin <script> ni atributos de evento vivos y con el valor intacto', async () => {
    const doc = await renderManager({ images: [imageOf(IMG_A, 'a', HOSTILE_ALT)] });
    expect([...doc.querySelectorAll('script')].map((s) => s.textContent).join('')).not.toContain('__pwned');
    expect(doc.querySelectorAll('[onerror], [onload], [onclick]')).toHaveLength(NONE);
    expect(doc.querySelectorAll('img')).toHaveLength(ONE);
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe(HOSTILE_ALT);
    expect((doc.querySelector('input[type="text"]') as HTMLInputElement).getAttribute('value')).toBe(HOSTILE_ALT);
  });

  test('una URL con esquema peligroso no se carga como imagen', async () => {
    const doc = await renderManager({ images: [{ id: IMG_A, url: 'javascript:alert(1)', alt: 'x' }] });
    const srcs = [...doc.querySelectorAll('img')].map((i) => (i.getAttribute('src') ?? '').toLowerCase());
    srcs.forEach((s) => expect(s.startsWith('javascript:')).toBe(false));
  });

  test('sin formularios anidados y sin h1 (la sección cuelga del h2 «Imágenes» del formulario)', async () => {
    const doc = await renderManager();
    expect(doc.querySelectorAll('form form')).toHaveLength(NONE);
    expect(doc.querySelectorAll('h1')).toHaveLength(NONE);
  });

  test('no pinta el id del producto en ningún texto visible ni usa el nombre de un archivo', async () => {
    const doc = await renderManager();
    expect(text(doc.body)).not.toContain(PRODUCT_ID);
  });
});

describe('ImageManager · «Subir» y «Bajar» (WCAG 2.5.7)', () => {
  test('cada imagen tiene «Subir» y «Bajar» como botones de un formulario POST, también la primera y la última', async () => {
    const doc = await renderManager();
    IMAGES.forEach((img) => {
      const forms = formsFor(doc, 'image-move', img.id);
      expect(forms, img.id).toHaveLength(TWO);
      forms.forEach((f) => {
        expect(f.getAttribute('method')?.toLowerCase()).toBe('post');
        expect(f.hasAttribute('hidden')).toBe(false);
        expect(submitterOf(f)).not.toBeNull();
      });
      const names = forms.map((f) => nameOf(submitterOf(f) as Element).toLowerCase());
      expect(names.some((n) => n.includes('subir'))).toBe(true);
      expect(names.some((n) => n.includes('bajar'))).toBe(true);
    });
  });

  test('los dos botones de una imagen llevan direcciones distintas y el mismo id de imagen', async () => {
    const doc = await renderManager();
    const forms = formsFor(doc, 'image-move', IMG_B);
    const fieldsets = forms.map((f) => serialize(f).filter(([k]) => k !== '_action').map(([k, v]) => `${k}=${v}`).sort().join('&'));
    expect(new Set(fieldsets).size).toBe(TWO);
    forms.forEach((f) => expect(imageIdIn(serialize(f))).toBe(IMG_B));
  });

  test('el nombre accesible de cada botón identifica la imagen: no hay dos «Subir» iguales en la página', async () => {
    const doc = await renderManager();
    const names = imageForms(doc)
      .filter((f) => actionOf(f) === 'image-move')
      .map((f) => nameOf(submitterOf(f) as Element));
    expect(new Set(names).size).toBe(names.length);
    names.forEach((n) => expect(n).toMatch(RE_HAS_DIGIT));
  });

  test('los botones están disponibles sin JavaScript: no dependen de un atributo `hidden` ni de la isla', async () => {
    const doc = await renderManager();
    imageForms(doc)
      .filter((f) => actionOf(f) === 'image-move')
      .forEach((f) => expect(hiddenDeep(submitterOf(f) as Element)).toBe(false));
  });
});

describe('ImageManager · orden y arrastre', () => {
  test('un formulario `image-order` con el campo `ids` lleva los ids actuales en orden', async () => {
    const doc = await renderManager();
    const form = imageForms(doc).find((f) => actionOf(f) === 'image-order') as HTMLFormElement;
    expect(form, 'falta el formulario image-order').toBeDefined();
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    const ids = serialize(form).find(([k]) => k === 'ids')?.[ONE] ?? '';
    expect(ids.match(RE_UUID_G)).toEqual([IMG_A, IMG_B, IMG_C]);
  });

  test('sin JavaScript las filas no se anuncian como arrastrables (el arrastre lo activa la isla)', async () => {
    const doc = await renderManager();
    items(doc).forEach((li) => expect(li.getAttribute('draggable')).not.toBe('true'));
  });

  test('hay una región con aria-live («polite»), vacía de inicio, para anunciar el movimiento', async () => {
    const doc = await renderManager();
    const live = doc.querySelector('[aria-live]');
    expect(live).not.toBeNull();
    expect(['polite', 'assertive']).toContain(live?.getAttribute('aria-live'));
    expect(text(live)).toBe('');
  });

  test('el asa de arrastre es decorativa (aria-hidden): no añade un control sin nombre', async () => {
    const doc = await renderManager();
    const buttonsWithoutName = [...doc.querySelectorAll('button')].filter((b) => nameOf(b) === '');
    expect(buttonsWithoutName).toHaveLength(NONE);
  });
});

describe('ImageManager · eliminar con confirmación', () => {
  test('cada imagen tiene un botón «Eliminar» que abre un <dialog> propio (commandfor) con su formulario `image-delete`', async () => {
    const doc = await renderManager();
    IMAGES.forEach((img) => {
      const forms = formsFor(doc, 'image-delete', img.id);
      expect(forms, img.id).toHaveLength(ONE);
      const dialog = forms[NONE].closest('dialog') as HTMLDialogElement;
      expect(dialog, 'el formulario de borrar va dentro de un diálogo de confirmación').not.toBeNull();
      const trigger = doc.querySelector(`button[commandfor="${dialog.getAttribute('id')}"]`);
      expect(trigger, img.id).not.toBeNull();
      expect(trigger?.getAttribute('command')).toBe('show-modal');
      expect(nameOf(trigger as Element).toLowerCase()).toContain('eliminar');
    });
  });

  test('borrar nunca es un clic suelto: el botón que abre el diálogo no envía nada (type="button")', async () => {
    const doc = await renderManager();
    [...doc.querySelectorAll('button[commandfor]')].forEach((b) => expect(b.getAttribute('type')).toBe('button'));
  });

  test('el diálogo tiene título (aria-labelledby), una acción para confirmar y otra para volver', async () => {
    const doc = await renderManager();
    const dialog = formsFor(doc, 'image-delete', IMG_A)[NONE].closest('dialog') as HTMLDialogElement;
    const title = doc.querySelector(`[id="${dialog.getAttribute('aria-labelledby')}"]`);
    expect(text(title).length).toBeGreaterThan(NONE);
    const buttons = [...dialog.querySelectorAll('button')].map((b) => text(b));
    expect(buttons.length).toBeGreaterThanOrEqual(TWO);
    expect(buttons.some((b) => RE_CONFIRM_WORD.test(b))).toBe(true);
    expect(buttons.some((b) => RE_BACK_WORD.test(b))).toBe(true);
  });

  test('el diálogo no está abierto de entrada (sin `open`)', async () => {
    const doc = await renderManager();
    [...doc.querySelectorAll('dialog')].forEach((d) => expect(d.hasAttribute('open')).toBe(false));
  });
});

describe('ImageManager · subida', () => {
  test('un formulario POST multipart con `image-upload`, el archivo y el alt obligatorio, y un botón de envío', async () => {
    const doc = await renderManager();
    const form = uploadForm(doc) as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.getAttribute('enctype')).toBe('multipart/form-data');
    expect(actionOf(form)).toBe('image-upload');
    const alt = form.querySelector('input[type="text"]') as HTMLInputElement;
    expect(alt.hasAttribute('required')).toBe(true);
    expect(alt.getAttribute('maxlength')).toBe(String(ALT_MAX));
    expect(labelFor(doc, alt).toLowerCase()).toContain('texto alternativo');
    expect(submitterOf(form)).not.toBeNull();
    expect(nameOf(submitterOf(form) as Element).toLowerCase()).toContain('subir');
  });

  test('el archivo acepta JPEG, PNG y WebP', async () => {
    const accept = (fileInput(await renderManager()) as HTMLInputElement).getAttribute('accept') ?? '';
    ACCEPT_SET.forEach((t) => expect(accept).toContain(t));
    expect(accept).not.toContain('gif');
  });

  test('hay un único formulario con archivo y es independiente de las filas (no anida otros formularios)', async () => {
    const doc = await renderManager();
    expect(doc.querySelectorAll('input[type="file"]')).toHaveLength(ONE);
    expect(uploadForm(doc)?.querySelectorAll('form')).toHaveLength(NONE);
  });

  test('con `max` alcanzado no se ofrece subir otro archivo; por debajo, sí', async () => {
    const full = await renderManager({ max: THREE });
    expect(enabledFileInputs(full)).toHaveLength(NONE);
    expect(text(full.body).toLowerCase()).toMatch(RE_MAX_WORD);
    const room = await renderManager({ max: THREE + ONE });
    expect(enabledFileInputs(room)).toHaveLength(ONE);
    const noMax = await renderManager();
    expect(enabledFileInputs(noMax)).toHaveLength(ONE);
  });
});

describe('ImageManager · errores por campo', () => {
  test('errors.file → bajo el archivo: aria-invalid y el texto vinculado', async () => {
    const doc = await renderManager({ errors: { file: 'El archivo supera los 5 MiB' } });
    const input = fileInput(doc) as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(errorsOf(doc, input)).toContain('El archivo supera los 5 MiB');
  });

  test('errors.alt sin imageId → en el alt de la subida, no en el de las imágenes', async () => {
    const doc = await renderManager({ errors: { alt: 'El texto alternativo es obligatorio' } });
    const upload = uploadForm(doc) as HTMLFormElement;
    const alt = upload.querySelector('input[type="text"]') as HTMLInputElement;
    expect(alt.getAttribute('aria-invalid')).toBe('true');
    expect(errorsOf(doc, alt)).toContain('El texto alternativo es obligatorio');
    IMAGES.forEach((img) => {
      const own = (itemOf(doc, img.id) as Element).querySelector('input[type="text"]') as HTMLInputElement;
      expect(own.getAttribute('aria-invalid')).not.toBe('true');
    });
  });

  test('errors.alt con imageId → solo en el alt de esa imagen', async () => {
    const doc = await renderManager({ errors: { alt: 'Texto alternativo no válido', imageId: IMG_B } });
    const own = (itemOf(doc, IMG_B) as Element).querySelector('input[type="text"]') as HTMLInputElement;
    expect(own.getAttribute('aria-invalid')).toBe('true');
    expect(errorsOf(doc, own)).toContain('Texto alternativo no válido');
    const others = [IMG_A, IMG_C].map((id) => (itemOf(doc, id) as Element).querySelector('input[type="text"]') as HTMLInputElement);
    others.forEach((o) => expect(o.getAttribute('aria-invalid')).not.toBe('true'));
    const upload = (uploadForm(doc) as HTMLFormElement).querySelector('input[type="text"]') as HTMLInputElement;
    expect(upload.getAttribute('aria-invalid')).not.toBe('true');
  });

  test('errors.form → un aviso de error anunciado (role="alert") con el texto', async () => {
    const doc = await renderManager({ errors: { form: 'Un producto publicado necesita al menos una imagen.' } });
    const alert = [...doc.querySelectorAll('[role="alert"]')].find((a) => text(a).includes('Un producto publicado necesita al menos una imagen.'));
    expect(alert).toBeDefined();
  });

  test('sin errores no hay avisos de error ni aria-invalid', async () => {
    const doc = await renderManager();
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(NONE);
    expect(doc.querySelectorAll('[aria-invalid="true"]')).toHaveLength(NONE);
  });

  test('los textos de error se escapan', async () => {
    const html = await renderAstro(ImageManager, {
      props: managerProps({ errors: { form: HOSTILE_ERROR, file: HOSTILE_ERROR, alt: HOSTILE_ERROR } }),
    });
    expect(html).not.toMatch(RE_LIVE_IMG_EVENT);
    expect(html).toContain('&lt;img');
  });
});

describe('ImageManager · imágenes de otro tipo de dato', () => {
  test('una imagen con alt vacío se pinta sin romper (campo vacío)', async () => {
    const doc = await renderManager({ images: [{ id: IMG_C, url: `${STORAGE}/c.webp`, alt: '' }] });
    expect(items(doc)).toHaveLength(ONE);
    expect(((itemOf(doc, IMG_C) as Element).querySelector('input[type="text"]') as HTMLInputElement).getAttribute('value') ?? '').toBe('');
  });

  test('con 30 imágenes se pintan todas y las pistas de posición no se desordenan', async () => {
    const many = Array.from({ length: MANY }, (_, i) => imageOf(`${String(i).padStart(ID_DIGITS, '0')}-0000-4000-8000-000000000000`, `m${i}`));
    const doc = await renderManager({ images: many });
    expect(items(doc)).toHaveLength(many.length);
    expect(visibleMain(doc)).toHaveLength(ONE);
  });
});

describe('ImageManager · altValue (conservar lo escrito tras un error)', () => {
  const uploadAlt = (doc: Document): HTMLInputElement => (uploadForm(doc) as HTMLFormElement).querySelector('input[type="text"]') as HTMLInputElement;

  test('altValue se pinta como valor del alt de la subida y de ningún otro campo', async () => {
    const doc = await renderManager({ altValue: 'Frente del reloj, esfera verde' });
    expect(uploadAlt(doc).getAttribute('value')).toBe('Frente del reloj, esfera verde');
    IMAGES.forEach((img) => {
      const own = (itemOf(doc, img.id) as Element).querySelector('input[type="text"]') as HTMLInputElement;
      expect(own.getAttribute('value')).toBe(img.alt);
    });
  });

  test('sin altValue el alt de la subida va vacío', async () => {
    const doc = await renderManager();
    expect(uploadAlt(doc).getAttribute('value') ?? '').toBe('');
  });

  test('altValue hostil se escapa: el valor llega intacto y no hay HTML ni eventos vivos', async () => {
    const doc = await renderManager({ altValue: HOSTILE_ALT });
    expect(uploadAlt(doc).getAttribute('value')).toBe(HOSTILE_ALT);
    expect([...doc.querySelectorAll('script')].map((s) => s.textContent).join('')).not.toContain('__pwned');
    expect(doc.querySelectorAll('[onerror]')).toHaveLength(NONE);
  });

  test('con altValue y un error de archivo, el valor y el error conviven', async () => {
    const doc = await renderManager({ altValue: 'Perfil', errors: { file: 'Formato no admitido: usa JPEG, PNG o WebP' } });
    expect(uploadAlt(doc).getAttribute('value')).toBe('Perfil');
    expect((fileInput(doc) as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('ImageManager · resumen de errores (RT-B10)', () => {
  const summary = (doc: Document): Element | null => doc.querySelector('[role="alert"]');
  const hrefs = (doc: Document): string[] => [...(summary(doc)?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href') ?? '');
  const targetExists = (doc: Document, href: string): boolean => doc.querySelector(`[id="${href.slice(ONE)}"]`) !== null;

  test('un resumen role="alert" enfocable por script (tabindex="-1") con el mensaje del formulario', async () => {
    const doc = await renderManager({ errors: { form: 'No se pudo guardar la imagen. Inténtalo de nuevo.' } });
    const el = summary(doc) as Element;
    expect(el).not.toBeNull();
    expect(el.getAttribute('tabindex')).toBe('-1');
    expect(text(el)).toContain('No se pudo guardar la imagen');
    expect(doc.querySelectorAll('[role="alert"]')).toHaveLength(ONE);
  });

  test('un error de archivo enlaza al campo del archivo y el destino existe', async () => {
    const doc = await renderManager({ errors: { file: 'El archivo supera los 5 MiB' } });
    expect(hrefs(doc)).toEqual([`#${fileInput(doc)?.getAttribute('id')}`]);
    hrefs(doc).forEach((h) => expect(targetExists(doc, h), h).toBe(true));
    expect(text(summary(doc))).toContain('El archivo supera los 5 MiB');
  });

  test('un error de alt de la subida enlaza al alt de la subida; con imageId, al alt de esa imagen', async () => {
    const up = await renderManager({ errors: { alt: 'Texto alternativo obligatorio' } });
    expect(hrefs(up)).toEqual([`#${(uploadForm(up) as HTMLFormElement).querySelector('input[type="text"]')?.getAttribute('id')}`]);
    const own = await renderManager({ errors: { alt: 'Texto alternativo no válido', imageId: IMG_B } });
    const ownInput = (itemOf(own, IMG_B) as Element).querySelector('input[type="text"]');
    expect(hrefs(own)).toEqual([`#${ownInput?.getAttribute('id')}`]);
    [up, own].forEach((d) => hrefs(d).forEach((h) => expect(targetExists(d, h), h).toBe(true)));
  });

  test('con error de formulario por servicio caído se ofrece «Reintentar»', async () => {
    const doc = await renderManager({ errors: { form: 'No se pudo guardar la imagen. Inténtalo de nuevo.' } });
    expect(text(summary(doc))).toContain('Reintentar');
  });

  test('sin errores no hay resumen', async () => {
    expect(summary(await renderManager())).toBeNull();
  });

  test('los textos del resumen se escapan', async () => {
    const html = await renderAstro(ImageManager, { props: managerProps({ errors: { form: HOSTILE_ERROR, file: HOSTILE_ERROR } }) });
    expect(html).not.toMatch(RE_LIVE_IMG_EVENT);
  });
});
