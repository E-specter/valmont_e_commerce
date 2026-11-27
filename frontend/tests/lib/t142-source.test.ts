import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import Icon from '../../src/components/ui/Icon.astro';
import { ICONS, type IconName } from '../../src/components/ui/icons';
import { FRONTEND, read } from '../helpers/css';
import { renderAstro } from '../helpers/render';

// T-142 · pruebas de fuente: iconos nuevos, capas (RT-B6), privacidad (RT-B7) y que las páginas del backoffice no pierdan la guardia.
const SRC = join(FRONTEND, 'src');
const NEW_ICONS = [
  'dashboard', 'orders', 'watch', 'inventory', 'tag', 'chart', 'users', 'shield', 'external', 'chevron', 'alert', 'upload', 'trash', 'back', 'chevdown', 'image', 'drag',
] as const;
const OLD_ICONS = [
  'search', 'heart', 'heart-off', 'shopping-bag', 'message-circle', 'user', 'x', 'send', 'check', 'check-circle', 'x-circle', 'alert-triangle', 'info', 'lock', 'mail',
  'eye', 'eye-off', 'clock', 'calendar', 'credit-card', 'chevron-down', 'arrow-right', 'arrow-left', 'grid', 'list', 'menu', 'plus', 'minus',
] as const;
const NEW_COUNT = 17;
const OLD_COUNT = 28;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/; // "M3 3h18" sí; "M3 3 <script>" no
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');
const files = (sub: string, ext: RegExp): string[] => {
  try {
    return walk(join(SRC, sub)).filter((f) => ext.test(f));
  } catch {
    return [];
  }
};

describe('iconos nuevos (solo se añade; trazos propios, sin dependencias)', () => {
  test('hay 17 nuevos y los 28 anteriores siguen', () => {
    expect(NEW_ICONS).toHaveLength(NEW_COUNT);
    expect(OLD_ICONS).toHaveLength(OLD_COUNT);
    const keys = Object.keys(ICONS);
    [...NEW_ICONS, ...OLD_ICONS].forEach((n) => expect(keys, n).toContain(n));
    expect(keys.length).toBeGreaterThanOrEqual(NEW_COUNT + OLD_COUNT);
  });

  test.each(NEW_ICONS)('%s dibuja al menos un trazo válido', (name) => {
    const paths: readonly string[] = ICONS[name as IconName];
    expect(paths.length).toBeGreaterThan(0);
    paths.forEach((d) => {
      expect(d.length).toBeGreaterThan(2);
      expect(d).toMatch(PATH_DATA);
    });
  });

  // `chevdown` y `back` son los nombres de Figma (bo/componentes) de `chevron-down` y `arrow-left`: pueden coincidir en el dibujo.
  const ALIASES = new Set(['chevdown', 'back']);
  test('los iconos nuevos no repiten el dibujo de otro, salvo los dos alias de Figma', () => {
    const owner = new Map<string, string[]>();
    Object.entries(ICONS).forEach(([name, p]) => {
      const key = (p as readonly string[]).join('|');
      owner.set(key, [...(owner.get(key) ?? []), name]);
    });
    const dupes = [...owner.values()].filter((names) => names.length > 1);
    dupes.forEach((names) => expect(names.filter((n) => !OLD_ICONS.includes(n as never)).every((n) => ALIASES.has(n)), names.join(',')).toBe(true));
    expect(dupes.length).toBeLessThanOrEqual(ALIASES.size);
  });

  test.each(NEW_ICONS)('%s se renderiza con el componente Icon (svg decorativo con data-icon)', async (name) => {
    const html = await renderAstro(Icon, { props: { name } });
    expect(html).toContain('<svg');
    expect(html).toContain(`data-icon="${name}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<path');
  });

  test('no se añadió ninguna dependencia de iconos: icons.ts no importa nada externo', () => {
    expect(read('src/components/ui/icons.ts')).not.toMatch(/^import\s/m);
  });
});

describe('RT-B6 · capas: componentes e islas no importan de lib/server', () => {
  const targets = [...files('components', /\.(astro|ts)$/), ...files('islands', /\.(astro|ts)$/)];

  test('hay archivos que revisar (no es una prueba vacía)', () => {
    expect(targets.length).toBeGreaterThan(10);
    expect(targets.map(rel)).toEqual(expect.arrayContaining(['src/components/admin/NavItem.astro', 'src/components/admin/UserMenu.astro']));
  });

  test('grep -rn "lib/server" src/components src/islands → vacío', () => {
    expect(targets.filter((f) => /lib\/server/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  test('lib/admin/** es neutro: sin astro:env, sin lib/server', () => {
    const lib = files('lib/admin', /\.ts$/);
    expect(lib.map(rel)).toContain('src/lib/admin/nav.ts');
    // Solo imports y re-exports que nombran astro:env o lib/server; los comentarios no cuentan.
    const IMPORT_OF = /^\s*(import|export)\b.*(astro:env|lib\/server)/m;
    expect(lib.filter((f) => IMPORT_OF.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  test('los componentes del backoffice no leen la sesión ni el entorno', () => {
    const admin = [...files('components/admin', /\.astro$/), join(SRC, 'layouts', 'AdminLayout.astro')];
    expect(admin.filter((f) => /astro:env|locals\.|Astro\.locals|getProfile|apiFor/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });
});

describe('RT-B7 / RT-1 · nada sensible llega al cliente desde el marco del backoffice', () => {
  const shell = [
    join(SRC, 'layouts', 'AdminLayout.astro'),
    ...files('components/admin', /\.astro$/),
    join(SRC, 'pages', 'admin', 'sin-permiso.astro'),
    join(SRC, 'pages', 'admin', 'no-disponible.astro'),
  ];

  test.each(shell.map((f) => [rel(f), f]))('%s: sin set:html, console, Authorization ni API_BASE_URL', (_n, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/set:html|set:text|console\.|Authorization|API_BASE_URL|dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage/);
  });

  test.each(shell.map((f) => [rel(f), f]))('%s: sin scripts en línea con datos (define:vars) ni handlers on*=', (_n, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/define:vars/);
    expect(src).not.toMatch(/\son(click|error|load|focus|submit)\s*=/i);
  });

  test('las páginas sin-permiso y no-disponible no se prerenderizan (llevan estado y cabeceras por petición)', () => {
    ['src/pages/admin/sin-permiso.astro', 'src/pages/admin/no-disponible.astro'].forEach((p) => expect(read(p)).toMatch(/export const prerender\s*=\s*false/));
  });

  test('ambas fijan su estado y no-store desde la propia página (también con rewrite)', () => {
    expect(read('src/pages/admin/sin-permiso.astro')).toMatch(/Astro\.response\.status\s*=\s*403/);
    expect(read('src/pages/admin/no-disponible.astro')).toMatch(/Astro\.response\.status\s*=\s*503/);
    ['src/pages/admin/sin-permiso.astro', 'src/pages/admin/no-disponible.astro'].forEach((p) => expect(read(p)).toMatch(/Cache-Control['"],\s*['"]private, no-store/));
  });
});

describe('/dev/admin-layout (solo desarrollo)', () => {
  const src = read('src/pages/dev/admin-layout.astro');

  test('responde 404 fuera de desarrollo, antes de cualquier otra lógica', () => {
    expect(src).toMatch(/import\.meta\.env\.DEV/);
    expect(src.indexOf('import.meta.env.DEV')).toBeLessThan(src.indexOf('await requireAdmin'));
    expect(src).toMatch(/status:\s*404/);
  });

  test('exige administrador (requireAdmin) y devuelve su respuesta tal cual', () => {
    expect(src).toMatch(/await requireAdmin\(Astro\)/);
    expect(src).toMatch(/if \(!gate\.ok\) return gate\.response/);
  });

  test('no se prerenderiza', () => {
    expect(src).toMatch(/export const prerender\s*=\s*false/);
  });
});

describe('páginas de administración (rutas bajo /admin): cada una exige requireAdmin', () => {
  // Las páginas reales de datos (T-145, T-084, T-146…) llegan en otras tareas; las que existan aquí, salvo los dos estados, deben pasar la guardia.
  const pages = files('pages/admin', /\.(astro|ts)$/).filter((f) => !/sin-permiso|no-disponible/.test(f));

  test('toda página de /admin distinta de los dos estados llama a requireAdmin y no se prerenderiza', () => {
    const offenders = pages.filter((f) => {
      const s = readFileSync(f, 'utf8');
      return !/requireAdmin\(/.test(s) || !/prerender\s*=\s*false/.test(s);
    });
    expect(offenders.map(rel)).toEqual([]);
  });
});
