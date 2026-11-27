import { describe, expect, test } from 'vitest';
import { specLine } from '../../src/components/catalog/spec-line';

// T-123 · specLine (STATUS "T-123 › Firmas públicas" y criterio RF02.07): `{mm}mm · {movimiento} · {material}`,
// omite los nulos sin separadores huérfanos; si los tres son nulos, null (la línea no se pinta).
const MOV = { code: 'automatic', label: 'Automático' };
const MAT = { code: 'gold', label: 'Oro Amarillo 18K' };
const MM = 40;

type Input = Parameters<typeof specLine>[0];
const input = (mm: boolean, mov: boolean, mat: boolean): Input => ({
  case_diameter_mm: mm ? MM : null,
  movement: mov ? MOV : null,
  case_material: mat ? MAT : null,
});

// Los 8 casos de nulos (diámetro, movimiento, material).
const CASES: [string, boolean, boolean, boolean, string | null][] = [
  ['los tres', true, true, true, '40mm · Automático · Oro Amarillo 18K'],
  ['sin material', true, true, false, '40mm · Automático'],
  ['sin movimiento', true, false, true, '40mm · Oro Amarillo 18K'],
  ['solo diámetro', true, false, false, '40mm'],
  ['sin diámetro', false, true, true, 'Automático · Oro Amarillo 18K'],
  ['solo movimiento', false, true, false, 'Automático'],
  ['solo material', false, false, true, 'Oro Amarillo 18K'],
  ['los tres nulos', false, false, false, null],
];
const EIGHT = 8;

describe('specLine', () => {
  test('cubre las 8 combinaciones de nulos', () => {
    expect(new Set(CASES.map((c) => `${c[1]}${c[2]}${c[3]}`)).size).toBe(EIGHT);
  });

  test.each(CASES)('%s', (_name, mm, mov, mat, expected) => {
    expect(specLine(input(mm, mov, mat))).toBe(expected);
  });

  test('ningún caso deja separadores huérfanos ni espacios sobrantes', () => {
    CASES.flatMap((c) => (c[4] === null ? [] : [specLine(input(c[1], c[2], c[3])) as string])).forEach((out) => {
      expect(out).toBe(out.trim());
      expect(out.startsWith('·') || out.endsWith('·')).toBe(false);
      expect(out.includes('·  ·') || out.includes('· ·') || out.includes('  ')).toBe(false);
    });
  });

  test('es una función pura: no muta la entrada y es repetible', () => {
    const p = input(true, true, true);
    const snapshot = JSON.stringify(p);
    expect(specLine(p)).toBe(specLine(p));
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  test('acepta un producto completo (Pick estructural): ignora los demás campos', () => {
    const full = { ...input(true, true, true), name: 'X', sku: 'S', price: { amount: 1, currency: 'PEN' } };
    expect(specLine(full)).toBe('40mm · Automático · Oro Amarillo 18K');
  });
});
