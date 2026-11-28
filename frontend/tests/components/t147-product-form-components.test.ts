import { describe, expect, test } from 'vitest';
import ProductForm from '../../src/components/admin/ProductForm.astro';
import PublishPanel from '../../src/components/admin/PublishPanel.astro';
import SpecsEditor from '../../src/components/admin/SpecsEditor.astro';
import { MSG_PUBLISH_MISSING } from '../../src/lib/admin/messages';
import { EMPTY_PRODUCT_VALUES } from '../../src/lib/admin/product-form';
import { parseHtml, renderAstro } from '../helpers/render';
import { CASE_MATERIALS, CATEGORIES, FORBIDDEN_NAMES, MOVEMENTS, PRODUCT_ID, SCALAR_FIELDS, formValues, serialize } from '../helpers/t147';
import { describedBy, text } from '../helpers/ui';

// T-147 · ProductForm, PublishPanel y SpecsEditor (Container API): campos, etiquetas, errores, ARIA y estructura del frame `201:748`.
const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const MAX_SPECS = 40;
const HOSTILE = '"><img src=x onerror=alert(1)><script>window.__pwned=1</script>';
const POLICY_LABELS = ['Solo con stock', 'Siempre bajo pedido', 'Con stock y, agotado, bajo pedido'];
const LABEL_WORDS: Record<string, string> = {
  sku: 'sku', slug: 'slug', name: 'nombre', description: 'descripción', category_id: 'categoría', price: 'precio (s/)', lead_time_days: 'plazo',
  movement_code: 'movimiento', case_material_code: 'material', case_diameter_mm: 'diámetro', water_resistance_m: 'resistencia al agua',
};

type Props = Record<string, unknown>;
const formProps = (over: Props = {}): Props => ({
  mode: 'create', values: EMPTY_PRODUCT_VALUES, categories: CATEGORIES, movements: MOVEMENTS, caseMaterials: CASE_MATERIALS, ...over,
});
const renderForm = async (over: Props = {}, slots: Record<string, string> = {}): Promise<Document> =>
  parseHtml(await renderAstro(ProductForm, { props: formProps(over), slots }));
const renderPanel = async (over: Props = {}): Promise<Document> =>
  parseHtml(await renderAstro(PublishPanel, { props: { productId: PRODUCT_ID, status: 'draft', ...over } }));
const renderSpecs = async (over: Props = {}): Promise<Document> => parseHtml(await renderAstro(SpecsEditor, { props: { specs: [], ...over } }));

const mainForm = (doc: Document): HTMLFormElement => doc.querySelector('form#product-form') as HTMLFormElement;
const control = (doc: Document, name: string): Element | null => doc.querySelector(`[name="${name}"]`);
const buttonsNamed = (doc: ParentNode, label: string): Element[] => [...doc.querySelectorAll('button, a')].filter((b) => text(b) === label);
const specInputs = (doc: ParentNode): HTMLInputElement[] => [...doc.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
/** Etiqueta accesible: aria-label, <label for>, <label> que envuelve, o aria-labelledby. */
function accessibleName(doc: ParentNode, el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const id = el.getAttribute('id');
  const forLabel = id ? doc.querySelector(`label[for="${id}"]`) : null;
  const label = forLabel ?? el.closest('label');
  if (label) return text(label);
  const by = el.getAttribute('aria-labelledby');
  return by ? by.split(' ').map((i) => text(doc.querySelector(`[id="${i}"]`))).join(' ') : '';
}
/** Acción que enviaría un formulario con ese botón: `_action` oculto o `name`/`value` del propio botón. */
function submittedAction(form: Element, button: Element): string | undefined {
  const own = button.getAttribute('name') === '_action' ? button.getAttribute('value') : null;
  return own ?? serialize(form).find(([k]) => k === '_action')?.[ONE];
}

describe('ProductForm · estructura y campos', () => {
  test('un <form id="product-form" method="post"> que envía a la propia página, con la acción `save`', async () => {
    const doc = await renderForm();
    const form = mainForm(doc);
    expect(form).not.toBeNull();
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(['', null, undefined]).toContain(form.getAttribute('action'));
    expect(serialize(form).find(([k]) => k === '_action')?.[ONE]).toBe('save');
  });

  test('los 12 campos escalares existen con el nombre de ProductFormValues, dentro del formulario', async () => {
    const form = mainForm(await renderForm());
    SCALAR_FIELDS.forEach((name) => expect(form.querySelector(`[name="${name}"]`), name).not.toBeNull());
    expect(form.querySelector('select[name="category_id"]')).not.toBeNull();
    expect(form.querySelector('select[name="movement_code"]')).not.toBeNull();
    expect(form.querySelector('select[name="case_material_code"]')).not.toBeNull();
    expect(form.querySelector('textarea[name="description"]')).not.toBeNull();
    expect(form.querySelectorAll('input[type="radio"][name="order_policy"]')).toHaveLength(THREE);
  });

  test('cada campo tiene una etiqueta accesible con su nombre en español', async () => {
    const doc = await renderForm();
    Object.entries(LABEL_WORDS).forEach(([name, word]) => {
      const el = control(doc, name) as Element;
      expect(accessibleName(doc, el).toLowerCase(), name).toContain(word);
    });
    expect(text(doc.querySelector('fieldset legend')).toLowerCase()).toContain('política');
  });

  test('la política de venta ofrece los tres textos del frame, en orden', async () => {
    const doc = await renderForm();
    const labels = [...doc.querySelectorAll('input[name="order_policy"]')].map((i) => text(i.closest('label')));
    POLICY_LABELS.forEach((l, i) => expect(labels[i]).toContain(l));
    expect([...doc.querySelectorAll('input[name="order_policy"]')].map((i) => i.getAttribute('value'))).toEqual(['stock', 'made_to_order', 'backorder']);
  });

  test('los atributos opcionales (movimiento, material) permiten dejar la opción vacía para borrarlos', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues() });
    ['movement_code', 'case_material_code'].forEach((name) => {
      const values = [...(control(doc, name) as Element).querySelectorAll('option')].map((o) => o.getAttribute('value'));
      expect(values, name).toContain('');
    });
  });

  test('las listas del backend llegan como opciones: categorías por id, atributos por código', async () => {
    const doc = await renderForm();
    const cat = [...(control(doc, 'category_id') as Element).querySelectorAll('option')].map((o) => [o.getAttribute('value'), text(o)]);
    expect(cat).toEqual(expect.arrayContaining(CATEGORIES.map((c) => [c.id, c.name])));
    const mov = [...(control(doc, 'movement_code') as Element).querySelectorAll('option')].map((o) => [o.getAttribute('value'), text(o)]);
    expect(mov).toEqual(expect.arrayContaining(MOVEMENTS.map((m) => [m.code, m.label])));
  });

  test('los valores recibidos rellenan cada control (precio tal cual, selects, política, descripción y especificaciones)', async () => {
    const v = formValues({ description: 'Línea 1\nLínea 2', price: '1250.50' });
    const doc = await renderForm({ mode: 'edit', values: v });
    const entries = serialize(mainForm(doc));
    const get = (k: string) => entries.find(([n]) => n === k)?.[ONE];
    SCALAR_FIELDS.forEach((k) => expect(get(k), k).toBe(v[k]));
    const pairs = entries.filter(([k]) => !(SCALAR_FIELDS as readonly string[]).includes(k) && k !== '_action').map(([, val]) => val);
    expect(pairs.slice(NONE, v.specs.length * TWO)).toEqual(v.specs.flatMap((s) => [s.label, s.value]));
  });

  test('el formulario no envía status, id, published_at, images ni datos de usuario o importes calculados', async () => {
    const form = mainForm(await renderForm({ mode: 'edit', values: formValues() }));
    const names = serialize(form).map(([k]) => k);
    FORBIDDEN_NAMES.forEach((bad) => expect(names, bad).not.toContain(bad));
    expect(names.filter((n) => n.toLowerCase().includes('status') || n.toLowerCase().includes('image'))).toEqual([]);
  });

  test('las secciones del frame son tarjetas con h2: datos, precio y venta, atributos y especificaciones', async () => {
    const heads = [...(await renderForm()).querySelectorAll('h2')].map((h) => text(h).toLowerCase());
    ['datos', 'precio', 'atributos', 'especificaciones'].forEach((w) => expect(heads.some((h) => h.includes(w)), w).toBe(true));
  });

  test('las especificaciones muestran el contador «N de 40»', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues() });
    expect(text(doc.body)).toContain(`${TWO} de ${MAX_SPECS}`);
    expect(text((await renderForm()).body)).toContain(`${NONE} de ${MAX_SPECS}`);
  });

  test('valores hostiles en cualquier campo se escapan (sin <script> ni <img>)', async () => {
    const v = formValues({ sku: HOSTILE, slug: HOSTILE, name: HOSTILE, description: `</textarea><script>1</script>${HOSTILE}`, price: HOSTILE, specs: [{ label: HOSTILE, value: HOSTILE }] });
    const doc = await renderForm({ mode: 'edit', values: v, errors: { name: HOSTILE, form: HOSTILE } });
    expect(doc.querySelectorAll('script:not([src]), img')).toHaveLength(NONE);
    expect(serialize(mainForm(doc)).find(([k]) => k === 'name')?.[ONE]).toBe(HOSTILE);
  });
});

describe('ProductForm · crear y editar', () => {
  test('crear: «Crear producto» (envía) y «Cancelar» (enlace a /admin/productos) al pie; sin panel de publicación ni «Guardar cambios»', async () => {
    const doc = await renderForm({ mode: 'create' });
    const create = buttonsNamed(doc, 'Crear producto')[NONE];
    expect(create).toBeDefined();
    expect(create.getAttribute('type')).toBe('submit');
    expect(mainForm(doc).contains(create)).toBe(true);
    const cancel = buttonsNamed(doc, 'Cancelar')[NONE];
    expect(cancel.tagName).toBe('A');
    expect(cancel.getAttribute('href')).toBe('/admin/productos');
    expect(buttonsNamed(doc, 'Guardar cambios')).toHaveLength(NONE);
    expect(buttonsNamed(doc, 'Publicar')).toHaveLength(NONE);
    expect(buttonsNamed(doc, 'Despublicar')).toHaveLength(NONE);
  });

  test('crear: avisa «Guarda el producto para añadir imágenes» y no muestra el hueco de imágenes', async () => {
    const doc = await renderForm({ mode: 'create' }, { images: '<p id="slot-images">IMAGENES</p>' });
    expect(text(doc.body).toLowerCase()).toContain('guarda el producto para añadir imágenes');
    expect(doc.getElementById('slot-images')).toBeNull();
  });

  test('editar: el hueco `images` y el `panel` se pintan; no aparece el aviso de guardar primero', async () => {
    const doc = await renderForm(
      { mode: 'edit', values: formValues() },
      { images: '<p id="slot-images">IMAGENES</p>', panel: '<div id="slot-panel">PANEL</div>' },
    );
    expect(doc.getElementById('slot-images')).not.toBeNull();
    expect(doc.getElementById('slot-panel')).not.toBeNull();
    expect(text(doc.body).toLowerCase()).not.toContain('guarda el producto para añadir imágenes');
  });

  test('editar: el panel lateral está fuera del <form> (no se anidan formularios) y «Guardar cambios» envía con form="product-form"', async () => {
    const panelHtml = await renderAstro(PublishPanel, { props: { productId: PRODUCT_ID, status: 'draft' } });
    const doc = await renderForm({ mode: 'edit', values: formValues() }, { panel: panelHtml });
    const save = buttonsNamed(doc, 'Guardar cambios')[NONE];
    expect(save).toBeDefined();
    expect(save.getAttribute('type')).toBe('submit');
    expect(save.getAttribute('form')).toBe('product-form');
    expect(mainForm(doc).contains(save)).toBe(false);
    expect(doc.querySelectorAll('form form')).toHaveLength(NONE);
    expect(mainForm(doc).querySelector('[name="_action"][value="publish"], [name="_action"][value="unpublish"]')).toBeNull();
  });

  test('editar: el primer botón de envío asociado al formulario es el de guardar (Enter en un campo nunca publica)', async () => {
    const panelHtml = await renderAstro(PublishPanel, { props: { productId: PRODUCT_ID, status: 'draft' } });
    const doc = await renderForm({ mode: 'edit', values: formValues() }, { panel: panelHtml });
    const form = mainForm(doc);
    const associated = [...doc.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(
      (b) => form.contains(b) || b.getAttribute('form') === 'product-form',
    );
    expect(associated.length).toBeGreaterThan(NONE);
    expect(submittedAction(form, associated[NONE])).toBe('save');
  });

  test.each([
    ['created', 'creado'],
    ['updated', 'guardado'],
    ['unchanged', 'sin cambios'],
  ] as const)('aviso `saved: %s` con su texto; sin la prop no hay aviso', async (saved, word) => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), saved });
    expect(text(doc.body).toLowerCase()).toContain(word);
    const none = await renderForm({ mode: 'edit', values: formValues() });
    ['producto creado', 'cambios guardados', 'sin cambios'].forEach((w) => expect(text(none.body).toLowerCase(), w).not.toContain(w));
  });
});

describe('ProductForm · errores y accesibilidad', () => {
  const ERRORS = { sku: 'Ya existe un producto con este SKU.', price: 'El valor no es válido.', name: 'Completa este campo.' };

  test('cada error de campo: aria-invalid="true" y aria-describedby con su texto', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: ERRORS });
    Object.entries(ERRORS).forEach(([name, msg]) => {
      const el = control(doc, name) as Element;
      expect(el.getAttribute('aria-invalid'), name).toBe('true');
      expect(describedBy(doc, el).map((d) => d.text).join(' '), name).toContain(msg);
    });
    expect((control(doc, 'description') as Element).hasAttribute('aria-invalid')).toBe(false);
  });

  test('un campo sin error no está marcado como inválido en todo el formulario', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues() });
    expect(doc.querySelectorAll('[aria-invalid="true"]')).toHaveLength(NONE);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('resumen de errores: role="alert" enfocable, con cada mensaje y enlaces que apuntan a controles existentes', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: ERRORS });
    const alert = doc.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    Object.values(ERRORS).forEach((m) => expect(text(alert)).toContain(m));
    expect(alert.getAttribute('tabindex')).toBe('-1');
    const links = [...alert.querySelectorAll('a[href^="#"]')];
    expect(links).toHaveLength(Object.keys(ERRORS).length);
    links.forEach((a) => expect(doc.getElementById((a.getAttribute('href') as string).slice(ONE)), a.getAttribute('href') ?? '').not.toBeNull());
  });

  test('errors.form: mensaje de formulario en el resumen', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: { form: 'La dirección de un producto publicado no se puede cambiar.' } });
    expect(text(doc.querySelector('[role="alert"]'))).toContain('La dirección de un producto publicado no se puede cambiar.');
  });

  test('error de política de venta: dentro del grupo y referenciado', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: { order_policy: 'Elige una política.' } });
    expect(text(doc.querySelector('fieldset'))).toContain('Elige una política.');
  });

  test('error en las especificaciones: el enlace del resumen lleva a un elemento que existe', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: { specs: 'Completa la etiqueta y el valor.' } });
    const link = doc.querySelector('[role="alert"] a[href^="#"]') as Element;
    expect(link).not.toBeNull();
    expect(doc.getElementById((link.getAttribute('href') as string).slice(ONE))).not.toBeNull();
  });

  test('todos los id del formulario son únicos y ningún botón que no envíe es de tipo submit por omisión', async () => {
    const doc = await renderForm({ mode: 'edit', values: formValues(), errors: ERRORS });
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
    [...mainForm(doc).querySelectorAll('button')].forEach((b) => expect(b.getAttribute('type'), text(b)).not.toBeNull());
  });
});

describe('PublishPanel', () => {
  test('borrador: pill «Borrador» y botón «Publicar» en su propio formulario POST con la acción `publish`', async () => {
    const doc = await renderPanel({ status: 'draft' });
    expect(text(doc.body)).toContain('Borrador');
    const publish = buttonsNamed(doc, 'Publicar')[NONE];
    expect(publish).toBeDefined();
    const form = publish.closest('form') as HTMLFormElement;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(submittedAction(form, publish)).toBe('publish');
    expect(buttonsNamed(doc, 'Despublicar')).toHaveLength(NONE);
  });

  test('publicado: pill «Publicado» y botón «Despublicar» con la acción `unpublish`; ya no hay «Publicar»', async () => {
    const doc = await renderPanel({ status: 'published' });
    expect(text(doc.body)).toContain('Publicado');
    const unpublish = buttonsNamed(doc, 'Despublicar')[NONE];
    expect(unpublish).toBeDefined();
    expect(submittedAction(unpublish.closest('form') as Element, unpublish)).toBe('unpublish');
    expect(buttonsNamed(doc, 'Publicar')).toHaveLength(NONE);
  });

  test('el formulario de publicar solo envía la acción: ningún id, estado, precio ni campo del producto', async () => {
    const doc = await renderPanel();
    const form = buttonsNamed(doc, 'Publicar')[NONE].closest('form') as Element;
    const names = serialize(form).map(([k]) => k);
    expect(names.filter((n) => n !== '_action')).toEqual([]);
    expect(form.getAttribute('action') ?? '').not.toContain('//');
    expect(form.getAttribute('action') ?? '/admin/productos/').toContain('/admin/productos/');
  });

  test('«Guardar cambios» está fuera de todo <form> y envía al del producto (form="product-form")', async () => {
    const doc = await renderPanel();
    const save = buttonsNamed(doc, 'Guardar cambios')[NONE];
    expect(save).toBeDefined();
    expect(save.getAttribute('type')).toBe('submit');
    expect(save.getAttribute('form')).toBe('product-form');
    expect(save.closest('form')).toBeNull();
  });

  test('«Descartar cambios» es un enlace a la propia página del producto (recarga sin guardar)', async () => {
    const link = buttonsNamed(await renderPanel(), 'Descartar cambios')[NONE];
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`/admin/productos/${PRODUCT_ID}`);
  });

  test('requisitos que faltan: aviso «No se puede publicar todavía» con cada uno traducido; sin las claves en bruto', async () => {
    const doc = await renderPanel({ missing: ['description', 'image', 'lead_time_days', 'category', 'price'] });
    expect(text(doc.body)).toContain('No se puede publicar todavía');
    ['description', 'image', 'lead_time_days', 'category', 'price'].forEach((k) => {
      expect(text(doc.body), k).toContain(MSG_PUBLISH_MISSING[k]);
      if (k !== 'image') expect(text(doc.body), k).not.toContain(k); // 'image' está dentro de «imagen»
    });
    expect(doc.querySelectorAll('li').length).toBeGreaterThanOrEqual(THREE);
  });

  test('sin requisitos pendientes no hay aviso', async () => {
    expect(text((await renderPanel({ missing: [] })).body)).not.toContain('No se puede publicar todavía');
    expect(text((await renderPanel()).body)).not.toContain('No se puede publicar todavía');
  });

  test('una clave desconocida en `missing` no rompe el renderizado', async () => {
    const doc = await renderPanel({ missing: ['name', 'algo_nuevo'] });
    expect(text(doc.body)).toContain('No se puede publicar todavía');
  });

  test('un error del panel se muestra como texto', async () => {
    expect(text((await renderPanel({ error: 'No está disponible por ahora.' })).body)).toContain('No está disponible por ahora.');
  });

  test('un id de producto o un error hostiles se escapan', async () => {
    const doc = await renderPanel({ productId: HOSTILE, error: HOSTILE, missing: [HOSTILE] });
    expect(doc.querySelectorAll('script:not([src]), img')).toHaveLength(NONE);
  });

  test('un solo h2 «Publicación» y los iconos son decorativos', async () => {
    const doc = await renderPanel({ error: 'x' });
    expect(text(doc.querySelector('h2')).toLowerCase()).toContain('publicación');
    doc.querySelectorAll('svg').forEach((s) => expect(s.getAttribute('aria-hidden')).toBe('true'));
  });
});

describe('SpecsEditor', () => {
  const rows = (doc: Document): number => specInputs(doc).length / TWO;

  test('sin especificaciones: 2 filas vacías; con 1 existente: 3 (las existentes y 2 vacías)', async () => {
    expect(rows(await renderSpecs())).toBe(TWO);
    expect(rows(await renderSpecs({ specs: [{ label: 'Calibre', value: 'VM-01' }] }))).toBe(THREE);
  });

  test('las filas existentes se pintan con sus valores, en orden', async () => {
    const specs = [{ label: 'Calibre', value: 'VM-01' }, { label: 'Cristal', value: 'Zafiro' }];
    const values = specInputs(await renderSpecs({ specs })).map((i) => i.getAttribute('value'));
    expect(values.slice(NONE, specs.length * TWO)).toEqual(['Calibre', 'VM-01', 'Cristal', 'Zafiro']);
  });

  test('con `max`: nunca más filas que el máximo, ni siquiera con las vacías', async () => {
    const full = Array.from({ length: MAX_SPECS }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    expect(rows(await renderSpecs({ specs: full }))).toBe(MAX_SPECS);
    expect(rows(await renderSpecs({ specs: full.slice(NONE, TWO), max: THREE }))).toBe(THREE);
  });

  test('las columnas «Característica» y «Valor» son visibles y cada control tiene nombre accesible único', async () => {
    const doc = await renderSpecs({ specs: [{ label: 'A', value: 'B' }] });
    expect(text(doc.body)).toContain('Característica');
    expect(text(doc.body)).toContain('Valor');
    const names = specInputs(doc).map((i) => accessibleName(doc, i));
    names.forEach((n) => expect(n.length).toBeGreaterThan(NONE));
    expect(new Set(names).size).toBe(names.length);
  });

  test('todos los botones son type="button" (ninguno envía el formulario) y existe «Agregar especificación»', async () => {
    const doc = await renderSpecs({ specs: [{ label: 'A', value: 'B' }] });
    const buttons = [...doc.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(NONE);
    buttons.forEach((b) => expect(b.getAttribute('type'), text(b)).toBe('button'));
    expect(buttons.some((b) => text(b) === 'Agregar especificación')).toBe(true);
    expect(buttons.filter((b) => b.getAttribute('aria-label')?.toLowerCase().includes('quitar')).length).toBeGreaterThanOrEqual(THREE);
  });

  test('error por fila: solo los controles de esa fila quedan inválidos, con el texto referenciado', async () => {
    const doc = await renderSpecs({ specs: [{ label: 'A', value: 'B' }, { label: 'C', value: '' }], errors: { 1: 'Completa la etiqueta y el valor.' } });
    const all = specInputs(doc);
    const invalid = all.filter((i) => i.getAttribute('aria-invalid') === 'true');
    expect(invalid.length).toBeGreaterThanOrEqual(ONE);
    invalid.forEach((i) => expect(all.indexOf(i)).toBeGreaterThanOrEqual(TWO));
    expect(all.slice(NONE, TWO).some((i) => i.hasAttribute('aria-invalid'))).toBe(false);
    expect(describedBy(doc, invalid[NONE]).map((d) => d.text).join(' ')).toContain('Completa la etiqueta y el valor.');
  });

  test('textos hostiles se escapan', async () => {
    const doc = await renderSpecs({ specs: [{ label: HOSTILE, value: HOSTILE }], errors: { 0: HOSTILE } });
    expect(doc.querySelectorAll('script:not([src]), img')).toHaveLength(NONE);
    expect(specInputs(doc)[NONE].getAttribute('value')).toBe(HOSTILE);
  });

});
