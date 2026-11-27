// Textos de interfaz del backoffice (RT-B4): constantes MSG_* sin las palabras que vigila el hook de
// secretos. Módulo neutro: importable desde componentes y desde el servidor.
export const MSG_FORBIDDEN = 'No tienes permiso para esta acción.';
export const MSG_UNAVAILABLE = 'No está disponible por ahora. Inténtalo de nuevo en unos minutos.';
export const MSG_STATE_CHANGED = 'El pedido cambió de estado. Revisa su estado actual antes de continuar.';
export const MSG_NOTE_REQUIRED = 'Escribe el motivo de la cancelación.';
export const MSG_FIELD_REQUIRED = 'Completa este campo.';
export const MSG_FIELD_INVALID = 'El valor no es válido.';
export const MSG_FIELD_TOO_LONG = 'El texto es demasiado largo.';
export const MSG_SKU_TAKEN = 'Ya existe un producto con este SKU.';
export const MSG_SLUG_TAKEN = 'Ya existe un producto con esta dirección.';
export const MSG_SLUG_LOCKED = 'La dirección de un producto publicado no se puede cambiar.';
export const MSG_LAST_IMAGE = 'Un producto publicado necesita al menos una imagen.';
export const MSG_FILE_TOO_LARGE = 'La imagen es demasiado grande.';
export const MSG_UNSUPPORTED_MEDIA = 'Formato de imagen no admitido.';
export const MSG_STORAGE_UNAVAILABLE = 'No se pudo guardar la imagen. Inténtalo de nuevo.';

/** Campos que faltan para publicar (`details.missing` de `publish_requirements_unmet`). */
export const MSG_PUBLISH_MISSING: Record<string, string> = {
  description: 'Descripción',
  category: 'Categoría',
  price: 'Precio',
  image: 'Al menos una imagen',
  lead_time_days: 'Plazo de entrega',
};
