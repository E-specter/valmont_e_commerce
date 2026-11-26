# Valmont — Brief técnico de diseño y marca

> **Estado: PROPUESTO (T-110, D-031).** Fuente: archivo de Figma `xRC4mg5JmdqlZ6mbv97kGO` (VALMONT), página `guide_design_brand` (8 tableros, nodos `125:12833` … `125:14095`) más los frames de producto que la acompañan. Extraído el 2026-11-26 por frontend-lead; **no se vuelve a consultar** lo que aquí consta (cuota de Figma, D-031). Inventario de vistas: [VIEWS.md](VIEWS.md).
> **Cómo leerlo:** `[F: nodo]` = valor leído en Figma. `PROPUESTA` = el diseño no lo define y lo propone frontend-lead (decide el Leader o el usuario). `INFERIDO` = deducido de capturas o del contexto; verificar al implementar.
> **Autoridad:** sustituye a los tokens provisionales de `DESIGN.md` §2–§6 (que eran una propuesta anterior a Figma, con otra paleta y otras tipografías). `DESIGN.md` conserva el flujo (§8) y la lista de revisión (§9).

## 1. Marca

- **Promesa** [F: 125:14165]: "Alta relojería mecánica para el mundo moderno." Voz: experta, directa, cálida.
- **Principios** [F: 125:12899]: (1) contraste con propósito (marfil y verde estructuran; amarillo y menta señalan acción, estado y acento); (2) retícula visible (bordes, tablas, dameros: "la precisión también se ve"); (3) editorial + funcional (display contundente para el relato; Geist para tareas, datos y formularios).
- **Personalidad** [F: 125:13015]: precisa, audaz, contemporánea, experta. "El lujo se expresa mediante criterio, no ornamento."
- **Wordmark** [F: 125:13037]: `VALMONT` en Jaro, mayúsculas, tracking −2 % a 1 %, proporción horizontal. Área segura = 1 × la altura de la V. Negro sobre marfil o marfil sobre verde; el amarillo se reserva para el símbolo o la acción. No deformar, recolorear, inclinar ni encerrar. No sustituir por una fuente de cuerpo.
- **Símbolo** [F: 125:13047, en los headers `1:120`]: rosa mecánica de ocho rayos (SVG; descargarlo con `download_assets` en la tarea de implementación, no existe aún en `frontend/public/`). Sirve de separador, pivote, favicon o marca de precisión; nunca como textura de fondo repetida.
- **Lockup de cabecera** [F: 1:116]: wordmark + símbolo + descriptor ("Alta relojería mecánica para el mundo moderno.") + enlaces + damero.
- **Damero** [F: 125:13065]: franja de módulos 1:1 que alterna `ink`/`ivory` (storefront) o `forest`/`mint` (auth). Escala 16–32 px (los frames usan 45 × 24 en tableros y 45 × 32 en auth). Debe tocar el borde del contenedor, un solo damero dominante por región, sin degradados ni sombras. Cierra header y footer.
- **Proporción 60/30/10** [F: 125:13023]: 60 % marfil · 30 % verde · 10 % acento (amarillo). En backoffice se invierte (verde dominante, amarillo como señal).
- **Dos contextos** [F: 125:14067]: *storefront* (narrativo, fondo marfil, foto protagonista, CTA amarillo) y *backoffice* (operativo, fondo verde, Geist domina, densidad alta, sidebar 260 px). El backoffice **no se capturó** (D-031/T-111): se diseña desde este brief.
- **Incoherencias del propio Figma** que no se copian: ver §12.

## 2. Color

Valores de la paleta [F: 125:13186 muestras · 125:13232 roles]. Hex exactos; la columna `CSS` es la variable que se crea en `frontend/src/styles/tokens.css` (T-12x, propuesta).

| Token (rol) | Hex | CSS | Uso según Figma |
|---|---|---|---|
| Negro relojero | `#0F0F0F` | `--color-ink` | wordmark, texto, controles, damero |
| Verde profundo | `#002312` | `--color-forest` | fondos inmersivos, auth, bordes 15–35 %, cabeceras de tabla |
| Verde muy oscuro | `#001A0B` | `--color-forest-deep` | superficies elevadas de backoffice, tarjetas oscuras [F: 125:13298] |
| Verde Valmont | `#003E1F` | `--color-forest-mid` | títulos, líneas, filtros activos, texto secundario sobre mint |
| Menta | `#B3EFB2` | `--color-mint` | secundarios, éxito/enviado, destacados, CTA en auth |
| Menta suave | `#D5FFD9` | `--color-mint-soft` | fondos auxiliares, "HAZ", texto sobre verde |
| Amarillo calibre | `#FFD900` | `--color-yellow` | CTA, activo, alerta, foco |
| Marfil | `#FFFDE4` | `--color-ivory` | canvas del storefront |
| Blanco técnico | `#FFFFFF` | `--color-white` | tarjetas, formularios, tablas |
| Gris verdoso | `#5B645D` | `--color-slate` | texto secundario sobre claro [F: 125:12999 y ss.] |
| Rojo | `#FF4D4D` | `--color-red` | error / pendiente crítico [F: 125:13251] |
| Rojo pálido | `#FFF1F1` | `--color-red-soft` | fondo de "EVITA" y de error |
| Ciruela | `#7D5470` | `--color-plum` | "Cancelado" [F: 54:429] (texto blanco) |
| Rojo sobre claro | `#B3261E` | `--color-red-strong` | **PROPUESTA** (ver §11): el rojo de Figma no llega a AA sobre claro |

**Roles semánticos** [F: 125:13233]. Los nombres describen función, no color:

| Rol | Valor | CSS |
|---|---|---|
| `background/primary` | ivory | `--bg-page` |
| `background/inverse` | forest (auth y relatos de producto) | `--bg-inverse` |
| `surface/card` | white | `--bg-surface` |
| `surface/elevated-dark` (backoffice) | forest-deep | `--bg-surface-dark` |
| `stroke/default` | forest al 15–35 %, 1 px | `--stroke-default` = `rgb(0 35 18 / .33)`; `--stroke-soft` = `rgb(0 35 18 / .2)` (filas de tabla); `--stroke-strong` = forest 100 % (tarjetas de producto y pedido) |
| `stroke/on-dark` | mint al 33 % | `--stroke-on-dark` = `rgb(179 239 178 / .33)` |
| `text/primary` · `text/secondary` · `text/on-dark` · `text/accent-on-dark` | ink · slate · ivory · yellow | `--text-primary` · `--text-secondary` · `--text-on-dark` · `--text-accent` |
| `state/active` · `success` · `error` · `cancelled` | yellow · mint · red · plum | `--state-active` … |

- Los frames usan además grises sueltos: `#E9E9E9` (divisor de tarjeta y borde de miniatura), `#444` (texto de ficha corta). **PROPUESTA:** absorberlos como `--stroke-soft` y `--text-secondary`; no crear tokens nuevos.
- **Jerarquía** [F: 125:13294]: storefront = marfil → tarjetas blancas → títulos verde/negro → CTA amarillo → menta para apoyo y éxito. Backoffice = verde profundo → superficies verdes elevadas → texto marfil → cifras y selección en amarillo.
- **Reglas** [F: 125:13304]: un solo amarillo prioritario por región; nunca amarillo para párrafos ni texto pequeño sobre marfil; no usar menta sobre blanco sin borde; no usar rojo como decoración de marca.
- **Estados** [F: 125:13232]: "nunca comuniques un estado solo con color: añade texto, icono o forma".

## 3. Tipografía

Cuatro familias, con roles cerrados [F: 125:13361]. Las cuatro están en Google Fonts con licencia OFL (verificar al integrar). **PROPUESTA:** alojarlas localmente (`@font-face`, `font-display: swap`, subconjunto latino + latino extendido, precarga de la de titulares) por RNF03 (LCP) y privacidad.

| Familia | Rol | CSS |
|---|---|---|
| **Jaro** 400 (`opsz` 6) | wordmark, enlaces de marca, botones expresivos, cifras enormes | `--font-brand` |
| **Phudu** 600/700 | H1–H3, títulos de tarjeta, precios destacados | `--font-heading` |
| **Staatliches** 400 | cuerpo editorial, breadcrumb, metadatos, etiquetas y precios de tienda | `--font-editorial` |
| **Geist** 400/500/600/700 | interfaz: formularios, dashboard, ayuda, microcopy, lectura extensa | `--font-ui` |

**Escala** [F: 125:13387]: tamaño / interlineado en px; el tracking es porcentaje (−2 % de 26 px = −0,52 px).

| Token | Familia | Desktop | Mobile | Tracking | CSS (`--text-…`) |
|---|---|---|---|---|---|
| Display/01 | Jaro | 128/106 | 54/46 | −2 % a 1 % | `display` |
| Heading/01 | Phudu 700 | 60/66 | 42/46 | 0 % | `h1` |
| Heading/02 | Phudu 600 | 42/46 | 32/36 | 1 % | `h2` |
| Heading/03 | Staatliches | 30/39 | 24/31 | 1 % | `h3` |
| Body/editorial | Staatliches | 20/28 | 18/25 | 1 % | `body-editorial` |
| Body/UI | Geist 400 | 16/24 | 15/22 | 0 % | `body-ui` |
| Caption | Geist 700 | 14/15 | 12/14 | −2 % | `caption` |

- Estilos con nombre en Figma: `Link` = Jaro 26/1,39, −2 % [F: 125:13750]; `Body` = Staatliches 20/1,39, +1 % [F: 43:413]. `get_variable_defs` devolvió casi vacío: **Figma no tiene variables de color ni de tamaño enlazadas**; todos los valores de este brief salen de los valores literales de los nodos. Variables con nombre halladas: `Accent/Accent 1 #0F0F0F`, `Background/Background 1 #FFFDE4`, `Divider 1 #002312`, `Background/Background 2 #B3EFB2`.
- Escala responsive: PROPUESTA `clamp()` entre las columnas Mobile y Desktop (sin saltos de breakpoint).
- Pesos [F: 125:13449]: Jaro 400 · Phudu 600 editorial / 700 datos · Geist 400 lectura, 500, 700 etiquetas.
- Capitalización [F: 125:13463]: MAYÚSCULAS en wordmark, CTA, navegación y etiquetas cortas; *sentence case* en microcopy, mensajes y ayuda. Sin justificar. 55–75 caracteres por línea en lectura extensa.
- Prohibido [F: 125:13481]: Jaro en párrafos, Phudu en microcopy, más de dos estilos display compitiendo en una vista.
- Precios: `font-variant-numeric: tabular-nums` (PROPUESTA, hereda de DESIGN.md §3). Formato `S/ 84,500` = `Intl.NumberFormat('es-PE', {style:'currency', currency:'PEN'})` con el entero en céntimos que da el servidor (D-015). Figma muestra enteros sin decimales: **decisión de formato pendiente** (ver VIEWS §9, pregunta P-3).
- **Contradicción interna de Figma:** los frames de tienda usan Staatliches (solo mayúsculas, 20 px) también dentro de los campos de formulario (`43:414`), pero el tablero 04 asigna los formularios a Geist. **Gana el tablero 04** (la guía es la base obligatoria): campos y texto de entrada en Geist. Staatliches queda para etiquetas, metadatos y precios.
- Texto mínimo: la guía exige ≥ 14 px (cuerpo recomendado 16) [F: 125:14198] pero los frames usan 11–13 px en metadatos. **PROPUESTA:** cuerpo ≥ 16, interfaz ≥ 14, metadato decorativo ≥ 12 con contraste ≥ 4,5:1.
- Glifos: comprobar `ñ ¿ ¡ á é í ó ú ü` en las cuatro familias antes de cerrar la integración (los frames muestran tildes correctas, no se ha probado `¿ ¡` en Staatliches).

## 4. Espaciado, bordes y forma

- **Escala** [F: 125:13604]: base 4, múltiplos de 8. `4 · 8 · 12 · 16 · 24 · 32` (verde) y `48 · 64 · 80` (amarillo). Uso: 4–12 iconos y microespacio · 16–24 componentes · 32–48 tarjetas y bloques · 64–80 secciones. CSS: `--space-4 … --space-80`.
- **Ritmo vertical** [F: 125:13639]: entre capítulos de página 80–100; sección 40–64; padding de tarjeta 16–32.
- **Radios** [F: 125:13652 + frames]: `--radius-xs` 2 (badge cuadrado de producto `51:398`) · `--radius-sm` 4 (controles, paginación, campos de checkout, miniaturas) · `--radius-md` 8 (tarjetas e inputs; **por defecto**) · `--radius-lg` 12–24 (solo capas flotantes: chat, overlay) · `--radius-pill` 999 (chips, filtros, badges de estado, botones CTA).
- **Bordes** [F: 125:13663]: 1 px al 15–35 % (`--stroke-default`); 2 px en foco y alertas. Tarjetas de producto y de pedido: 1 px forest sólido.
- **Sombras:** Figma **no define ninguna** (superficies planas separadas por borde). **PROPUESTA:** ninguna, salvo `--shadow-overlay: 0 8px 24px rgb(0 18 9 / .18)` para chat y desplegables (el drawer del chat en `104:384` se ve elevado).
- **Elevación** de backoffice: por color de superficie (forest → forest-deep), no por sombra.

## 5. Movimiento

Figma **no define duraciones, curvas ni transiciones**; solo implica un "nodo pulsante" en el paso actual de la línea de tiempo de pedido [F: 54:497] y un estado hover para el botón ("Hover/foco nunca cambia el significado", 125:13764). **PROPUESTA** (hereda DESIGN.md §5): `--dur-state: 150ms` · `--dur-appear: 250ms` · `--dur-page: 400ms` · `--ease: cubic-bezier(0.2, 0, 0, 1)`. El pulso del paso actual y cualquier animación no esencial se desactivan con `prefers-reduced-motion: reduce`. Sin carruseles automáticos.

## 6. Retícula, contenedores y breakpoints

- **Retícula** [F: 125:13535 · 125:13554 · 125:13569]: desktop 1280–1440 → **12 col**, gutter 12 · tablet 800 → **8 col**, gutter 12 · mobile 375 → **4 col**, gutter 8; "margen exterior proporcional". Frames de diseño: **1280 / 800 / 375** (la portada y "nosotros" tienen las tres; auth, catálogo, pagos, pedidos y wishlist solo desktop 1280–1440).
- **Contenedor storefront** [F: 125:13581]: ancho máximo 1280; margen lateral **30** en editorial (catálogo, pedidos) y **60** en transaccional (carrito, checkout, wishlist).
- **Contenedor backoffice** [F: 125:13590]: 1440, sidebar fijo 260 (no se colapsa en desktop).
- **Breakpoints — PROPUESTA** (Figma da anchos de diseño, no breakpoints): mobile-first desde **360** (RNF04; el frame de 375 es el de referencia); `--bp-tablet: 800px`; `--bp-desktop: 1280px`. Las variables CSS no valen en `@media`: se escriben como literales o se usan *container queries*. Sustituyen a `sm/md/lg/xl` de DESIGN.md §6.
- **Reordenación responsive** [F: 125:13669]: desktop = *split layouts*, grids de 3–4, resumen lateral, tablas completas · tablet = apila el split, grid de 2, filtros envueltos, sidebar a barra · mobile = una columna, CTA a todo el ancho, tarjetas apiladas, línea de tiempo vertical. "Reorganiza la jerarquía; no comprimas proporcionalmente." Objetivo táctil ≥ 44 × 44.
- Patrón de desbordamiento: el `Decorative border` del header mide 1997 px en un frame de 1280 [F: 1:135]; implementar como franja que ocupa el 100 % del contenedor con `overflow: clip`, no como un ancho fijo.

## 7. Componentes base: variantes y estados

Estados obligatorios en todo interactivo: reposo · hover · `focus-visible` · activo/pulsado · deshabilitado · cargando · error. Foco [F: 125:13301]: **anillo de 2 px, amarillo sobre verde; negro sobre amarillo o marfil; offset ≥ 2 px**. Los estados que Figma no dibuja se marcan PROPUESTA. Detalle de uso por vista y matriz: [VIEWS.md](VIEWS.md) §8.

| Componente | Variantes [F] | Estilo observado | Estados no dibujados |
|---|---|---|---|
| **Button** [125:13758; 55:412; 43:355] | `primary` amarillo + texto ink + borde 1,5 px ink, píldora (Añadir al carrito, Descubrir, Confirmar pedido) · `dark` verde con texto marfil (Primario del tablero 06) · `secondary` outline/marfil (Ver detalle) · `mint` sobre fondo verde (Crear cuenta) · `link` texto subrayado con flecha (Ver detalle →) | Jaro mayúsculas 20–26 px, padding ≈ 26 × 8 (tablero) / 32 × 16 (frames) | hover, foco, deshabilitado, cargando |
| **IconButton** | corazón circular 32 px (tarjeta) y 56 px (ficha), cierre ×, enviar | blanco, borde forest, radio píldora | hover, activo (relleno si guardado) |
| **Input** [125:13781; 32:634; 43:413] | normal · foco (borde 2 px amarillo) · error (borde 1 px rojo + mensaje) · con icono a la izquierda · con acción a la derecha (ojo, tarjeta) | blanco, radio 8 (4 en checkout), padding 14 × 11, etiqueta Geist 11 bold mayúsculas | deshabilitado, solo lectura, éxito |
| **Checkbox / Toggle** [32:648; 51:375] | caja 20 px radio 4 con marca mint · interruptor 40 × 20 | | foco, deshabilitado |
| **Chip / Pill de filtro** [125:13798; 54:357] | activo relleno `forest`+ivory · inactivo outline · amarillo · mint · rojo · removible con × · "Limpiar" | píldora, Geist/Staatliches 11–12 mayúsculas, padding 12 × 6 | hover, foco |
| **Badge de estado** [54:380 · 54:397 · 54:413 · 54:429] | amarillo (En tránsito) · forest + texto blanco (Entregado) · outline (En preparación) · ciruela + texto blanco (Cancelado) | píldora, Staatliches 12 | — |
| **Badge de producto** [51:398] | "Nuevo", "Edición limitada" | amarillo, borde negro 1 px, radio 2, Jaro 12 mayúsculas | — |
| **Card de producto** [51:395] | tienda (imagen 16:9 recortada) · ficha relacionada · wishlist (imagen alta, botón Descubrir) · compacta (miniatura 100 px) | blanca, borde forest 1 px, radio 8, padding 16, imagen radio 6, divisor `#E9E9E9` | hover, foco, sin imagen, agotado |
| **Precio** | normal · con promoción (original tachado) | Phudu 600 20 px (tarjeta), Phudu 700 (ficha) | — |
| **Disponibilidad** [55:400] | punto 10 px + texto ("En stock — Envío asegurado gratuito") | | las 4 del contrato: in_stock, low_stock, out_of_stock, on_request (ver VIEWS §9) |
| **Breadcrumb** [51:336] | Inicio > Sección > Actual | Staatliches 12–14, separador `>` | — |
| **Pagination** [51:554; 54:440] | página activa amarilla (tienda) o forest (pedidos) · "Siguiente →" | caja 32–36 px radio 4 | deshabilitada, foco |
| **Stepper** [43:386] | 4 pasos numerados; activo amarillo | círculo 24 px | completado (INFERIDO) |
| **Timeline de pedido** [54:488; 125:13848] | nodo hecho · actual (pulsante, negrita) · pendiente + línea | nodo 14–16 px | — |
| **Order summary** [43:339; 54:547] | carrito · checkout · detalle de pedido | blanca, padding 28–32, líneas Staatliches | cargando |
| **Table** [125:13824] | cabecera forest + filas con pill (backoffice) | cabecera Geist 10 bold | ordenación, vacío |
| **KPI / Alert** [125:13866 · 125:13870] | oscuras (forest-deep) | cifra Staatliches 34 amarilla | — |
| **Chat / Asistente** [104:348 · 104:384 · 104:521] | disparador (píldora "Chat con AI" o FAB redondo 72 px) · ventana 320–360 × 303–559 (cabecera, mensajes bot/usuario, respuestas rápidas, entrada) | radio 12–24, borde, sombra suave | cargando, error, modo degradado (RF08.07) |
| **Header / Footer** [1:116; 1:235] | cabecera: wordmark + símbolo + descriptor + 3 enlaces + damero; pie: enlaces + contacto + wordmark gigante + damero | | menú móvil (no dibujado) |

## 8. Iconografía [F: 125:14171]

Estilo Lucide (INFERIDO por los nombres: `search`, `heart`, `heart-off`, `shopping-bag`, `message-circle`, `bell`, `bot`, `x`, `x-circle`, `send`, `check`, `lock`, `mail`, `eye`, `clock`, `calendar`, `user`, `settings`, `credit-card`, `chevron-down`, `arrow-right`, `grid`, `list`, `edit-3`, `sparkles`, `smile`). Trazo 1,5–2 px, terminal redondo, tamaño 16–24 px (los frames usan 10–32). Siempre con etiqueta si la acción no es universal. **PROPUESTA:** SVG propios en `components/ui/Icon.astro` (un `<symbol>` por icono, sin dependencia); no añadir `lucide` salvo aprobación.

## 9. Imagen y fotografía [F: 125:14144]

- **Producto héroe:** 3/4, detalle nítido, fondo oscuro, metal cálido. **Proceso artesanal:** manos, herramienta y textura; luz dirigida. **Boutique/contexto:** humano, sobrio, táctil; evita el *lifestyle* genérico. "Producto como instrumento; artesanía como evidencia."
- Recorte: tarjeta de tienda con imagen panorámica (relación ≈ 6:1 en el frame `51:396`, probable error de maquetación: ver §12) y `object-cover`; ficha con principal 712 × 593 y 4 miniaturas ≈ 170; wishlist 365 × 380; carrito 140 × 140; pedidos 64 × 64; confirmación 50 × 50; compacta 100 × 100.
- Alt [F: 125:14201]: describe producto y contexto. Las imágenes vienen del contrato (`main_image`/`images[]`/`image` con `alt` obligatorio); nunca se inventan.
- Fotos de stock genéricas, lorem ipsum y fotografía ajena al relojería están vetadas [F: 125:14274]; los frames de wishlist y checkout traen fotos de cócteles como relleno: no son contenido.
- **PROPUESTA:** `width`/`height` explícitos, `loading="lazy"` salvo la imagen principal (LCP), `fetchpriority="high"` en la principal de ficha, `srcset` si el almacenamiento lo permite.

## 10. Voz, tono y microcopy [F: 125:14164]

- Experta, directa, cálida. Verbo al inicio y una acción por botón. Explicar consecuencias antes de confirmar.
- CTA: "Descubrir", "Ver mi pedido", "Confirmar pedido". Ayuda: "Pago seguro y protegido". Error: "Revisa el número de tarjeta e inténtalo nuevamente" (explica qué hacer, sin culpar).
- Fechas y moneda locales: "15 de agosto · S/ 84,500" (`Intl` con `es-PE`; PENDIENTE de P-3 el formato de decimales).
- **Todo en español.** Los frames mezclan francés (`Retirer`, `Sous-total`, `Offerte`, `Ville`, `Nombre/Apellidos` con datos "Jean/Valmont", "18 Rue du Faubourg Saint-Honoré", "+33…") y español: se corrige a español (VIEWS §9). Vetado: lorem ipsum, mensajes culpabilizantes, mezcla de idiomas.
- Mayúsculas por CSS (`text-transform`), no escritas en el HTML (accesibilidad y lectores de pantalla).

## 11. Accesibilidad (WCAG 2.2 AA, RNF07)

Checklist de la guía [F: 125:14195]: contraste AA y foco visible · texto mínimo 14 px (cuerpo 16) · objetivos táctiles 44 × 44 · estado comunicado con texto + forma · alt que describe producto y contexto · orden de lectura = orden visual. QA [F: 125:14214]: retícula y ritmo siguen tokens · ningún texto mezcla idiomas · imágenes mantienen encuadre · loading/vacío/error/éxito diseñados · responsive validado en 1280/800/375 · sin duplicar componentes.

**Contraste medido** (WCAG 2.x, calculado el 2026-11-26 sobre los hex de Figma; ≥ 4,5 texto, ≥ 3 texto grande y límites de controles):

| Par (texto / fondo) | Ratio | Veredicto |
|---|---|---|
| ink / ivory | 18,64 | AAA |
| forest / ivory | 16,35 | AAA |
| forest-mid / ivory | 11,95 | AAA |
| slate / ivory · / white | 5,96 · 6,13 | AA |
| ivory / forest | 16,35 | AAA |
| mint / forest · yellow / forest | 12,73 · 12,15 | AAA |
| ink / yellow · forest / yellow | 13,85 · 12,15 | AAA |
| forest / mint · forest-mid / mint | 12,73 · 9,31 | AAA |
| white / plum `#7D5470` | 6,22 | AA |
| yellow / forest-mid | 8,88 | AAA |
| **yellow / ivory** | **1,35** | **FALLA** (nunca texto; solo relleno con texto ink) |
| **mint / ivory** | **1,28** | **FALLA** (ni texto ni límite de control) |
| **red `#FF4D4D` / ivory** | **3,18** | **FALLA** como texto normal (≥ 3 solo grande/límite) |
| **red / red-soft `#FFF1F1`** | **2,98** | **FALLA** |
| red / forest · / forest-deep | 5,14 · 5,57 | AA (solo en fondos oscuros) |
| red-strong `#B3261E` / ivory · / white · / red-soft | 6,36 · 6,54 · 5,95 | AA (PROPUESTA para texto y borde de error sobre claro) |

- Las etiquetas de la guía son aproximadas ("Verde/Menta ≈ 10:1"; lo real es 12,73). Cualquier par nuevo se mide antes de usarse.
- Borde de campo sobre blanco: al 25 % (checkout `43:413`) da 1,71:1 y al 33 % (tablero 06) 2,08:1; **no cumplen 3:1 como límite de control** (WCAG 1.4.11). **PROPUESTA:** `--stroke-control: rgb(0 35 18 / .6)` (4,53:1; el 50 % ya da 3,32:1) y el 33 % solo para divisores decorativos.
- Foco: anillo 2 px con offset 2 (§7). Estado: texto + forma + color; el pulso de la línea de tiempo respeta `prefers-reduced-motion`.
- HTML semántico, un `h1` por página, `lang="es"`, etiquetas en los campos, `alt`. Mayúsculas por CSS.
- El "Chat" es diálogo no modal: foco gestionado, `Esc` cierra, `aria-live="polite"` para mensajes del asistente.

## 12. Defectos e incoherencias detectados en Figma (no se copian)

1. **Botones deformados:** las instancias `Button` (`32:655`, `32:663`, `43:355`) dibujan el fondo como SVG estirado, por eso salen como elipses o rectángulos de tamaños dispares (`159×54`, `560×80`, `251×51`). Se implementa un único componente `Button` en píldora con altura fija, no se copian las geometrías.
2. **Contraste:** "INGRESAR" en el frame de login (`32:655`) se ve texto verde claro sobre fondo menta (≈ 1,3:1, INFERIDO de la captura); usar ink sobre mint.
3. **Campos de auth sin límite visible** (sin borde ni fondo, `32:634`): se implementa con borde `--stroke-control` y fondo, no sin límite.
4. **Dos filtros "Complicación" idénticos** en el catálogo (`51:366` y `51:369`): el segundo es probablemente otro atributo (material o movimiento); ver VIEWS P-2.
5. **Imagen de tarjeta de catálogo** de 358 × 56 (`51:396`): recorte erróneo; la ficha relacionada usa 358 × 358 (`55:497`) y wishlist 365 × 380. Se adopta una relación de aspecto única por variante (PROPUESTA 4:5 o 1:1).
6. **Mezcla de idiomas y datos de relleno** (francés, direcciones de París, fotos de cócteles, `Colección Alta Relojería` inventada). Ver §10.
7. **Nombres de plantilla residuales:** sección "Flavors" y "Stocklist" en la portada (`1:226`, `1:231`); "Reflejos" en nombres. Se renombran por función.
8. **Cabecera sin carrito, cuenta, búsqueda ni lista de deseos**, y con enlaces distintos por frame (Nuestra historia/Boutiques/Contacto, Tiendas, Historia/Contáctanos). Ver VIEWS P-1.
9. **Estados de pedido** del diseño (Todos, En proceso, Enviado, Entregado, Cancelado, En tránsito, En preparación, Confirmado) no coinciden con los ocho estados del backend. Ver VIEWS §9 H-14.
10. **Texto mínimo** de la guía (14 px) vs. 11–13 px en los frames. Ver §3.
11. **Sin variables de Figma:** todo es literal; si el diseño cambia hay que releer valores (CU-D3 de D-031).

## 13. Mapa token → variable CSS (resumen para `tokens.css`)

```css
:root {
  /* color [§2] */
  --color-ink:#0F0F0F; --color-forest:#002312; --color-forest-deep:#001A0B; --color-forest-mid:#003E1F;
  --color-mint:#B3EFB2; --color-mint-soft:#D5FFD9; --color-yellow:#FFD900; --color-ivory:#FFFDE4;
  --color-white:#FFFFFF; --color-slate:#5B645D; --color-red:#FF4D4D; --color-red-soft:#FFF1F1;
  --color-plum:#7D5470; --color-red-strong:#B3261E; /* PROPUESTA */
  /* tipografía [§3] */
  --font-brand:'Jaro',sans-serif; --font-heading:'Phudu',sans-serif;
  --font-editorial:'Staatliches',sans-serif; --font-ui:'Geist',system-ui,sans-serif;
  /* espaciado [§4] */ --space-4:4px; --space-8:8px; --space-12:12px; --space-16:16px; --space-24:24px;
  --space-32:32px; --space-48:48px; --space-64:64px; --space-80:80px;
  /* forma [§4] */ --radius-xs:2px; --radius-sm:4px; --radius-md:8px; --radius-lg:16px; --radius-pill:999px;
  /* movimiento [§5, PROPUESTA] */ --dur-state:150ms; --dur-appear:250ms; --dur-page:400ms; --ease:cubic-bezier(.2,0,0,1);
  /* contenedores [§6] */ --container-max:1280px; --gutter-desktop:12px; --gutter-mobile:8px;
}
```

La traducción de los roles semánticos (`--bg-page`, `--text-primary`, `--stroke-*`) y de la escala tipográfica se hace en la tarea de implementación de los tokens, partiendo de las tablas de §2 y §3. Modo oscuro de sistema: **no aplica** (la identidad ya define contextos claro y oscuro por superficie; no hay tema por preferencia del usuario en Figma).
