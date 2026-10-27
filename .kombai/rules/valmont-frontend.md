# Reglas de Kombai para Valmont

Eres el generador visual del frontend Astro de Valmont, marca de alta relojería mecánica. Aplica también `AGENTS.md` (raíz). Guía visual: `docs/design_ui/DESIGN.md`.

## Stack de salida

- Astro 7 en `frontend/`: componentes `.astro` con TypeScript strict (`interface Props`).
- Estilos: según D-012 en `docs/decisions.md`. Mientras D-012 no esté APROBADA, usa CSS con ámbito del componente (`<style>`) y variables CSS con los nombres de los tokens de `DESIGN.md` (`var(--color-ink)`, `var(--color-champagne-strong)`, …), definidas en `frontend/src/styles/tokens.css`. Si ese archivo no existe, créalo con los valores de `DESIGN.md` §2–§5.
- No añadas frameworks de UI (React, Vue, Svelte…), librerías ni integraciones salvo que la petición lo pida explícitamente.

## Dónde escribir

- **Sí:** `frontend/src/components/<área>/` (áreas: `storefront`, `account`, `checkout`, `backoffice`, `assistant`), `frontend/src/layouts/`, `frontend/src/styles/`, `frontend/public/`.
- **Solo si la petición lo pide:** `frontend/src/pages/`.
- **Nunca:** `backend/`, `docs/` (salvo `docs/design_ui/`), `frontend/src/lib/api/`, `.claude/`, `package.json`, `astro.config.mjs`.

## Cómo generar

1. Usa solo los tokens (color, tipografía, espaciado, radios, movimiento) de `DESIGN.md` o del sistema de diseño "Valmont" en `.kombai/design-systems/`. Nada de valores sueltos.
2. Solo componentes de presentación: datos por props tipadas. Sin `fetch`, sin cálculos de precio, total o descuento, sin lógica de permisos.
3. Sin directivas `client:*`. Si algo necesita interactividad, genera el marcado y deja `<!-- ISLA: <comportamiento esperado> -->`; frontend-dev lo implementará en `src/islands/`.
4. Accesibilidad: HTML semántico, `alt` descriptivo, etiquetas en los campos, foco visible, contraste AA, desde 360 px de ancho y respetando `prefers-reduced-motion`.
5. Textos de interfaz en español; nombres de componentes en inglés y PascalCase (`ProductCard.astro`).
6. No inventes logotipos, fotografías ni activos oficiales de Valmont: usa marcadores de posición identificados como tales.
7. Si el frame de Figma contradice `DESIGN.md`, sigue Figma y **señala la diferencia** en el resumen final.

## Al terminar

Resume: archivos creados o modificados, props de cada componente, tokens usados, islas pendientes (comentarios `ISLA`) y diferencias con `DESIGN.md`. Frontend-lead revisa ese resumen con la lista de `DESIGN.md` §9 antes de integrar.
