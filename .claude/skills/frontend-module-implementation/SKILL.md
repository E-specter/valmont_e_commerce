---
name: frontend-module-implementation
description: Implementa páginas, componentes e islas del frontend Astro de Valmont e integra la salida de Kombai generada desde Figma. Úsala en cualquier tarea que cree o modifique frontend/src (pages, layouts, components, islands, lib/api, styles), al revisar código generado por Kombai, o al conectar una pantalla de Figma con datos reales del backend.
---

# Implementación de módulo frontend

Fuentes canónicas: `docs/modules.md` §5 (estructura y reglas), `docs/design_ui/DESIGN.md` (tokens, componentes, flujo Figma → Kombai, lista §9), la sección "Contrato API" de `docs/modules/<módulo>/SPEC.md` y la guía oficial de Astro en `frontend/AGENTS.md`.

## Procedimiento

1. **Contexto** (skill `context-handoff` §A): paquete de tarea, contrato, DESIGN.md §2–§7. Línea base: `cd frontend && npm run check && npm run build`.
2. **Decide el renderizado:**
   - página pública sin datos por usuario → estática (por defecto);
   - datos por usuario (cuenta, carrito, pedidos) → SSR. Requiere un adaptador de Astro; si aún no está configurado, es una decisión del frontend-lead: `BLOCKED`.
   - ¿necesita estado o interacción en el cliente? → isla en `src/islands/`, hidratada con `client:visible` o `client:idle` antes que `client:load`. Framework según D-014.
3. **Parte visual desde Figma (si la tarea trae un frame):**
   - Kombai lo maneja la persona desde VS Code: `@figma` + URL del frame (con `node-id`), sistema de diseño "Valmont", con la petición: "componente Astro en `frontend/src/components/<área>/<Nombre>.astro`, datos por props, sin fetch".
   - Un agente de Claude **no controla Kombai** salvo que esté configurado el Kombai MCP (`docs/setup.md` §5). Si necesitas ver el diseño tú mismo, usa el MCP de Figma (captura o contexto del frame) como referencia y adáptalo a los tokens.
   - Revisa la salida con la lista de `DESIGN.md` §9 y corrige las desviaciones. Los comentarios `<!-- ISLA: … -->` que deja Kombai son trabajo tuyo en `src/islands/`.
4. **Datos:** añade o extiende funciones tipadas en `src/lib/api/<módulo>.ts` según el contrato. Es el único lugar con `fetch`. Si el contrato no cubre un campo o endpoint, `BLOCKED` + skill `api-contract-review`; no lo inventes.
5. **Estados:** cargando · error (con reintento) · vacío · éxito · pendiente, en cada vista con datos.
6. **Accesibilidad:** HTML semántico, un solo `h1` por página, etiquetas en los campos, foco visible, navegación por teclado, `alt` descriptivo, contraste ≥ 4,5:1, `lang="es"`.
7. **Prohibido en el cliente:** calcular precios, totales o descuentos definitivos (se muestran los del servidor, RN-09), decidir permisos (RF13.02) y usar variables de entorno que no sean `PUBLIC_*`.
8. **Puertas** (skill `testing-and-quality-gates`) y **traspaso** (skill `context-handoff` §C). Incluye capturas o la ruta de la página para la revisión visual de frontend-lead.

## No hacer

- Añadir dependencias (`npm install …`) o integraciones (`astro add …`) sin aprobación de frontend-lead.
- Modificar `backend/` o contratos.
- Dejar valores de color, tamaño o tipografía sueltos fuera de los tokens.
