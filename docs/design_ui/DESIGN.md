# Valmont — Guía de diseño de interfaz

> **Estado: PROPUESTA PROVISIONAL.** No son activos oficiales de marca. Cuando exista el archivo de Figma de Valmont, sus variables pasan a ser la fuente canónica y este documento se actualiza para coincidir con ellas (D-006).
> Cuando existan `BRIEF.md` (tokens, tipografía, retícula, componentes y marca) y `VIEWS.md` (inventario de vistas), ambos pendientes de T-110/T-111, serán la fuente canónica de tokens y vistas. Hasta entonces, los tokens de este archivo siguen como PROPUESTA. Kombai fue eliminado (D-031).

## 1. Principios

Valmont es alta relojería mecánica. La interfaz transmite **precisión, elegancia, detalle, confianza y conocimiento del producto**.

- **Editorial antes que comercial:** jerarquía tipográfica clara, mucho espacio en blanco, imagen de producto protagonista.
- **El detalle de fabricación es contenido:** calibre, materiales y acabados se presentan como ficha técnica, no como letra pequeña.
- **Sobriedad:** pocas animaciones, cortas y con propósito. Nada de efectos que compitan con el producto.
- **Claridad en la compra:** el checkout es sobrio y explícito; el precio y la disponibilidad nunca se ocultan.
- **Accesible por defecto:** WCAG 2.2 AA (RNF07), totalmente utilizable con teclado y lector de pantalla.

**Evitar:** interfaces recargadas, componentes genéricos sin adaptar, sombras y degradados llamativos, carruseles automáticos, texto sobre imagen sin garantizar contraste.

## 2. Color (tokens provisionales)

| Token | Valor | Uso | Contraste verificado |
|---|---|---|---|
| `color.ink` | `#14130F` | Texto principal; superficies oscuras | 16,77:1 sobre `ivory` |
| `color.ivory` | `#F6F3EC` | Fondo principal | — |
| `color.surface` | `#FBFAF6` | Tarjetas y paneles elevados | — |
| `color.graphite` | `#5C5A55` | Texto secundario; bordes de campos de formulario | 6,22:1 sobre `ivory` |
| `color.graphite-on-dark` | `#A8A49B` | Texto secundario sobre `ink` | 7,48:1 sobre `ink` |
| `color.line` | `#DCD7CC` | Divisores **decorativos** solamente | 1,29:1 (no apto como límite de control) |
| `color.champagne` | `#B08D57` | Acento decorativo (filetes, iconos grandes); texto **solo** sobre `ink` | 2,79:1 sobre `ivory` ✗ · 6,01:1 sobre `ink` ✓ |
| `color.champagne-strong` | `#7E6034` | Enlaces, acento de texto y botón de acento sobre fondos claros | 5,25:1 sobre `ivory` |
| `color.danger` | `#9B2C2C` | Errores | 6,79:1 sobre `ivory` |
| `color.success` | `#2F6B45` | Confirmaciones | 5,73:1 sobre `ivory` |

Regla: todo par texto/fondo nuevo debe medir ≥ 4,5:1 (≥ 3:1 para texto grande y límites de controles) antes de usarse.

## 3. Tipografía (provisional)

| Rol | Familia | Uso |
|---|---|---|
| Display | **Cormorant Garamond** (Google Fonts, OFL) | Titulares, nombres de modelo, citas editoriales |
| Texto e interfaz | **Manrope** (Google Fonts, OFL) | Cuerpo, navegación, formularios, botones |

- Escala (rem): `0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 · 3 · 4`.
- Interlineado: display 1,1 · cuerpo 1,6.
- Etiquetas en mayúsculas: `letter-spacing: 0.08em`, tamaño ≤ 0,875 rem.
- Precios y especificaciones técnicas: `font-variant-numeric: tabular-nums`.
- Longitud de línea del texto corrido: 60–75 caracteres.

## 4. Espaciado, forma y elevación

- Espaciado base 4 px: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 128`.
- Radios: `0` (por defecto, aristas precisas) · `2 px` (campos y botones) · `999 px` (solo chips y filtros).
- Elevación: casi plana. Una sola sombra suave para menús y diálogos; las tarjetas se separan con espacio o `color.line`.
- Contenedor máximo: 1280 px; márgenes laterales 16 px (móvil) a 48 px (escritorio).

## 5. Movimiento

- Duraciones: `150 ms` (estado), `250 ms` (aparición), `400 ms` (transición de página o imagen).
- Curva: `cubic-bezier(0.2, 0, 0, 1)`.
- `prefers-reduced-motion: reduce` desactiva toda animación no esencial.

## 6. Responsive

| Punto de corte | Ancho mínimo | Uso |
|---|---|---|
| `sm` | 640 px | Móvil grande |
| `md` | 1024 px | Tableta y portátil pequeño |
| `lg` | 1280 px | Escritorio |
| `xl` | 1536 px | Pantallas grandes |

Diseño móvil primero desde 360 px. Objetivos táctiles de al menos 44 × 44 px.

## 7. Componentes y estados

**Inventario base:** encabezado y navegación · pie · botón (primario `ink`, acento `champagne-strong`, secundario con borde, texto) · enlace · campo de texto, selector, casilla, radio · chip de filtro · tarjeta de producto · galería de producto · tabla de especificaciones · precio (con promoción) · indicador de disponibilidad · línea de carrito con selección (RN-05) · resumen de pedido · línea de tiempo de estados de pedido · aviso (info, éxito, error) · diálogo · paginación · migas de pan · estado vacío · esqueleto de carga · panel del asistente.

**Estados obligatorios en cada componente interactivo:** reposo · hover · `focus-visible` (anillo de 2 px `champagne-strong` con 2 px de separación) · activo · deshabilitado · cargando · error.

**Estados obligatorios en cada vista con datos:** cargando · error (con acción de reintento) · vacío · éxito · operación pendiente.

## 8. Flujo Figma MCP → código (D-031)

1. **Figma:** cada pantalla o componente es un *frame* nombrado según el área (`storefront/ProductCard`). Se lee con el MCP oficial de Figma (plugin `figma`, OAuth con `/mcp`).
2. **Extracción (frontend-lead, T-110/T-111):** produce `docs/design_ui/BRIEF.md` (brief técnico de diseño y marca) y `docs/design_ui/VIEWS.md` (frame → ruta Astro → componentes reutilizables → datos/RF → estados, más la matriz de reutilización).
3. **Implementación (frontend-dev):** skill `figma:figma-design-to-code` solo para los nodos citados en su paquete. La salida de referencia (React + Tailwind) se adapta a Astro y a los tokens. Los componentes genéricos van en `frontend/src/components/ui/`; se reutiliza antes de crear. Cada nodo se consulta una vez (cuota de la API).
4. **Revisión:** frontend-lead revisa con la lista del §9 y se conectan los datos reales a través de `src/lib/api/`.
5. Si Figma limita la API (rate limit), se espera a la renovación de la cuota o se trabaja con las capturas ya guardadas; no se repiten consultas.

## 9. Lista de revisión de la implementación desde Figma

- [ ] Usa los tokens (§2–§5); no hay colores, tamaños ni fuentes sueltos.
- [ ] HTML semántico, `alt` en imágenes, etiquetas en los campos y orden de foco lógico.
- [ ] Contraste ≥ 4,5:1 en el texto.
- [ ] Sin `fetch` ni lógica de negocio en el componente; los datos llegan por props.
- [ ] Sin hidratación (`client:*`) salvo que el componente necesite estado; en ese caso va en `islands/`.
- [ ] Funciona desde 360 px y respeta `prefers-reduced-motion`.
- [ ] Textos de interfaz en español.
- [ ] Reutilización: no duplica un componente existente en `components/ui/` ni en `components/<área>/`.
- [ ] Captura de Playwright de la página comparada con `get_screenshot` del frame de Figma (fidelidad visual).
