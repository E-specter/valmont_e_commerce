---
name: frontend-module-implementation
description: Implementa páginas, componentes e islas del frontend Astro de Valmont a partir de Figma con su MCP (D-031). Úsala en cualquier tarea que cree o modifique frontend/src (pages, layouts, components, islands, lib/api, styles), al implementar un nodo de Figma, o al conectar una pantalla con datos reales del backend. Las pruebas las escribe qa-reviewer (D-033).
---

# Implementación de módulo frontend

Fuentes canónicas: `docs/modules.md` §5 (estructura y reglas), `docs/design_ui/DESIGN.md` (tokens, componentes, flujo Figma MCP, lista §9), `docs/design_ui/BRIEF.md` y `docs/design_ui/VIEWS.md` (pendientes de T-110/T-111; hasta entonces los tokens de `DESIGN.md` son PROPUESTA), la sección "Contrato API" de `docs/modules/<módulo>/SPEC.md` y la guía oficial de Astro en `frontend/AGENTS.md`.

## Procedimiento

1. **Contexto** (skill `context-handoff` §A): paquete de tarea, contrato, DESIGN.md §2–§7. Línea base: el último veredicto de QA en el STATUS (no escribes ni ejecutas pruebas ni el build, D-028, D-033).
2. **Decide el renderizado:**
   - página pública sin datos por usuario → estática (por defecto);
   - datos por usuario (cuenta, carrito, pedidos) → SSR. Requiere un adaptador de Astro; si aún no está configurado, es una decisión del frontend-lead: `BLOCKED`.
   - ¿necesita estado o interacción en el cliente? → isla en `src/islands/`, hidratada con `client:visible` o `client:idle` antes que `client:load`. Framework según D-014.
3. **Parte visual desde Figma (si la tarea trae un frame):**
   - Consulta solo los nodos citados en tu paquete, con la skill `figma:figma-design-to-code` (MCP de Figma). Cada nodo se consulta **una vez** (cuota): guarda lo que necesites en el traspaso en vez de repetir la consulta.
   - La salida de referencia es React + Tailwind: no se copia. Adáptala a Astro y a los tokens del proyecto (`BRIEF.md`/`DESIGN.md`), con datos por props y sin `fetch`.
   - Reutiliza antes de crear: revisa la matriz de reutilización de `VIEWS.md` y `src/components/`. Los componentes genéricos van en `frontend/src/components/ui/`; los de un área, en `components/<área>/`.
   - `modern-web-guidance` es obligatoria para todo HTML, CSS y JS de cliente; `frontend-design` para el acabado visual. Para dudas del framework, usa el MCP `astro-docs` (`.mcp.json`) o context7.
   - Revisa el resultado con la lista de `DESIGN.md` §9 y corrige las desviaciones. Lo que requiera estado en el cliente es trabajo tuyo en `src/islands/`.
4. **Datos:** añade o extiende funciones tipadas en `src/lib/api/<módulo>.ts` según el contrato. Es el único lugar con `fetch`. Si el contrato no cubre un campo o endpoint, `BLOCKED` + skill `api-contract-review`; no lo inventes.
5. **Estados:** cargando · error (con reintento) · vacío · éxito · pendiente, en cada vista con datos.
6. **Accesibilidad:** HTML semántico, un solo `h1` por página, etiquetas en los campos, foco visible, navegación por teclado, `alt` descriptivo, contraste ≥ 4,5:1, `lang="es"`.
7. **Prohibido en el cliente:** calcular precios, totales o descuentos definitivos (se muestran los del servidor, RN-09), decidir permisos (RF13.02) y usar variables de entorno que no sean `PUBLIC_*`.
8. Cierre:
   - **Análisis estático:** `npm run check`. El build y las pruebas los escribe y ejecuta qa-reviewer (D-028, D-033).
   - **Entrega preparada:** skill `version-control` §A.
   - **Traspaso:** skill `context-handoff` §C. Incluye los nodos de Figma consultados y la ruta de la página para la revisión visual de frontend-lead.

## No hacer

- Añadir dependencias (`npm install …`) o integraciones (`astro add …`) sin aprobación de frontend-lead.
- Modificar `backend/` o contratos.
- Crear o modificar pruebas, `conftest` o fixtures (D-033).
- Dejar valores de color, tamaño o tipografía sueltos fuera de los tokens.
