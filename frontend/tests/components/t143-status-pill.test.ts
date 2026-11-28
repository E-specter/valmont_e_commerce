import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import StatusPill from '../../src/components/ui/StatusPill.astro';
import { FRONTEND } from '../helpers/css';
import { hasMarker, markers, root, text, ui } from '../helpers/ui';

// T-143 · StatusPill (punto + texto, nunca solo color) y la unión `PillTone` (VIEWS §12.4, STATUS §10.5 3.8).
const NONE = 0;
const ONE = 1;
const TWO = 2;
const TONES = ['pending', 'paid', 'active', 'transit', 'done', 'cancelled', 'neutral'] as const;
// Los 8 estados de pedido con el tono que fija 3.8 (`orderPill`) y el texto de VIEWS §12.4.
const ORDER_STATES: [status: string, label: string, tone: (typeof TONES)[number]][] = [
  ['pendiente_pago', 'Pendiente de pago', 'pending'],
  ['pagado', 'Pagado', 'paid'],
  ['en_preparacion', 'En preparación', 'active'],
  ['enviado', 'Enviado', 'transit'],
  ['listo_para_recojo', 'Listo para recojo', 'transit'],
  ['entregado', 'Entregado', 'done'],
  ['cancelado', 'Cancelado', 'cancelled'],
  ['expirado', 'Expirado', 'neutral'],
];
const PRODUCT_STATES: [string, (typeof TONES)[number]][] = [
  ['Borrador', 'neutral'],
  ['Publicado', 'paid'],
];

const pill = async (props: Record<string, unknown>): Promise<Element> => root(await ui(StatusPill, props));
// Los literales de la unión: lo que va entre comillas simples en `export type PillTone = 'a' | 'b';`.
const unionOf = (src: string): string[] => {
  const start = src.indexOf('export type PillTone');
  if (start === -ONE) throw new Error('No se encuentra `export type PillTone`');
  const decl = src.slice(start, src.indexOf(';', start));
  return decl.split("'").filter((_, i) => i % TWO === ONE);
};

describe('StatusPill · Container API', () => {
  test.each(ORDER_STATES)('%s → texto visible «%s» y tono %s', async (_s, label, tone) => {
    const el = await pill({ label, tone });
    expect(text(el)).toBe(label);
    expect(hasMarker(el, tone)).toBe(true);
  });

  test.each(PRODUCT_STATES)('producto «%s» (tono %s) también lleva texto', async (label, tone) => {
    const el = await pill({ label, tone });
    expect(text(el)).toBe(label);
    expect(hasMarker(el, tone)).toBe(true);
  });

  test('los 7 tonos producen marcas distintas entre sí', async () => {
    const all = await Promise.all(TONES.map(async (tone) => markers(await pill({ label: 'X', tone }))));
    expect(new Set(all).size).toBe(TONES.length);
  });

  test('nunca solo color: cada pill tiene texto no vacío y un punto decorativo (aria-hidden) que no contiene texto', async () => {
    const reports = await Promise.all(
      TONES.map(async (tone) => {
        const el = await pill({ label: 'Etiqueta', tone });
        const dot = el.querySelector('[aria-hidden="true"]');
        return { tone, hasText: text(el) === 'Etiqueta', hasDot: dot !== null, dotEmpty: (dot?.textContent ?? '').trim() === '' };
      }),
    );
    expect(reports.filter((r) => !r.hasText || !r.hasDot || !r.dotEmpty)).toEqual([]);
  });

  test('el nombre accesible es el texto: sin aria-label que lo sustituya ni role de imagen', async () => {
    const el = await pill({ label: 'Pagado', tone: 'paid' });
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(el.getAttribute('role')).not.toBe('img');
  });

  test('un pill no es interactivo ni anuncia cambios (sin role alert/status, sin tabindex, sin enlaces ni botones)', async () => {
    const el = await pill({ label: 'Pagado', tone: 'paid' });
    expect(['alert', 'status']).not.toContain(el.getAttribute('role'));
    expect(el.hasAttribute('tabindex')).toBe(false);
    expect(el.querySelectorAll('a, button, input').length).toBe(NONE);
  });

  test('Enviado y Listo para recojo comparten tono pero se distinguen por el texto', async () => {
    const a = await pill({ label: 'Enviado', tone: 'transit' });
    const b = await pill({ label: 'Listo para recojo', tone: 'transit' });
    expect(markers(a)).toBe(markers(b));
    expect(text(a)).not.toBe(text(b));
  });

  test('el texto del servidor se pinta como texto (se escapa)', async () => {
    const body = await ui(StatusPill, { label: '<img id="pwn" src=x onerror=alert(1)>', tone: 'neutral' });
    expect(body.querySelector('#pwn')).toBeNull();
    expect(text(root(body))).toContain('<img id="pwn"');
  });

  test('un solo elemento raíz con el texto una sola vez', async () => {
    const body = await ui(StatusPill, { label: 'Cancelado', tone: 'cancelled' });
    expect((body.textContent ?? '').split('Cancelado').length - ONE).toBe(ONE);
  });
});

describe('PillTone · la unión (STATUS T-143 «Firmas públicas»)', () => {
  const pillSrc = readFileSync(join(FRONTEND, 'src/components/ui/status-pill.ts'), 'utf8');

  test('`status-pill.ts` declara exactamente los 7 tonos del contrato', () => {
    expect([...unionOf(pillSrc)].sort()).toEqual([...TONES].sort());
  });

  test('`StatusPill.astro` importa `PillTone` de `status-pill.ts` y no la redeclara', () => {
    const src = readFileSync(join(FRONTEND, 'src/components/ui/StatusPill.astro'), 'utf8');
    expect(src.includes("from './status-pill'")).toBe(true);
    expect(src.includes('type PillTone =')).toBe(false);
  });

  // Paridad con T-144: `lib/admin/status.ts` solo existe cuando T-144 está integrado. Mientras falte, esta comprobación no
  // aplica a este paquete; en cuanto exista, la unión debe coincidir con la de `status-pill.ts`.
  const statusPath = join(FRONTEND, 'src/lib/admin/status.ts');
  test.runIf(existsSync(statusPath))('PARIDAD con T-144: `lib/admin/status.ts` declara la misma unión que `status-pill.ts`', () => {
    expect([...unionOf(readFileSync(statusPath, 'utf8'))].sort()).toEqual([...unionOf(pillSrc)].sort());
  });
});
