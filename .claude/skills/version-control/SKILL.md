---
name: version-control
description: Protocolo de control de versiones de Valmont con git. Úsala al hacer un commit (aporte atómico completo de una tarea T-NNN), al informar commits en un traspaso, al preparar el paquete de push para el usuario, al integrar una rama en main con su autorización y al activar los hooks del repositorio. También cuando se pregunte qué commits faltan por subir o cómo hacer push.
---

# Control de versiones

Reglas: `docs/agents/PROTOCOL.md` §11 (D-026, D-028). Esta skill es el procedimiento. Todos los comandos son de Git Bash y se ejecutan desde la raíz del repo o del worktree.

## A. Entrega preparada (quien implementa; sin commit)

1. **Identifica lo tuyo:** `git status --short`. Solo entran los archivos de tu tarea.
2. **Prepara rutas concretas:** `git add backend/src/valmont/modules/catalog backend/tests/catalog`. Nunca uses `git add -A` si hay más agentes en la misma copia.
3. **Revisa lo preparado:** `git diff --cached --stat`. Si aparece algo ajeno, `git restore --staged <ruta>`. `git diff` debe salir vacío: no puede quedar nada sin preparar.
4. **No hagas commit.** En el punto 12 de tu traspaso pon "ninguno — preparado", las rutas y el mensaje propuesto con el formato de §11.4. Si después corriges algo tras la revisión, vuelve a prepararlo.

## A2. Verificación (qa-reviewer)

Antes de las puertas, anota:
- el commit base: `git rev-parse --short HEAD`;
- el estado: `git status --short` (un archivo de la tarea sin preparar es un hallazgo);
- que `git diff` sale vacío;
- la huella de lo preparado: `git diff --cached | git hash-object --stdin`.

Todo eso va en el punto 12 del veredicto.

## A3. Commit (Leader, tras el `APROBADO`)

1. Comprueba que lo preparado sigue siendo lo verificado: `git diff --cached | git hash-object --stdin` debe dar la huella de QA. Si no coincide, no hay commit: vuelve a QA.
2. Haz el commit con el mensaje propuesto. Los hooks validan el asunto, la tarea y los secretos:
   ```bash
   git commit -m "feat(catalog): API de administración del catálogo (T-028)" \
     -m "Qué cambia y por qué. Verificado por qa-reviewer (APROBADO, huella 3f2a…): pytest -q → 445 passed; pytest -m integration -q → 117 passed." \
     -m "Agent: backend-dev
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
   ```
3. Anota el resultado con `git log -1 --format="%h %s"`. En un cambio solo de documentación, el Leader revisa y hace el commit sin pasar por QA.

Si el hook rechaza el commit, corrige la causa (mensaje, archivo `.env` o secreto). **Nunca** uses `--no-verify`.

## B. Informar commits

- **Quien implementa:** punto 12 del traspaso (`PROTOCOL.md` §5): "ninguno — preparado" y el mensaje propuesto.
- **qa-reviewer:** commit base y huella verificada.
- **Leader:** en el mismo turno, al usuario: tabla con hash, asunto, tarea y veredicto de QA.

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
3. El último veredicto de qa-reviewer sobre la punta de `main` (`comando → resultado`); si no lo hay, pídeselo.
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
