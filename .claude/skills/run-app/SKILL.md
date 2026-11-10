---
name: run-app
description: Arranca status (la demo con fuentes y GitLab simulados) y compruébalo con curl o capturas. Úsala para "arrancar", "levantar", "enséñamelo" o confirmar un cambio en la página.
---

# Arrancar y probar status

Lánzalo en segundo plano (Bash con `run_in_background: true`):

```bash
devenv shell -- dev
```

- Antes, mira si ya hay uno: `ss -ltn | grep -E ':3410[01]\b'`.
- Página: http://localhost:34100 · GitLab simulado: http://localhost:34101/gitlab/issues
- `DEMO_HOST` (por defecto el hostname) decide el host de los enlaces, para que funcionen desde
  otro equipo por Tailscale: `http://pi-home:34100`.
- Los fallos siguen un ciclo de 150 s (`demo/mock.ts`). Para esperar a que haya una incidencia:

  ```bash
  until curl -s localhost:34100/api/status | grep -q '"active":\[{'; do sleep 3; done
  ```

- Para otra instancia en paralelo: `PORT=34110 STATUS_MOCK_PORT=34111 STATE_FILE=$(mktemp -d)/s.json node demo/run.ts`.

## Capturas

Chromium de nixpkgs necesita fuentes y no debe heredar `LD_LIBRARY_PATH`:

```bash
FONTCONFIG_FILE=<fonts.conf con dejavu> env -u LD_LIBRARY_PATH chromium --headless=new --no-sandbox \
  --window-size=1400,2400 --timeout=9000 --screenshot=shot.png 'http://localhost:34100/?theme=light'
```

`?theme=light|dark|oled`, `?palette=…` y `?version=1` fijan el aspecto.
