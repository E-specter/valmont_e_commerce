import { describe, expect, test } from 'vitest';
import { ApiError, parseResponse, toQueryString } from '../../src/lib/api/http';

// T-120 · contrato 3.1 (STATUS ui): toQueryString, ApiError y conversión de respuestas.
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('toQueryString', () => {
  test('omite undefined, null y cadena vacía', () => {
    expect(toQueryString({ a: undefined, b: null, c: '', d: 'x' })).toBe('d=x');
  });

  test('conserva 0 y false (no son "vacíos")', () => {
    expect(toQueryString({ page: 0, available: false })).toBe('available=false&page=0');
  });

  test('sin parámetros devuelve cadena vacía (sin "?")', () => {
    expect(toQueryString({})).toBe('');
    expect(toQueryString({ a: undefined, b: [] })).toBe('');
  });

  test('orden estable alfabético, independiente del orden de inserción', () => {
    const a = toQueryString({ sort: 'newest', category: 'c', page: 2, q: 'x' });
    const b = toQueryString({ q: 'x', page: 2, category: 'c', sort: 'newest' });
    expect(a).toBe('category=c&page=2&q=x&sort=newest');
    expect(b).toBe(a);
  });

  test('los arrays repiten la clave y conservan el orden de sus valores', () => {
    expect(toQueryString({ status: ['paid', 'shipped'], page: 1 })).toBe('page=1&status=paid&status=shipped');
  });

  test('en un array se omiten los elementos vacíos', () => {
    expect(toQueryString({ status: ['a', '', 'b'] })).toBe('status=a&status=b');
  });

  test('escapa claves y valores con encodeURIComponent', () => {
    expect(toQueryString({ q: 'a b&c=d' })).toBe('q=a%20b%26c%3Dd');
    expect(toQueryString({ q: 'ñandú/ü' })).toBe('q=%C3%B1and%C3%BA%2F%C3%BC');
    expect(toQueryString({ 'a&b': 'x' })).toBe('a%26b=x');
    expect(toQueryString({ q: '#frag?x=1' })).toBe('q=%23frag%3Fx%3D1');
  });

  test('números y booleanos se serializan como texto', () => {
    expect(toQueryString({ n: 12.5, b: true })).toBe('b=true&n=12.5');
  });
});

describe('ApiError', () => {
  test('es un Error con status, code, message y details (details por defecto null)', () => {
    const e = new ApiError(404, 'not_found', 'No existe.');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: 'not_found', message: 'No existe.', details: null });
    const d = new ApiError(422, 'validation_error', 'x', { field: 'q' });
    expect(d.details).toEqual({ field: 'q' });
  });
});

describe('parseResponse', () => {
  test('204 → undefined', async () => {
    expect(await parseResponse(new Response(null, { status: 204 }))).toBeUndefined();
  });

  test('2xx con JSON → el cuerpo tal cual', async () => {
    expect(await parseResponse(json({ items: [1], total: 1 }))).toEqual({ items: [1], total: 1 });
  });

  test('ErrorOut → ApiError con code, message, status y details', async () => {
    const err = await parseResponse(
      json({ error: { code: 'validation_error', message: 'Datos no válidos.', details: [{ loc: ['query', 'page'] }] } }, 422),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'validation_error',
      message: 'Datos no válidos.',
      details: [{ loc: ['query', 'page'] }],
    });
  });

  test('ErrorOut sin details → details null', async () => {
    const err = await parseResponse(json({ error: { code: 'not_found', message: 'No existe.' } }, 404)).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: 'not_found', details: null });
  });

  test.each([
    ['HTML de un proxy', '<html>502 Bad Gateway</html>', 502],
    ['texto plano', 'Internal Server Error', 500],
    ['cuerpo vacío', '', 500],
    ['2xx que no es JSON', 'OK', 200],
  ])('cuerpo no JSON (%s) → invalid_response con el status real', async (_n, body, status) => {
    const err = await parseResponse(new Response(body, { status })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code: 'invalid_response' });
  });

  test.each([
    ['sin clave error', { detail: 'boom' }],
    ['error como texto', { error: 'boom' }],
    ['error sin message', { error: { code: 'x' } }],
    ['error sin code', { error: { message: 'x' } }],
    ['code no textual', { error: { code: 5, message: 'x' } }],
    ['null', null],
    ['array', []],
  ])('error sin el formato común (%s) → invalid_response con el status real', async (_n, body) => {
    const err = await parseResponse(json(body, 503)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'invalid_response' });
  });

  test('un cuerpo con traza no se filtra al ApiError (ni al mensaje, ni a la pila, ni a la serialización)', async () => {
    const trace = 'Traceback (most recent call last): File "/srv/valmont/secret.py" password=hunter2';
    for (const res of [
      new Response(trace, { status: 500 }),
      json({ detail: trace, error: 'x' }, 500),
      json({ error: { code: 'internal_error', message: 'Error interno.', trace, stack: trace } }, 500),
    ]) {
      const err = (await parseResponse(res).catch((e) => e)) as ApiError;
      const dump = `${err.message}|${err.stack}|${JSON.stringify(err)}|${String(err.details)}`;
      expect(dump).not.toContain('Traceback');
      expect(dump).not.toContain('hunter2');
    }
  });
});
