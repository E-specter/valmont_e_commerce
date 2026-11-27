import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import type { OrderStatus, TransitionTarget } from '../../src/lib/api/admin-orders';
import { cancelCopy, ORDER_STATUS_LABEL, ORDER_STATUSES, orderPill, productPill, transitionLabel, transitionTargets } from '../../src/lib/admin/status';

// T-144 · lib/admin/status.ts (STATUS ui §10.5 3.8; VIEWS §12.4). Texto + tono por estado y destinos de transición.
// El frontend NO deduce transiciones: `transitionTargets` solo intersecta lo que manda el servidor con los 5 destinos.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const DESTINATIONS: TransitionTarget[] = ['en_preparacion', 'enviado', 'listo_para_recojo', 'entregado', 'cancelado'];
const NEVER: OrderStatus[] = ['pendiente_pago', 'pagado', 'expirado'];
const TONES = ['pending', 'paid', 'active', 'transit', 'done', 'cancelled', 'neutral'];
const STATUS_COUNT = 8;

const LABELS: Record<OrderStatus, string> = {
  pendiente_pago: 'Pendiente de pago',
  pagado: 'Pagado',
  en_preparacion: 'En preparación',
  enviado: 'Enviado',
  listo_para_recojo: 'Listo para recojo',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  expirado: 'Expirado',
};
const TONE: Record<OrderStatus, string> = {
  pendiente_pago: 'pending',
  pagado: 'paid',
  en_preparacion: 'active',
  enviado: 'transit',
  listo_para_recojo: 'transit',
  entregado: 'done',
  cancelado: 'cancelled',
  expirado: 'neutral',
};

describe('estados de pedido', () => {
  test('ORDER_STATUSES lista los 8 estados, sin repetir, en el orden del ciclo de vida', () => {
    expect([...ORDER_STATUSES]).toEqual(['pendiente_pago', 'pagado', 'en_preparacion', 'enviado', 'listo_para_recojo', 'entregado', 'cancelado', 'expirado']);
    expect(new Set(ORDER_STATUSES).size).toBe(STATUS_COUNT);
  });

  test('ORDER_STATUS_LABEL: el texto en español de cada estado', () => {
    expect(ORDER_STATUS_LABEL).toEqual(LABELS);
  });

  test.each(ORDER_STATUSES)('orderPill(%s): texto y tono de VIEWS §12.4', (status) => {
    expect(orderPill(status)).toEqual({ label: LABELS[status], tone: TONE[status] });
  });

  test('enviado y listo_para_recojo comparten tono; todos los tonos usados pertenecen a la unión', () => {
    expect(orderPill('enviado').tone).toBe(orderPill('listo_para_recojo').tone);
    expect(ORDER_STATUSES.every((s) => TONES.includes(orderPill(s).tone))).toBe(true);
  });

  test('el estado nunca es solo color: cada pill trae un texto no vacío', () => {
    expect(ORDER_STATUSES.every((s) => orderPill(s).label.trim().length > 0)).toBe(true);
  });
});

describe('estados de producto', () => {
  test('draft → Borrador (neutral) · published → Publicado (paid)', () => {
    expect(productPill('draft')).toEqual({ label: 'Borrador', tone: 'neutral' });
    expect(productPill('published')).toEqual({ label: 'Publicado', tone: 'paid' });
  });
});

describe('transitionLabel', () => {
  test.each([
    ['en_preparacion', 'pagado', 'Preparar pedido'],
    ['enviado', 'en_preparacion', 'Marcar como enviado'],
    ['listo_para_recojo', 'en_preparacion', 'Marcar listo para recojo'],
    ['entregado', 'enviado', 'Marcar como entregado'],
    ['entregado', 'listo_para_recojo', 'Marcar como entregado'],
    ['cancelado', 'pagado', 'Cancelar y reembolsar'],
    ['cancelado', 'en_preparacion', 'Cancelar y reembolsar'],
    ['cancelado', 'pendiente_pago', 'Cancelar pedido'],
  ] as [TransitionTarget, OrderStatus, string][])('%s desde %s → «%s»', (to, from, label) => {
    expect(transitionLabel(to, from)).toBe(label);
  });
});

describe('cancelCopy', () => {
  test.each(['pagado', 'en_preparacion'] as OrderStatus[])('desde %s: reembolso simulado del total y el stock no se repone', (from) => {
    const c = cancelCopy(from);
    expect(Object.keys(c).sort()).toEqual(['body', 'confirm', 'title']);
    expect(c.body.toLowerCase()).toContain('reembols');
    expect(c.body.toLowerCase()).toContain('stock');
    expect([c.title, c.body, c.confirm].every((t) => t.trim().length > 0)).toBe(true);
  });

  test('desde pendiente_pago: libera las reservas y no promete reembolso', () => {
    const c = cancelCopy('pendiente_pago');
    expect(c.body.toLowerCase()).toContain('reserva');
    expect(c.body.toLowerCase()).not.toContain('reembolsar');
    expect(c.body).not.toBe(cancelCopy('pagado').body);
    expect(c.confirm.trim().length).toBeGreaterThan(0);
  });
});

describe('transitionTargets (D-B4 A: lo decide el servidor)', () => {
  test('pagado/en_preparacion/cancelado → solo los destinos, avance primero y cancelar al final', () => {
    expect(transitionTargets(['pagado', 'en_preparacion', 'cancelado'])).toEqual(['en_preparacion', 'cancelado']);
  });

  // Discrepancia anotada en el traspaso: el criterio del paquete dice `['enviado','entregado']` → `['entregado']`, pero «enviado» es a la vez
  // estado y destino (en_preparacion → enviado), así que la intersección de 3.8 no puede descartarlo. Se prueba lo que sí es contrato.
  test('un pedido enviado solo ofrece entregado (can_transition_to = [entregado])', () => {
    expect(transitionTargets(['entregado'])).toEqual(['entregado']);
    expect(transitionTargets(['listo_para_recojo'])).toEqual(['listo_para_recojo']);
  });

  test('cancelar va siempre al final aunque el servidor lo mande primero', () => {
    expect(transitionTargets(['cancelado', 'en_preparacion'])).toEqual(['en_preparacion', 'cancelado']);
    expect(transitionTargets(['cancelado', 'enviado', 'listo_para_recojo']).at(-1)).toBe('cancelado');
  });

  test('sin transiciones (estados terminales) → arreglo vacío', () => {
    expect(transitionTargets([])).toEqual([]);
  });

  test('nunca devuelve pendiente_pago, pagado ni expirado, ni inventa un destino', () => {
    const out = transitionTargets([...ORDER_STATUSES]);
    expect(out.filter((s) => (NEVER as string[]).includes(s))).toEqual([]);
    expect(out.every((s) => DESTINATIONS.includes(s))).toBe(true);
    expect(transitionTargets(NEVER)).toEqual([]);
  });

  test('no deduce nada: solo devuelve lo que el servidor mandó (sin añadir cancelar ni avanzar)', () => {
    expect(transitionTargets(['en_preparacion'])).toEqual(['en_preparacion']);
    expect(transitionTargets(['entregado'])).toEqual(['entregado']);
    expect(transitionTargets(['pagado'])).toEqual([]);
  });

  test('ignora valores desconocidos del servidor y no muta la entrada', () => {
    const input = ['cancelado', 'refunded', 'en_preparacion', ''] as unknown as OrderStatus[];
    const copy = [...input];
    expect(transitionTargets(input)).toEqual(['en_preparacion', 'cancelado']);
    expect(input).toEqual(copy);
  });

  test('con envío y con recojo ofrece cada avance que manda el servidor', () => {
    expect(new Set(transitionTargets(['enviado', 'cancelado']))).toEqual(new Set(['enviado', 'cancelado']));
    expect(new Set(transitionTargets(['listo_para_recojo', 'cancelado']))).toEqual(new Set(['listo_para_recojo', 'cancelado']));
  });
});

describe('PillTone duplicado a propósito (T-143 ↔ T-144)', () => {
  const union = (file: string): string[] => {
    const full = join(SRC, file);
    const program = ts.createProgram([full], { noEmit: true, skipLibCheck: true, types: [], moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext });
    const source = program.getSourceFile(full);
    const decl = source?.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'PillTone');
    expect(decl, `PillTone exportado en ${file}`).toBeDefined();
    const t = program.getTypeChecker().getTypeAtLocation(decl!.name);
    return (t.isUnion() ? t.types : [t]).map((x) => (x as ts.StringLiteralType).value).sort();
  };

  test('lib/admin/status.ts declara los 7 tonos del paquete', () => {
    expect(union('lib/admin/status.ts')).toEqual([...TONES].sort());
  });

  test('components/ui/status-pill.ts (T-143), cuando existe, declara la misma unión', () => {
    // T-143 se desarrolla en paralelo: en la rama de integración las dos uniones deben coincidir.
    const pill = join(SRC, 'components/ui/status-pill.ts');
    if (!existsSync(pill)) {
      expect(readFileSync(join(SRC, 'lib/admin/status.ts'), 'utf8')).toContain('status-pill.ts');
      return;
    }
    expect(union('components/ui/status-pill.ts')).toEqual(union('lib/admin/status.ts'));
  });
});
