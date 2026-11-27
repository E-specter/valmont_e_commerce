// @ts-check
import { defineConfig, envField, fontProviders } from 'astro/config';
import node from '@astrojs/node';

const google = fontProviders.google();

// https://astro.build/config
// D-024: páginas estáticas por defecto (portada, legales); listado, categoría y ficha
// se renderizan bajo demanda con `export const prerender = false`.
// El adaptador genera siempre dist/server/entry.mjs, que sirve también lo prerenderizado.
export default defineConfig({
  output: 'static',
  adapter: node({ mode: 'standalone' }),

  // D-042: fuentes con la API de Astro y proveedor Google; se descargan al compilar y se sirven
  // desde el propio sitio. Roles de familia: BRIEF §3.
  fonts: [
    { provider: google, name: 'Jaro', cssVariable: '--f-jaro', weights: [400], styles: ['normal'], subsets: ['latin'], fallbacks: ['sans-serif'] },
    { provider: google, name: 'Phudu', cssVariable: '--f-phudu', weights: ['600 700'], styles: ['normal'], subsets: ['latin'], fallbacks: ['sans-serif'] },
    { provider: google, name: 'Staatliches', cssVariable: '--f-staatliches', weights: [400], styles: ['normal'], subsets: ['latin'], fallbacks: ['sans-serif'] },
    { provider: google, name: 'Geist', cssVariable: '--f-geist', weights: ['400 700'], styles: ['normal'], subsets: ['latin'], fallbacks: ['system-ui', 'sans-serif'] },
  ],

  // Solo servidor y secretas: ninguna PUBLIC_*. SUPABASE_ANON_KEY no se valida en el build
  // (validateSecrets=false): solo en tiempo de ejecución de las rutas que la importan (T-126).
  env: {
    schema: {
      API_BASE_URL: envField.string({ context: 'server', access: 'secret', default: 'http://127.0.0.1:8000' }),
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret', default: 'http://127.0.0.1:54321' }),
      // shortcut: opcional hasta T-126 (sesión SSR), que la vuelve obligatoria y review-up.sh genera frontend/.env
      SUPABASE_ANON_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
