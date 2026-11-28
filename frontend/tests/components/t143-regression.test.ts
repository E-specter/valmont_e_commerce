import { describe, expect, test } from 'vitest';
import Availability from '../../src/components/ui/Availability.astro';
import Badge from '../../src/components/ui/Badge.astro';
import Breadcrumb from '../../src/components/ui/Breadcrumb.astro';
import Button from '../../src/components/ui/Button.astro';
import Card from '../../src/components/ui/Card.astro';
import Checkbox from '../../src/components/ui/Checkbox.astro';
import Checkerboard from '../../src/components/ui/Checkerboard.astro';
import Chip from '../../src/components/ui/Chip.astro';
import DefinitionList from '../../src/components/ui/DefinitionList.astro';
import EmptyState from '../../src/components/ui/EmptyState.astro';
import Field from '../../src/components/ui/Field.astro';
import Icon from '../../src/components/ui/Icon.astro';
import IconButton from '../../src/components/ui/IconButton.astro';
import Notice from '../../src/components/ui/Notice.astro';
import Pagination from '../../src/components/ui/Pagination.astro';
import Price from '../../src/components/ui/Price.astro';
import Skeleton from '../../src/components/ui/Skeleton.astro';
import TextLink from '../../src/components/ui/TextLink.astro';
import Wordmark from '../../src/components/ui/Wordmark.astro';
import AvailabilityBefore from '../helpers/fixtures/before-t143/Availability.astro';
import BadgeBefore from '../helpers/fixtures/before-t143/Badge.astro';
import BreadcrumbBefore from '../helpers/fixtures/before-t143/Breadcrumb.astro';
import ButtonBefore from '../helpers/fixtures/before-t143/Button.astro';
import CardBefore from '../helpers/fixtures/before-t143/Card.astro';
import CheckboxBefore from '../helpers/fixtures/before-t143/Checkbox.astro';
import CheckerboardBefore from '../helpers/fixtures/before-t143/Checkerboard.astro';
import ChipBefore from '../helpers/fixtures/before-t143/Chip.astro';
import DefinitionListBefore from '../helpers/fixtures/before-t143/DefinitionList.astro';
import EmptyStateBefore from '../helpers/fixtures/before-t143/EmptyState.astro';
import FieldBefore from '../helpers/fixtures/before-t143/Field.astro';
import IconBefore from '../helpers/fixtures/before-t143/Icon.astro';
import IconButtonBefore from '../helpers/fixtures/before-t143/IconButton.astro';
import NoticeBefore from '../helpers/fixtures/before-t143/Notice.astro';
import PaginationBefore from '../helpers/fixtures/before-t143/Pagination.astro';
import PriceBefore from '../helpers/fixtures/before-t143/Price.astro';
import SkeletonBefore from '../helpers/fixtures/before-t143/Skeleton.astro';
import TextLinkBefore from '../helpers/fixtures/before-t143/TextLink.astro';
import WordmarkBefore from '../helpers/fixtures/before-t143/Wordmark.astro';
import { renderAstro } from '../helpers/render';

// T-143 · RIESGO PRINCIPAL: los `ui/` de la tienda, sin las props nuevas, producen el MISMO HTML que antes.
// Los fixtures `before-t143/*` son copias EXACTAS de `frontend/src/components/ui/*` en main d352052 (solo cambia la ruta de
// `lib/format` en Price). Se compara el marcado, no los estilos (los estilos de la tienda se comparan en el E2E, por estilo calculado).
const CELL_LARGE = 32;
const CELL_SMALL = 16;
const TWO = 2;
const THREE = 3;
const ICON_LARGE = 32;
const ICON_BUTTON_SMALL = 32;
const ICON_BUTTON_LARGE = 56;
const ONE = 1;
const NINE = 9;
const PAGE_SIZE_ROWS = 12;
const PAGE_SIZE_TEN = 10;
const FEW_ITEMS = 5;
const MANY_ITEMS = 120;
const HUNDRED_ITEMS = 100;
const LEAD_DAYS = 45;
const PRICE_BASE = 125000;
const PRICE_FRACTION = 125050;
const PRICE_SALE = 100000;
const PRICE_DISCOUNT = 25000;
const MONEY = (amount: number) => ({ amount, currency: 'PEN' });
// Acepta ` data-astro-cid-abc123` y ` data-astro-cid-abc123="x"`; rechaza `data-tone="light"`.
const CID_ATTR = / data-astro-cid-\w+(="[^"]*")?/g;
// Acepta la clase de ámbito ` astro-abc123` (con o sin espacio delante); rechaza `astro` suelto.
const CID_CLASS = /\s?astro-[a-z0-9]+/g;
// Acepta un bloque `<style>…</style>` completo, incluso con saltos de línea; rechaza un `<styled>` sin cierre.
const STYLE_BLOCK = /<style[\s\S]*?<\/style>/g;
// Acepta cualquier racha de espacios o saltos de línea (varios espacios seguidos); rechaza el texto sin espacios.
const WHITESPACE_RUN = /\s+/g;
const normalize = (html: string): string => html.replace(STYLE_BLOCK, '').replace(CID_ATTR, '').replace(CID_CLASS, '').replace(WHITESPACE_RUN, ' ').trim();

type Component = Parameters<typeof renderAstro>[0];
type Props = Record<string, unknown>;
type Slots = Record<string, string>;
type Case = [name: string, props: Props, slots?: Slots];
const render = (c: Component, props: Props, slots: Slots = {}): Promise<string> => renderAstro(c, { props, slots });

const SUITES: [name: string, now: Component, before: Component, cases: Case[]][] = [
  [
    'Button',
    Button,
    ButtonBefore,
    [
      ['primario por defecto', {}, { default: 'Comprar' }],
      ['dark', { variant: 'dark' }, { default: 'Ingresar' }],
      ['secondary', { variant: 'secondary' }, { default: 'Cancelar' }],
      ['mint', { variant: 'mint' }, { default: 'Ver' }],
      ['tamaño lg', { size: 'lg' }, { default: 'Grande' }],
      ['submit', { type: 'submit' }, { default: 'Enviar' }],
      ['reset', { type: 'reset' }, { default: 'Limpiar' }],
      ['como enlace', { href: '/x' }, { default: 'Ir' }],
      ['enlace deshabilitado', { href: '/x', disabled: true }, { default: 'Ir' }],
      ['deshabilitado', { disabled: true }, { default: 'No' }],
      ['cargando', { loading: true, type: 'submit' }, { default: 'Guardando' }],
      ['ancho completo con icono', { fullWidth: true, iconRight: 'arrow-right' }, { default: 'Seguir' }],
      ['atributos y clase extra', { class: 'extra', id: 'b1', 'aria-label': 'Algo', name: 'n', value: 'v' }, { default: 'Texto' }],
    ],
  ],
  [
    'Notice',
    Notice,
    NoticeBefore,
    [
      ['info por defecto', {}, { default: '<p>Mensaje</p>' }],
      ['success', { tone: 'success' }, { default: 'Hecho' }],
      ['warning con título', { tone: 'warning', title: 'Ojo' }, { default: 'Cuidado' }],
      ['error', { tone: 'error', title: 'Falló' }, { default: 'Reintenta' }],
      ['con acciones', { tone: 'error' }, { default: 'Falló', actions: '<a href="/r">Reintentar</a>' }],
      ['clase y atributos', { class: 'extra', id: 'n1' }, { default: 'x' }],
    ],
  ],
  [
    'Badge',
    Badge,
    BadgeBefore,
    [
      ['status', {}, { default: 'En preparación' }],
      ['producto', { kind: 'product' }, { default: 'Nuevo' }],
      ['contador', { kind: 'count' }, { default: '3' }],
      ...(['yellow', 'forest', 'outline', 'plum', 'mint', 'red'] as const).map((tone): Case => [`tono ${tone}`, { tone }, { default: 'T' }]),
    ],
  ],
  [
    'Breadcrumb',
    Breadcrumb,
    BreadcrumbBefore,
    [
      ['tres niveles', { items: [{ label: 'Inicio', href: '/' }, { label: 'Relojes', href: '/relojes' }, { label: 'Jade' }] }],
      ['un nivel', { items: [{ label: 'Inicio' }] }],
    ],
  ],
  [
    'Card',
    Card,
    CardBefore,
    [
      ['por defecto', {}, { default: '<p>Contenido</p>' }],
      ['article forest', { as: 'article', tone: 'forest', padding: 'lg' }, { default: 'x' }],
      ['ink suave sm', { tone: 'ink', outline: 'soft', padding: 'sm' }, { default: 'x' }],
      ['li con clase', { as: 'li', class: 'extra', id: 'c1' }, { default: 'x' }],
    ],
  ],
  [
    'Checkbox',
    Checkbox,
    CheckboxBefore,
    [
      ['con label', { id: 'c', name: 'c', label: 'Acepto' }],
      ['marcada, obligatoria y con error', { id: 'c', name: 'c', label: 'Acepto', checked: true, required: true, error: 'Obligatorio' }],
      ['con tono dark', { id: 'c', name: 'c', label: 'Acepto', tone: 'dark' }],
      ['con enlaces en el slot', { id: 'c', name: 'c' }, { default: 'Acepto los <a href="/terminos">términos</a>' }],
    ],
  ],
  [
    'Checkerboard',
    Checkerboard,
    CheckerboardBefore,
    [
      ['por defecto', {}],
      ['auth 32 dos filas', { palette: 'auth', cell: CELL_LARGE, rows: TWO }],
      ['storefront 16', { cell: CELL_SMALL }],
    ],
  ],
  [
    'Chip',
    Chip,
    ChipBefore,
    [
      ['enlace', { label: 'Acero', href: '/x' }],
      ['enlace activo con quitar', { label: 'Acero', href: '/x', active: true, removeHref: '/y' }],
      ['botón', { label: 'Acero', as: 'button' }],
      ['botón activo amarillo', { label: 'Acero', as: 'button', active: true, tone: 'yellow' }],
      ['span', { label: 'Acero', as: 'span', tone: 'mint' }],
      ['forest y red', { label: 'Acero', tone: 'forest' }],
      ['red', { label: 'Acero', tone: 'red' }],
    ],
  ],
  [
    'DefinitionList',
    DefinitionList,
    DefinitionListBefore,
    [
      ['apilada', { items: [{ term: 'Caja', description: 'Acero' }, { term: 'Diámetro', description: '39 mm' }] }],
      ['dos columnas', { items: [{ term: 'A', description: 'B' }], columns: 2 }],
      ['filas', { items: [{ term: 'A', description: 'B' }, { term: 'C', description: 'D' }], variant: 'rows' }],
    ],
  ],
  [
    'EmptyState',
    EmptyState,
    EmptyStateBefore,
    [
      ['solo título', { title: 'Sin resultados' }],
      ['completo', { title: 'Sin resultados', description: 'Cambia los filtros', icon: 'search', headingLevel: 3 }, { default: '<a href="/x">Limpiar</a>' }],
    ],
  ],
  [
    'Field',
    Field,
    FieldBefore,
    [
      ['mínimo', { id: 'a', name: 'a', label: 'Etiqueta' }],
      ['completo', { id: 'a', name: 'a', label: 'Correo', type: 'email', error: 'Mal', hint: 'Ayuda', required: true, value: 'x@example.com', iconLeft: 'user' }],
      ['numérico', { id: 'a', name: 'a', label: 'N', type: 'number', min: ONE, max: NINE }],
      ['fecha', { id: 'a', name: 'a', label: 'F', type: 'date', max: '2026-11-27', tone: 'dark' }],
      ['con acción', { id: 'p', name: 'p', label: 'Clave', type: 'password' }, { action: '<button type="button">ojo</button>' }],
    ],
  ],
  [
    'Icon',
    Icon,
    IconBefore,
    [
      ['decorativo', { name: 'search' }],
      ['tamaño 32', { name: 'search', size: ICON_LARGE }],
      ['con etiqueta', { name: 'info', label: 'Información' }],
    ],
  ],
  [
    'IconButton',
    IconButton,
    IconButtonBefore,
    [
      ['por defecto', { icon: 'search', label: 'Buscar' }],
      ['plain 32', { icon: 'search', label: 'Buscar', variant: 'plain', size: ICON_BUTTON_SMALL }],
      ['presionado 56', { icon: 'heart', label: 'Favorito', pressed: true, size: ICON_BUTTON_LARGE }],
      ['enlace', { icon: 'search', label: 'Buscar', href: '/b' }],
      ['deshabilitado', { icon: 'search', label: 'Buscar', disabled: true, type: 'submit' }],
    ],
  ],
  [
    'Pagination',
    Pagination,
    PaginationBefore,
    [
      ['una página', { page: ONE, pageSize: PAGE_SIZE_ROWS, total: FEW_ITEMS, hrefFor: (p: number) => `?page=${String(p)}` }],
      ['mitad', { page: FEW_ITEMS, pageSize: PAGE_SIZE_ROWS, total: MANY_ITEMS, hrefFor: (p: number) => `?page=${String(p)}` }],
      ['con vecinos 2', { page: TWO, pageSize: PAGE_SIZE_TEN, total: HUNDRED_ITEMS, hrefFor: (p: number) => `/p/${String(p)}`, siblings: TWO }],
    ],
  ],
  [
    'Price',
    Price,
    PriceBefore,
    [
      ['simple', { price: MONEY(PRICE_BASE) }],
      ['con fracción', { price: MONEY(PRICE_FRACTION), size: 'lg', align: 'end' }],
      ['con descuento', { price: MONEY(PRICE_SALE), originalPrice: MONEY(PRICE_BASE), discountAmount: MONEY(PRICE_DISCOUNT), size: 'sm' }],
    ],
  ],
  [
    'Skeleton',
    Skeleton,
    SkeletonBefore,
    [
      ['línea', {}],
      ['tres líneas', { lines: THREE, width: '10rem' }],
      ['bloque', { variant: 'block', height: '4rem' }],
      ['tarjeta', { variant: 'card' }],
    ],
  ],
  [
    'TextLink',
    TextLink,
    TextLinkBefore,
    [
      ['simple', { href: '/x' }, { default: 'Ver' }],
      ['flecha ivory', { href: '/x', arrow: true, tone: 'ivory' }, { default: 'Ver' }],
      ['externo forest', { href: 'https://example.com', external: true, tone: 'forest' }, { default: 'Sitio' }],
      ['atributos', { href: '/x', class: 'extra', id: 't1' }, { default: 'Ver' }],
    ],
  ],
  [
    'Wordmark',
    Wordmark,
    WordmarkBefore,
    [
      ['ink', {}],
      ['ivory con enlace', { tone: 'ivory', href: '/' }],
    ],
  ],
  [
    'Availability',
    Availability,
    AvailabilityBefore,
    [
      ['en stock', { availability: { status: 'in_stock', lead_time_days: null } }],
      ['pocas', { availability: { status: 'low_stock', lead_time_days: null } }],
      ['agotado sin etiqueta', { availability: { status: 'out_of_stock', lead_time_days: null }, showLabel: false }],
      ['bajo pedido con plazo', { availability: { status: 'on_request', lead_time_days: LEAD_DAYS } }],
      ['bajo pedido sin plazo', { availability: { status: 'on_request', lead_time_days: null } }],
    ],
  ],
];

describe('T-143 · regresión: los ui/ existentes sin props nuevas producen el mismo HTML que en main d352052', () => {
  test('los fixtures cubren los 19 componentes de ui/ (la prueba no es vacía)', () => {
    expect(SUITES.map(([n]) => n).sort()).toEqual(
      [
        'Availability', 'Badge', 'Breadcrumb', 'Button', 'Card', 'Checkbox', 'Checkerboard', 'Chip', 'DefinitionList',
        'EmptyState', 'Field', 'Icon', 'IconButton', 'Notice', 'Pagination', 'Price', 'Skeleton', 'TextLink', 'Wordmark',
      ].sort(),
    );
  });

  describe.each(SUITES)('%s', (_name, now, before, cases) => {
    test.each(cases)('%s', async (_n, props, slots) => {
      expect(normalize(await render(now, props, slots))).toBe(normalize(await render(before, props, slots)));
    });
  });
});
