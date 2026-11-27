import { describe, expect, test } from 'vitest';
import { fieldErrors } from '../../src/lib/admin/errors';
import * as messages from '../../src/lib/admin/messages';
import { ApiError } from '../../src/lib/api/http';
import { ST } from '../helpers/t144';

// T-144 · lib/admin/errors.ts y messages.ts (RT-B4, RT-B9): 422 por campo, sin el `msg` en inglés del backend.
const ENGLISH = 'Field required MSG-DEL-BACKEND-QX';
const FIELDS = ['note', 'carrier', 'tracking_code'] as const;
const MIN_MESSAGES = 13;
const A_NUMBER = 7;
const ANOTHER_NUMBER = 3;
const err = (details: unknown, status: number = ST.INVALID) => new ApiError(status, 'validation_error', 'Mensaje del servidor.', details);
const det = (field: string, type: string, extra: (string | number)[] = []) => ({ loc: ['body', ...extra, field], type, msg: ENGLISH });
const values = (r: Record<string, string>) => Object.values(r);

describe('fieldErrors', () => {
  test('sin details (null) devuelve {}', () => {
    expect(fieldErrors(err(null), FIELDS)).toEqual({});
    expect(fieldErrors(new ApiError(ST.SERVER, 'internal_error', 'x'), FIELDS)).toEqual({});
  });

  test('details que no es un arreglo devuelve {} sin lanzar', () => {
    [{}, 'texto', A_NUMBER, true, { loc: ['body', 'note'] }].forEach((d) => expect(fieldErrors(err(d), FIELDS)).toEqual({}));
  });

  test('el último elemento de loc es el campo; el texto va en español', () => {
    const r = fieldErrors(err([det('note', 'string_too_short')]), FIELDS);
    expect(Object.keys(r)).toEqual(['note']);
    expect(r.note.trim().length).toBeGreaterThan(0);
  });

  test('nunca expone el msg del backend (en inglés), sea cual sea el type', () => {
    const types = ['missing', 'string_too_short', 'string_too_long', 'value_error', 'string_type', 'tipo_desconocido', 'int_parsing', ''];
    const r = fieldErrors(err(types.map((type, i) => det(FIELDS[i % FIELDS.length], type))), FIELDS);
    expect(values(r).filter((v) => v.includes('Field required') || v.includes('MSG-DEL-BACKEND'))).toEqual([]);
    expect(values(r).every((v) => v.trim().length > 0)).toBe(true);
  });

  test('un type desconocido cae en un texto genérico no vacío', () => {
    const r = fieldErrors(err([det('carrier', 'algo_nuevo_del_backend')]), FIELDS);
    expect(r.carrier.trim().length).toBeGreaterThan(0);
    expect(r.carrier).not.toContain('algo_nuevo');
  });

  test('un campo que no está en la lista se descarta (no se pinta un error de otro formulario)', () => {
    const r = fieldErrors(err([det('note', 'missing'), det('user_id', 'missing'), det('__proto__', 'missing')]), FIELDS);
    expect(Object.keys(r)).toEqual(['note']);
  });

  test('loc anidado: se toma el último elemento (body.specs.0.value → value)', () => {
    const r = fieldErrors(err([{ loc: ['body', 'specs', 0, 'value'], type: 'missing', msg: ENGLISH }]), ['value', 'specs']);
    expect(Object.keys(r)).toEqual(['value']);
  });

  test('entradas mal formadas (sin loc, loc vacío, null, loc numérico) no lanzan y no producen campos', () => {
    const junk = [null, undefined, ANOTHER_NUMBER, 'x', {}, { loc: [] }, { loc: 'note' }, { loc: [0], type: 'missing' }];
    expect(() => fieldErrors(err(junk), FIELDS)).not.toThrow();
    expect(fieldErrors(err(junk), FIELDS)).toEqual({});
  });

  test('varios errores en campos distintos se devuelven todos', () => {
    const r = fieldErrors(err([det('note', 'string_too_long'), det('carrier', 'missing')]), FIELDS);
    expect(Object.keys(r).sort()).toEqual(['carrier', 'note']);
  });

  test('la lista de campos vacía no devuelve nada', () => {
    expect(fieldErrors(err([det('note', 'missing')]), [])).toEqual({});
  });
});

describe('messages.ts', () => {
  const entries = Object.entries(messages);

  test('todas las exportaciones son constantes MSG_*', () => {
    expect(entries.map(([k]) => k).filter((k) => !k.startsWith('MSG_'))).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(MIN_MESSAGES);
  });

  test('los nombres no contienen las palabras que vigila el hook de secretos (RT-B4)', () => {
    const watched = ['key', 'secret', 'password', 'token'];
    expect(entries.map(([k]) => k).filter((k) => watched.some((w) => k.toLowerCase().includes(w)))).toEqual([]);
  });

  test('cada mensaje es texto en español no vacío (salvo el mapa de publicación)', () => {
    const texts = entries.filter(([k]) => k !== 'MSG_PUBLISH_MISSING').map(([, v]) => v);
    expect(texts.every((v) => typeof v === 'string' && v.trim().length > 0)).toBe(true);
  });

  test('hay un mensaje para cada código de error de los paquetes del backoffice', () => {
    const names = entries.map(([k]) => k.toUpperCase()).join(' ');
    ['SKU_TAKEN', 'SLUG_TAKEN', 'SLUG_LOCKED', 'LAST_IMAGE', 'FILE_TOO_LARGE', 'STORAGE_UNAVAILABLE', 'FORBIDDEN', 'UNAVAILABLE', 'STATE_CHANGED', 'NOTE_REQUIRED', 'FIELD_REQUIRED'].forEach(
      (code) => expect(names, code).toContain(code),
    );
    expect(names).toContain('UNSUPPORTED');
  });

  test('MSG_PUBLISH_MISSING traduce los 5 requisitos de publicación', () => {
    expect(messages.MSG_PUBLISH_MISSING).toEqual({
      description: 'Descripción',
      category: 'Categoría',
      price: 'Precio',
      image: 'Al menos una imagen',
      lead_time_days: 'Plazo de entrega',
    });
  });

  test('los mensajes no filtran detalles técnicos (trazas, SQL, rutas, códigos HTTP)', () => {
    const texts = entries.filter(([k]) => k !== 'MSG_PUBLISH_MISSING').map(([, v]) => String(v));
    const technical = ['Traceback', 'SQL', 'psycopg', 'Exception', 'HTTP', 'undefined', 'null'];
    expect(texts.filter((t) => technical.some((w) => t.includes(w)))).toEqual([]);
  });
});
