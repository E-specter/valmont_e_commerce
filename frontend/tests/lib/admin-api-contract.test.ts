import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import * as catalog from '../../src/lib/api/admin-catalog';
import * as orders from '../../src/lib/api/admin-orders';
import * as inventory from '../../src/lib/api/admin-inventory';
import { cleanQuery, IMAGE_ID, MONEY, ORDER_ID, PRODUCT_ID, recorder } from '../helpers/t144';

// T-144 · contrato: los tipos y las llamadas de lib/api/admin-*.ts frente al OpenAPI del backend (api-contract-review §6).
//   - Siempre contra una copia recortada: tests/helpers/fixtures/openapi-admin.json (leída de /openapi.json el 2026-11-27).
//   - Además, contra http://127.0.0.1:8000/openapi.json si el backend está levantado.
// Los tipos se leen con el compilador de TypeScript (no con expresiones regulares), como en catalog-contract.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../src/lib/api');
const FIXTURE = JSON.parse(readFileSync(join(HERE, '../helpers/fixtures/openapi-admin.json'), 'utf8'));
const LIVE_URL = 'http://127.0.0.1:8000/openapi.json';
const LIVE_TIMEOUT_MS = 3000;
const PREFIX = '/api/v1';
const PAGE_TWO = 2;
const MAX_ORDERS = 50;
const MAX_LISTS = 48;
// El OpenAPI es JSON sin tipar: un único alias laxo, a propósito.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

type Spec = { paths: Record<string, Record<string, J>>; components: { schemas: Record<string, J> } };
const live: Spec | null = await fetch(LIVE_URL, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

// ---- forma normalizada ------------------------------------------------------------------------
type Shape =
  | { kind: 'string' | 'number' | 'boolean'; nullable: boolean }
  | { kind: 'enum'; values: string[]; nullable: boolean }
  | { kind: 'array'; items: Shape; nullable: boolean }
  | { kind: 'object'; props: Record<string, { required: boolean; shape: Shape }>; nullable: boolean };
type Obj = Extract<Shape, { kind: 'object' }>;

function fromSchema(spec: Spec, s: J, nullable = false): Shape {
  if (s.$ref) return fromSchema(spec, spec.components.schemas[s.$ref.split('/').pop() as string], nullable);
  if (s.anyOf) {
    const rest = s.anyOf.filter((x: J) => x.type !== 'null');
    expect(rest.length, 'anyOf con más de un tipo no nulo').toBe(1);
    return fromSchema(spec, rest[0], true);
  }
  if (s.enum) return { kind: 'enum', values: [...s.enum].sort(), nullable };
  if (s.const !== undefined) return { kind: 'string', nullable };
  const scalar: Record<string, Shape['kind']> = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean' };
  if (scalar[s.type]) return { kind: scalar[s.type], nullable } as Shape;
  if (s.type === 'array') return { kind: 'array', items: fromSchema(spec, s.items), nullable };
  if (s.type === 'object') {
    const req = new Set<string>(s.required ?? []);
    const props = Object.fromEntries(Object.entries<J>(s.properties).map(([k, v]) => [k, { required: req.has(k), shape: fromSchema(spec, v) }]));
    return { kind: 'object', props, nullable };
  }
  throw new Error(`esquema no soportado: ${JSON.stringify(s)}`);
}

const programs = new Map<string, { checker: ts.TypeChecker; source: ts.SourceFile }>();
function load(file: string) {
  const full = join(SRC, file);
  const hit = programs.get(file);
  if (hit) return hit;
  const program = ts.createProgram([full], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  });
  const source = program.getSourceFile(full);
  expect(source, `${file} existe`).toBeDefined();
  const entry = { checker: program.getTypeChecker(), source: source! };
  programs.set(file, entry);
  return entry;
}

function fromType(file: string, t: ts.Type, nullable = false): Shape {
  const { checker, source } = load(file);
  if (t.isUnion()) {
    const nonNull = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    const isNullable = nullable || nonNull.length !== t.types.length;
    if (nonNull.length === 2 && nonNull.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return { kind: 'boolean', nullable: isNullable };
    if (nonNull.length > 1 && nonNull.every((x) => x.isStringLiteral())) {
      return { kind: 'enum', values: nonNull.map((x) => (x as ts.StringLiteralType).value).sort(), nullable: isNullable };
    }
    expect(nonNull.length, `unión no soportada: ${checker.typeToString(t)}`).toBe(1);
    return fromType(file, nonNull[0], isNullable);
  }
  if (t.flags & ts.TypeFlags.StringLike) return { kind: 'string', nullable };
  if (t.flags & ts.TypeFlags.NumberLike) return { kind: 'number', nullable };
  if (t.flags & ts.TypeFlags.BooleanLike) return { kind: 'boolean', nullable };
  if (checker.isArrayType(t)) return { kind: 'array', items: fromType(file, checker.getTypeArguments(t as ts.TypeReference)[0]), nullable };
  const props: Record<string, { required: boolean; shape: Shape }> = {};
  checker.getPropertiesOfType(t).forEach((p) => {
    props[p.name] = { required: !(p.flags & ts.SymbolFlags.Optional), shape: fromType(file, checker.getTypeOfSymbolAtLocation(p, source)) };
  });
  return { kind: 'object', props, nullable };
}

const typeNamed = (file: string, name: string) => {
  const { checker, source } = load(file);
  const decl = source.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  expect(decl, `tipo ${name} exportado en ${file}`).toBeDefined();
  return checker.getTypeAtLocation(decl!.name);
};
const fnNamed = (file: string, name: string) => {
  const { checker, source } = load(file);
  const decl = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  expect(decl, `función ${name} exportada en ${file}`).toBeDefined();
  const sig = checker.getSignatureFromDeclaration(decl!)!;
  const awaited = fromType(file, checker.getAwaitedType(checker.getReturnTypeOfSignature(sig))!);
  const param = (i: number): Obj => {
    const sym = sig.parameters[i];
    return fromType(file, checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(sym, decl!))) as Obj;
  };
  return { awaited, param };
};
const schemaRef = (n: string) => ({ $ref: `#/components/schemas/${n}` });

const ORD = 'admin-orders.ts';
const CAT = 'admin-catalog.ts';
const INV = 'admin-inventory.ts';

const suites: [string, Spec][] = [['fixture (copia de /openapi.json, 2026-11-27)', FIXTURE]];
if (live) suites.push(['OpenAPI en vivo (127.0.0.1:8000)', live]);

describe.each(suites)('contrato de administración frente a %s', (_label, spec) => {
  const op = (path: string, method: string) => spec.paths[`${PREFIX}${path}`][method];
  const okSchema = (path: string, method: string) => {
    const r = op(path, method).responses;
    return (r['200'] ?? r['201']).content['application/json'].schema;
  };
  const queryNames = (path: string): string[] => op(path, 'get').parameters.filter((p: J) => p.in === 'query').map((p: J) => p.name).sort();
  const requestSchema = (path: string, method: string, media = 'application/json') => op(path, method).requestBody.content[media].schema;
  const resolve = (s: J): J => (s.$ref ? spec.components.schemas[s.$ref.split('/').pop() as string] : s);
  const schemaKeys = (s: J): string[] => Object.keys(resolve(s).properties).sort();
  const schemaRequired = (s: J): string[] => [...(resolve(s).required ?? [])].sort();
  const keys = (s: Shape) => Object.keys((s as Obj).props).sort();
  const required = (s: Shape) =>
    Object.entries((s as Obj).props)
      .filter(([, p]) => p.required)
      .map(([k]) => k)
      .sort();

  // --- tipos de respuesta -----------------------------------------------------------------------
  test.each([
    [ORD, 'OrderStatus', 'OrderStatus'],
    [ORD, 'AdminOrderSummary', 'AdminOrderSummaryOut'],
    [ORD, 'AdminOrderDetail', 'AdminOrderDetailOut'],
    [ORD, 'AdminOrderLine', 'OrderLineOut'],
    [ORD, 'AdminDelivery', 'DeliveryOut'],
    [ORD, 'AdminHistoryEntry', 'AdminHistoryEntryOut'],
    [INV, 'StockItem', 'StockItemOut'],
    [INV, 'StockStatus', 'AvailabilityStatus'],
    [CAT, 'AdminProduct', 'AdminProductOut'],
    [CAT, 'ProductImage', 'ProductImageOut'],
    [CAT, 'ProductStatus', 'ProductStatus'],
    [CAT, 'OrderPolicy', 'OrderPolicy'],
    [CAT, 'AdminCategory', 'AdminCategoryOut'],
    [CAT, 'AdminAttributeValue', 'AdminAttributeValueOut'],
  ])('%s · tipo %s ≡ esquema %s (campos, obligatoriedad, nulabilidad, tipos y enums)', (file, tsName, schemaName) => {
    expect(fromType(file, typeNamed(file, tsName))).toEqual(fromSchema(spec, schemaRef(schemaName)));
  });

  test('TransitionTarget ≡ enum de TransitionIn.to', () => {
    expect(fromType(ORD, typeNamed(ORD, 'TransitionTarget'))).toEqual(fromSchema(spec, spec.components.schemas.TransitionIn.properties.to));
  });

  test('los campos anulables del contrato siguen siendo anulables y obligatorios (no se estrechan)', () => {
    const summary = fromType(ORD, typeNamed(ORD, 'AdminOrderSummary')) as Obj;
    ['expires_at', 'estimated_delivery_on', 'district'].forEach((f) => {
      expect(summary.props[f].shape.nullable, f).toBe(true);
      expect(summary.props[f].required, f).toBe(true);
    });
    const product = fromType(CAT, typeNamed(CAT, 'AdminProduct')) as Obj;
    ['movement', 'case_material', 'case_diameter_mm', 'water_resistance_m', 'main_image', 'lead_time_days', 'published_at'].forEach((f) => {
      expect(product.props[f].shape.nullable, f).toBe(true);
    });
    expect((fromType(ORD, typeNamed(ORD, 'AdminOrderDetail')) as Obj).props.refund.shape.nullable).toBe(true);
  });

  // --- funciones: lo que devuelve cada una ---------------------------------------------------------
  test.each([
    [ORD, 'listAdminOrders', '/orders/admin', 'get'],
    [ORD, 'getAdminOrder', '/orders/admin/{order_id}', 'get'],
    [ORD, 'transitionOrder', '/orders/admin/{order_id}/transitions', 'post'],
    [INV, 'listStock', '/inventory/admin/stock', 'get'],
    [CAT, 'listAdminProducts', '/catalog/admin/products', 'get'],
    [CAT, 'getAdminProduct', '/catalog/admin/products/{product_id}', 'get'],
    [CAT, 'createProduct', '/catalog/admin/products', 'post'],
    [CAT, 'updateProduct', '/catalog/admin/products/{product_id}', 'patch'],
    [CAT, 'publishProduct', '/catalog/admin/products/{product_id}/publish', 'post'],
    [CAT, 'unpublishProduct', '/catalog/admin/products/{product_id}/unpublish', 'post'],
    [CAT, 'listAdminCategories', '/catalog/admin/categories', 'get'],
    [CAT, 'getAdminAttributes', '/catalog/admin/attributes', 'get'],
    [CAT, 'uploadProductImage', '/catalog/admin/products/{product_id}/images', 'post'],
    [CAT, 'updateImageAlt', '/catalog/admin/products/{product_id}/images/{image_id}', 'patch'],
    [CAT, 'reorderImages', '/catalog/admin/products/{product_id}/images/order', 'put'],
  ])('%s · %s devuelve lo que declara 200/201 de %s %s', (file, fn, path, method) => {
    expect(fnNamed(file, fn).awaited).toEqual(fromSchema(spec, okSchema(path, method)));
  });

  // --- consultas y cuerpos: nombres exactos --------------------------------------------------------
  test('AdminOrderQuery ≡ parámetros de consulta de GET /orders/admin (todos opcionales)', () => {
    const q = fromType(ORD, typeNamed(ORD, 'AdminOrderQuery')) as Obj;
    expect(keys(q)).toEqual(queryNames('/orders/admin'));
    expect(required(q)).toEqual([]);
  });

  test('listStock y listAdminProducts: sus parámetros de consulta son los del OpenAPI', () => {
    expect(keys(fnNamed(INV, 'listStock').param(1))).toEqual(queryNames('/inventory/admin/stock'));
    expect(keys(fnNamed(CAT, 'listAdminProducts').param(1))).toEqual(queryNames('/catalog/admin/products'));
    expect(required(fnNamed(INV, 'listStock').param(1))).toEqual([]);
  });

  test('el cuerpo de transitionOrder ≡ TransitionIn (mismas claves; solo `to` obligatorio)', () => {
    const body = fnNamed(ORD, 'transitionOrder').param(2);
    const schema = requestSchema('/orders/admin/{order_id}/transitions', 'post');
    expect(keys(body)).toEqual(schemaKeys(schema));
    expect(required(body)).toEqual(schemaRequired(schema));
  });

  test('ProductInput ≡ ProductCreateIn y ProductPatch ≡ ProductUpdateIn (mismas claves y obligatoriedad)', () => {
    const create = requestSchema('/catalog/admin/products', 'post');
    const patch = requestSchema('/catalog/admin/products/{product_id}', 'patch');
    const input = fromType(CAT, typeNamed(CAT, 'ProductInput'));
    const patchType = fromType(CAT, typeNamed(CAT, 'ProductPatch'));
    expect(keys(input)).toEqual(schemaKeys(create));
    expect(required(input)).toEqual(schemaRequired(create));
    expect(keys(patchType)).toEqual(schemaKeys(patch));
    expect(required(patchType)).toEqual([]);
    expect(schemaRequired(patch)).toEqual([]);
  });

  test('ProductInput.case_diameter_mm admite una cadena decimal (si no, escalar: STATUS T-144)', () => {
    const schema = spec.components.schemas.ProductCreateIn.properties.case_diameter_mm.anyOf.map((x: J) => x.type).filter(Boolean);
    expect(schema).toContain('string');
    expect(((fromType(CAT, typeNamed(CAT, 'ProductInput')) as Obj).props.case_diameter_mm.shape as { kind: string }).kind).toBe('string');
  });

  test('el cuerpo multipart de la imagen son `file` y `alt` y ambos son obligatorios', () => {
    const schema = requestSchema('/catalog/admin/products/{product_id}/images', 'post', 'multipart/form-data');
    expect(schemaKeys(schema)).toEqual(['alt', 'file']);
    expect(schemaRequired(schema)).toEqual(['alt', 'file']);
  });

  test('ImageUpdateIn solo tiene `alt` y el orden de imágenes es un arreglo de UUID', () => {
    expect(schemaKeys(requestSchema('/catalog/admin/products/{product_id}/images/{image_id}', 'patch'))).toEqual(['alt']);
    expect(requestSchema('/catalog/admin/products/{product_id}/images/order', 'put')).toMatchObject({ type: 'array', items: { type: 'string', format: 'uuid' } });
  });

  // --- lo que cada función envía realmente -----------------------------------------------------------
  const FILE = new File(['x'], 'a.png', { type: 'image/png' });
  const INPUT: catalog.ProductInput = {
    sku: 'VAL-0001',
    name: 'Aurelia',
    description: 'd',
    category_id: PRODUCT_ID,
    price: MONEY,
    order_policy: 'stock',
    specs: [],
  };
  const calls: [string, (t: ReturnType<typeof recorder>['transport']) => Promise<unknown>, string, string][] = [
    ['listAdminOrders', (t) => orders.listAdminOrders(t, { status: 'pagado', page: PAGE_TWO }), 'get', '/orders/admin'],
    ['getAdminOrder', (t) => orders.getAdminOrder(t, ORDER_ID), 'get', '/orders/admin/{order_id}'],
    ['transitionOrder', (t) => orders.transitionOrder(t, ORDER_ID, { to: 'cancelado', note: 'x' }), 'post', '/orders/admin/{order_id}/transitions'],
    ['listStock', (t) => inventory.listStock(t, { status: 'low_stock' }), 'get', '/inventory/admin/stock'],
    ['listAdminProducts', (t) => catalog.listAdminProducts(t, { status: 'draft' }), 'get', '/catalog/admin/products'],
    ['getAdminProduct', (t) => catalog.getAdminProduct(t, PRODUCT_ID), 'get', '/catalog/admin/products/{product_id}'],
    ['createProduct', (t) => catalog.createProduct(t, INPUT), 'post', '/catalog/admin/products'],
    ['updateProduct', (t) => catalog.updateProduct(t, PRODUCT_ID, { name: 'x' }), 'patch', '/catalog/admin/products/{product_id}'],
    ['publishProduct', (t) => catalog.publishProduct(t, PRODUCT_ID), 'post', '/catalog/admin/products/{product_id}/publish'],
    ['unpublishProduct', (t) => catalog.unpublishProduct(t, PRODUCT_ID), 'post', '/catalog/admin/products/{product_id}/unpublish'],
    ['listAdminCategories', (t) => catalog.listAdminCategories(t), 'get', '/catalog/admin/categories'],
    ['getAdminAttributes', (t) => catalog.getAdminAttributes(t), 'get', '/catalog/admin/attributes'],
    ['uploadProductImage', (t) => catalog.uploadProductImage(t, PRODUCT_ID, FILE, 'a'), 'post', '/catalog/admin/products/{product_id}/images'],
    ['updateImageAlt', (t) => catalog.updateImageAlt(t, PRODUCT_ID, IMAGE_ID, 'a'), 'patch', '/catalog/admin/products/{product_id}/images/{image_id}'],
    ['reorderImages', (t) => catalog.reorderImages(t, PRODUCT_ID, [IMAGE_ID]), 'put', '/catalog/admin/products/{product_id}/images/order'],
    ['deleteImage', (t) => catalog.deleteImage(t, PRODUCT_ID, IMAGE_ID), 'delete', '/catalog/admin/products/{product_id}/images/{image_id}'],
  ];

  test.each(calls)('%s envía el método y la ruta que declara el OpenAPI y solo parámetros declarados', async (_fn, run, method, template) => {
    const { transport, last } = recorder();
    await run(transport);
    const sent = last();
    expect(sent.method.toLowerCase()).toBe(method);
    // La ruta enviada, con los ids sustituidos por su marcador, es exactamente la plantilla del OpenAPI.
    const concrete = sent.path.replace(ORDER_ID, '{order_id}').replace(PRODUCT_ID, '{product_id}').replace(IMAGE_ID, '{image_id}');
    expect(concrete).toBe(template);
    const operation = op(template, method);
    expect(operation, `${method} ${template} existe en el OpenAPI`).toBeDefined();
    const declared = (operation.parameters ?? []).filter((p: J) => p.in === 'query').map((p: J) => p.name);
    expect(Object.keys(cleanQuery(sent.query)).filter((k) => !declared.includes(k))).toEqual([]);
    expect(operation.responses['401'], 'documenta 401').toBeDefined();
    expect(operation.responses['403'], 'documenta 403').toBeDefined();
  });

  test('las claves del cuerpo JSON enviado existen en el esquema del OpenAPI y se incluyen las obligatorias', async () => {
    const check = async (run: (t: J) => Promise<unknown>, path: string, method: string) => {
      const { transport, last } = recorder();
      await run(transport);
      const schema = requestSchema(path, method);
      const sent = JSON.parse(JSON.stringify(last().body)) as Record<string, unknown>;
      expect(Object.keys(sent).filter((k) => !schemaKeys(schema).includes(k))).toEqual([]);
      expect(schemaRequired(schema).filter((k) => !(k in sent))).toEqual([]);
    };
    await check((t) => orders.transitionOrder(t, ORDER_ID, { to: 'enviado', carrier: 'Olva', tracking_code: 'X1' }), '/orders/admin/{order_id}/transitions', 'post');
    await check((t) => catalog.createProduct(t, INPUT), '/catalog/admin/products', 'post');
    await check((t) => catalog.updateProduct(t, PRODUCT_ID, { name: 'x', specs: [] }), '/catalog/admin/products/{product_id}', 'patch');
    await check((t) => catalog.updateImageAlt(t, PRODUCT_ID, IMAGE_ID, 'a'), '/catalog/admin/products/{product_id}/images/{image_id}', 'patch');
  });

  test('el multipart enviado trae exactamente los campos del OpenAPI', async () => {
    const { transport, last } = recorder();
    await catalog.uploadProductImage(transport, PRODUCT_ID, FILE, 'a');
    const schema = requestSchema('/catalog/admin/products/{product_id}/images', 'post', 'multipart/form-data');
    expect([...(last().body as FormData).keys()].sort()).toEqual(schemaKeys(schema));
  });

  // --- idempotencia y formato de error ---------------------------------------------------------------
  test('ninguna operación de administración declara Idempotency-Key: solo los pagos la exigen (T-018c)', () => {
    const withHeader = Object.entries(spec.paths).filter(([path]) => path.includes('/admin')).flatMap(([path, ops]) =>
      Object.entries<J>(ops)
        .filter(([, o]) => (o.parameters ?? []).some((p: J) => p.in === 'header' && p.name.toLowerCase().includes('idempotency')))
        .map(([m]) => `${m} ${path}`),
    );
    expect(withHeader).toEqual([]);
  });

  test('los errores usan ErrorOut { error: { code, message, details? } }, lo que parseResponse espera', () => {
    const body = spec.components.schemas.ErrorBody;
    expect(Object.keys(body.properties).sort()).toEqual(['code', 'details', 'message']);
    expect([...body.required].sort()).toEqual(['code', 'message']);
    expect(spec.components.schemas.ErrorOut.required).toEqual(['error']);
  });

  test('todas las rutas de administración exigen autenticación (security declarada)', () => {
    const open = Object.entries(spec.paths).filter(([path]) => path.includes('/admin')).flatMap(([path, ops]) =>
      Object.entries<J>(ops)
        .filter(([, o]) => !o.security || o.security.length === 0)
        .map(([m]) => `${m} ${path}`),
    );
    expect(open).toEqual([]);
  });

  test('page_size máximo: 50 en pedidos y 48 en stock y productos', () => {
    const max = (path: string) => op(path, 'get').parameters.find((p: J) => p.name === 'page_size').schema.maximum;
    expect([max('/orders/admin'), max('/inventory/admin/stock'), max('/catalog/admin/products')]).toEqual([MAX_ORDERS, MAX_LISTS, MAX_LISTS]);
  });
});
