import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

// T-120 · prueba de contrato: los tipos de `catalog.ts` (leídos con el compilador de TypeScript, no
// con expresiones regulares) frente al OpenAPI del backend.
//   - Siempre contra una copia recortada: tests/helpers/fixtures/openapi-catalog.json (2026-11-26).
//   - Además, contra http://127.0.0.1:8000/openapi.json si el backend está levantado.
const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_TS = join(HERE, '../../src/lib/api/catalog.ts');
const FIXTURE = JSON.parse(readFileSync(join(HERE, '../helpers/fixtures/openapi-catalog.json'), 'utf8'));

type Spec = { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
const LIVE_URL = 'http://127.0.0.1:8000/openapi.json';
const live: Spec | null = await fetch(LIVE_URL, { signal: AbortSignal.timeout(3000) })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);

// ---- forma normalizada ------------------------------------------------------------------------
type Shape =
  | { kind: 'string' | 'number' | 'boolean'; nullable: boolean }
  | { kind: 'enum'; values: string[]; nullable: boolean }
  | { kind: 'array'; items: Shape; nullable: boolean }
  | { kind: 'object'; props: Record<string, { required: boolean; shape: Shape }>; nullable: boolean };

// OpenAPI → forma
function fromSchema(spec: Spec, s: any, nullable = false): Shape {
  if (s.$ref) return fromSchema(spec, spec.components.schemas[s.$ref.split('/').pop() as string], nullable);
  if (s.anyOf) {
    const rest = s.anyOf.filter((x: any) => x.type !== 'null');
    expect(rest.length, 'anyOf con más de un tipo no nulo').toBe(1);
    return fromSchema(spec, rest[0], true);
  }
  if (s.enum) return { kind: 'enum', values: [...s.enum].sort(), nullable };
  if (s.const !== undefined) return { kind: 'string', nullable };
  switch (s.type) {
    case 'string':
      return { kind: 'string', nullable };
    case 'integer':
    case 'number':
      return { kind: 'number', nullable };
    case 'boolean':
      return { kind: 'boolean', nullable };
    case 'array':
      return { kind: 'array', items: fromSchema(spec, s.items), nullable };
    case 'object': {
      const req = new Set<string>(s.required ?? []);
      const props = Object.fromEntries(
        Object.entries<any>(s.properties).map(([k, v]) => [k, { required: req.has(k), shape: fromSchema(spec, v) }]),
      );
      return { kind: 'object', props, nullable };
    }
    default:
      throw new Error(`esquema no soportado: ${JSON.stringify(s)}`);
  }
}

// TypeScript → forma
const program = ts.createProgram([CATALOG_TS], {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  types: [],
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(CATALOG_TS)!;

function fromType(t: ts.Type, nullable = false): Shape {
  if (t.isUnion()) {
    const nonNull = t.types.filter((x) => !(x.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
    const isNullable = nullable || nonNull.length !== t.types.length;
    if (nonNull.length === 2 && nonNull.every((x) => x.flags & ts.TypeFlags.BooleanLiteral)) return { kind: 'boolean', nullable: isNullable };
    if (nonNull.length > 1 && nonNull.every((x) => x.isStringLiteral())) {
      return { kind: 'enum', values: nonNull.map((x) => (x as ts.StringLiteralType).value).sort(), nullable: isNullable };
    }
    expect(nonNull.length, `unión no soportada: ${checker.typeToString(t)}`).toBe(1);
    return fromType(nonNull[0], isNullable);
  }
  if (t.flags & ts.TypeFlags.StringLike) return { kind: 'string', nullable };
  if (t.flags & ts.TypeFlags.NumberLike) return { kind: 'number', nullable };
  if (t.flags & ts.TypeFlags.BooleanLike) return { kind: 'boolean', nullable };
  if (checker.isArrayType(t)) return { kind: 'array', items: fromType(checker.getTypeArguments(t as ts.TypeReference)[0]), nullable };
  const props: Record<string, { required: boolean; shape: Shape }> = {};
  for (const p of checker.getPropertiesOfType(t)) {
    const pt = checker.getTypeOfSymbolAtLocation(p, source);
    props[p.name] = { required: !(p.flags & ts.SymbolFlags.Optional), shape: fromType(pt) };
  }
  return { kind: 'object', props, nullable };
}

const typeNamed = (name: string) => {
  const decl = source.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  expect(decl, `tipo ${name} exportado en catalog.ts`).toBeDefined();
  return checker.getTypeAtLocation(decl!.name);
};
const fnNamed = (name: string) => {
  const decl = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  expect(decl, `función ${name} exportada en catalog.ts`).toBeDefined();
  const sig = checker.getSignatureFromDeclaration(decl!)!;
  return { decl: decl!, sig, awaited: fromType(checker.getAwaitedType(checker.getReturnTypeOfSignature(sig))!) };
};

const suites: [string, Spec][] = [['fixture (copia de /openapi.json, 2026-11-26)', FIXTURE]];
if (live) suites.push(['OpenAPI en vivo (127.0.0.1:8000)', live]);

describe.each(suites)('contrato de catálogo frente a %s', (_label, spec) => {
  const resp = (path: string, status = '200') => spec.paths[path].get.responses[status].content['application/json'].schema;

  test.each([
    ['Category', 'CategoryOut'],
    ['AttributeValue', 'AttributeValueOut'],
    ['ProductImage', 'ProductImageOut'],
    ['Availability', 'AvailabilityOut'],
    ['ProductSummary', 'ProductSummaryOut'],
    ['ProductDetail', 'ProductDetailOut'],
  ])('tipo %s ≡ esquema %s (campos, obligatoriedad, nulabilidad, tipos y enums)', (tsName, schemaName) => {
    expect(fromType(typeNamed(tsName))).toEqual(fromSchema(spec, { $ref: `#/components/schemas/${schemaName}` }));
  });

  test('ProductSort ≡ enum ProductSort', () => {
    expect(fromType(typeNamed('ProductSort'))).toEqual(fromSchema(spec, { $ref: '#/components/schemas/ProductSort' }));
  });

  test('los campos anulables del contrato siguen siendo anulables (no se estrechan)', () => {
    const p = fromType(typeNamed('ProductSummary')) as Extract<Shape, { kind: 'object' }>;
    for (const f of ['original_price', 'discount_amount', 'movement', 'case_material', 'case_diameter_mm', 'water_resistance_m']) {
      expect(p.props[f].shape.nullable, f).toBe(true);
      expect(p.props[f].required, f).toBe(true);
    }
    expect((p.props.availability.shape as any).props.lead_time_days.shape.nullable).toBe(true);
    expect((fromType(typeNamed('Category')) as any).props.description.shape.nullable).toBe(true);
  });

  test.each([
    ['listProducts', '/api/v1/catalog/products'],
    ['getProduct', '/api/v1/catalog/products/{slug}'],
    ['listCategories', '/api/v1/catalog/categories'],
    ['getAttributes', '/api/v1/catalog/attributes'],
  ])('%s devuelve lo que declara 200 de %s', (fn, path) => {
    expect(fnNamed(fn).awaited).toEqual(fromSchema(spec, resp(path)));
  });

  test('ProductFilters ≡ parámetros de consulta de GET /catalog/products (mismos nombres, todos opcionales)', () => {
    const params: any[] = spec.paths['/api/v1/catalog/products'].get.parameters.filter((p: any) => p.in === 'query');
    const filters = fromType(typeNamed('ProductFilters')) as Extract<Shape, { kind: 'object' }>;
    expect(Object.keys(filters.props).sort()).toEqual(params.map((p) => p.name).sort());
    for (const [name, p] of Object.entries(filters.props)) expect(p.required, name).toBe(false);
    // El enum de `sort` coincide con el del servidor.
    expect(filters.props.sort.shape).toMatchObject({ kind: 'enum', values: (fromSchema(spec, { $ref: '#/components/schemas/ProductSort' }) as { values: string[] }).values });
    // Tipos: lo numérico del servidor es number; lo textual, string; `available`, boolean.
    const kindsOf = (p: any): string[] =>
      (p.schema.anyOf ?? [p.schema])
        .filter((x: any) => x.type !== 'null')
        .map((x: any) => (x.$ref ? 'enum' : x.type === 'integer' ? 'number' : x.type));
    for (const p of params) expect(kindsOf(p), p.name).toContain(filters.props[p.name].shape.kind);
  });

  test('getProduct tiene exactamente un parámetro de ruta {slug}; 404 y 422 usan ErrorOut (formato común)', () => {
    const get = spec.paths['/api/v1/catalog/products/{slug}'].get;
    expect(get.parameters.map((p: any) => [p.name, p.in])).toEqual([['slug', 'path']]);
    expect(resp('/api/v1/catalog/products/{slug}', '404')).toEqual({ $ref: '#/components/schemas/ErrorOut' });
    expect(resp('/api/v1/catalog/products/{slug}', '422')).toEqual({ $ref: '#/components/schemas/ErrorOut' });
    expect(resp('/api/v1/catalog/products', '422')).toEqual({ $ref: '#/components/schemas/ErrorOut' });
    // ErrorOut = { error: { code, message, details? } }: es lo que parseResponse espera.
    const body = spec.components.schemas.ErrorBody;
    expect(Object.keys(body.properties).sort()).toEqual(['code', 'details', 'message']);
    expect([...body.required].sort()).toEqual(['code', 'message']);
    expect(spec.components.schemas.ErrorOut.required).toEqual(['error']);
  });

  test('las rutas públicas de catálogo no exigen autenticación', () => {
    for (const p of ['/api/v1/catalog/products', '/api/v1/catalog/products/{slug}', '/api/v1/catalog/categories', '/api/v1/catalog/attributes']) {
      expect(spec.paths[p].get.security, p).toBeUndefined();
    }
  });

  test('las funciones solo reciben el transporte y datos de consulta: ni precios, totales ni ids de usuario', () => {
    const banned = /^(user_?id|customer_?id|owner|total|subtotal|amount|price|unit_price|discount|discount_amount)$/i;
    const names = [
      ...['listProducts', 'getProduct', 'listCategories', 'getAttributes'].flatMap((f) => fnNamed(f).sig.parameters.map((p) => p.name)),
      ...Object.keys((fromType(typeNamed('ProductFilters')) as Extract<Shape, { kind: 'object' }>).props),
    ];
    expect(names.filter((n) => banned.test(n))).toEqual([]);
  });
});
