---
name: version-control
description: Protocolo de control de versiones de Valmont con git. Úsala al hacer un commit (aporte atómico completo de una tarea T-NNN), al informar commits en un traspaso, al preparar el paquete de push para el usuario, al integrar una rama en main con su autorización y al activar los hooks del repositorio. También cuando se pregunte qué commits faltan por subir o cómo hacer push.
---

# Control de versiones

Reglas: `docs/agents/PROTOCOL.md` §11 (D-026). Esta skill es el procedimiento. Todos los comandos son de Git Bash y se ejecutan desde la raíz del repo o del worktree.

## A. Commit atómico

1. **Puertas en verde** (skill `testing-and-quality-gates`). Si alguna falla, no hay commit.
2. **Identifica lo tuyo:** `git status --short`. Solo entran los archivos de tu tarea.
3. **Añade rutas concretas:** `git add backend/src/valmont/modules/catalog backend/tests/catalog` (nunca `git add -A` si hay más agentes en la misma copia).
4. **Revisa lo preparado:** `git diff --cached --stat`. Si aparece algo ajeno: `git restore --staged <ruta>`.
5. **Commit** con el formato de §11.4. Los hooks validan el asunto, la tarea y los secretos:
   ```bash
   git commit -m "feat(catalog): API de administración del catálogo (T-028)" \
     -m "Qué cambia y por qué. Evidencias: pytest -q → 445 passed; pytest -m integration -q → 117 passed." \
     -m "Agent: backend-dev
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
   ```
6. **Anota el resultado:** `git log -1 --format="%h %s"` → va al punto 12 de tu traspaso.

Si el hook rechaza el commit, corrige la causa (mensaje, archivo `.env` o secreto). **Nunca** uses `--no-verify`.

## B. Informar commits

- **Subagente:** punto 12 del traspaso (`PROTOCOL.md` §5): `hash corto — asunto`, uno por línea, o "ninguno" con el motivo.
- **Leader:** en el mismo turno, al usuario: tabla con hash, asunto y tarea. Si el Leader añade commits de revisión, también los lista.

## C. Paquete de push (para el usuario)

```bash
git remote -v                      # ¿hay remoto?
git fetch origin                   # si lo hay
git log --reverse --format="%h %ad %s" --date=short origin/main..main   # pendientes de subir
# sin remoto: git log --reverse --format="%h %ad %s" --date=short main
git log --format=%s origin/main..main | grep -o "T-[0-9]\{3\}" | sort -u   # tareas cubiertas
git branch --no-merged main        # ramas de trabajo aún sin integrar
```

Entrega al usuario:
1. La lista de commits pendientes (hash, fecha, asunto).
2. Las tareas que cubren.
3. Las puertas ejecutadas sobre `main` en ese momento (`comando → resultado`).
4. Los riesgos.
5. El comando para subir, que ejecuta **el usuario**: `git push origin main` (la primera vez, `git remote add origin <url>` y `git push -u origin main`).

## D. Integrar una rama en main (solo con autorización del usuario)

```bash
# en la copia donde está main (no en el worktree de la tarea)
git status --short                 # debe estar limpio
git merge --ff-only <rama>         # fast-forward: historial lineal
```

Si no es fast-forward, no fuerces nada: pregunta al usuario si prefiere un commit de merge o rebasar la rama.

## E. Activar los hooks (una vez por clon)

```bash
git config core.hooksPath .githooks
```

`commit-msg` valida `<tipo>(<ámbito>): <resumen>` y que el mensaje cite una tarea `T-NNN`. `pre-commit` rechaza archivos `.env` (salvo `.env.example`), secretos literales entre comillas, JWT pegados y valores en `.env.example`.

## F. Prohibido

`push` (salvo autorización concreta del usuario), `push --force`, `commit --amend` o `rebase` de commits ya comunicados, `reset --hard`, `clean -fd`, `--no-verify`, y commits en `main` sin autorización.
