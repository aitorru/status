# Arquitectura

Un único proceso de Node sin dependencias. Comprueba, decide, escribe en GitLab y sirve la página.

```
                ┌────────────────────────── proceso ──────────────────────────┐
 rutas HTTP ◄───┤ checks.ts      runCheck() por servicio, cada intervalSeconds │
 Prometheus ◄───┤                                                              │
 Grafana    ◄───┤ monitor.ts     debounce → incidencia → cola por servicio ────┼──► GitLab REST v4
 Grafana    ────┼► /hooks/grafana   (push)                                     │
                │ server.ts      /api/status · /api/events (SSE) · estáticos ──┼──► navegadores
                │ data/state.json  histórico + incidencias (escritura atómica) │
                └──────────────────────────────────────────────────────────────┘
```

| Fichero | Responsabilidad |
| --- | --- |
| `src/config.ts` | Lee `services.json`, sustituye `${VAR}`, valida ids y fuentes |
| `src/checks.ts` | Una función por tipo de comprobación. Nunca lanza: un error es un resultado «caído» |
| `src/monitor.ts` | Máquina de estados, incidencias, sincronización con GitLab, persistencia y snapshot |
| `src/gitlab.ts` | Cliente mínimo de la API (issues, notas). Sin token, dry-run |
| `src/server.ts` | HTTP, SSE y el webhook. Rechaza cualquier escritura que no sea el webhook |
| `public/` | Página sin framework. Pinta el snapshot con el HTML de los componentes de Punto |

## Ciclo de una comprobación

1. Cada `intervalSeconds` se lanzan todas las comprobaciones en paralelo.
2. Cada resultado se añade al histórico (`historySize` muestras) y pasa por la máquina de estados.
3. Se guarda `STATE_FILE` (fichero temporal + `rename`, nunca queda a medias).
4. Se emite el snapshot por SSE a todas las páginas abiertas.

## Máquina de estados de una incidencia

```
              failThreshold fallos                 cambio degradado ⇄ caído
  operativo ─────────────────────► ABIERTA ──────────────────────────────┐
      ▲                             │  ▲                                 │
      │ recoverThreshold aciertos   │  └─────────────────────────────────┘
      └─────────────────────────────┘
                RESUELTA ── falla otra vez antes de reopenMinutes ──► ABIERTA (misma issue)
```

- **Debounce**: un fallo suelto no abre nada. Hacen falta `failThreshold` seguidos; el inicio se
  fecha en el primero de ellos.
- **«Sin datos»** no cuenta ni como fallo ni como acierto.
- **Push** (`grafana-webhook`): se aplica al instante, porque Grafana ya ha esperado su `for:`.

## Sincronización con GitLab

Cada servicio tiene su propia cola de promesas, así que las llamadas de un mismo servicio van en
orden y las de servicios distintos van en paralelo. Si una llamada falla se registra en el log y:

- si falló la **creación**, se reintenta a los 30 s mientras la incidencia siga abierta;
- si falló una **actualización**, la siguiente (cambio de estado o latido) reescribe el bloque
  completo, así que la issue converge.

La descripción se reescribe leyendo antes la issue y sustituyendo solo el bloque marcado, para no
pisar lo que el equipo haya escrito.

Al arrancar se listan las issues abiertas con `gitlab.labels` y se adoptan por su etiqueta
`service::<id>`. Así un reinicio, aunque se pierda `STATE_FILE`, no duplica incidencias.

## La página

- Solo lectura: `GET` de estáticos y del snapshot. No hay entradas de usuario.
- Recibe el snapshot completo por SSE en cada ciclo (unos KB) y repinta. Los tiempos relativos
  («hace 3 min») avanzan solos cada segundo sin repintar, para no cortar las animaciones.
- El diseño es Punto 2. `public/punto.css` se genera con `scripts/sync-punto.sh` desde
  `aitorru/desing` y la página escribe el mismo HTML que los componentes React de allí. Si cambia
  el marcado de un componente, hay que actualizar `public/app.js` a mano.

## Límites conocidos

- **Una sola instancia.** El estado vive en memoria y en un fichero. Dos réplicas abrirían issues
  duplicadas. Para alta disponibilidad haría falta un almacén compartido (Redis o Postgres) y
  elección de líder.
- **Sin autenticación en la página.** Ponla detrás del SSO o de la red interna.
- **Issue cerrada a mano con el servicio aún caído**: se siguen añadiendo comentarios a esa issue
  cerrada hasta que el servicio se recupera.
- **Servicio eliminado con incidencia abierta**: su issue queda abierta; ciérrala a mano.
- **Fuentes tipográficas** desde Google Fonts: en redes aisladas se usan las del sistema.
