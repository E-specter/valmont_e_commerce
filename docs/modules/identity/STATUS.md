# identity — Estado
> Fase: 1 · Estado del módulo: SPECIFICATION · Última actualización: 2026-10-26 claude-leader

## Plan

| ID | Título | Rol | Depende de | Estado |
|---|---|---|---|---|
| T-008 | SPEC de identity | claude-leader | D-009 | IN_REVIEW (falta que el frontend revise el contrato) |
| T-016 | Verificación del JWT, `app.profiles`, `current_user` / `require_admin`, `GET` y `PATCH /me` | backend-dev + qa-reviewer | T-007, T-015 | BACKLOG |

## Paquetes de tarea

El paquete de T-016 se escribe aquí cuando T-015 (capa de datos) esté integrada, para fijar las rutas exactas de `shared/db.py` y de la migración.

## Traspasos

_(ninguno todavía)_

## Discrepancias y riesgos

- No hay FK a `auth.users` (decisión de la SPEC §6): un perfil puede quedar huérfano si se borra el usuario en Supabase Auth. Se trata junto con P-IDENTITY-1 (cancelación de cuenta).
