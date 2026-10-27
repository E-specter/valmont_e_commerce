// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// https://astro.build/config
// D-024: páginas estáticas por defecto (portada, legales); listado, categoría y ficha
// se renderizan bajo demanda con `export const prerender = false`.
// El adaptador genera siempre dist/server/entry.mjs, que sirve también lo prerenderizado.
export default defineConfig({
  output: 'static',
  adapter: node({ mode: 'standalone' }),
});
