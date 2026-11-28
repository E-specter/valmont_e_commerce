// Estados de disponibilidad (catalog SPEC §7, D-023). Nunca expone cantidades.
export type AvailabilityStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'on_request';
export type Availability = { status: AvailabilityStatus; lead_time_days: number | null };

const LABELS: Record<AvailabilityStatus, (days: number | null) => string> = {
  in_stock: () => 'En stock',
  low_stock: () => 'Quedan pocas unidades',
  out_of_stock: () => 'Agotado',
  on_request: (days) =>
    days == null ? 'Bajo pedido' : `Bajo pedido, entrega estimada en ${days} ${days === 1 ? 'día' : 'días'}`,
};

export function availabilityLabel(a: Availability): string {
  return LABELS[a.status](a.lead_time_days);
}
