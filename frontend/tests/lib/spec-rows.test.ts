import { describe, expect, test } from 'vitest';
import { specRows } from '../../src/components/catalog/spec-rows';
import { detail } from '../helpers/product-detail';

// T-125 · specRows (STATUS "T-125 › Resultado esperado y firmas"; RF02.07):
// Referencia (sku), Movimiento, Diámetro de caja, Material de caja y Resistencia al agua (solo los no nulos) y a continuación
// `specs[]` en el orden del servidor, sin repetir una etiqueta ya mostrada.
const NONE = 0;
const ONE = 1;
const DIAMETER_MM = 43.5;
const WATER_M = 300;

const terms = (rows: { term: string }[]): string[] => rows.map((r) => r.term);
const STRUCTURED = ['Referencia', 'Movimiento', 'Diámetro de caja', 'Material de caja', 'Resistencia al agua'];
const NO_EXTRA = { specs: [] as { label: string; value: string }[] };

describe('specRows · filas estructuradas', () => {
  test('con todos los datos: las 5 filas en el orden del paquete', () => {
    expect(terms(specRows(detail(NO_EXTRA)))).toEqual(STRUCTURED);
  });

  test('Referencia es el sku del contrato y va siempre primera', () => {
    const rows = specRows(detail({ sku: 'DEMO-009', ...NO_EXTRA }));
    expect(rows[NONE]).toEqual({ term: 'Referencia', description: 'DEMO-009' });
  });

  test('los valores traen su etiqueta del servidor y la unidad (mm, m)', () => {
    const rows = specRows(detail({ case_diameter_mm: DIAMETER_MM, water_resistance_m: WATER_M, ...NO_EXTRA }));
    const by = Object.fromEntries(rows.map((r) => [r.term, r.description]));
    expect(by['Movimiento']).toBe('Automático');
    expect(by['Material de caja']).toBe('Oro Amarillo 18K');
    expect(['43.5mm', '43,5mm']).toContain(by['Diámetro de caja'].replaceAll(' ', ''));
    expect(by['Resistencia al agua'].replaceAll(' ', '')).toBe('300m');
  });

  test.each([
    ['movement', 'Movimiento'],
    ['case_material', 'Material de caja'],
    ['case_diameter_mm', 'Diámetro de caja'],
    ['water_resistance_m', 'Resistencia al agua'],
  ] as const)('%s nulo: la fila "%s" no aparece y las demás conservan su orden', (field, term) => {
    const rows = specRows(detail({ [field]: null, ...NO_EXTRA }));
    expect(terms(rows)).toEqual(STRUCTURED.filter((t) => t !== term));
  });

  test('todos los opcionales nulos: queda solo la Referencia', () => {
    const rows = specRows(detail({ movement: null, case_material: null, case_diameter_mm: null, water_resistance_m: null, ...NO_EXTRA }));
    expect(rows).toEqual([{ term: 'Referencia', description: detail().sku }]);
  });

  test('0 no es nulo: una resistencia al agua de 0 m sí se muestra', () => {
    const rows = specRows(detail({ water_resistance_m: NONE, ...NO_EXTRA }));
    expect(terms(rows)).toContain('Resistencia al agua');
  });
});

describe('specRows · specs[] del servidor', () => {
  test('se añaden después de las estructuradas y en el orden del servidor', () => {
    const specs = [
      { label: 'Calibre', value: 'V-100' },
      { label: 'Cristal', value: 'Zafiro' },
      { label: 'Garantía', value: '2 años' },
    ];
    const rows = specRows(detail({ specs }));
    expect(terms(rows)).toEqual([...STRUCTURED, 'Calibre', 'Cristal', 'Garantía']);
    expect(rows.slice(STRUCTURED.length)).toEqual(specs.map((s) => ({ term: s.label, description: s.value })));
  });

  test('sin specs extra (lista vacía): solo las filas estructuradas', () => {
    expect(terms(specRows(detail(NO_EXTRA)))).toEqual(STRUCTURED);
  });

  test('specs ausente (respuesta incompleta): no falla y devuelve las estructuradas', () => {
    const odd = detail({ specs: undefined as unknown as [] });
    expect(terms(specRows(odd))).toEqual(STRUCTURED);
  });

  test('una etiqueta ya mostrada no se repite: gana la estructurada y se descarta la del servidor', () => {
    const specs = [
      { label: 'Movimiento', value: 'Cuarzo (otra cifra)' },
      { label: 'Referencia', value: 'OTRA-REF' },
      { label: 'Calibre', value: 'V-100' },
    ];
    const rows = specRows(detail({ specs }));
    expect(terms(rows).filter((t) => t === 'Movimiento')).toHaveLength(ONE);
    expect(terms(rows).filter((t) => t === 'Referencia')).toHaveLength(ONE);
    expect(rows.find((r) => r.term === 'Movimiento')?.description).toBe('Automático');
    expect(rows.find((r) => r.term === 'Referencia')?.description).toBe(detail().sku);
    expect(terms(rows).at(-ONE)).toBe('Calibre');
  });

  test('la comparación de etiquetas no distingue mayúsculas', () => {
    const rows = specRows(detail({ specs: [{ label: 'MOVIMIENTO', value: 'x' }, { label: 'material de caja', value: 'y' }] }));
    expect(terms(rows)).toEqual(STRUCTURED);
  });

  test('dos specs del servidor con la misma etiqueta: se muestra solo la primera', () => {
    const rows = specRows(detail({ specs: [{ label: 'Cristal', value: 'Zafiro' }, { label: 'Cristal', value: 'Mineral' }] }));
    expect(rows.filter((r) => r.term === 'Cristal')).toEqual([{ term: 'Cristal', description: 'Zafiro' }]);
  });

  test('si el movimiento es nulo, un spec "Movimiento" del servidor sí se muestra (no hay fila estructurada que repetir)', () => {
    const rows = specRows(detail({ movement: null, specs: [{ label: 'Movimiento', value: 'Calibre manual' }] }));
    expect(rows.filter((r) => r.term === 'Movimiento')).toEqual([{ term: 'Movimiento', description: 'Calibre manual' }]);
  });

  test('ninguna etiqueta se repite jamás, sea cual sea la entrada', () => {
    const labels = ['Referencia', 'Calibre', 'calibre', 'Movimiento', 'Cristal', 'Cristal'];
    const rows = specRows(detail({ specs: labels.map((label, i) => ({ label, value: `v${i}` })) }));
    const keys = terms(rows).map((t) => t.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('specRows · pureza', () => {
  test('no muta el producto y es repetible', () => {
    const p = detail({ specs: [{ label: 'Movimiento', value: 'x' }, { label: 'Calibre', value: 'V' }] });
    const snapshot = JSON.stringify(p);
    expect(specRows(p)).toEqual(specRows(p));
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  test('cada fila tiene exactamente term y description de tipo texto', () => {
    specRows(detail()).forEach((r) => {
      expect(Object.keys(r).sort()).toEqual(['description', 'term']);
      expect(typeof r.term).toBe('string');
      expect(typeof r.description).toBe('string');
    });
  });

  test('los valores se devuelven como texto sin transformar (no se escapan ni se interpretan)', () => {
    const rows = specRows(detail({ specs: [{ label: 'Nota', value: '<b>negrita</b> & más' }] }));
    expect(rows.at(-ONE)?.description).toBe('<b>negrita</b> & más');
  });
});
