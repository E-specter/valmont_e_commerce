import { describe, expect, test } from 'vitest';
import Badge from '../../src/components/ui/Badge.astro';
import Button from '../../src/components/ui/Button.astro';
import Card from '../../src/components/ui/Card.astro';
import Checkbox from '../../src/components/ui/Checkbox.astro';
import Chip from '../../src/components/ui/Chip.astro';
import EmptyState from '../../src/components/ui/EmptyState.astro';
import Field from '../../src/components/ui/Field.astro';
import Icon from '../../src/components/ui/Icon.astro';
import IconButton from '../../src/components/ui/IconButton.astro';
import Notice from '../../src/components/ui/Notice.astro';
import StatusPill from '../../src/components/ui/StatusPill.astro';
import TextLink from '../../src/components/ui/TextLink.astro';
import BadgeBefore from '../helpers/fixtures/before-t147/Badge.astro';
import ButtonBefore from '../helpers/fixtures/before-t147/Button.astro';
import CardBefore from '../helpers/fixtures/before-t147/Card.astro';
import CheckboxBefore from '../helpers/fixtures/before-t147/Checkbox.astro';
import ChipBefore from '../helpers/fixtures/before-t147/Chip.astro';
import EmptyStateBefore from '../helpers/fixtures/before-t147/EmptyState.astro';
import FieldBefore from '../helpers/fixtures/before-t147/Field.astro';
import IconBefore from '../helpers/fixtures/before-t147/Icon.astro';
import IconButtonBefore from '../helpers/fixtures/before-t147/IconButton.astro';
import NoticeBefore from '../helpers/fixtures/before-t147/Notice.astro';
import StatusPillBefore from '../helpers/fixtures/before-t147/StatusPill.astro';
import TextLinkBefore from '../helpers/fixtures/before-t147/TextLink.astro';
import { parseHtml, renderAstro } from '../helpers/render';

// T-147 · RIESGO PRINCIPAL del paquete UI: añadir `Select`, `Textarea` y `RadioGroup` no cambia el HTML de los `ui/` existentes.
// Los fixtures `before-t147/*` son copias EXACTAS de `frontend/src/components/ui/*` en main f6c45ae. Se compara el marcado (sin los
// atributos y clases de ámbito de Astro ni las hojas de estilo), no los estilos.
const NONE = 0;
const ONE = 1;
const SIZE_SMALL = 16;
const SIZE_LARGE = 32;

/** Marcado comparable: sin <style>/<script>, sin `data-astro-cid-*` ni clases `astro-*`, con espacios normalizados. */
function normalize(html: string): string {
  const doc = parseHtml(html);
  doc.querySelectorAll('style, script').forEach((el) => el.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    [...el.attributes].filter((a) => a.name.startsWith('data-astro-cid')).forEach((a) => el.removeAttribute(a.name));
    [...el.classList].filter((c) => c.startsWith('astro-')).forEach((c) => el.classList.remove(c));
    if (el.getAttribute('class') === '') el.removeAttribute('class');
  });
  return doc.body.innerHTML.replaceAll('\n', ' ').split(' ').filter(Boolean).join(' ');
}

type Component = Parameters<typeof renderAstro>[0];
type Case = [name: string, props: Record<string, unknown>, slots?: Record<string, string>];
const SUITES: [name: string, now: Component, before: Component, cases: Case[]][] = [
  [
    'Field',
    Field,
    FieldBefore,
    [
      ['texto', { id: 'a', name: 'a', label: 'Nombre' }],
      ['valor y requerido', { id: 'a', name: 'a', label: 'Nombre', value: 'Ana', required: true }],
      ['error y ayuda', { id: 'a', name: 'a', label: 'Nombre', error: 'Mal', hint: 'Ayuda' }],
      ['tono oscuro', { id: 'a', name: 'a', label: 'Nombre', tone: 'dark' }],
      ['numérico con límites', { id: 'a', name: 'a', label: 'N', type: 'number', min: ONE, max: SIZE_LARGE, inputmode: 'numeric' }],
    ],
  ],
  [
    'Button',
    Button,
    ButtonBefore,
    [
      ['primario', {}, { default: 'Guardar' }],
      ['submit con form', { type: 'submit', form: 'x' }, { default: 'Guardar' }],
      ['secundario', { variant: 'secondary' }, { default: 'Publicar' }],
      ['enlace', { href: '/admin/productos', variant: 'ghost' }, { default: 'Cancelar' }],
      ['ancho completo', { fullWidth: true }, { default: 'Ok' }],
      ['cargando', { loading: true, type: 'submit' }, { default: 'Guardando' }],
    ],
  ],
  [
    'Notice',
    Notice,
    NoticeBefore,
    [
      ['info', {}, { default: 'Mensaje' }],
      ['advertencia con título', { tone: 'warning', title: 'Ojo' }, { default: 'Cuidado' }],
      ['error con acciones', { tone: 'error' }, { default: 'Falló', actions: '<a href="/r">Reintentar</a>' }],
      ['éxito', { tone: 'success' }, { default: 'Hecho' }],
    ],
  ],
  ['Card', Card, CardBefore, [['sección', { as: 'section' }, { default: '<h2>T</h2>' }], ['por defecto', {}, { default: 'x' }]]],
  [
    'Checkbox',
    Checkbox,
    CheckboxBefore,
    [['simple', { id: 'c', name: 'c', label: 'Acepto' }], ['marcado con error', { id: 'c', name: 'c', label: 'Acepto', checked: true, error: 'Falta' }]],
  ],
  ['Icon', Icon, IconBefore, [['trash', { name: 'trash', size: SIZE_SMALL }], ['plus', { name: 'plus', size: SIZE_LARGE }], ['alert', { name: 'alert-triangle', size: SIZE_SMALL }]]],
  ['IconButton', IconButton, IconButtonBefore, [['básico', { icon: 'trash', label: 'Quitar' }]]],
  ['TextLink', TextLink, TextLinkBefore, [['enlace', { href: '/admin/productos' }, { default: 'Volver' }]]],
  ['Badge', Badge, BadgeBefore, [['estado', {}, { default: 'Nuevo' }]]],
  ['Chip', Chip, ChipBefore, [['chip', {}, { default: 'Acero' }]]],
  ['EmptyState', EmptyState, EmptyStateBefore, [['vacío', { title: 'Sin resultados' }, { default: 'Prueba otra búsqueda' }]]],
  [
    'StatusPill',
    StatusPill,
    StatusPillBefore,
    [['borrador', { label: 'Borrador', tone: 'neutral' }], ['publicado', { label: 'Publicado', tone: 'paid' }]],
  ],
];

describe.each(SUITES)('el HTML de ui/%s no cambia con T-147', (_name, now, before, cases) => {
  test.each(cases)('%s', async (_case, props, slots = {}) => {
    const [a, b] = await Promise.all([renderAstro(now, { props, slots }), renderAstro(before, { props, slots })]);
    expect(normalize(a).length).toBeGreaterThan(NONE);
    expect(normalize(a)).toBe(normalize(b));
  });
});
