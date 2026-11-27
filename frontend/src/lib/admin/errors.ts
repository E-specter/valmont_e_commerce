// Errores 422 del backend por campo (RT-B9): se traduce por `loc` y `type`; el `msg` en inglés
// nunca se muestra.
import type { ApiError } from '../api/http';
import { MSG_FIELD_INVALID, MSG_FIELD_REQUIRED, MSG_FIELD_TOO_LONG } from './messages';

type Detail = { loc?: unknown; type?: unknown };

const BY_TYPE: Record<string, string> = {
  missing: MSG_FIELD_REQUIRED,
  string_too_short: MSG_FIELD_REQUIRED,
  string_too_long: MSG_FIELD_TOO_LONG,
};

/** 422: el último elemento de `loc` es el campo; solo se devuelven los de `fields` (el primero gana). */
export function fieldErrors(e: ApiError, fields: readonly string[]): Record<string, string> {
  const details = Array.isArray(e.details) ? (e.details as Detail[]) : [];
  return details.reduce<Record<string, string>>((acc, d) => {
    const loc = Array.isArray(d?.loc) ? d.loc : [];
    const field = String(loc[loc.length - 1]);
    if (!fields.includes(field) || field in acc) return acc;
    return { ...acc, [field]: BY_TYPE[String(d.type)] ?? MSG_FIELD_INVALID };
  }, {});
}
