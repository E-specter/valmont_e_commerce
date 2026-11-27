// Contenido de demostración del banner "Destacado del mes" (D-041 P-2): no hay contrato de destacados.
import type { Money } from '../lib/format';

export const featured: { kicker: string; title: string; description: string; price: Money } = {
  kicker: 'Destacado del mes',
  title: 'Tourbillon Classique Édition Limitée',
  description: 'Solo 50 piezas en el mundo. Movimiento tourbillon volante con escape de silicio y caja de oro rosa de 18 quilates.',
  price: { amount: 12750000, currency: 'PEN' },
};
