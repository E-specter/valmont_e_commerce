// Estados de pedido y producto del backoffice (VIEWS §12.4). Solo etiquetas y tonos: las
// transiciones las calcula el servidor (`can_transition_to`); aquí nunca se deducen.
import type { OrderStatus, TransitionTarget } from '../api/admin-orders';
import type { ProductStatus } from '../api/admin-catalog';

// Se declara igual en components/ui/status-pill.ts (T-143), a propósito: lib no importa de components.
export type PillTone = 'pending' | 'paid' | 'active' | 'transit' | 'done' | 'cancelled' | 'neutral';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pendiente_pago',
  'pagado',
  'en_preparacion',
  'enviado',
  'listo_para_recojo',
  'entregado',
  'cancelado',
  'expirado',
];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pendiente_pago: 'Pendiente de pago',
  pagado: 'Pagado',
  en_preparacion: 'En preparación',
  enviado: 'Enviado',
  listo_para_recojo: 'Listo para recojo',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  expirado: 'Expirado',
};

const ORDER_TONE: Record<OrderStatus, PillTone> = {
  pendiente_pago: 'pending',
  pagado: 'paid',
  en_preparacion: 'active',
  enviado: 'transit',
  listo_para_recojo: 'transit',
  entregado: 'done',
  cancelado: 'cancelled',
  expirado: 'neutral',
};

export function orderPill(s: OrderStatus): { label: string; tone: PillTone } {
  return { label: ORDER_STATUS_LABEL[s], tone: ORDER_TONE[s] };
}

const PRODUCT_PILL: Record<ProductStatus, { label: string; tone: PillTone }> = {
  draft: { label: 'Borrador', tone: 'neutral' },
  published: { label: 'Publicado', tone: 'paid' },
};

export function productPill(s: ProductStatus): { label: string; tone: PillTone } {
  return PRODUCT_PILL[s];
}

const TRANSITION_LABEL: Record<Exclude<TransitionTarget, 'cancelado'>, string> = {
  en_preparacion: 'Preparar pedido',
  enviado: 'Marcar como enviado',
  listo_para_recojo: 'Marcar listo para recojo',
  entregado: 'Marcar como entregado',
};

export function transitionLabel(to: TransitionTarget, from: OrderStatus): string {
  if (to !== 'cancelado') return TRANSITION_LABEL[to];
  return from === 'pagado' || from === 'en_preparacion' ? 'Cancelar y reembolsar' : 'Cancelar pedido';
}

export function cancelCopy(from: OrderStatus): { title: string; body: string; confirm: string } {
  if (from === 'pagado' || from === 'en_preparacion') {
    return {
      title: 'Cancelar y reembolsar',
      body: 'Se reembolsará el total del pedido de forma simulada. El stock no se repone automáticamente.',
      confirm: 'Cancelar y reembolsar',
    };
  }
  return {
    title: 'Cancelar pedido',
    body: 'Se liberarán las reservas de stock. El pedido no tiene pago, así que no hay reembolso.',
    confirm: 'Cancelar pedido',
  };
}

// Avance primero, cancelar al final.
const TARGET_ORDER: readonly TransitionTarget[] = [
  'en_preparacion',
  'enviado',
  'listo_para_recojo',
  'entregado',
  'cancelado',
];

/** Intersección con los 5 destinos posibles; nunca deduce estados que el servidor no ofreció. */
export function transitionTargets(canTransitionTo: readonly OrderStatus[]): TransitionTarget[] {
  return TARGET_ORDER.filter((t) => canTransitionTo.includes(t));
}
