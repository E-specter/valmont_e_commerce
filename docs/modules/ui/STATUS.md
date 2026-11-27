# ui — Estado
> Fase: 4 (pista de frontend) · Estado: PLANIFICADO (T-116…T-131 con paquete; T-132…T-139 libres) · Última actualización: 2026-11-26 frontend-lead (T-116, plan)
> Fuentes: `docs/design_ui/BRIEF.md` y `VIEWS.md` (§2–§11), D-012, D-014, D-024, D-025, D-041. Figma: **no se ha consultado nada nuevo** en este plan; cada paquete cita los nodos que frontend-dev puede consultar **una vez** (D-031).

## 1. Plan

Rango reservado del módulo: **T-116–T-139**. En uso: T-116–T-131. Libres: **T-132–T-139** (correcciones `fix`, lote 2 de `ui/`, islas de carrito, deseos y pedidos, `ChatWidget`).

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-130 | Infraestructura de pruebas del frontend (Vitest, Playwright) | qa-reviewer | **aprobación del usuario de las dependencias (pregunta 9 del traspaso)** | BLOCKED (decisión del usuario) |
| T-116 | Tokens, fuentes, `global.css`, `BaseLayout`, `StoreLayout`, `AuthLayout` y variables de entorno | frontend-dev + qa-reviewer | D-012 | READY |
| T-117 | `ui/` lote 1A: `Icon`, `Wordmark`, `Checkerboard`, `Button`, `IconButton`, `TextLink`, `Field`, `Checkbox` | frontend-dev + qa-reviewer | T-116 | BACKLOG (READY al integrar T-116) |
| T-118 | `ui/` lote 1B: `Card`, `Badge`, `Chip`, `Price`, `Availability`, `Notice`, `EmptyState`, `Skeleton` y `lib/format.ts` | frontend-dev + qa-reviewer | T-116 (`Icon` de T-117 solo al integrar) | BACKLOG (READY al integrar T-116) |
| T-119 | `SiteHeader`, `SiteFooter`, `PageTitle`, `lib/site.ts` y cableado de los layouts | frontend-dev + qa-reviewer | T-117, T-118, D-041 (P-1) | BACKLOG |
| T-120 | Cliente de API del servidor (`lib/api/http.ts`, `server.ts`, `catalog.ts`) | frontend-dev + qa-reviewer | T-116 (esquema de variables) | BACKLOG (READY al integrar T-116) |
| T-121 | Portada `/` (SSR con caché corta) | frontend-dev + qa-reviewer | T-118, T-119, T-120, D-041 (P-2) | BACKLOG |
| T-122 | "Nosotros" `/nosotros` y páginas legales `/privacidad`, `/terminos` | frontend-dev + qa-reviewer | T-119, T-123 (`DefinitionList`), D-041 (P-9) | BACKLOG |
| T-123 | `Breadcrumb`, `Pagination`, `DefinitionList`, `ProductCard` (4 variantes) y `ProductGrid` | frontend-dev + qa-reviewer | T-117, T-118, T-120 (tipos) | BACKLOG |
| T-124 | Catálogo `/relojes`: filtros por URL, chips, paginación y estados | frontend-dev + qa-reviewer | T-119, T-120, T-123, D-041 (P-2, P-3) | BACKLOG |
| T-125 | Ficha `/relojes/[slug]`, galería, `BuyBox` y página 404 | frontend-dev + qa-reviewer | T-119, T-120, T-123 | BACKLOG |
| T-126 | Sesión SSR: `@supabase/ssr`, middleware, guardia de rutas, `/auth/callback`, `/salir` y proxy `/bff/*` | frontend-dev + qa-reviewer (revisión de seguridad a fondo) | T-120; **aprobación de `@supabase/ssr` y `@supabase/supabase-js`**; D-025, D-041 (P-5); aviso de config de Supabase (§6) | BLOCKED (decisión del usuario) |
| T-127 | Ingreso `/ingresar` (`AuthSplit`, `WatchmakerArtwork`, `AuthForm`) | frontend-dev + qa-reviewer | T-117, T-118, T-119, T-126 | BACKLOG |
| T-128 | Registro `/registro` (alta, consentimiento, estado "revisa tu correo") | frontend-dev + qa-reviewer | T-127 | BACKLOG |
| T-129 | Cuenta `/cuenta`: perfil y cierre de sesión | frontend-dev + qa-reviewer | T-119, T-126 | BACKLOG |
| T-131 | Fecha de nacimiento en el registro (+18) | frontend-dev + qa-reviewer | T-113 (identity, sin hacer), T-128 | BLOCKED (T-113) |

### Orden y paralelismo (rutas disjuntas)

```
Ola 0   T-130 (QA, bloquea la ejecución de pruebas de todas las demás)
Ola 1   T-116
Ola 2   T-117 ∥ T-118 ∥ T-120          (T-118 importa Icon: se integra después de T-117)
Ola 3   T-119 ∥ T-123 ∥ T-126
Ola 4   T-121 ∥ T-122 ∥ T-124 ∥ T-125 ∥ T-127 ∥ T-129
Ola 5   T-128 → T-131
```

- Cada **∥** comparte cero archivos de producción con sus pares (ver "Puede modificar" de cada paquete). Los únicos archivos compartidos y su dueño: `astro.config.mjs`, `src/env.d.ts` (base) y `src/layouts/*` → T-116, retocados en serie por T-119 (layouts) y T-126 (`env.d.ts`, `Locals`); `frontend/package.json` → T-130 (test) y T-126 (`@supabase/*`), nunca a la vez.
- Páginas de muestrario para la revisión visual: `src/pages/dev/<grupo>.astro` (una por paquete: `tokens`, `ui-a`, `ui-b`, `layout`), con `export const prerender = false` y respuesta 404 si no es `import.meta.env.DEV`. No existen en producción.
- Tamaño: cada paquete es de **un día** de un desarrollador como máximo; si un paquete excede, frontend-dev lo devuelve con `BLOCKED` antes de ampliar el alcance.
- Lo que **no** cubre este plan (VIEWS §11, puntos 7–10): lote 2 de `ui/` (`QuantityStepper`, `Stepper`, `Timeline`), `WishlistToggle`, `AddToCart`, `ChatWidget` y el backoffice. Los desbloquean T-060, T-069, T-081…T-084 (ver el traspaso, punto 9 y "Ajustes propuestos").

## 2. Reglas transversales (RT) — aplican a todos los paquetes

- **RT-1 Estilos (D-012):** solo variables de `tokens.css`; cero `#`, `px` de tipografía o `font-family` sueltos (`grep` de revisión). El `<style>` de cada componente va envuelto en `@layer components { … }`. Responsive por *container queries* en componentes y por `@media (min-width: 800px)` / `(min-width: 1280px)` (literales: las variables no valen en `@media`) en layouts; diseño desde 360 px.
- **RT-2 Componentes:** Astro sin estado; datos solo por props tipadas (`interface Props`), sin `fetch`. Atributos HTML restantes con `...rest`. Reutilizar antes de crear (revisar `src/components/**` y la matriz de `VIEWS.md` §6).
- **RT-3 Estados de vista:** en páginas SSR, **cargando** lo cubre el HTML en streaming de Astro (sin esqueleto); se implementan error (con reintento), vacío, éxito y, si aplica, 404. Los esqueletos son para islas y para botones `loading`. (Concreta `VIEWS.md` §2: Figma no dibuja ninguno.)
- **RT-4 Accesibilidad (WCAG 2.2 AA):** un `h1`; landmarks (`header`, `nav` con `aria-label`, `main#contenido`, `footer`); `lang="es"`; foco visible de 2 px con separación de 2; objetivo táctil ≥ 44 × 44; contraste ≥ 4,5:1 (pares de BRIEF §11; el amarillo y la menta **nunca** como texto sobre marfil; texto de error con `--color-red-strong`); estado nunca solo con color; `prefers-reduced-motion`; mayúsculas por CSS; `alt` siempre del contrato.
- **RT-5 Seguridad:** sin `set:html` con datos del servidor; el token no entra en el HTML ni en props de islas; sin PII ni respuestas de la API en `console`; la interfaz oculta controles pero la autorización es del backend (RF13.02); importes y estados **siempre** los del servidor (RN-09).
- **RT-6 Imágenes:** `<img>` con `width`/`height`, `decoding="async"`, `loading="lazy"` salvo la de LCP; URL y `alt` del contrato. Fotografía de marca (portada, nosotros, auth): `download_assets` de los nodos citados a `frontend/src/assets/**`; si un nodo trae relleno ajeno a la relojería (BRIEF §9), bloque de color del token y se anota.
- **RT-7 Formatos:** todo importe y fecha pasa por `lib/format.ts` (P-3, D-037); nada de `toFixed` ni `toLocaleString` sueltos.
- **RT-8 Figma:** solo los nodos citados, cada uno una vez (`get_design_context` con la skill `figma:figma-design-to-code`; `get_screenshot` para la revisión); la salida (React + Tailwind) se traduce a tokens, no se copia. Lo aprendido va al traspaso. Skills `modern-web-guidance` y `frontend-design` obligatorias.
- **RT-9 Dependencias:** ninguna nueva; si falta algo, `BLOCKED` y se escala a frontend-lead.
- **RT-10 Revisión de frontend-lead:** lista de `DESIGN.md` §9 + captura de Playwright frente a `get_screenshot` del frame (1280, y 375 donde Figma lo dibuja) + el kit o la página del paquete.
- **RT-11 Entrega:** `git add <rutas exactas>` sin commit; mensaje propuesto con el formato `<tipo>(<ámbito>): <resumen> (T-NNN)`. frontend-dev solo pasa `npm run check` (no cuenta como evidencia); las pruebas las escribe y ejecuta qa-reviewer (D-033).
- **RT-12 Pruebas de QA (D-033):** componentes `.astro` con la Container API de Astro en entorno `node` (Astro 6+ no las renderiza en `happy-dom`); islas y scripts de cliente con `happy-dom`; `lib/**` unitarias con `fetch` simulado; E2E y accesibilidad (axe) con Playwright sobre el stack de `scripts/review-up.sh`. Rutas de QA: `frontend/tests/**` y `frontend/e2e/**`. Puertas: `npm run check`, `npm run build`, `npm test`, `npm run test:e2e` (los dos últimos existen cuando T-130 se apruebe y se implemente).

## 3. Contratos transversales del plan (los cierra frontend-lead; los consumen varios paquetes)

**3.1 Transporte (T-120).** Único punto con `fetch` a la API; módulos `lib/api/<módulo>.ts` reciben el transporte como primer argumento, de modo que sirven en el servidor (SSR) y en el navegador (islas) sin duplicarse.

```ts
// lib/api/http.ts
export type Money = { amount: number; currency: 'PEN' };               // céntimos enteros (D-015)
export type Page<T> = { items: T[]; total: number; page: number; page_size: number };
export class ApiError extends Error {
  status: number;      // HTTP; 0 si no hubo respuesta
  code: string;        // del cuerpo {"error":{"code"}} o 'network' | 'timeout' | 'invalid_response'
  details: unknown;    // error.details o null
}
export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;
export type Transport = <T>(req: {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;                       // relativo a /api/v1, p. ej. '/catalog/products'
  query?: Query; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal;
}) => Promise<T>;
export function toQueryString(q: Query): string;   // omite undefined, null y ''; arrays → clave repetida; orden estable (alfabético)
// lib/api/server.ts
export function serverTransport(opts?: { accessToken?: string | null }): Transport; // base API_BASE_URL + '/api/v1'; Bearer si hay token; tiempo máximo 8 s; 204 → undefined
```

**3.2 Sesión (T-126).** El token vive solo en cookies `httpOnly` de `@supabase/ssr` y en `Astro.locals` del servidor.

```ts
// src/env.d.ts
type Session = { userId: string; email: string | null; accessToken: string; expiresAt: number /* epoch s */ };
declare namespace App { interface Locals { session: Session | null; supabase: import('@supabase/supabase-js').SupabaseClient } }
// lib/server/guard.ts
export const PROTECTED_PREFIXES: readonly string[];           // ['/cuenta', '/carrito', '/checkout']
export function isProtectedPath(pathname: string): boolean;   // prefijo exacto por segmento: '/cuenta/x' sí, '/cuentas' no
export function safeNext(raw: string | null | undefined, fallback?: string): string; // solo rutas internas ('/x', no '//x', no '/\x', sin esquema); si no, fallback ('/')
export function loginUrl(url: URL): string;                   // '/ingresar?next=' + encodeURIComponent(pathname + search)
// lib/server/session.ts
export function apiFor(locals: App.Locals): Transport;        // serverTransport({ accessToken: locals.session?.accessToken })
```

Reglas: el middleware no toca rutas prerenderizadas (`context.isPrerendered`); en rutas protegidas sin sesión responde 302 a `loginUrl`; cabecera `Cache-Control: private, no-store` en esas rutas. Variables de entorno **solo de servidor** (`astro:env/server`, `access: 'secret'`): `API_BASE_URL` (por defecto `http://127.0.0.1:8000`), `SUPABASE_URL` (por defecto `http://127.0.0.1:54321`), `SUPABASE_ANON_KEY` (obligatoria; la clave anónima o publicable del proyecto). Ninguna `PUBLIC_*`.

**3.3 Proxy para islas (T-126).** Las islas no pueden leer la cookie `httpOnly`, así que llaman a `/bff/*` (mismo origen) y el servidor de Astro añade el Bearer. **No se usa `/api/*`**: en producción el Caddy (`deploy/Caddyfile`) lo enruta directo al backend, sin sesión.

| Aspecto | Contrato |
|---|---|
| Ruta | `src/pages/bff/[...path].ts` (todos los métodos), `prerender = false` |
| Lista permitida | `^(cart\|wishlist\|orders)(/[^/]+)*$` sin `orders/admin`; todo lo demás → 404 `not_found` |
| Sin sesión | 401 `{"error":{"code":"unauthenticated","message":"…","details":null}}` (formato común) |
| Origen | en métodos distintos de GET, `Origin` debe ser igual a `url.origin`; si no, 403 `forbidden` |
| Entrada | reenvía método, query, cuerpo JSON (solo `content-type: application/json`, máx. 16 KiB → 413) y la cabecera `Idempotency-Key`; descarta el resto de cabeceras del cliente |
| Salida | mismo estado y mismo cuerpo que el backend; sin `Set-Cookie`; `Cache-Control: no-store`; tiempo máximo 10 s → 504 `{"error":{"code":"timeout"}}` |
| Cliente | `lib/api/browser.ts`: `export const browserTransport: Transport` (`fetch('/bff' + path)`, `credentials: 'same-origin'`; lanza `ApiError`) |

**3.4 Formato (T-118).**

```ts
// lib/format.ts
export function formatMoney(m: Money): string;
// es-PE, PEN; 0 decimales si amount % 100 === 0, 2 si no (P-3). {amount: 8450000} → "S/ 84,500"; {amount: 1062550} → "S/ 10,625.50"; {amount: 5} → "S/ 0.05".
// El espacio entre "S/" y la cifra es el que emite Intl (U+00A0): QA compara contra Intl, no contra un literal con espacio normal.
export function formatDate(iso: string, style?: 'date' | 'datetime'): string;   // UTC → America/Lima, es-PE: "15 de agosto de 2026" (date) | "15 de agosto de 2026, 3:04 p. m." (datetime)
export function formatDateOnly(isoDate: string): string;                        // 'YYYY-MM-DD' (estimated_delivery_on) → "10 de diciembre de 2026", sin desplazamiento de zona
```

## 4. Paquetes de tarea

### T-116 — Tokens, fuentes, estilos globales, layouts y entorno
- Objetivo: el sitio tiene sus tokens de diseño, sus cuatro familias tipográficas alojadas en el propio sitio, la cascada ordenada con `@layer` y los tres layouts base, de modo que cualquier página posterior solo compone componentes.
- Responsable: frontend-dev (pruebas: qa-reviewer; acepta frontend-lead) · Módulo: ui · Requisitos: RNF03, RNF04, RNF07, RNF01
- Leer: `docs/design_ui/BRIEF.md` §2–§6, §11, §13 (los valores **ya están allí**: no se vuelve a pedir `get_variable_defs`); `VIEWS.md` §2; D-012; Astro: guía "Using custom fonts" y "Using environment variables" (MCP `astro-docs`).
- Contratos aplicables: ninguno (sin API).
- Dependencias: D-012.
- Puede modificar: `frontend/astro.config.mjs` (solo `fonts` y `env.schema`), `frontend/src/styles/tokens.css`, `frontend/src/styles/global.css`, `frontend/src/layouts/{BaseLayout,StoreLayout,AuthLayout}.astro`, `frontend/src/env.d.ts` (tipos del esquema), `frontend/.env.example` (nombres sin valores), `frontend/public/brand/symbol.svg` y `frontend/public/favicon.svg`, `frontend/src/pages/dev/tokens.astro`.
- Protegido: `frontend/package.json` y `package-lock.json`, `backend/**`, `deploy/**`, `src/pages/index.astro` (lo sustituye T-121).
- Resultado esperado:
  - `tokens.css`: todo `BRIEF.md` §13 más los roles de §2 (`--bg-page`, `--bg-inverse`, `--bg-surface`, `--bg-surface-dark`, `--stroke-default|soft|strong|control|on-dark`, `--text-primary|secondary|on-dark|accent`, `--state-active|success|error|cancelled`), `--color-red-strong` (PROPUESTA de §11), `--stroke-control: rgb(0 35 18 / .6)`, `--shadow-overlay`, `--focus-ring`, movimiento (§5) y `--page-margin` (30 px editorial / 60 px transaccional, con `clamp` hacia 16 px en 360).
  - Escala tipográfica de §3 como `--text-display|h1|h2|h3|body-editorial|body-ui|caption` (tamaño con `clamp()` entre Mobile y Desktop) más `--leading-*`.
  - Fuentes con la API de fuentes de Astro (`fonts` en `astro.config.mjs`, proveedor Google, sin dependencia npm; Astro descarga en el build y sirve desde el propio sitio): Jaro 400, Phudu `"600 700"`, Staatliches 400 y Geist `"400 700"`, subconjunto `latin`, `cssVariable` `--f-jaro|--f-phudu|--f-staatliches|--f-geist`, `fallbacks` con familia genérica; `tokens.css` mapea `--font-brand|heading|editorial|ui` a esas variables. Precarga solo de Phudu y Geist.
  - `global.css`: `@layer reset, tokens, base, components, utilities;`, reset mínimo, `box-sizing`, tipografía base (Geist 16/24), `:focus-visible` con `--focus-ring`, `.sr-only`, `[hidden]`, `@media (prefers-reduced-motion: reduce)`, enlace "Saltar al contenido".
  - `BaseLayout` (`lang="es"`, `charset`, `viewport`, `title`/`description`, `<Font>` de las cuatro familias, `global.css`, favicon, `noindex` opcional); `StoreLayout` y `AuthLayout` como carcasas (`<main id="contenido" tabindex="-1">` y, en auth, el reparto 50/50 con fondo `--bg-inverse`); T-119 les añade cabecera y pie.
  - Esquema `env` (3.2) y `frontend/.env.example` con los tres nombres y **sin valores**.
  - `symbol.svg` descargado con `download_assets` del símbolo (`125:13047` / `1:120`).
  - `/dev/tokens`: muestra paleta con su par de contraste, escala tipográfica con una frase con `ñ ¿ ¡ á é í ó ú ü` en cada familia, espaciado, radios y foco.
- Criterios de aceptación:
  - [ ] Los 14 colores y los roles de BRIEF §2 existen con sus hex; `grep -rnE "#[0-9A-Fa-f]{3,8}\b" frontend/src --include=*.astro --include=*.css` solo da `tokens.css`.
  - [ ] Las cuatro familias cargan desde el propio origen (sin peticiones a `fonts.googleapis.com` ni `fonts.gstatic.com` en producción) y `ñ ¿ ¡ á é í ó ú ü` se ven en cada una; si Staatliches no trae `¿ ¡`, se anota en el traspaso.
  - [ ] Cada layout produce `lang="es"`, un solo `main#contenido`, y el enlace "Saltar al contenido" lleva a él.
  - [ ] `--color-red-strong` y `--stroke-control` cumplen BRIEF §11 (≥ 4,5:1 y ≥ 3:1).
  - [ ] Sin `PUBLIC_*`; `npm run build` no exige variables de entorno (valores por defecto; `SUPABASE_ANON_KEY` solo se valida en tiempo de ejecución de las rutas que la usan, T-126).
- Firmas públicas:
  - Variables CSS: nombres de BRIEF §13 y los de "Resultado esperado".
  - `BaseLayout` Props: `{ title: string; description?: string; noindex?: boolean }`; slots `default` y `head`.
  - `StoreLayout` Props: `{ title: string; description?: string; noindex?: boolean; headerVariant?: 'full' | 'compact' }`; slot `default`.
  - `AuthLayout` Props: `{ title: string; description?: string; variant: 'login' | 'register' }`; slots `default` (formulario) y `art` (arte).
  - Módulos: `astro:env/server` exporta `API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- Pruebas obligatorias (qa-reviewer; T-130): componente de cada layout (Container API: `lang`, `main#contenido`, skip link, `<title>`, `noindex`); unitaria de `tokens.css` (cada variable de BRIEF §13 y §2 declarada; cálculo de contraste de los pares críticos ≥ umbral); búsqueda de valores sueltos (regla de RT-1) como prueba; `npm run check`; `npm run build`; E2E ligero: `/dev/tokens` sin errores de consola y sin peticiones externas de fuentes.
- Diseño (frontend): BRIEF §2–§6 y §13; nodos `125:13186`, `125:13232` (color), `125:13387` (escala), `125:13604` (espaciado), `125:13535` · `125:13554` · `125:13569` (retícula), `125:13581` (contenedor) **solo para verificar un valor dudoso**, y `125:13047` para `download_assets`. Filas de VIEWS: §2 (layouts).
- Revisión manual (el usuario, en `main`): http://localhost:4321/dev/tokens — ver paleta, tipos (con tildes y `¿ ¡`), foco al tabular y el comportamiento a 360 px.
- Seguridad: ninguna clave en el repo; `.env.example` sin valores; las fuentes no abren conexiones a terceros desde el navegador.
- Estado inicial: READY
- Entrega: RT-11; mensaje propuesto `feat(frontend): tokens, fuentes y layouts base (T-116)`.
- IDs reservados: ninguno.
- Escalar si: la API de fuentes de Astro no encuentra una familia en el proveedor Google (proponer archivos `woff2` locales con licencia OFL), o `get_variable_defs` contradice BRIEF §2.

### T-117 — `ui/` lote 1A: marca, acciones y campos
- Objetivo: existen los componentes genéricos de marca, acción y entrada de formulario con todos sus estados.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RNF07, RNF04
- Leer: `BRIEF.md` §1, §7 (Button, IconButton, Input, Checkbox), §8, §11, §12.1–3; `VIEWS.md` §5–§6; RT-1…RT-5.
- Contratos aplicables: ninguno.
- Dependencias: T-116.
- Puede modificar: `frontend/src/components/ui/{Icon,Wordmark,Checkerboard,Button,IconButton,TextLink,Field,Checkbox}.astro`, `frontend/src/components/ui/icons.ts`, `frontend/src/pages/dev/ui-a.astro`.
- Protegido: todo lo demás (en especial `ui/` de T-118, `layouts/`, `lib/`).
- Resultado esperado: los 8 componentes. `Icon`: SVG propios en el estilo del brief (trazo 1,5–2, terminal redondo), sin dependencia. `Button` una sola geometría en píldora con altura fija (BRIEF §12.1), no las del Figma. `Field` con borde `--stroke-control` y fondo (§12.3). Contraste del botón `mint`: ink sobre menta (§12.2).
- Criterios de aceptación:
  - [ ] Cada interactivo tiene reposo, hover, `focus-visible`, activo, deshabilitado y (Button) cargando; el objetivo táctil es ≥ 44 × 44 aunque el dibujo sea de 32.
  - [ ] `Button` con `href` renderiza `<a>`; sin `href`, `<button>` (`type` por defecto `button`); `loading` pone `aria-busy="true"`, impide el doble clic y anuncia "Cargando" a lectores de pantalla.
  - [ ] `IconButton` exige `label` (nombre accesible) y refleja `pressed` con `aria-pressed`.
  - [ ] `Field` enlaza `label` con `for`/`id`; con `error`, `aria-invalid="true"` y `aria-describedby` al mensaje (texto en `--color-red-strong`, con icono, no solo color); `hint` también por `aria-describedby`.
  - [ ] `Icon` sin `label` es `aria-hidden`; con `label`, `role="img"` y `aria-label`.
  - [ ] Wordmark: texto "Valmont" con mayúsculas por CSS; no se deforma ni cambia de color fuera de `ink`/`ivory`. `Checkerboard` es decorativo (`aria-hidden`), sin elementos por módulo (gradiente cónico repetido), y toca el borde del contenedor.
  - [ ] Ningún valor suelto (RT-1).
- Firmas públicas (contra las que QA escribe sus pruebas):
  - `icons.ts`: `export type IconName = 'search'|'heart'|'heart-off'|'shopping-bag'|'message-circle'|'user'|'x'|'send'|'check'|'check-circle'|'x-circle'|'alert-triangle'|'info'|'lock'|'mail'|'eye'|'eye-off'|'clock'|'calendar'|'credit-card'|'chevron-down'|'arrow-right'|'arrow-left'|'grid'|'list'|'menu'|'plus'|'minus'`.
  - `Icon` Props: `{ name: IconName; size?: 16 | 20 | 24 | 32 /* 20 */; label?: string }`.
  - `Wordmark` Props: `{ tone?: 'ink' | 'ivory' /* ink */; href?: string }` (con `href`, es un enlace a `/` con nombre accesible "Valmont, inicio").
  - `Checkerboard` Props: `{ palette?: 'storefront' | 'auth' /* storefront: ink/ivory; auth: forest/mint */; cell?: 16 | 24 | 32 /* 24 */; rows?: 1 | 2 /* 1 */ }`.
  - `Button` Props: `{ variant?: 'primary'|'dark'|'secondary'|'mint' /* primary */; size?: 'md'|'lg' /* md */; href?: string; type?: 'button'|'submit'|'reset'; loading?: boolean; disabled?: boolean; fullWidth?: boolean; iconRight?: IconName } & HTMLAttributes`; slot `default`.
  - `IconButton` Props: `{ icon: IconName; label: string; variant?: 'plain'|'outline' /* outline */; size?: 32|44|56 /* 44 */; pressed?: boolean; href?: string; type?: 'button'|'submit'; disabled?: boolean }`.
  - `TextLink` Props: `{ href: string; arrow?: boolean; tone?: 'ink'|'ivory'|'forest' /* ink */; external?: boolean /* añade rel="noopener noreferrer" y target="_blank" */ }`.
  - `Field` Props: `{ id: string; name: string; label: string; type?: 'text'|'email'|'password'|'tel'|'date'|'search'|'number' /* text */; value?: string; placeholder?: string; autocomplete?: string; inputmode?: string; required?: boolean; disabled?: boolean; readonly?: boolean; error?: string; hint?: string; iconLeft?: IconName; minlength?: number; maxlength?: number; min?: number; max?: number; pattern?: string }`; slot `action` (botón a la derecha, p. ej. el ojo).
  - `Checkbox` Props: `{ id: string; name: string; label?: string; value?: string /* 'on' */; checked?: boolean; required?: boolean; disabled?: boolean; error?: string }`; slot `default` (etiqueta con enlaces; sustituye a `label`).
- Pruebas obligatorias: por criterio, con la Container API (HTML esperado de cada variante y atributo ARIA), contraste de los pares usados (cálculo), `/dev/ui-a` con axe sin violaciones y navegación por teclado (Tab/Espacio/Enter) en E2E; `npm run check`; `npm run build`.
- Diseño (frontend): nodos de BRIEF §7: Button `125:13758`, `55:412`, `43:355` (geometría **no** se copia, §12.1); Input `125:13781`, `32:634`, `43:413`; Checkbox/Toggle `32:648`; Wordmark `125:13037`; Damero `125:13065`; iconos `125:14171`; Link `125:13750`. Matriz VIEWS §6: filas Button, IconButton, TextLink, Field, Checkbox, Checkerboard, Wordmark, Icon.
- Revisión manual (el usuario): http://localhost:4321/dev/ui-a — todos los estados (el kit fuerza hover/foco con clases solo en `/dev`), tabulación y lectura con zoom 200 %.
- Seguridad: `external` añade `rel` seguro; sin `set:html`.
- Estado inicial: BACKLOG (READY al integrar T-116)
- Entrega: RT-11; `feat(frontend): componentes ui de marca, acciones y campos (T-117)`.
- IDs reservados: ninguno.
- Escalar si: un estado exige un token que no existe o el contraste del brief no alcanza para un par.

### T-118 — `ui/` lote 1B: superficies, estado y avisos, y formato
- Objetivo: existen la tarjeta, las etiquetas, el precio, la disponibilidad y los avisos de interfaz, más el formateo de importes y fechas en `es-PE`.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.08, RF09.02, RNF07 · D-015, D-037, D-041 (P-3)
- Leer: `BRIEF.md` §7 (Card, Badge, Chip, Precio, Disponibilidad), §10, §11; `VIEWS.md` §4.5 (tarjeta), §9 (H-14, H-26), §10 (P-3); catalog SPEC §7 (`Availability`, `Money`); RT-1…RT-7.
- Contratos aplicables: `Money` (D-015) y `Availability` de catalog §7; el precio con promoción de promotions §7 (`original_price`, `discount_amount`, ambos `null` sin descuento).
- Dependencias: T-116. `Notice`/`EmptyState` importan `Icon` (T-117): se pueden escribir en paralelo con la firma cerrada, pero se integran después de T-117.
- Puede modificar: `frontend/src/components/ui/{Card,Badge,Chip,Price,Availability,Notice,EmptyState,Skeleton}.astro`, `frontend/src/components/ui/availability.ts`, `frontend/src/lib/format.ts`, `frontend/src/pages/dev/ui-b.astro`.
- Protegido: lo no listado; en especial `ui/` de T-117 y `lib/api/**`.
- Resultado esperado: los 8 componentes y `lib/format.ts`. Sombras ninguna (superficies planas con borde, BRIEF §4). El precio usa `font-variant-numeric: tabular-nums`.
- Criterios de aceptación:
  - [ ] `formatMoney`: `{amount: 8450000}` → `S/ 84,500`; `{amount: 1062550}` → `S/ 10,625.50`; `{amount: 5}` → `S/ 0.05`; nunca calcula (solo formatea).
  - [ ] `Price` con `originalPrice` y `discountAmount` no nulos pinta el vigente, el original tachado en `<del>` con texto oculto "Precio original" y "Ahorras S/ X" visible; con ambos `null`, solo el vigente.
  - [ ] `Availability` cubre los 4 estados con **texto + punto** (no solo color): `in_stock` "En stock", `low_stock` "Quedan pocas unidades", `out_of_stock` "Agotado", `on_request` "Bajo pedido, entrega estimada en N días" (N = `lead_time_days`; si es `null`, "Bajo pedido"). Nunca muestra cantidades.
  - [ ] `Notice`: `error` usa `role="alert"`, el resto `role="status"`; incluye icono y texto, no solo color; slot `actions`.
  - [ ] `EmptyState` con encabezado del nivel pedido y slot `action`; `Skeleton` es `aria-hidden` y se detiene con `prefers-reduced-motion`.
  - [ ] `Chip` como enlace (`a`) marca `aria-current="true"` si está activo; `as="span"` + `aria-disabled="true"` es no interactivo (D-041 P-2); la variante removible tiene un enlace "Quitar filtro {label}".
  - [ ] `Badge` de producto y de estado según BRIEF §7 (colores de los 4 estados de pedido: amarillo, forest + blanco, outline, ciruela + blanco).
  - [ ] Sin valores sueltos.
- Firmas públicas:
  - `Card` Props: `{ as?: 'div'|'article'|'section'|'li' /* div */; tone?: 'surface'|'ink'|'forest' /* surface */; padding?: 'sm'|'md'|'lg' /* md */; outline?: 'strong'|'soft' /* strong */ }`; slot `default`.
  - `Badge` Props: `{ kind?: 'status'|'product'|'count' /* status */; tone?: 'yellow'|'forest'|'outline'|'plum'|'mint'|'red' /* outline */ }`; slot `default`.
  - `Chip` Props: `{ label: string; as?: 'a'|'button'|'span' /* a */; href?: string; active?: boolean; tone?: 'forest'|'outline'|'yellow'|'mint'|'red' /* outline */; removeHref?: string }`.
  - `Price` Props: `{ price: Money; originalPrice?: Money | null; discountAmount?: Money | null; size?: 'sm'|'md'|'lg' /* md */; align?: 'start'|'end' /* start */ }`.
  - `Availability` Props: `{ availability: { status: 'in_stock'|'low_stock'|'out_of_stock'|'on_request'; lead_time_days: number | null }; showLabel?: boolean /* true */ }`; `availability.ts` exporta `availabilityLabel(a): string`.
  - `Notice` Props: `{ tone?: 'info'|'success'|'error'|'warning' /* info */; title?: string }`; slots `default`, `actions`.
  - `EmptyState` Props: `{ title: string; description?: string; icon?: IconName; headingLevel?: 2|3|4 /* 2 */ }`; slot `action`.
  - `Skeleton` Props: `{ variant?: 'line'|'block'|'card' /* line */; lines?: number /* 1 */; width?: string; height?: string }`.
  - `lib/format.ts`: `formatMoney`, `formatDate`, `formatDateOnly` (3.4).
- Pruebas obligatorias: unitarias de `format.ts` (tabla de importes enteros y con fracción, miles, cero, importes grandes; fechas en el borde de día UTC/Lima: `2026-08-16T03:00:00Z` es 15 de agosto en Lima; `estimated_delivery_on` sin desplazamiento); Container API de cada componente y variante (roles ARIA, texto de los 4 estados, `<del>`); `/dev/ui-b` con axe; `npm run check`; `npm run build`.
- Diseño (frontend): Card `51:395`; badges `54:380`, `54:397`, `54:413`, `54:429` y de producto `51:398`; Chip `125:13798`, `54:357`; Precio `51:395`, `55:397`; Disponibilidad `55:400`. Notice, EmptyState y Skeleton **no están en Figma** (BRIEF §12): se diseñan desde tokens. VIEWS §6: filas Card, Badge, Chip, Price, Availability, Notice, EmptyState, Skeleton.
- Revisión manual (el usuario): http://localhost:4321/dev/ui-b — precios con y sin promoción, los cuatro estados de disponibilidad, avisos y vacío.
- Seguridad: los avisos escriben texto (no HTML) venido del servidor.
- Estado inicial: BACKLOG (READY al integrar T-116)
- Entrega: RT-11; `feat(frontend): componentes ui de superficie, precio y avisos y formato es-PE (T-118)`.
- IDs reservados: ninguno.
- Escalar si: `Intl` de Node no emite `S/` con `es-PE` (ICU recortado): se propone empaquetar los datos de `Intl` o formatear a mano con las mismas reglas.

### T-119 — Cabecera, pie y título de página
- Objetivo: todas las páginas comparten una cabecera con carrito, cuenta, lista de deseos y búsqueda (P-1), un pie con datos de contacto únicos y el título de página.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.02, RF03.01, RF10.01, RNF04, RNF07 · D-041 (P-1)
- Leer: `BRIEF.md` §1 (lockup, damero), §6, §8, §12.8; `VIEWS.md` §3, §4.5 (título), §9 (H-22, H-23), §10 (P-1); los componentes de T-117 y T-118.
- Contratos aplicables: ninguno (los contadores de carrito y deseos **no** van en esta versión: G-7).
- Dependencias: T-117, T-118.
- Puede modificar: `frontend/src/components/layout/{SiteHeader,SiteFooter,PageTitle}.astro`, `frontend/src/lib/site.ts`, `frontend/src/layouts/{StoreLayout,AuthLayout}.astro` (solo para insertar cabecera y pie), `frontend/src/pages/dev/layout.astro`.
- Protegido: `ui/**`, `BaseLayout`, `astro.config.mjs`, `lib/api/**`.
- Resultado esperado:
  - `SiteHeader` `full`: `Wordmark` con símbolo y descriptor, `<nav aria-label="Principal">` con **Relojes** `/relojes`, **Nosotros** `/nosotros`, **Contacto** `/nosotros#contacto` (enlaces fijos, P-1); formulario de búsqueda (`<form role="search" method="get" action="/relojes">` con `q`, ≤ 100); accesos con `IconButton` a `/cuenta/lista-de-deseos` ("Lista de deseos"), `/carrito` ("Carrito") y `/cuenta` ("Mi cuenta"); damero `storefront` al pie. `compact`: wordmark + Nosotros y Contacto, sin accesos ni damero.
  - Menú móvil sin framework: botón con `popovertarget` y `popover` (`<nav>` dentro), cierra con `Esc` y al elegir; la búsqueda se pliega dentro. Sin JavaScript propio si el navegador lo soporta; si hace falta, un `<script>` < 30 líneas.
  - `SiteFooter`: enlaces (Relojes, Nosotros, Contacto, Privacidad `/privacidad`, Términos `/terminos`), teléfono y correo de `lib/site.ts`, wordmark gigante decorativo, "© 2026 Valmont. Todos los derechos reservados.", damero.
  - `lib/site.ts`: `SITE` (nombre, descriptor, teléfono `+51 (1) 625-4500`, correo `contacto@valmont.pe`, Instagram `@valmontperu`) y `PRIVACY_VERSION = '2026-10'`. Fuente única del contacto (H-22).
  - `PageTitle` y cableado en `StoreLayout` (cabecera `full` salvo `headerVariant="compact"`) y `AuthLayout` (cabecera `compact`).
- Criterios de aceptación:
  - [ ] Existe un único `h1` por página (lo pone `PageTitle`, no la cabecera); `aria-current="page"` en el enlace de la ruta actual.
  - [ ] Los tres accesos tienen nombre accesible y objetivo ≥ 44 × 44; el enlace de cuenta apunta **siempre** a `/cuenta` (el servidor decide: redirige a `/ingresar` sin sesión; así sirve también en páginas estáticas).
  - [ ] La cabecera no pinta datos por usuario (invariante: las páginas públicas pueden llevar `Cache-Control: public`; si se añaden contadores, pasan a `private`).
  - [ ] En 360 px no hay desbordamiento horizontal; el menú móvil se opera con teclado y devuelve el foco al botón al cerrar.
  - [ ] El damero ocupa el 100 % del contenedor con `overflow: clip` (BRIEF §6), no un ancho fijo.
  - [ ] Sin valores sueltos.
- Firmas públicas:
  - `SiteHeader` Props: `{ variant?: 'full' | 'compact' /* full */; currentPath?: string /* Astro.url.pathname */ }`.
  - `SiteFooter` Props: ninguno.
  - `PageTitle` Props: `{ title: string; kicker?: string; description?: string; align?: 'start' | 'center' /* start */; level?: 1 | 2 /* 1 */ }`; slot `meta`.
  - `lib/site.ts`: `export const SITE: { name: string; tagline: string; phone: string; email: string; instagram: { label: string; href: string } }; export const PRIVACY_VERSION: string`.
- Pruebas obligatorias: Container API (landmarks, enlaces y `aria-current`, búsqueda `action`/`method`/`name="q"`, variante `compact`, un solo `h1` con `PageTitle`); E2E a 1280, 800 y 360 (sin desbordamiento, menú móvil con teclado, `Esc`); axe; `npm run check`; `npm run build`.
- Diseño (frontend): `SiteHeader` `1:116` (desktop), `1:709` (tablet), `1:780` (mobile), compacto `32:577`, copias `51:671`, `56:306`, `54:602`, `42:258`, `43:578` (solo para ver variaciones, una vez); `SiteFooter` `1:235`; títulos `51:342`, `40:699`, `54:347`. Los accesos de cuenta, carrito, deseos y búsqueda **no existen en Figma** (P-1): se diseñan con los iconos del brief. Menú móvil no dibujado: se diseña con tokens. VIEWS: §3, matriz filas SiteHeader, SiteFooter, PageTitle.
- Revisión manual (el usuario): http://localhost:4321/dev/layout — cabecera y pie a tres anchos; tabular por la cabecera; abrir y cerrar el menú móvil.
- Seguridad: la búsqueda va por GET y no registra el término; los enlaces externos (Instagram) con `rel` seguro.
- Estado inicial: BACKLOG (depende de T-117 y T-118)
- Entrega: RT-11; `feat(frontend): cabecera, pie y título de página (T-119)`.
- IDs reservados: ninguno.
- Escalar si: el usuario quiere contadores en la cabecera (rompe la caché pública y exige datos por usuario en cada página).

### T-120 — Cliente de API del servidor y de catálogo
- Objetivo: existe el único punto de acceso a la API desde el servidor de Astro, con errores tipados, y las funciones y tipos de catalog que consumen portada, catálogo y ficha.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui (lib) · Requisitos: RF02.01–08, RF09.02
- Leer: `docs/modules.md` §5 y §6; catalog SPEC §7 (esquemas y parámetros); `backend/src/valmont/modules/catalog/adapters/http.py` (campos reales: `original_price`, `discount_amount` en `ProductSummaryOut`; `ProductSort`); `docs/modules/promotions/SPEC.md` §7 (precio); contratos 3.1.
- Contratos aplicables: catalog §7 (APROBADO) y el OpenAPI real.
- Dependencias: T-116 (esquema de variables de entorno).
- Puede modificar: `frontend/src/lib/api/{http,server,catalog}.ts`.
- Protegido: `lib/format.ts`, componentes, páginas, `astro.config.mjs`, `backend/**`.
- Resultado esperado: contratos 3.1 y el módulo de catálogo con tipos exactos del OpenAPI. Los tipos nulos del contrato se conservan (`movement`, `case_material`, `case_diameter_mm`, `water_resistance_m` pueden ser `null`).
- Criterios de aceptación:
  - [ ] `serverTransport` antepone `API_BASE_URL + '/api/v1'`, envía `Accept: application/json`, añade `Authorization: Bearer` solo si hay token y corta a los 8 s con `ApiError` `code: 'timeout'`.
  - [ ] Un cuerpo de error `{"error":{"code","message","details"}}` se convierte en `ApiError` con esos campos y el `status`; un fallo de red es `status: 0`, `code: 'network'`; un cuerpo no JSON o sin el formato, `code: 'invalid_response'`.
  - [ ] `toQueryString` omite `undefined`, `null` y `''`, repite las claves de los arrays y ordena de forma estable; escapa valores.
  - [ ] `getProduct` con 404 lanza `ApiError` con `status: 404`; `listProducts` con 422 lanza `ApiError` con `details`.
  - [ ] Ninguna función acepta ni envía precios, totales o ids de usuario.
- Firmas públicas:
  - `http.ts` y `server.ts`: contratos 3.1.
  - `catalog.ts`:
    ```ts
    export type Category = { slug: string; name: string; description: string | null };
    export type AttributeValue = { code: string; label: string };
    export type ProductImage = { id: string; url: string; alt: string };
    export type Availability = { status: 'in_stock'|'low_stock'|'out_of_stock'|'on_request'; lead_time_days: number | null };
    export type ProductSummary = { id: string; slug: string; sku: string; name: string;
      category: { slug: string; name: string }; price: Money; original_price: Money | null; discount_amount: Money | null;
      movement: AttributeValue | null; case_material: AttributeValue | null; case_diameter_mm: number | null;
      water_resistance_m: number | null; main_image: ProductImage; availability: Availability };
    export type ProductDetail = ProductSummary & { description: string; specs: { label: string; value: string }[]; images: ProductImage[]; related: ProductSummary[] };
    export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'relevance';
    export type ProductFilters = { q?: string; category?: string; movement?: string; case_material?: string;
      case_diameter_mm_min?: number; case_diameter_mm_max?: number; water_resistance_m_min?: number;
      price_min?: number; price_max?: number /* céntimos */; available?: boolean; sort?: ProductSort; page?: number; page_size?: number };
    export function listProducts(t: Transport, f?: ProductFilters): Promise<Page<ProductSummary>>;
    export function getProduct(t: Transport, slug: string): Promise<ProductDetail>;
    export function listCategories(t: Transport): Promise<Category[]>;
    export function getAttributes(t: Transport): Promise<{ movements: AttributeValue[]; case_materials: AttributeValue[] }>;
    ```
    `available: true` se envía como `available=true`; `false` o ausente no se envía. Verificar los nombres contra `/openapi.json` al implementar; si difieren, gana el OpenAPI y se registra.
- Pruebas obligatorias (qa-reviewer): unitarias con `fetch` simulado por ruta: URL final (con y sin filtros), cabeceras, mapeo de cada error (404, 422, 5xx, red, tiempo agotado, cuerpo no JSON), `toQueryString`; prueba de contrato contra una muestra del OpenAPI (nombres de campos); `npm run check`; `npm run build`.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario): ninguna visible; se ejerce en T-121, T-124 y T-125.
- Seguridad: no registra cuerpos ni cabeceras; no acepta URLs absolutas en `path` (solo rutas que empiezan por `/`); `Authorization` solo se añade si el llamador lo pasa.
- Estado inicial: BACKLOG (READY al integrar T-116)
- Entrega: RT-11; `feat(frontend): cliente de API del servidor y de catálogo (T-120)`.
- IDs reservados: ninguno.
- Escalar si: el OpenAPI real difiere de catalog §7 o necesita un campo que el contrato no ofrece.

### T-121 — Portada `/`
- Objetivo: la portada presenta la marca y lleva al catálogo, con los mosaicos de colección tomados de las categorías reales.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.01 · D-041 (P-2)
- Leer: `VIEWS.md` §4.1, §9 (H-06), §10 (P-2); `BRIEF.md` §9, §10; T-118 y T-119; `lib/api/catalog.ts`.
- Contratos aplicables: `GET /api/v1/catalog/categories` y `GET /api/v1/catalog/products?sort=newest&page_size=1` (catalog §7).
- Dependencias: T-118, T-119, T-120.
- Puede modificar: `frontend/src/pages/index.astro`, `frontend/src/components/home/{HeroCta,ManifestoBlock,CollectionTile,CollectionLinks,StoreBanner,FeaturedProduct}.astro`, `frontend/src/data/home.ts`, `frontend/src/assets/home/**`.
- Protegido: `ui/**`, `layout/**`, `lib/**`.
- Resultado esperado: la página (`prerender = false`, `Cache-Control: public, max-age=60`) con las secciones de `1:187`…`1:231`. Textos de marca en `data/home.ts` (en español, sin lorem ni francés). Los 3 mosaicos y los enlaces tipográficos son las primeras categorías por `position` (`/relojes?category=<slug>`); el bloque de producto protagonista usa el reloj más reciente (`sort=newest`, `page_size=1`) con `Price` y su ficha; la invitación a "boutiques" enlaza a `/nosotros#contacto`.
- Criterios de aceptación:
  - [ ] Los mosaicos enlazan a categorías existentes (no se inventan colecciones); con `categories` vacío o error de API la página sigue sirviéndose: un único enlace "Ver todos los relojes" a `/relojes`, sin `Notice` de error ni 500.
  - [ ] El bloque "Novedad" solo aparece si hay producto; muestra precio vigente con `Price`; sin imagen, bloque de color del token.
  - [ ] Un solo `h1` (el del hero); `alt` de las fotos descriptivo; la imagen de LCP sin `loading="lazy"`.
  - [ ] Apila correctamente a 800 y 375 (dibujados en Figma: `1:658`, `1:779`); sin desbordamiento a 360.
  - [ ] No hay `ChatWidget` (llega con el contrato de assistant) ni "Boutiques/Tiendas" como pantalla (P-1).
- Firmas públicas:
  - `HeroCta` Props: `{ title: string; ctaLabel: string; ctaHref: string; image: { src: ImageMetadata | string; alt: string } }`.
  - `ManifestoBlock` Props: `{ text: string; linkLabel: string; linkHref: string }`.
  - `CollectionTile` Props: `{ title: string; href: string; image?: { src: ImageMetadata | string; alt: string } | null }`.
  - `CollectionLinks` Props: `{ links: { label: string; href: string }[] }`.
  - `StoreBanner` Props: `{ title: string; text: string; linkLabel: string; linkHref: string; image?: { src: ImageMetadata | string; alt: string } | null }`.
  - `FeaturedProduct` Props: `{ product: ProductSummary }`.
  - Ruta `/` (GET, SSR).
- Pruebas obligatorias: Container API de cada componente (props → HTML; `image` nula); E2E con la API simulada o real: con categorías (3 mosaicos con `href` correcto), con lista vacía y con API caída (página 200 y enlace de respaldo); axe; capturas a 1280, 800 y 375; `npm run check`; `npm run build`.
- Diseño (frontend): `1:1283` (Desktop `1:115`, Tablet `1:658`, Mobile `1:779`); secciones `1:187` (CTA), `1:193` (manifiesto), `1:197` (producto protagonista), `1:203` (mosaicos), `1:226` (enlaces), `1:231` (invitación), `Main` `1:186`. Imágenes con `download_assets` (RT-6). VIEWS §4.1.
- Revisión manual (el usuario): http://localhost:4321/ con el catálogo sembrado (`seed_dev`): mosaicos con las categorías demo, enlace al catálogo filtrado; apagar el backend y recargar (la portada sigue).
- Seguridad: URLs de imagen solo del contrato (Storage) o de `assets`; sin `set:html`.
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): portada con categorías reales (T-121)`.
- IDs reservados: ninguno.
- Escalar si: el usuario prefiere portada estática (los mosaicos pasan a `/relojes`) o quiere un "destacado" administrable (requiere ampliar catalog, P-2 B).

### T-122 — "Nosotros" y páginas legales
- Objetivo: el visitante lee la historia y el contacto de la marca (contenido de demostración) y existen las páginas de privacidad y términos a las que enlazan el pie y el registro.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RNF10 (consentimiento y política) · D-041 (P-9), D-024
- Leer: `VIEWS.md` §4.2, §9 (H-22), §10 (P-9); `BRIEF.md` §10; `lib/site.ts`; `DefinitionList` de T-123.
- Contratos aplicables: ninguno (estático).
- Dependencias: T-119, T-123.
- Puede modificar: `frontend/src/pages/{nosotros,privacidad,terminos}.astro`, `frontend/src/components/about/{AwardsList,ContactBlock}.astro`, `frontend/src/data/about.ts`, `frontend/src/data/legal.ts`, `frontend/src/assets/about/**`.
- Protegido: `ui/**`, `layout/**`, `lib/site.ts`.
- Resultado esperado: tres páginas **estáticas** (`prerender = true`). "Nosotros" con las secciones `1:383`, `1:388` (reconocimientos + imagen) y `1:419` (`id="contacto"`, contacto desde `SITE`). Los textos, reconocimientos y "Est. …" se **redactan** coherentes con la marca (ficticios, P-9) y cada sección con contenido de demostración lleva `data-demo-content` y una etiqueta visible discreta "Contenido de demostración" (para la lista de lanzamiento: `grep -rn data-demo-content`). `/privacidad` y `/terminos`: texto de demostración con los elementos de la Ley 29733 (responsable, finalidad, derechos de acceso, rectificación, cancelación y oposición, plazo, versión `PRIVACY_VERSION`) y su fecha.
- Criterios de aceptación:
  - [ ] Teléfono, correo y red salen de `SITE`; el mismo teléfono en pie y en "Nosotros" (H-22).
  - [ ] Cada página: un `h1`, jerarquía de encabezados sin saltos, longitud de línea de 55–75 caracteres en texto largo, `alt` descriptivo.
  - [ ] `data-demo-content` presente en cada bloque de demostración; ningún dato de Figma (reconocimientos 2022–2025, "Est. 2005", `@valmontperu` si no coincide con `SITE`) se copia sin pasar por `data/about.ts`.
  - [ ] Responsive a 1280, 800 y 375 (dibujado en Figma: `1:381`, `1:436`, `1:491`).
- Firmas públicas:
  - `AwardsList` Props: `{ items: { year: number; title: string; description?: string }[] }`.
  - `ContactBlock` Props: `{ phone: string; email: string; instagram: { label: string; href: string }; image?: { src: ImageMetadata | string; alt: string } | null }`.
  - Rutas `/nosotros`, `/privacidad`, `/terminos` (GET, estáticas); ancla `#contacto`.
- Pruebas obligatorias: Container API (props → HTML, `data-demo-content`, un `h1`), prueba de que el pie y `/nosotros` muestran el mismo teléfono, E2E (las tres rutas responden 200, ancla `#contacto`, enlaces del pie) y axe; `npm run check`; `npm run build` (las tres rutas aparecen como estáticas).
- Diseño (frontend): `1:1284` (Desktop `1:381`, Tablet `1:436`, Mobile `1:491`); `1:383`, `1:388`, `1:391`, `1:419`. `/privacidad` y `/terminos` **no existen en Figma**: se diseñan con tokens y `PageTitle`.
- Revisión manual (el usuario): http://localhost:4321/nosotros, `/privacidad`, `/terminos`; localizar la etiqueta de demostración.
- Seguridad: sin datos personales reales; el contenido de demostración queda marcado para retirarlo antes de producción (lista de lanzamiento).
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): nosotros y páginas legales de demostración (T-122)`.
- IDs reservados: ninguno.
- Escalar si: el usuario entrega texto legal real (sustituye `data/legal.ts`), o quiere publicar los reconocimientos de Figma (P-9 B exige confirmar su veracidad).

### T-123 — Migas, paginación, lista de definiciones, `ProductCard` y `ProductGrid`
- Objetivo: existen los componentes de producto y de navegación que reutilizan catálogo, ficha y, después, lista de deseos.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.01, RF02.03, RF02.05, RF02.07, RF02.08, RF09.02, RNF07
- Leer: `VIEWS.md` §4.5 (tarjeta), §4.6, §4.12, §5, §6 (matriz: ProductCard 4 variantes), §9 (H-02, H-04); `BRIEF.md` §7 (Card de producto, Breadcrumb, Pagination), §9; T-118; tipos de T-120.
- Contratos aplicables: `ProductSummary` (3 / T-120).
- Dependencias: T-117, T-118, T-120 (solo tipos).
- Puede modificar: `frontend/src/components/ui/{Breadcrumb,Pagination,DefinitionList}.astro`, `frontend/src/components/catalog/{ProductCard,ProductGrid}.astro`, `frontend/src/components/catalog/spec-line.ts`, `frontend/src/pages/dev/products.astro`.
- Protegido: `ui/` de T-117/T-118, páginas, `lib/api/**`.
- Resultado esperado: los 5 componentes. `ProductCard` es **un enlace único** sobre la tarjeta (patrón de enlace extendido, sin enlaces anidados); la acción de corazón no entra todavía (la añade la tarea de `WishlistToggle`, que modifica este archivo: ver "Ajustes propuestos"). Sin badges "Nuevo"/"Edición limitada" (no hay dato: H-02, D-041 P-2).
- Criterios de aceptación:
  - [ ] Cada variante usa los mismos datos de `ProductSummary`; imagen con relación de aspecto única por variante (PROPUESTA de BRIEF §12.5: 4:5 en `store` y `wishlist`, 1:1 en `related` y `compact`), `alt` del contrato, `width`/`height`, `loading="lazy"` salvo `priority`.
  - [ ] La ficha corta es `{case_diameter_mm}mm · {movement.label} · {case_material.label}` y **omite los nulos** sin dejar separadores huérfanos (RF02.07); si los tres son nulos, no se pinta la línea.
  - [ ] El precio sale de `Price` con `original_price` y `discount_amount`; la disponibilidad se muestra con `Availability` salvo en `compact`.
  - [ ] `ProductGrid` es una lista (`ul`) con 1 columna en 360, 2 en 800 y 3 en 1280 (container query) y acepta el encabezado accesible `label`.
  - [ ] `Breadcrumb`: `nav` con `aria-label`, `ol`, último elemento sin enlace y con `aria-current="page"`.
  - [ ] `Pagination`: no se pinta si `total <= pageSize`; página actual con `aria-current="page"`, "Anterior"/"Siguiente" con `rel`, deshabilitados (sin enlace) en los extremos, ventana de páginas con elipsis sin saltos de foco; cada enlace es un `<a>` (funciona sin JS).
  - [ ] `DefinitionList` genera `<dl>` con `<dt>`/`<dd>` y admite 1 o 2 columnas por container query.
- Firmas públicas:
  - `Breadcrumb` Props: `{ items: { label: string; href?: string }[] }`.
  - `Pagination` Props: `{ page: number; pageSize: number; total: number; hrefFor: (page: number) => string; siblings?: number /* 1 */ }`.
  - `DefinitionList` Props: `{ items: { term: string; description: string }[]; columns?: 1 | 2 /* 1 */ }`.
  - `ProductCard` Props: `{ product: ProductSummary; variant?: 'store'|'related'|'wishlist'|'compact' /* store */; headingLevel?: 2 | 3 | 4 /* 3 */; priority?: boolean /* false */ }`; slot `action` (reservado).
  - `ProductGrid` Props: `{ products: ProductSummary[]; variant?: 'store'|'related'|'wishlist'|'compact' /* store */; label: string; headingLevel?: 2 | 3 | 4 }` (envuelve cada tarjeta en `li`).
  - `spec-line.ts`: `export function specLine(p: Pick<ProductSummary, 'case_diameter_mm'|'movement'|'case_material'>): string | null`.
- Pruebas obligatorias: unitarias de `specLine` (los 8 casos de nulos); Container API de cada variante (un único `<a>` por tarjeta, `alt`, precio con y sin promoción, `Availability`, `priority`); `Pagination` (1 página, primera, intermedia, última, muchas páginas, `hrefFor` llamado con cada número); axe sobre `/dev/products`; `npm run check`; `npm run build`.
- Diseño (frontend): tarjeta tienda `51:395`, relacionados `55:497`, wishlist `40:706`, compacta `40:753` (3 tarjetas); Breadcrumb `51:336`, `55:371`; Paginación `51:554`, `54:440`; tabla de especificaciones `55:419` (para `DefinitionList`). VIEWS §6: filas ProductCard, ProductGrid, Breadcrumb, Pagination, DefinitionList.
- Revisión manual (el usuario): http://localhost:4321/dev/products — las cuatro variantes con datos de ejemplo (precio con promoción, agotado, bajo pedido, sin imagen), paginación en varios estados.
- Seguridad: texto de producto como texto (nunca `set:html`).
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): tarjetas de producto, migas, paginación y lista de definiciones (T-123)`.
- IDs reservados: ninguno.
- Escalar si: Figma o el usuario piden badges, o una relación de aspecto distinta de la propuesta.

### T-124 — Catálogo `/relojes`
- Objetivo: el visitante explora los relojes, filtra y ordena con parámetros de URL (compartible y sin JavaScript) y navega por páginas.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.01–04, RF02.08, RF09.02, RNF01 · D-041 (P-2, P-3)
- Leer: `VIEWS.md` §4.5, §9 (H-02…H-04, H-23, H-24), §10 (P-2); catalog §7 (parámetros) y `ProductSort`; T-120, T-123.
- Contratos aplicables: `GET /api/v1/catalog/products`, `/categories`, `/attributes`.
- Dependencias: T-119, T-120, T-123.
- Puede modificar: `frontend/src/pages/relojes/index.astro`, `frontend/src/components/catalog/{FilterBar,ActiveFilters,FeaturedBanner}.astro`, `frontend/src/lib/catalog/query.ts`, `frontend/src/data/featured.ts`.
- Protegido: `ProductCard` y demás componentes de T-123, `lib/api/**`, `pages/relojes/[slug].astro`.
- Resultado esperado: página SSR (`prerender = false`, `Cache-Control: public, max-age=30, stale-while-revalidate=60`) con migas (Inicio › Relojes [› categoría]), `PageTitle` "Nuestros relojes" con "{total} modelos" (singular con 1), `FilterBar`, chips de filtros activos con "Limpiar todo", `ProductGrid` y `Pagination`. Los filtros son un `<form method="get" action="/relojes">` con botón "Aplicar" (sin envío automático al cambiar: WCAG 3.2.2). Una sola petición a `listProducts` más `listCategories` y `getAttributes` en paralelo (`Promise.all`).
  - **Parámetros de URL** (mismos nombres que la API, salvo precio): `q`, `category`, `movement`, `case_material`, `price_min`, `price_max` (**en soles enteros en la URL**; `parseCatalogQuery` los convierte a céntimos para la API), `available=1`, `sort`, `page`.
  - **Estático y no interactivo (D-041 P-2):** el desplegable "Complicación" (uno solo, BRIEF §12.4), el interruptor cuadrícula/lista y el banner `FeaturedBanner` ("Destacado del mes"; texto de `data/featured.ts`, **sin botón ni enlace**, marcado "Contenido de demostración" con `data-demo-content`). Los controles estáticos van fuera del `<form>`, con `aria-disabled="true"` y fuera del orden de tabulación.
  - La etiqueta del filtro de `available` es "Solo disponibles" (excluye solo agotados: incluye bajo pedido).
- Criterios de aceptación:
  - [ ] Cada filtro del contrato (categoría, movimiento, material, precio mín./máx., disponibles, orden) funciona sin JavaScript y se refleja en la URL; recargar o compartir la URL reproduce el listado.
  - [ ] `parseCatalogQuery` descarta valores desconocidos (orden no listado, `page` no numérico o < 1, precios negativos o no enteros) y marca `invalid` sin lanzar; `price_min > price_max` se corrige no enviando la petición y mostrando `Notice` de error con el enlace "Limpiar filtros".
  - [ ] Estados: **vacío** ("Ningún reloj coincide con tu búsqueda" + acción "Limpiar filtros"; también con `category` desconocida, que el servidor devuelve como `items: []`), **error** (422 → `Notice` con "Revisa los filtros"; 5xx o red → `Notice` "No pudimos cargar los relojes" con enlace "Reintentar" a la misma URL y estado HTTP 502), **éxito**. Una página fuera de rango (`page` > última) redirige a la última o muestra vacío con enlace a la página 1 (decisión del desarrollador, anotada).
  - [ ] Los chips de filtros activos dan el nombre (`label`) del atributo y el enlace "Quitar" regenera la URL sin ese filtro y sin `page`.
  - [ ] Cambiar un filtro reinicia `page` a 1.
  - [ ] `q` ≤ 100 caracteres (el servidor responde 422 si no): se recorta en `parseCatalogQuery`.
  - [ ] Las imágenes de LCP (primeras 3 tarjetas) con `priority`.
- Firmas públicas:
  - `lib/catalog/query.ts`:
    ```ts
    export type CatalogQuery = { q?: string; category?: string; movement?: string; case_material?: string; price_min_soles?: number; price_max_soles?: number; available?: boolean; sort?: ProductSort; page: number };
    export function parseCatalogQuery(sp: URLSearchParams): { query: CatalogQuery; filters: ProductFilters; invalid: boolean };   // filters: céntimos y page_size = 24
    export function catalogHref(q: Partial<CatalogQuery>): string;   // '/relojes?…' ordenado y sin valores vacíos; omite page=1
    export function activeChips(q: CatalogQuery, lookups: { categories: Category[]; movements: AttributeValue[]; case_materials: AttributeValue[] }): { label: string; removeHref: string }[];
    ```
  - `FilterBar` Props: `{ categories: Category[]; movements: AttributeValue[]; materials: AttributeValue[]; query: CatalogQuery; action?: string /* '/relojes' */ }`.
  - `ActiveFilters` Props: `{ chips: { label: string; removeHref: string }[]; clearHref: string }`.
  - `FeaturedBanner` Props: `{ kicker: string; title: string; description?: string; price?: Money }`.
  - Ruta `GET /relojes?…`.
- Pruebas obligatorias: unitarias de `parseCatalogQuery`/`catalogHref`/`activeChips` (parámetros inválidos, ida y vuelta, soles↔céntimos, reinicio de `page`); Container API de `FilterBar` (valores preseleccionados, campos fuera del `form` para los estáticos) y `ActiveFilters`; E2E contra el stack sembrado: filtrar por categoría/movimiento/material, rango de precio, solo disponibles, ordenar por precio, paginar (24 por página), sin resultados, URL inválida, API caída (502 con reintento); axe; capturas a 1280 y 375; `npm run check`; `npm run build`.
- Diseño (frontend): `51:323`; `51:336` (migas), `51:342` (título), `51:345` (banner), `51:357` (barra de filtros: `51:366` y `51:369` son el mismo "Complicación"), `51:394` (rejilla), `51:554` (paginación). VIEWS §4.5.
- Revisión manual (el usuario): http://localhost:4321/relojes — filtrar, ordenar, copiar la URL en otra pestaña, buscar algo inexistente, apagar el backend y recargar.
- Seguridad: valores de la URL se validan antes de llegar a la API y se escapan al pintarse; no se reenvía ningún parámetro desconocido.
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): catálogo con filtros por URL y paginación (T-124)`.
- IDs reservados: ninguno.
- Escalar si: el usuario quiere el filtro "Complicación" funcional, "En stock / Por encargo" por separado o buscador con sugerencias (requiere ampliar catalog con `api-contract-review`).

### T-125 — Ficha de producto `/relojes/[slug]` y página 404
- Objetivo: el visitante ve el detalle completo de un reloj (galería, precio vigente, disponibilidad, especificaciones, relacionados) y una página 404 coherente para lo inexistente.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF02.05–08, RF09.02, RF03.01 (punto de entrada del carrito) · D-024
- Leer: `VIEWS.md` §4.6, §9 (H-04, H-05, H-07, H-13), §10 (P-2); catalog §7 (`ProductDetail`); T-118, T-123.
- Contratos aplicables: `GET /api/v1/catalog/products/{slug}` (404 si no existe o no está publicado).
- Dependencias: T-119, T-120, T-123.
- Puede modificar: `frontend/src/pages/relojes/[slug].astro`, `frontend/src/pages/404.astro`, `frontend/src/components/catalog/{ProductGallery,BuyBox}.astro`, `frontend/src/components/catalog/spec-rows.ts`.
- Protegido: `ProductCard` y demás de T-123, `lib/api/**`, `pages/relojes/index.astro`.
- Resultado esperado:
  - Página SSR (`Cache-Control: public, max-age=30, stale-while-revalidate=60`) con migas, galería (principal 712 × 593 y miniaturas; sin JavaScript las miniaturas son enlaces a la imagen; con JavaScript, un `<script>` < 30 líneas cambia la principal y `aria-current`), `BuyBox` (colección, `h1` con el nombre, "Ref. {sku}", `Price` con promoción, "IGV incluido" fijo [H-13], `Availability`, slot `actions` vacío hasta T-060, enlace "Consultar con un asesor" a `/nosotros#contacto`), `DefinitionList` de especificaciones y relacionados (`ProductGrid variant="related"`, solo si hay).
  - `spec-rows.ts` construye las filas: Referencia (`sku`), Movimiento, Diámetro de caja, Material de caja y Resistencia al agua (solo los no nulos) y a continuación `specs[]` en el orden del servidor, sin repetir una etiqueta ya mostrada.
  - `404.astro`: `EmptyState` "Esta página no existe" + enlace al catálogo; sirve de destino de `Astro.rewrite('/404')` con estado 404.
  - **No se implementan** `CaliberSection` ni `CraftCard` (H-07): las cifras (72 h, COSC…) son contenido por modelo sin contrato; mostrarlas fijas sería afirmar datos falsos. Se retoman si catalog amplía el contrato.
  - Sin valoraciones ni selector de material (H-04, H-05).
- Criterios de aceptación:
  - [ ] `getProduct` con 404 → respuesta 404 con la página `404.astro` (mismo mensaje para inexistente y borrador); 5xx o red → estado 502, `Notice` "No pudimos cargar este reloj" con "Reintentar".
  - [ ] Producto agotado (`out_of_stock`) muestra el precio, el aviso "Agotado" y, cuando exista el slot `actions`, el botón de compra deshabilitado (no se oculta el precio, VIEWS §4.6). `on_request` muestra "entrega estimada en N días".
  - [ ] Un solo `h1`; la imagen principal es la de LCP: sin `loading="lazy"` y con `fetchpriority="high"`; las miniaturas con `alt` propio; `title` y `meta description` (primeros 155 caracteres de `description`) y `og:image` de la imagen principal.
  - [ ] La descripción se pinta como texto con saltos de línea preservados (`white-space: pre-line`), nunca con `set:html`.
  - [ ] Producto sin `related` no pinta la sección; sin `specs` extra, solo las filas estructuradas.
  - [ ] A 360 px la galería y el `BuyBox` se apilan sin desbordamiento.
- Firmas públicas:
  - `ProductGallery` Props: `{ images: ProductImage[]; productName: string }` (≥ 1 imagen).
  - `BuyBox` Props: `{ product: ProductDetail }`; slot `actions`.
  - `spec-rows.ts`: `export function specRows(p: ProductDetail): { term: string; description: string }[]`.
  - Rutas: `GET /relojes/{slug}` y `404`.
- Pruebas obligatorias: unitarias de `specRows` (sin nulos duplicados, orden); Container API de `ProductGallery` (1 y 5 imágenes) y `BuyBox` (los 4 estados de disponibilidad, con y sin promoción); E2E: ficha existente, slug inexistente (404), producto agotado y bajo pedido (semilla `seed_dev`), API caída (502); axe; capturas a 1280 y 375; `npm run check`; `npm run build`.
- Diseño (frontend): `55:358`; `55:371` (migas), `55:379` (hero), `55:380` (galería), `55:387` (info), `55:397` (precio), `55:400` (disponibilidad), `55:412` (acciones), `55:419` (especificaciones), `55:493`/`55:497` (relacionados). VIEWS §4.6.
- Revisión manual (el usuario): http://localhost:4321/relojes/<slug> de un reloj de la semilla (con promoción, agotado y bajo pedido) y de un slug inventado (404).
- Seguridad: las URL de imagen son del contrato; sin HTML del servidor; el botón de compra es solo experiencia: el backend valida stock (RN-14).
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): ficha de producto y página 404 (T-125)`.
- IDs reservados: ninguno.
- Escalar si: el usuario quiere "El Calibre" y "Artesanía" por modelo (requiere ampliar catalog) o contenido de marca genérico (decisión de producto).

### T-126 — Sesión SSR, guardia de rutas, `/auth/callback`, `/salir` y proxy `/bff/*`
- Objetivo: el servidor de Astro conoce al usuario por una cookie `httpOnly`, protege las rutas de cuenta y reenvía el Bearer a FastAPI, sin exponer el token al navegador.
- Responsable: frontend-dev (pruebas: qa-reviewer con **revisión de seguridad a fondo**) · Módulo: ui · Requisitos: RF01.02, RF01.03, RF01.05, RNF02 · D-025, D-041 (P-5)
- Leer: contratos 3.1–3.3 de este STATUS; D-025; `VIEWS.md` §2 (H-01); skill `supabase` (sección SSR con Astro y `@supabase/ssr`); guías de Astro: middleware, cookies y `locals`; `supabase/config.toml` (`[auth]`, `[auth.email]`) y `supabase/templates/confirmation.html` (usa `{{ .ConfirmationURL }}`); `docs/modules/identity/SPEC.md` §7.
- Contratos aplicables: Supabase Auth (cliente oficial); identity §7 (`PATCH /identity/me`).
- Dependencias: T-120; **aprobación de `@supabase/ssr` y `@supabase/supabase-js`** (pregunta 9); aviso de configuración de Supabase (§6, lo gestiona el Leader).
- Puede modificar: `frontend/package.json` y `package-lock.json` (solo esas dos dependencias, tras la aprobación), `frontend/src/middleware.ts`, `frontend/src/env.d.ts` (`Locals`), `frontend/src/lib/server/{supabase,guard,session}.ts`, `frontend/src/lib/api/browser.ts`, `frontend/src/pages/bff/[...path].ts`, `frontend/src/pages/auth/callback.ts`, `frontend/src/pages/salir.ts`, `frontend/.env.example`.
- Protegido: `lib/api/{http,server,catalog}.ts` (solo se consumen), páginas y componentes, `backend/**`, `supabase/**`, `deploy/**`.
- Resultado esperado: contratos 3.2 y 3.3 implementados.
  - `lib/server/supabase.ts`: `createSupabaseServer({ request, cookies })` con `createServerClient` (`getAll`/`setAll` sobre las cookies de Astro) forzando `httpOnly: true`, `sameSite: 'lax'`, `secure: import.meta.env.PROD`, `path: '/'`.
  - `middleware.ts`: crea el cliente, valida la sesión (preferir `auth.getClaims()`, verificación local del JWT; si la versión instalada no lo trae, `auth.getUser()`), deja `locals.session` y `locals.supabase`, deja que `@supabase/ssr` renueve y reescriba las cookies, y aplica la guardia de rutas protegidas.
  - `GET /auth/callback?code&next`: `exchangeCodeForSession(code)`; si `user_metadata` trae `full_name` y `accept_privacy_version` (los puso el registro), hace **una vez** `PATCH /identity/me` con ellos; redirige a `safeNext(next, '/cuenta')`; sin `code` o con error → `/ingresar?error=confirmacion`.
  - `POST /salir`: `auth.signOut()`, borra cookies, redirige 303 a `/`. Solo POST (un GET no cierra sesión).
  - `/bff/*` y `browser.ts` según 3.3.
- Criterios de aceptación:
  - [ ] Tras iniciar sesión, la cookie de sesión es `HttpOnly` y `SameSite=Lax` (`Secure` en producción); `document.cookie` no la muestra; el token no aparece en ningún HTML ni respuesta de `/bff/*`.
  - [ ] `/cuenta`, `/carrito` y `/checkout` (y subrutas) sin sesión → 302 a `/ingresar?next=<ruta original codificada>`; `/cuentas` y `/carritos` **no** se protegen.
  - [ ] `safeNext` rechaza `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:…`, rutas con saltos de línea y cualquier valor que no empiece por `/`; devuelve el `fallback`.
  - [ ] `/bff/cart` con sesión devuelve el mismo cuerpo que `GET /api/v1/cart`; sin sesión, 401 con el formato común; `/bff/orders/admin/...`, `/bff/identity/me` y `/bff/catalog/...` → 404; `POST` con `Origin` ajeno → 403; cuerpo > 16 KiB → 413; el backend lento → 504.
  - [ ] El proxy reenvía `Idempotency-Key` y descarta `Cookie`, `Authorization` y cualquier otra cabecera del cliente.
  - [ ] Cuando el backend responde 401 (token caducado y renovación fallida), el servidor limpia la sesión y las rutas protegidas redirigen al ingreso.
  - [ ] Sin las variables obligatorias, las rutas con sesión responden 500 con mensaje genérico (sin nombres de variables) y el resto del sitio sigue funcionando.
  - [ ] No se usa `localStorage`/`sessionStorage` para tokens; no hay `PUBLIC_*` nuevas.
- Firmas públicas: contratos 3.2 y 3.3 (tipos `Session`, `App.Locals`, `isProtectedPath`, `safeNext`, `loginUrl`, `apiFor`, `browserTransport`; rutas `GET /auth/callback`, `POST /salir`, `ALL /bff/*`).
- Pruebas obligatorias (qa-reviewer; seguridad a fondo): unitarias de `isProtectedPath` y `safeNext` (tabla de entradas hostiles); middleware con un `Request` simulado (con y sin cookie; ruta pública, protegida y prerenderizada); `/bff/*` con `fetch` simulado (tabla de lista permitida, métodos, `Origin`, tamaño, cabeceras descartadas, tiempo agotado, que nunca se devuelva `Set-Cookie`); E2E contra Supabase y backend locales: iniciar sesión, verificar atributos de la cookie, acceder a `/bff/cart`, cerrar sesión, expirar la sesión; revisión: ningún token en HTML ni en `console`; `npm run check`; `npm run build`.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario): con `frontend/.env` creado (ver §6) y Supabase en marcha, abrir `/carrito` sin sesión (redirige a `/ingresar`), iniciar sesión (T-127), en DevTools → Application → Cookies comprobar `HttpOnly`, y abrir http://localhost:4321/bff/cart (devuelve el carrito en JSON con sesión; 401 sin ella).
- Seguridad: ninguna clave en el repo (`SUPABASE_ANON_KEY` solo en `.env` no versionado); la cookie nunca se lee desde el cliente; el proxy es una lista de permitidos, no un reenviador abierto (sin SSRF: el destino lo fija `API_BASE_URL`); validar `next` contra redirección abierta; `checkOrigin` de Astro activo.
- Estado inicial: BLOCKED (aprobación de dependencias, §6)
- Entrega: RT-11; `feat(frontend): sesión SSR con cookie httpOnly y proxy autenticado (T-126)`.
- IDs reservados: ninguno.
- Escalar si: `emailRedirectTo` no está permitido por Supabase (ver §6), el cliente de `@supabase/ssr` no puede forzar `httpOnly`, o el backend necesita CORS.

### T-127 — Ingreso `/ingresar`
- Objetivo: el usuario inicia sesión con correo y contraseña y vuelve a la página que quería.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF01.02, RNF07 · D-025
- Leer: `VIEWS.md` §4.3, §9 (H-18); `BRIEF.md` §11, §12.2–3; contratos 3.2; T-117, T-118, T-119, T-126.
- Contratos aplicables: Supabase Auth `signInWithPassword` (errores: `invalid_credentials`, `email_not_confirmed`, `over_request_rate_limit`, fallos de red o 5xx).
- Dependencias: T-117, T-118, T-119, T-126.
- Puede modificar: `frontend/src/pages/ingresar.astro`, `frontend/src/components/auth/{AuthSplit,WatchmakerArtwork,AuthForm}.astro`, `frontend/src/islands/password-toggle.ts`, `frontend/src/lib/server/auth-errors.ts`, `frontend/src/assets/auth/**`.
- Protegido: `middleware.ts` y lo demás de T-126, `ui/**`, `layout/**`.
- Resultado esperado: página SSR (`prerender = false`, `Cache-Control: private, no-store`) con `AuthLayout variant="login"`. El formulario es un `<form method="post">` de la propia página (funciona sin JavaScript); el manejador `POST` valida, llama a `locals.supabase.auth.signInWithPassword` y redirige 303 a `safeNext(next)`. La isla `password-toggle` (TypeScript puro, `initPasswordToggle(root?)`) alterna `type` del campo y `aria-pressed` del botón "Mostrar contraseña". **Sin** "Recuérdame" ni "¿Olvidaste tu contraseña?" (H-18; RF01.04 es POSTERIOR). "Crear cuenta Valmont +" enlaza a `/registro?next=…`.
- Criterios de aceptación:
  - [ ] Credenciales válidas → 303 a `safeNext(next)` (por defecto `/cuenta`) con la cookie puesta; ya autenticado → redirige sin mostrar el formulario.
  - [ ] Estados y estado HTTP: campo vacío o correo mal formado → 422 con error por campo (`Field.error`) y `Notice` resumen; credenciales erróneas → 401 con **el mismo mensaje** para correo inexistente y contraseña errónea ("Correo o contraseña incorrectos"); correo sin confirmar → 403 con "Confirma tu correo para ingresar" (sin revelar nada más); límite de intentos → 429 con "Demasiados intentos; espera un momento"; Supabase o red caídos → 503 `Notice` con "Reintentar". El correo escrito se conserva; la contraseña **nunca** se vuelve a pintar.
  - [ ] `Notice` de error con `role="alert"` y foco al resumen al cargar la respuesta de error; `autocomplete="email"` y `autocomplete="current-password"`; `Field` de contraseña con la acción del ojo (`IconButton` con `label` "Mostrar contraseña"/"Ocultar contraseña").
  - [ ] Contraste del botón: ink sobre menta (BRIEF §12.2); campos con `--stroke-control` (§12.3).
  - [ ] Los textos del arte están en español ("Instrumento relojero de precisión · Calibre Valmont 2026 · 24 rubíes"); el arte es decorativo (`aria-hidden`) y se oculta o reduce en 360 px.
  - [ ] Sin JavaScript el formulario funciona completo.
- Firmas públicas:
  - `AuthSplit` Props: `{ variant: 'login' | 'register' }`; slots `default` (formulario) y `art`.
  - `WatchmakerArtwork` Props: `{ variant: 'movement' | 'mainspring' }` (SVG decorativo).
  - `AuthForm` Props: `{ mode: 'login'; email?: string; errors?: { form?: string; email?: string; password?: string }; next?: string }`.
  - `lib/server/auth-errors.ts`: `export function mapAuthError(e: { code?: string; status?: number; name?: string } | null): { status: 401|403|422|429|503; message: string }`.
  - `islands/password-toggle.ts`: `export function initPasswordToggle(root?: ParentNode): void`.
  - Ruta `GET|POST /ingresar?next=`.
- Pruebas obligatorias: unitarias de `mapAuthError` (cada código de Supabase, error de red, 5xx); `initPasswordToggle` con `happy-dom` (alterna `type` y `aria-pressed`, idempotente); Container API de `AuthForm` (errores por campo, `autocomplete`, contraseña sin `value`); E2E contra el stack (login correcto con redirección a `next`, contraseña errónea, correo inexistente con el **mismo** mensaje, `next` hostil ignorado, sin JavaScript); axe; capturas a 1440 y 375; `npm run check`; `npm run build`.
- Diseño (frontend): `32:576` (1440 × 1372); `32:584` (`Split_Layout`), `32:585` (arte), `32:621` (`Form_Header`), `32:631` (`Credentials_Form`), `32:654` (`Action_Group`), `32:665` (damero menta), `32:577` (cabecera compacta). Los `ChatWidget` `104:636`/`104:613` no se implementan. Solo desktop en Figma: tablet y móvil se derivan de BRIEF §6. VIEWS §4.3.
- Revisión manual (el usuario): http://localhost:4321/ingresar — entrar con un usuario creado en Studio o por el registro; probar contraseña errónea; entrar a `/carrito` sin sesión y comprobar que vuelve a `/carrito` tras ingresar.
- Seguridad: el mismo mensaje y tiempo para correo inexistente y contraseña errónea (RN anti-enumeración); la contraseña no se registra ni se devuelve; `next` validado; el formulario protegido por `checkOrigin`.
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): pantalla de ingreso (T-127)`.
- IDs reservados: ninguno.
- Escalar si: el registro de arte de la pantalla de registro (`34:595`) no se puede ubicar con una llamada de `get_metadata`, o el usuario exige "Recuérdame".

### T-128 — Registro `/registro`
- Objetivo: un visitante crea su cuenta de cliente, acepta la política de privacidad y recibe el aviso de confirmar su correo.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF01.01, RNF10, RNF07 · D-025, D-041 (P-8 parcial: ver T-131)
- Leer: `VIEWS.md` §4.4, §9 (H-18), §10 (P-8); identity §7 (`PATCH /me`, validación 422 por `type`); `supabase/config.toml` (`enable_confirmations = true`, `minimum_password_length = 6`); T-126 y T-127.
- Contratos aplicables: Supabase Auth `signUp`; `PATCH /api/v1/identity/me` con `full_name` y `accept_privacy_version` (hecho por `/auth/callback` de T-126 tras la confirmación).
- Dependencias: T-127.
- Puede modificar: `frontend/src/pages/registro.astro`, `frontend/src/components/auth/RegisterForm.astro`, `frontend/src/lib/server/register.ts`.
- Protegido: `AuthSplit`, `WatchmakerArtwork`, `AuthForm`, `auth-errors.ts` (solo se importan), `middleware.ts`.
- Resultado esperado: página SSR con `AuthLayout variant="register"` y `WatchmakerArtwork variant="mainspring"`. Campos: nombre completo, correo, contraseña, repetir contraseña, casilla "Acepto los términos y la política de privacidad" (enlaces a `/terminos` y `/privacidad`, texto con `PRIVACY_VERSION`). `POST`: `signUp({ email, password, options: { emailRedirectTo: <origen>/auth/callback?next=/cuenta, data: { full_name, accept_privacy_version: PRIVACY_VERSION } } })`.
  - Con confirmación activa (`session` nula): estado éxito "Revisa tu correo: te enviamos un enlace para confirmar tu cuenta" (en desarrollo, el correo está en Mailpit, http://127.0.0.1:54324). Si la respuesta ya trae sesión (confirmación desactivada), el servidor hace `PATCH /identity/me` y redirige a `/cuenta`.
  - Un correo ya registrado produce **el mismo** estado de éxito (Supabase no lo revela): no se confirma ni se niega su existencia.
  - **Sin** fecha de nacimiento todavía: la añade T-131 cuando T-113 deje el contrato (G-1).
- Criterios de aceptación:
  - [ ] Validación en el servidor (422 con error por campo): nombre (1–120, el límite real lo da identity §7), correo, contraseña ≥ 6 (el mínimo de Supabase local; subirlo es decisión de seguridad, §7 riesgo R-UI-3), repetición idéntica, casilla obligatoria.
  - [ ] Errores de Supabase mapeados: `weak_password` (mensaje con la regla), `over_request_rate_limit` (429), red o 5xx (503 con reintento); contraseña nunca devuelta al HTML.
  - [ ] Éxito sin sesión: `role="status"` con el aviso; el formulario se sustituye por el estado de éxito; no se inicia sesión.
  - [ ] La casilla enlaza a páginas que existen (T-122) y el texto cita la versión de la política.
  - [ ] Sin JavaScript el formulario funciona completo; con él, solo el ojo de contraseña (isla de T-127).
  - [ ] Ya autenticado → redirige a `safeNext(next)`.
- Firmas públicas:
  - `RegisterForm` Props: `{ values?: { full_name?: string; email?: string }; errors?: { form?: string; full_name?: string; email?: string; password?: string; password_confirm?: string; accept_terms?: string } }`.
  - `lib/server/register.ts`: `export function validateRegister(input: { full_name: string; email: string; password: string; password_confirm: string; accept_terms: boolean }): { ok: true } | { ok: false; errors: Record<string, string> }`.
  - Ruta `GET|POST /registro?next=`.
- Pruebas obligatorias: unitarias de `validateRegister` (límites, repetición, casilla); Container API de `RegisterForm` (errores por campo, sin `value` en contraseñas, enlaces legales); E2E contra el stack: registro completo, abrir el correo de Mailpit (API local de Mailpit) y seguir el enlace hasta `/auth/callback` → sesión iniciada y `GET /identity/me` con `full_name` y `privacy_version`; correo repetido con el mismo mensaje; contraseña débil; axe; capturas a 1440 y 375; `npm run check`; `npm run build`.
- Diseño (frontend): `34:595` (1440 × 1532); formulario `34:658`; el nodo del arte se localiza con **una** llamada a `get_metadata` sobre `34:595`. VIEWS §4.4.
- Revisión manual (el usuario): http://localhost:4321/registro — crear una cuenta, abrir http://127.0.0.1:54324 (Mailpit), confirmar el correo, quedar con la sesión iniciada en `/cuenta`.
- Seguridad: sin enumeración de cuentas; `full_name` y consentimiento viajan en `user_metadata` firmado por Supabase y se registran en el backend al confirmar (R-UI-2); la contraseña no se registra; `next` validado; sin fecha de nacimiento aún (dato personal: RNF10).
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): pantalla de registro con consentimiento (T-128)`.
- IDs reservados: ninguno.
- Escalar si: el usuario quiere confirmación de correo desactivada en desarrollo, o el backend necesita registrar el consentimiento en el momento del alta (cambio de contrato de identity).

### T-129 — Cuenta `/cuenta`: perfil y cierre de sesión
- Objetivo: el cliente ve y edita su nombre y teléfono, y cierra la sesión; la cabecera tiene un destino real para "Mi cuenta".
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF01.03, RF01.06 · D-025
- Leer: identity §7 (`ProfileOut`, `ProfileUpdateIn`, notas de contrato); T-118, T-119, T-126.
- Contratos aplicables: `GET /api/v1/identity/me`, `PATCH /api/v1/identity/me` (solo `full_name` y `phone`).
- Dependencias: T-119, T-126.
- Puede modificar: `frontend/src/pages/cuenta/index.astro`, `frontend/src/components/account/ProfileForm.astro`, `frontend/src/lib/api/identity.ts`.
- Protegido: lo demás de T-126, `ui/**`, `layout/**`, `lib/api/{http,server,catalog}.ts`.
- Resultado esperado: página protegida (la guardia de T-126; `Cache-Control: private, no-store`) con `PageTitle` "Mi cuenta", el correo (de `locals.session.email`, solo lectura), un formulario `POST` con nombre y teléfono (el manejador hace `PATCH` con solo los campos cambiados; vacío = `null` para borrar), enlaces a "Mis pedidos" (`/cuenta/pedidos`) y "Lista de deseos" (`/cuenta/lista-de-deseos`) y un `<form method="post" action="/salir">` con el botón "Cerrar sesión". **No hay frame de Figma**: se diseña con tokens y `Card` (G-3). Preferencias del perfil y marketing no entran.
- Criterios de aceptación:
  - [ ] Sin sesión, 302 a `/ingresar?next=/cuenta`; con sesión, carga el perfil con `GET /identity/me` y muestra los valores actuales.
  - [ ] Éxito ("Datos guardados", `role="status"`), 422 por campo (traducido por `type`: `string_too_long`, `string_too_short`, etc., a mensajes en español), 401 (sesión caducada → redirección al ingreso), 5xx o red → `Notice` con reintento; el formulario conserva lo escrito.
  - [ ] "Cerrar sesión" es un `POST` (nunca un enlace GET) y deja la sesión cerrada; tras él, `/cuenta` vuelve a pedir ingreso.
  - [ ] Los enlaces a pedidos y deseos se pintan aunque las páginas lleguen después (404 temporal anotado en la revisión).
  - [ ] No se muestra el rol, el `user_id` ni datos de otros usuarios.
- Firmas públicas:
  - `lib/api/identity.ts`: `export type Profile = { user_id: string; role: 'customer' | 'admin'; full_name: string | null; phone: string | null; privacy_version: string | null; marketing_opt_in: boolean }` (campos no usados por la UI se tipan según el OpenAPI); `getProfile(t: Transport): Promise<Profile>`; `updateProfile(t: Transport, changes: { full_name?: string | null; phone?: string | null }): Promise<Profile>`.
  - `ProfileForm` Props: `{ values: { full_name: string; phone: string }; email: string | null; errors?: { form?: string; full_name?: string; phone?: string }; saved?: boolean }`.
  - Ruta `GET|POST /cuenta`.
- Pruebas obligatorias: unitarias de `getProfile`/`updateProfile` (cuerpo del `PATCH` solo con campos cambiados; `null` para borrar; 422 con `details`); Container API de `ProfileForm`; E2E: ver perfil, editar, 422 de campo, cerrar sesión, acceso sin sesión; axe; `npm run check`; `npm run build`.
- Diseño (frontend): sin frame (G-3); `PageTitle` `54:347` y `Card` como referencia de estilo.
- Revisión manual (el usuario): http://localhost:4321/cuenta — editar el nombre, recargar, cerrar sesión y volver a entrar.
- Seguridad: el cliente nunca envía `user_id` ni `role`; el correo sale de la sesión validada, no de un parámetro; `no-store`.
- Estado inicial: BACKLOG
- Entrega: RT-11; `feat(frontend): página de cuenta con perfil y cierre de sesión (T-129)`.
- IDs reservados: ninguno.
- Escalar si: el usuario quiere editar las preferencias o la baja de la cuenta (otro RF).

### T-130 — Infraestructura de pruebas del frontend
- Objetivo: el frontend puede ejecutar pruebas unitarias, de componente, de isla y E2E con accesibilidad, con los comandos de la skill `testing-and-quality-gates`.
- Responsable: qa-reviewer (acepta frontend-lead) · Módulo: ui · Requisitos: RNF07, D-028, D-033
- Leer: `docs/skills/README.md`; `testing-and-quality-gates` §1–§2; guía "Testing" de Astro (Vitest y Container API); `frontend/package.json`.
- Contratos aplicables: ninguno.
- Dependencias: **aprobación del usuario** de las dependencias de desarrollo (pregunta 9 del traspaso).
- Puede modificar: `frontend/package.json` y `package-lock.json` (solo `devDependencies` y `scripts` `test`, `test:e2e`), `frontend/vitest.config.ts`, `frontend/playwright.config.ts`, `frontend/tests/helpers/**`, `frontend/e2e/helpers/**`, `.gitignore` de `frontend/` (resultados de prueba), y una fila en la tabla de puertas de `.claude/skills/testing-and-quality-gates/SKILL.md` (E2E y pruebas del frontend ya no "no configuradas") vía Leader.
- Protegido: `frontend/src/**` (código de producción), `astro.config.mjs`, el `Dockerfile` (las devDependencies no entran en la imagen: usa `npm ci --omit=dev`).
- Resultado esperado: `npm test` (Vitest con `getViteConfig`: proyecto `components` en entorno `node` para la Container API y `lib`; proyecto `dom` en `happy-dom` para islas y scripts); `npm run test:e2e` (Playwright, Chromium, 1280 y 375, `baseURL` `http://localhost:4321`, reutiliza el servidor ya levantado por `scripts/review-up.sh`; ayudas para axe y para leer el buzón de Mailpit); un ejemplo mínimo de cada tipo que pasa en verde.
- Criterios de aceptación: `npm test` y `npm run test:e2e` ejecutan su ejemplo y fallan si se rompe; `npm run build` y la imagen de Docker no cambian de tamaño; el entorno `node` renderiza un `.astro` con la Container API y `happy-dom` ejecuta un script de isla.
- Firmas públicas: scripts `test`, `test:e2e`; carpetas `frontend/tests/**` (Vitest) y `frontend/e2e/**` (Playwright).
- Pruebas obligatorias: las propias de infraestructura (ejemplos en verde y rojo deliberado); `npm run check` sin cambios; `npm run build`.
- Diseño (frontend): no aplica.
- Revisión manual (el usuario): ninguna visible; `npm test` en `frontend/`.
- Seguridad: los navegadores de Playwright se descargan fuera del repo (caché de usuario); sin credenciales de prueba en el repo (usuarios de prueba creados en cada ejecución).
- Estado inicial: BLOCKED (decisión del usuario)
- Entrega: RT-11; `test(frontend): infraestructura de pruebas con Vitest y Playwright (T-130)`.
- IDs reservados: ninguno.
- Escalar si: Vitest no renderiza componentes con la versión de Astro instalada, o el usuario aprueba solo una parte (se ajusta el alcance).

### T-131 — Fecha de nacimiento en el registro (+18)
- Objetivo: el registro pide la fecha de nacimiento y exige 18 años, según el contrato de identity que deje T-113.
- Responsable: frontend-dev (pruebas: qa-reviewer) · Módulo: ui · Requisitos: RF01.07 · D-041 (P-8)
- Leer: la SPEC de identity ampliada por T-113 (contrato de `birth_date`, dónde se exige, mensajes de error); `VIEWS.md` §4.4; T-128.
- Contratos aplicables: **por definir en T-113** (no se inventa ningún campo).
- Dependencias: T-113 (backend, sin hacer), T-128.
- Puede modificar: `frontend/src/components/auth/RegisterForm.astro`, `frontend/src/lib/server/register.ts`, `frontend/src/lib/api/identity.ts` (solo los tipos nuevos).
- Protegido: lo demás.
- Resultado esperado y criterios: se cierran cuando T-113 fije el contrato (campo `Field type="date"` con "Debes tener 18 años o más", validación en el servidor por el backend, tratamiento de dato personal sin registrarlo en consola). Firmas, pruebas y revisión manual se completan entonces.
- Estado inicial: BLOCKED (T-113)
- Entrega: RT-11; `feat(frontend): fecha de nacimiento en el registro (T-131)`.
- IDs reservados: ninguno.
- Escalar si: T-113 deja la edad en otra pantalla (p. ej. al comprar), no en el registro.

## 5. Huecos entre diseño, contrato y requisitos (este plan; complementan `VIEWS.md` §9)

| ID | Vista / paquete | Hueco | Tratamiento |
|---|---|---|---|
| G-1 | Registro (T-128, T-131) | Fecha de nacimiento (P-8): `ProfileOut` no la tiene hasta T-113. | Registro sin el campo; T-131 lo añade. |
| G-2 | T-122 | `/privacidad` y `/terminos` no existen en Figma y el registro los necesita. | Páginas de demostración con tokens. |
| G-3 | T-129 | `/cuenta` no tiene frame (RF01.03 y RF01.06 sin pantalla). | Diseño propio con BRIEF; es el destino de "Mi cuenta". |
| G-4 | T-121 | Colecciones de la portada (Classique…) no existen; "destacado" tampoco. | Mosaicos = categorías reales (`GET /categories`); bloque "Novedad" = `sort=newest` (dato real). Alternativa: estática. |
| G-5 | T-124 | Banner "Destacado del mes", filtro "Complicación", vista lista, badges: sin contrato. | Estático y no interactivo (D-041 P-2); badges no se pintan. |
| G-6 | T-125 | "El Calibre" y "Artesanía" (cifras por modelo) sin contrato (H-07). | No se implementan. |
| G-7 | T-119 | Contadores de carrito y deseos en la cabecera exigen `GET /cart` y `GET /wishlist` en cada página. | Fuera; si se piden, las páginas públicas pasan a `Cache-Control: private`. |
| G-8 | T-126, T-128 | `emailRedirectTo` de la confirmación debe estar en `additional_redirect_urls` de Supabase. | §6. |
| G-9 | T-127 | "Recuérdame", "¿Olvidaste tu contraseña?" y reenviar confirmación (RF01.04 POSTERIOR). | Omitidos. |
| G-10 | T-083 (ajuste) | `OrderSummaryOut` (listado) no trae imágenes ni líneas: las "hasta 2 miniaturas" de "Mis pedidos" no tienen dato (P-7 solo cubre el detalle). | Omitir miniaturas en el listado, o ampliar el listado con `api-contract-review`. |

## 6. Dependencias, configuración y riesgos

- **Dependencias nuevas** (todas requieren aprobación del usuario; ver pregunta 9): `@supabase/ssr` y `@supabase/supabase-js` (T-126, producción); `vitest`, `happy-dom`, `@playwright/test`, `@axe-core/playwright` (T-130, solo desarrollo). **No** requieren dependencia: fuentes (API de fuentes de Astro), variables de entorno (`astro:env`), iconos (SVG propios), menú móvil (`popover`).
- **Aviso al Leader (config, puerta Docker D-011):** el enlace del correo de confirmación debe volver a `/auth/callback`. `supabase/config.toml` permite hoy solo `http://localhost:4321`; hay que añadir `http://localhost:4321/auth/callback` a `additional_redirect_urls` (y su equivalente en producción, `deploy/compose.yml`). Requiere reiniciar Supabase. Alternativa sin tocar la config: `emailRedirectTo` = `http://localhost:4321` y que el middleware trate `?code=` en `/` (más frágil).
- **Aviso al Leader (revisión manual):** T-126 necesita `frontend/.env` con `SUPABASE_ANON_KEY` (y `SUPABASE_URL`, `API_BASE_URL` si difieren de los valores por defecto). `scripts/review-up.sh` puede generarlo desde `npx supabase status -o env` (sin imprimir la clave) y debe reiniciar `astro dev` si el archivo cambia. `docs/setup.md` §3 debe nombrarlo.
- **R-UI-1:** `astro dev` ya en marcha no recoge variables de entorno nuevas: reiniciarlo tras crear `.env`.
- **R-UI-2:** el consentimiento de privacidad se registra en el backend al confirmar el correo (no al enviar el formulario): `privacy_accepted_at` refleja el momento de la confirmación. Revisar con backend-lead si la Ley 29733 exige la fecha del alta.
- **R-UI-3:** el mínimo de contraseña de Supabase local es 6 (`minimum_password_length`); recomendar subirlo (≥ 8) en `config.toml` y producción: decisión de seguridad del Leader.
- **R-UI-4:** si el contador de carrito o deseos entra en la cabecera, hay que quitar el `public` de la caché de portada, catálogo y ficha.
- **R-UI-5:** la imagen de producto viene de Storage (`http://127.0.0.1:54321/storage/v1/...` en local): se usa `<img>` simple (sin el servicio de imágenes de Astro) para no declarar dominios; el recorte lo hace el CSS.
- **R-UI-6:** `/dev/*` existe solo en desarrollo; QA verifica que en `npm run build` + `astro preview` respondan 404.
- **R-UI-7 (D-014):** la decisión de Preact se toma con la isla `Cart` de T-060: la medida es el número de líneas de manipulación de DOM del módulo de la isla (`wc -l` de `src/islands/cart*.ts` sin imports ni tipos) frente al umbral de ~200. Las islas de T-126 a T-129 son pequeñas (`password-toggle`) y no cuentan.

## 7. Ajustes propuestos a los paquetes existentes (no se editan sus STATUS; los aplica el Leader o module-coordinator)

| Paquete | Ajuste |
|---|---|
| **T-060** carrito | Dependencias: T-116…T-119, T-120, T-123, T-126. Firmas: las funciones de `lib/api/cart.ts` reciben `t: Transport` primero (`getCart(t)`, `addToCart(t, productId, quantity?)`, `updateCartItem(t, productId, {quantity?, selected?})`, `removeFromCart(t, productId)`); la isla usa `browserTransport` (`/bff/cart…`) y la página `/carrito` pinta el `CartOut` inicial desde el servidor (`apiFor(locals)`) y se lo pasa a la isla. Figma: `43:285`, `43:297` (Stepper), `43:306`/`43:311` (líneas), `43:339` (resumen); `QuantityStepper`, `Stepper` y `Checkbox` de selección son nuevos o de T-117. Dividir (IDs T-132…T-135): (a) `cart.ts` + `QuantityStepper` + `Stepper`; (b) `/carrito`, `CartLine`, `OrderSummary`, isla `Cart` (medida D-014); (c) isla `AddToCart` en el slot `actions` de `BuyBox` (toca `[slug].astro` de T-125). Estado: pasa a READY cuando se integren T-116…T-126. Sin sesión, "Añadir" redirige a `/ingresar?next=`. Con contadores en cabecera: R-UI-4. |
| **T-069** deseos | Dependencias: T-120, T-123, T-126 (no T-111). Reutiliza `ProductCard` (variantes `wishlist` y `compact`), no crea otra tarjeta; la isla `WishlistToggle` modifica `ProductCard` (slot `action`) y obtiene el estado inicial de `GET /wishlist` en el servidor (una petición por página con sesión). Figma: `40:686`, `40:699`, `40:704`/`40:706`. El bloque "También te gustarán" (`40:753`) se omite (H-09: sin contrato; D-041 P-2). "Pasar al carrito" depende de `cart.ts` (T-132). Firmas con `t: Transport` primero. Ruta `/cuenta/lista-de-deseos`. |
| **T-054** promociones | El precio tachado en tienda ya lo cubren `Price` (T-118), los tipos de T-120 y las tarjetas de T-123/T-125: se retira de su alcance. Queda el **backoffice** (sin frames, `admin` no capturado): `BackofficeLayout`, guardia de rol (solo experiencia), lista permitida de `/bff` para `promotions/admin` o formularios SSR. Dependencias: T-126 y un paquete de diseño del backoffice (VIEWS §11.10), aún sin ID. Ruta de componentes: `components/backoffice/promotions/**` (no existe `components/storefront/`). Estado: BACKLOG. |
| **T-081** cliente de orders | Dependencias: T-120 y T-126; solo T-074…T-076 (cliente final) están en `main`: dividir en cliente final (listo para READY) y administración (espera a T-078/T-079). Firmas con `t: Transport` primero; `createOrder(t, idempotencyKey, delivery)` pasa la clave por `Idempotency-Key` (el proxy `/bff` la reenvía); `listOrders(t, { status?: OrderStatus[], page?, page_size? })` (parámetro repetido, T-075); `OrderLine` incluye `image: {url, alt} | null` (P-7). |
| **T-082** checkout | Dividir: (a) **entrega y creación del pedido** (`/checkout`, `/checkout/confirmacion/[order_id]` con el estado `pendiente_pago` y su cuenta atrás), listo cuando estén T-060 y T-081; (b) **pago** (tarjeta solo en el cliente, P-4) cuando exista la SPEC de payments (T-090+). Figma: `43:374`, `43:386` (stepper), `43:407` (formularios), `43:459` (resumen); `43:503`, `43:516`, `43:523`, `43:538`, `43:550`. Resumen y líneas salen de `GET /cart` (trae `image` y `slug`: no hace falta ampliar `CheckoutLine`). Campos de ubigeo como texto (H-11). Clave de idempotencia con `crypto.randomUUID()` guardada en `sessionStorage` por intento. Dependencias: T-117…T-119, T-126, lote 2 de `ui/` (`Stepper`). |
| **T-083** mis pedidos | Figma: `54:335`, `54:347`, `54:357`, `54:374`/`54:375`, `54:440`; detalle `54:463`, `54:475`, `54:488`, `54:514`, `54:516`, `54:533`, `54:547`, `54:562`, `54:577`. **Sin** `Payment_Card`, "Rastrear envío" ni "Solicitar devolución" (H-17). Mapa de estados agrupados solo en el frontend (`lib/orders/status.ts`, P-6) y filtro con `status` repetido. Hueco G-10: el listado no trae miniaturas. Dependencias: T-123 (`Breadcrumb`, `Pagination`), `Chip`, `Badge`, `Timeline` (lote 2), T-126. |
| **T-084** backoffice de pedidos | Sin frames (`admin` no capturada) y depende de T-078/T-079 (BACKLOG). Queda en el carril de backoffice, tras el diseño desde BRIEF; no entra en esta pista. |

## 8. Traspasos

#### Traspaso T-116 (planificación de la pista de frontend) — 2026-11-26 — frontend-lead
Plan completo en este documento. Estado: IN_REVIEW. Sin pruebas ejecutadas (planificación; solo documentación). Archivos: `docs/modules/ui/STATUS.md` (nuevo) y una aclaración en `docs/design_ui/VIEWS.md` §11. Preguntas para el usuario, ajustes a paquetes existentes, filas de `tasks.md` y línea de rangos: ver el traspaso final entregado al Leader.

## 9. Discrepancias y riesgos

- `VIEWS.md` §2 dice portada, ingreso y registro "estáticos"; este plan los hace SSR: la portada por las categorías reales (G-4) y ingreso y registro porque su formulario es un `POST` de la propia página (cookie de sesión). Se anota una aclaración en `VIEWS.md` §11.
- `T-081` pide "T-074…T-079 integradas": solo T-074…T-076 están en `main`; la parte del cliente final (crear, listar, ver y cancelar) puede arrancar ya, la de administración espera a T-078 y T-079.
