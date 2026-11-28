// Navegación del backoffice (STATUS ui §10.7 T-142). Neutro: sin astro:env ni lib/server.
import type { IconName } from '../../components/ui/icons';

export type AdminSection =
  | 'panel'
  | 'pedidos'
  | 'productos'
  | 'inventario'
  | 'promociones'
  | 'reportes'
  | 'clientes'
  | 'auditoria';

export type NavEntry = { section: AdminSection; label: string; href: string; icon: IconName; enabled: boolean };

// D-B1: solo Panel está habilitado hasta que exista la pantalla de cada módulo (se activa aquí, una por tarea).
export const ADMIN_NAV: readonly NavEntry[] = [
  { section: 'panel', label: 'Panel', href: '/admin', icon: 'dashboard', enabled: true },
  { section: 'pedidos', label: 'Pedidos', href: '/admin/pedidos', icon: 'orders', enabled: false },
  { section: 'productos', label: 'Productos', href: '/admin/productos', icon: 'watch', enabled: true },
  { section: 'inventario', label: 'Inventario', href: '/admin/inventario', icon: 'inventory', enabled: false },
  { section: 'promociones', label: 'Promociones', href: '/admin/promociones', icon: 'tag', enabled: false },
  { section: 'reportes', label: 'Reportes', href: '/admin/reportes', icon: 'chart', enabled: false },
  { section: 'clientes', label: 'Clientes', href: '/admin/clientes', icon: 'users', enabled: false },
  { section: 'auditoria', label: 'Auditoría', href: '/admin/auditoria', icon: 'shield', enabled: false },
];
