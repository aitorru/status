---
name: devenv
description: Cómo ejecutar comandos en status (node, pnpm, biome, tsc) a través de devenv/Nix. Úsala antes de lanzar cualquier herramienta del repo, cuando un comando "no se encuentra", o al tocar devenv.nix / devenv.yaml.
---

# Entorno devenv de status

`devenv.nix` aporta Node 24, pnpm y Biome. La app no tiene dependencias: pnpm solo instala
`typescript` y `@types/node` para `tsc`. Node ejecuta los `.ts` directamente (type stripping), así
que **el código debe ser TypeScript «borrable»** (`erasableSyntaxOnly`): nada de `enum`,
`namespace` ni parámetros de constructor con modificadores, e imports con extensión `.ts`.

```bash
devenv shell -- <comando>
devenv shell -- bash -c 'lint && unit'   # agrupa: entrar al shell cuesta unos segundos
```

| Script | Qué hace |
| --- | --- |
| `lint` | `biome ci`, `tsc --noEmit`, `bash -n` del script de sync, `node --check` de `public/*.js` |
| `unit` | `node --test "test/*.test.ts"` |
| `dev` | Demo (`demo/run.ts`) con `--watch-path` en `src` y `demo`; puertos 34100 y 34101 |
| `start` | Servidor con `config/services.json` y `.env` reales |
| `sync-punto [ref]` | Regenera `public/punto.css` desde `aitorru/desing` |

Biome viene de nixpkgs (el binario de npm no arranca en NixOS). Formatea con
`devenv shell -- biome check --write .`. `.pre-commit-config.yaml` es generado.
