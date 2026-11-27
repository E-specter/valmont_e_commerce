import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FRONTEND, read } from '../helpers/css';

// T-136 · D-044 (REVIEW-2026-11-27 D-04; BRIEF §3): Jaro solo en el wordmark VALMONT. Jaro dibuja la V como U.
// Phudu (--font-heading) para títulos y llamadas; Geist (--font-ui) para UI. Se lee el código fuente de `src/`.
const SRC = join(FRONTEND, 'src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const rel = (f: string): string => relative(FRONTEND, f).replaceAll('\\', '/');

// Los únicos archivos que pueden nombrar la familia de marca.
const ALLOWED = [
  'src/components/ui/Wordmark.astro',
  'src/components/layout/SiteFooter.astro',
  'src/styles/tokens.css',
  'src/pages/dev/tokens.astro',
];
// Uso de la familia de marca: "var(--font-brand)" casa; "var(--font-heading)" no.
// Probar: https://regex101.com/?flavor=javascript&regex=--font-brand&flags=
const BRAND_USE = /--font-brand/;

/** Cuerpo de la regla CSS que contiene `selector` (hasta su `}`), o '' si no existe. */
function rule(file: string, selector: string): string {
  const text = read(file);
  const at = text.indexOf(selector);
  if (at === -1) return '';
  return text.slice(at, text.indexOf('}', at));
}

describe('T-136 · Jaro solo en el wordmark (código fuente)', () => {
  const users = walk(SRC)
    .filter((f) => ['.astro', '.css', '.ts'].some((e) => f.endsWith(e)) && BRAND_USE.test(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  test('la familia de marca solo aparece en Wordmark, el wordmark del pie, tokens.css y /dev/tokens', () => {
    expect(users).toEqual([...ALLOWED].sort());
  });

  test('en el pie, --font-brand solo está en la regla .site-footer__mark', () => {
    const text = read('src/components/layout/SiteFooter.astro');
    const hits = text.split('\n').filter((l) => l.includes('--font-brand'));
    expect(hits).toHaveLength(1);
    expect(rule('src/components/layout/SiteFooter.astro', '.site-footer__mark {')).toContain('var(--font-brand)');
  });

  test('Wordmark conserva Jaro', () => {
    expect(read('src/components/ui/Wordmark.astro')).toContain('var(--font-brand)');
  });
});

describe('T-136 · botones, llamadas y navegación usan Phudu o Geist (D-044)', () => {
  test('Button: Phudu semibold, 16 px (--text-body-ui), mayúsculas, sin Jaro', () => {
    const r = rule('src/components/ui/Button.astro', '.btn {');
    expect(r).toContain('font-family: var(--font-heading)');
    expect(r).toContain('font-weight: var(--weight-semibold)');
    expect(r).toContain('font-size: var(--text-body-ui)');
    expect(r).toContain('text-transform: uppercase');
    expect(r).not.toContain('--font-brand');
  });

  test('ProductCard .cta: Phudu semibold, 16 px, mayúsculas', () => {
    const r = rule('src/components/catalog/ProductCard.astro', '.product-card .cta {');
    expect(r).toContain('font-family: var(--font-heading)');
    expect(r).toContain('font-weight: var(--weight-semibold)');
    expect(r).toContain('font-size: var(--text-body-ui)');
    expect(r).toContain('text-transform: uppercase');
  });

  test.each([
    ['src/components/home/CollectionLinks.astro', 'a {'],
    ['src/components/home/FeaturedProduct.astro', 'h2 {'],
    ['src/pages/nosotros.astro', '.awards__block {'],
  ])('%s · %s: Phudu bold', (file, selector) => {
    const r = rule(file, selector);
    expect(r).toContain('font-family: var(--font-heading)');
    expect(r).toContain('font-weight: var(--weight-bold)');
  });

  test('Badge de producto: Geist bold', () => {
    const r = rule('src/components/ui/Badge.astro', ".badge[data-kind='product'] {");
    expect(r).toContain('font-family: var(--font-ui)');
    expect(r).toContain('font-weight: var(--weight-bold)');
  });

  test('navegación de la cabecera: Geist semibold, mayúsculas', () => {
    const header = read('src/components/layout/SiteHeader.astro');
    const blocks = header.split('}').filter((b) => b.includes('text-transform: uppercase') && b.includes('--touch-target'));
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((b) => {
      expect(b).toContain('font-family: var(--font-ui)');
      expect(b).toContain('font-weight: var(--weight-semibold)');
      expect(b).not.toContain('--font-brand');
    });
  });

  test('pie: los enlaces no vuelven a flex a 800 px (rejilla de 2 columnas a todos los anchos)', () => {
    const footer = read('src/components/layout/SiteFooter.astro');
    const media = footer.slice(footer.indexOf('@media (min-width: 800px)'));
    expect(media).not.toContain('.site-footer__links');
    const links = rule('src/components/layout/SiteFooter.astro', '.site-footer__links {');
    expect(links).toContain('display: grid');
    expect(links).toContain('grid-template-columns: 1fr 1fr');
  });
});
