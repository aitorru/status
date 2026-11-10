# status

Página de estado de servicios para equipos de plataforma. Comprueba cada servicio (rutas HTTP,
Prometheus o Grafana), lo muestra en una página de solo lectura y, cuando algo se cae, **abre una
issue en GitLab y la mantiene al día** hasta que se recupera.

```
 rutas HTTP ─┐
 Prometheus ─┼─► monitor ──► incidencias ──► issues de GitLab
 Grafana ────┘   (debounce)      │
                                 └──► SSE ──► página (solo lectura)
```

- **Sin dependencias ni build**: Node ≥ 24 ejecuta el TypeScript directamente.
- **Solo lectura**: no hay login ni formularios. Pensada también para una pantalla en la pared.
- **Diseño**: Punto 2 (edición formal) de [`aitorru/desing`](https://github.com/aitorru/desing).

## Probarlo en un minuto

```bash
devenv shell -- dev        # o, con Node 24 en el PATH: npm run demo
```

| URL | Qué es |
| --- | --- |
| http://localhost:34100 | La página de estado |
| http://localhost:34101/gitlab/issues | Un GitLab simulado: aquí se ven las issues que abre y actualiza |

La demo simula fuentes HTTP, Prometheus, Grafana y GitLab. Los fallos se repiten cada 150 s, así
que en un par de minutos se ve el ciclo completo: abrir la issue, empeorar o mejorar, resolver,
cerrar y reabrir.

## Montarlo para tus servicios

La guía paso a paso está en **[docs/montaje.md](docs/montaje.md)**. Resumen:

```bash
cp .env.example .env                                   # GitLab, Grafana, tokens
cp config/services.example.json config/services.json   # tus servicios
docker build -t status . && docker run -p 8080:8080 --env-file .env \
  -v "$PWD/config/services.json:/config/services.json:ro" -v status-data:/data status
```

| Documento | Para qué |
| --- | --- |
| [docs/montaje.md](docs/montaje.md) | Instalación de principio a fin: fuentes, GitLab, Grafana, despliegue y verificación |
| [docs/configuracion.md](docs/configuracion.md) | Referencia de `services.json`, tipos de comprobación y variables de entorno |
| [docs/arquitectura.md](docs/arquitectura.md) | Cómo funciona por dentro, ciclo de vida de una incidencia y límites conocidos |
| [`deploy/`](deploy) | Ejemplos listos: Docker Compose, Kubernetes, systemd y nginx |

## Desarrollo

Todo el toolchain viene de `devenv.nix` (Node 24, pnpm, Biome).

| Comando | Qué hace |
| --- | --- |
| `devenv shell -- dev` | Demo con recarga al tocar `src/` o `demo/` (puertos 34100 y 34101) |
| `devenv shell -- start` | Arranca con `config/services.json` y `.env` reales |
| `devenv shell -- lint` | Biome, `tsc --noEmit`, sintaxis del JS del navegador y del script de shell |
| `devenv shell -- unit` | Tests (`node --test`): comprobaciones y ciclo de vida completo de una incidencia |
| `devenv shell -- sync-punto [ref]` | Regenera `public/punto.css` desde `aitorru/desing` (por defecto `origin/main`) |
| `devenv test` | `lint` + `unit`, lo mismo que CI |

| Perfil | Para qué |
| --- | --- |
| (por defecto) | Mínimo: Node, pnpm, Biome |
| `devenv --profile ide shell` | Añade el LSP de TypeScript |

Ramas: `develop` para integrar y `main` estable. CI (`.github/workflows/ci.yml`) pasa lint, tests,
`pnpm audit` y una prueba de humo de la imagen Docker.

## Estructura

```
src/       servidor (HTTP + SSE), monitor, comprobaciones y cliente de GitLab
public/    la página: HTML, CSS de Punto generado y JS sin framework
config/    services.example.json (plantilla) y demo.json
demo/      fuentes y GitLab simulados para la demo
deploy/    Compose, Kubernetes, systemd, nginx
test/      tests con node:test
```
