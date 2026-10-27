---
name: context-handoff
description: Protocolo de contexto de Valmont para cualquier agente. Úsala al EMPEZAR una tarea (cargar el contexto mínimo suficiente desde docs/), al TERMINARLA (traspaso estructurado con evidencias), cuando el contexto se acerque al límite o antes de compactar, y al REANUDAR una sesión. También cuando se pida "traspaso", "handoff", "retoma", "dónde quedamos" o el estado de una tarea.
---

# Contexto y traspaso

Las reglas están en `docs/agents/PROTOCOL.md` §2 (inicio), §5 (plantilla de traspaso) y §8 (política de contexto). Esta skill es el procedimiento.

## A. Al empezar una tarea

1. Identifica el `task_id`. Si no existe y la tarea no es trivial, pídelo a quien te delegó (o, si eres el Leader, créalo en `docs/agents/tasks.md`).
2. Lee el paquete de la tarea: `docs/modules/<módulo>/STATUS.md` o la sección de paquetes de `docs/agents/tasks.md`.
3. Lee **solo** lo que el paquete pone en "Leer:". Busca los requisitos por ID en vez de leer el documento entero:
   ```bash
   grep -n "RF02\.03\|RN-05" docs/requirements.md
   ```
4. Verifica el estado real: abre los archivos de código citados. La línea base de pruebas es el último veredicto de qa-reviewer en el STATUS: solo QA ejecuta pruebas (D-028).
5. Anota para ti un plan de 3 a 7 pasos y dos listas: "puedo tocar" y "no puedo tocar".
6. Pasa tu fila de la tarea a `IN_PROGRESS` (solo tu fila).

**Amplía la lectura solo si** el paquete cita un contrato o documento que no existe, el cambio toca archivos compartidos (`backend/src/valmont/main.py`, `backend/src/valmont/shared/`, `frontend/src/lib/api/`) o dos fuentes se contradicen. En ese caso registra la discrepancia en el STATUS; no elijas en silencio.

## B. Durante la ejecución

- Lo que el siguiente agente vaya a necesitar se escribe en el STATUS, no solo en tu respuesta.
- Si te bloqueas, escribe en el STATUS `BLOCKED: <qué falta> — decide: <rol>` y devuelve el traspaso. No inventes datos ni contratos para avanzar.
- Cita `archivo §sección` en vez de copiar bloques de documentación.

## C. Al terminar: traspaso

1. Guarda cada `comando → resultado observado` de lo que ejecutaste:
   - Si implementas: solo el análisis estático, más `NO EJECUTADO: pruebas (D-028)`.
   - Si eres qa-reviewer: todas las puertas.
2. Rellena los 12 puntos de la plantilla de `PROTOCOL.md` §5. Las pruebas, literales: `uv run pytest -q → 12 passed`, no "las pruebas pasan".
3. Añade el traspaso al STATUS del módulo (sección "Traspasos", el más reciente arriba) o debajo del paquete en `tasks.md`.
4. Pon tu fila en `IN_REVIEW` (si otro debe revisar) o en `BLOCKED`. Quien implementa nunca marca `DONE`: lo marca quien acepta.
5. Tu respuesta final **es** el traspaso: es lo único que recibe quien te lanzó.

## D. Antes de compactar o cerca del límite de contexto

1. Deja de leer lo no esencial.
2. Actualiza el STATUS o `tasks.md`: qué está hecho, qué falta, comandos de prueba, errores conocidos y la **siguiente acción concreta**.
3. Registra las decisiones nuevas en `docs/decisions.md`.
4. Escribe la nota de continuidad en `docs/agents/<agente-id>/profile.md`.
5. Lo que no esté validado no se describe como completo.

## E. Al reanudar

1. Lee tu `profile.md` → `tasks.md` → el STATUS del módulo activo.
2. Comprueba en el código los archivos que el STATUS da por modificados; pueden haber cambiado.
3. Continúa desde "Siguiente acción recomendada".
