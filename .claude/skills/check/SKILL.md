---
name: check
description: Reproduce en local los jobs de CI de status (lint, tests, audit, imagen Docker) y arregla lo que falle. Úsala antes de commitear, antes de abrir un PR, o cuando pidan "verificar" o "que pase CI".
---

# Verificar como CI

CI (`.github/workflows/ci.yml`) tiene cuatro jobs: `lint`, `test`, `audit` y `docker`.

1. **Lint y tests** (siempre, segundos):

   ```bash
   devenv shell -- bash -c 'lint && unit'
   ```

   - Biome: aplica el formato con `biome check --write .`, no a mano.
   - `tsc`: el código debe ser TypeScript borrable (ver skill `devenv`).
   - `test/monitor.test.ts` recorre el ciclo completo de una incidencia con un GitLab falso. Si
     cambias `src/monitor.ts`, amplíalo en vez de relajarlo.

2. **Audit** (si tocaste `package.json` o `pnpm-lock.yaml`):
   `devenv shell -- pnpm audit --audit-level moderate`.

3. **Docker** (si tocaste `Dockerfile`, `src/server.ts` o rutas de ficheros): en pi-home no hay
   Docker; indícalo y deja que lo cubra CI.

Informa de qué pasos corriste, cuáles pasaron y cuáles se saltaron y por qué.
