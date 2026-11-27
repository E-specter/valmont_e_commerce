import type { ProductDetail } from '../../lib/api/catalog';

// Quita las marcas diacríticas tras normalizar a NFD: "Rubíes" -> "Rubies"; "Rubies" queda igual.
// https://regex101.com/?regex=%5Cp%7BM%7D&flags=gu&testString=Rub%C3%ADes
const DIACRITICS = /\p{M}/gu;
const norm = (s: string) => s.normalize('NFD').replace(DIACRITICS, '').trim().toLowerCase();

type Row = { term: string; description: string };

/** Filas de la ficha técnica (RF02.07): campos estructurados no nulos y luego `specs[]` del servidor, sin repetir etiquetas. */
export function specRows(p: ProductDetail): Row[] {
  const structured: (Row | null)[] = [
    { term: 'Referencia', description: p.sku },
    p.movement ? { term: 'Movimiento', description: p.movement.label } : null,
    p.case_diameter_mm != null ? { term: 'Diámetro de caja', description: `${p.case_diameter_mm} mm` } : null,
    p.case_material ? { term: 'Material de caja', description: p.case_material.label } : null,
    p.water_resistance_m != null ? { term: 'Resistencia al agua', description: `${p.water_resistance_m} m` } : null,
  ];
  return [...structured.filter((r): r is Row => r !== null), ...(p.specs ?? []).map((s) => ({ term: s.label, description: s.value }))].filter(
    (row, i, all) => all.findIndex((r) => norm(r.term) === norm(row.term)) === i,
  );
}
