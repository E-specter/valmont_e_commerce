import type { ProductSummary } from '../../lib/api/catalog';

/** Ficha corta "40mm · Automático · Oro Amarillo 18K" (RF02.07). Omite los nulos; sin datos, null. */
export function specLine(p: Pick<ProductSummary, 'case_diameter_mm' | 'movement' | 'case_material'>): string | null {
  const parts = [
    p.case_diameter_mm == null ? null : `${p.case_diameter_mm}mm`,
    p.movement?.label,
    p.case_material?.label,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : null;
}
