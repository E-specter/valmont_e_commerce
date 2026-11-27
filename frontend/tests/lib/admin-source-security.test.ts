import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// T-144 · prueba de código fuente de lib/admin/** y lib/api/admin-*.ts (RT-B4, RT-B6, RN-09, D-050, D-049 B).
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(FRONTEND, 'src/lib');
const rel = (f: string) => relative(FRONTEND, f).replaceAll('\\', '/');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const EOL = '\n';
// Solo líneas de código: se descartan comentarios de línea y de bloque (la documentación puede nombrar lo prohibido).
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .split(EOL)
    .filter((l) => !['//', '/*', '*'].some((c) => l.trimStart().startsWith(c)))
    .join(EOL);

const API_FILES = ['admin-orders.ts', 'admin-catalog.ts', 'admin-inventory.ts'].map((f) => join(LIB, 'api', f));
const ADMIN_UTILS = ['status.ts', 'money.ts', 'order-query.ts', 'errors.ts', 'messages.ts'].map((f) => join(LIB, 'admin', f));
const ALL = [...API_FILES, ...ADMIN_UTILS];
const EVERY_ADMIN_FILE = existsSync(join(LIB, 'admin')) ? walk(join(LIB, 'admin')).filter((f) => f.endsWith('.ts')) : [];
const NEUTRAL = [...new Set([...API_FILES, ...EVERY_ADMIN_FILE])];
const NO_RESULT = 0;
// Acepta "import type { IconName } from '../../components/ui/icons';" (con o sin ';'); rechaza cualquier otra forma.
const ALLOWED_NAV_IMPORT = /^import type \{ IconName \} from '(\.\.\/)+components\/ui\/icons';?$/;
const NAV_FILE = 'src/lib/admin/nav.ts';
/** Líneas de `text` que importan o re-exportan de components/ o pages/, salvo el import de tipo exacto de nav.ts. */
const layerViolations = (file: string, text: string): string[] =>
  text
    .split(EOL)
    .filter((l) => (l.includes('import') || l.includes('from ')) && (l.includes('components/') || l.includes('/pages/')))
    .filter((l) => !(file === NAV_FILE && ALLOWED_NAV_IMPORT.test(l.trim())));
const MIN_LITERAL = 8;

describe('los archivos del paquete existen', () => {
  test.each(ALL.map(rel))('%s', (f) => {
    expect(existsSync(join(FRONTEND, f))).toBe(true);
  });
});

describe('módulos neutros: sin entorno ni servidor (RT-B6, D-050)', () => {
  test.each(NEUTRAL.map(rel))('%s no importa de astro:env, de lib/server ni de módulos de Node', (f) => {
    const imports = code(join(FRONTEND, f))
      .split(EOL)
      .filter((l) => l.includes('import ') || l.includes('from ') || l.includes('require('));
    const banned = ['astro:env', 'lib/server', '/server\'', '/server"', 'node:', 'astro:middleware', 'supabase', 'process.env', 'import.meta.env'];
    expect(imports.filter((l) => banned.some((b) => l.includes(b)))).toEqual([]);
    expect(code(join(FRONTEND, f)).includes('process.env')).toBe(false);
    expect(code(join(FRONTEND, f)).includes('import.meta.env')).toBe(false);
  });

  test('lib/admin/** y lib/api/admin-*.ts no importan de components/ ni de pages/ (la capa baja no depende de la alta; única excepción: el tipo IconName en nav.ts)', () => {
    const offenders = NEUTRAL.filter((f) => layerViolations(rel(f), code(f)).length > NO_RESULT);
    expect(offenders.map(rel)).toEqual([]);
  });

  // T-142 (decisión del Leader): `IconName` es `keyof typeof ICONS` y no puede salir de components/ui/icons; un `import type` se borra al compilar.
  describe('la excepción de nav.ts es exacta', () => {
    const NAV = 'src/lib/admin/nav.ts';
    const OK = "import type { IconName } from '../../components/ui/icons';";

    test('el import de tipo exacto, solo en nav.ts, no es una infracción', () => {
      expect(layerViolations(NAV, OK)).toEqual([]);
      expect(layerViolations(NAV, OK.replace(';', ''))).toEqual([]);
    });

    test.each([
      ['un import de valor desde components/ui/icons', "import { ICONS } from '../../components/ui/icons';"],
      ['un import de valor y de tipo juntos', "import { ICONS, type IconName } from '../../components/ui/icons';"],
      ['import type de otro nombre', "import type { Other } from '../../components/ui/icons';"],
      ['import type de IconName junto con otro nombre', "import type { IconName, Other } from '../../components/ui/icons';"],
      ['import type desde otro componente', "import type { Props } from '../../components/ui/Button.astro';"],
      ['import type de IconName desde otro módulo de components/', "import type { IconName } from '../../components/admin/NavItem.astro';"],
      ['import type desde pages/', "import type { X } from '../../pages/admin/sin-permiso.astro';"],
      ['import de valor desde pages/', "import { X } from '../../pages/index.astro';"],
      ['import efectos laterales', "import '../../components/ui/icons';"],
      ['re-exportación', "export { ICONS } from '../../components/ui/icons';"],
      ['import dinámico', "const m = await import('../../components/ui/icons');"],
    ])('%s en nav.ts sigue prohibido', (_name, line) => {
      expect(layerViolations(NAV, line).length).toBeGreaterThan(NO_RESULT);
    });

    test('el mismo import de tipo en cualquier otro archivo de lib/admin o lib/api sigue prohibido', () => {
      ['src/lib/admin/status.ts', 'src/lib/admin/money.ts', 'src/lib/api/admin-orders.ts'].forEach((f) =>
        expect(layerViolations(f, OK).length, f).toBeGreaterThan(NO_RESULT),
      );
    });

    test('nav.ts real: tiene exactamente ese import y ningún otro de components/ o pages/', () => {
      const lines = code(join(FRONTEND, 'src/lib/admin/nav.ts')).split(EOL).filter((l) => l.includes('components/') || l.includes('/pages/'));
      expect(lines.map((l) => l.trim())).toEqual([OK]);
    });
  });
});

describe('los clientes de API usan el transporte, nunca fetch ni la red directa', () => {
  test.each(API_FILES.map(rel))('%s: sin fetch, XMLHttpRequest, WebSocket, cookies ni almacenamiento', (f) => {
    const c = code(join(FRONTEND, f));
    const banned = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'document.cookie', 'localStorage', 'sessionStorage', 'API_BASE_URL', '127.0.0.1', 'localhost'];
    expect(banned.filter((b) => c.includes(b))).toEqual([]);
  });

  test.each(API_FILES.map(rel))('%s: toda función exportada recibe el transporte como primer parámetro', (f) => {
    const c = code(join(FRONTEND, f));
    // Cada `export function nombre(` (también en varias líneas) empieza por `t: Transport`.
    const exported = c.split('export function ').slice(1);
    expect(exported.length).toBeGreaterThan(NO_RESULT);
    expect(exported.filter((chunk) => !chunk.slice(chunk.indexOf('(') + 1).trimStart().startsWith('t: Transport'))).toEqual([]);
  });

  test.each(API_FILES.map(rel))('%s: sin console.* ni debugger', (f) => {
    const c = code(join(FRONTEND, f));
    expect(['console.', 'debugger'].filter((b) => c.includes(b))).toEqual([]);
  });
});

describe('privacidad y mensajes', () => {
  test.each(NEUTRAL.map(rel))('%s: sin console.* ni debugger (RT-B7: nada de PII en consola)', (f) => {
    const c = code(join(FRONTEND, f));
    expect(['console.', 'debugger'].filter((b) => c.includes(b))).toEqual([]);
  });

  test.each(NEUTRAL.map(rel))('%s: sin literales que dispararían el hook de secretos (RT-B4)', (f) => {
    const hookPattern = ['key', 'secret', 'password', 'token'];
    // Una línea asigna un literal de 8 o más caracteres a un nombre vigilado: `nombreKey = 'abcdefgh'`.
    const offenders = code(join(FRONTEND, f))
      .split(EOL)
      .filter((l) => {
        const lower = l.toLowerCase();
        const assigned = ['=', ':'].map((op) => lower.indexOf(op)).filter((i) => i >= NO_RESULT);
        if (assigned.length === NO_RESULT) return false;
        const left = lower.slice(NO_RESULT, Math.min(...assigned));
        const right = l.slice(Math.min(...assigned) + 1).trim();
        const literal = ['\'', '"'].some((q) => right.startsWith(q) && right.split(q)[1].length >= MIN_LITERAL);
        return literal && hookPattern.some((w) => left.includes(w));
      });
    expect(offenders).toEqual([]);
  });

  test('los textos de interfaz compartidos viven en messages.ts y no se duplican en los clientes de API', () => {
    const spanish = ['No tienes permiso', 'Inténtalo de nuevo', 'Completa este campo'];
    API_FILES.forEach((f) => expect(spanish.filter((t) => code(f).includes(t)), rel(f)).toEqual([]));
  });
});

describe('importes (RN-09, D-015, D-B6 = B)', () => {
  test.each(ADMIN_UTILS.map(rel))('%s: no formatea importes por su cuenta (Intl.NumberFormat, toLocaleString, toFixed): se usa formatMoney', (f) => {
    const c = code(join(FRONTEND, f));
    expect(['Intl.NumberFormat', 'toLocaleString', 'toFixed', 'parseFloat'].filter((b) => c.includes(b))).toEqual([]);
  });

  test.each(API_FILES.map(rel))('%s: sin cálculo de importes (subtotal, total, descuento) ni user_id en lo que envía', (f) => {
    const c = code(join(FRONTEND, f));
    // Los cuerpos se arman con lo recibido: no hay operaciones aritméticas sobre `amount`.
    expect(['.amount *', '.amount +', '.amount -', '.amount /'].filter((b) => c.includes(b))).toEqual([]);
    expect(c.includes('body: { user_id')).toBe(false);
    expect(c.includes('user_id,')).toBe(false);
  });
});

describe('el listado de pedidos no sale de la lista blanca', () => {
  test('order-query.ts no reenvía parámetros sin filtrar (nada de Object.fromEntries(searchParams) ni spread de la URL)', () => {
    const c = code(join(LIB, 'admin/order-query.ts'));
    expect(['Object.fromEntries(sp', 'Object.fromEntries(searchParams', 'sp.entries()', 'searchParams.entries()'].filter((b) => c.includes(b))).toEqual([]);
  });
});
