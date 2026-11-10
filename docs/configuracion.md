# Referencia de configuración

Dos sitios: **`services.json`** (qué vigilar y cómo) y **variables de entorno** (dónde están las
cosas y los secretos). Los strings del JSON admiten `${VAR}` y `${VAR:-por defecto}`.

## Variables de entorno

| Variable | Por defecto | Qué es |
| --- | --- | --- |
| `PORT` | `34100` (`8080` en Docker) | Puerto HTTP |
| `CONFIG` | `config/services.json` | Ruta del fichero de servicios |
| `STATE_FILE` | `data/state.json` | Histórico e incidencias. Debe persistir entre reinicios |
| `PUBLIC_URL` | — | URL pública de la página, enlazada desde las issues |
| `GITLAB_URL` | — | Instancia de GitLab, p. ej. `https://gitlab.example.com` |
| `GITLAB_TOKEN` | — | Token de proyecto, scope `api`, rol Reporter o superior. Sin él: dry-run |
| `GITLAB_PROJECT` | — | `grupo/proyecto` o id numérico |
| `HOOK_TOKEN` | — | Secreto para `POST /hooks/grafana`. Sin él, el endpoint acepta cualquier petición |
| `DISPLAY_TZ` | `Europe/Madrid` | Zona horaria de las fechas que se escriben en las issues |

`GRAFANA_URL`, `GRAFANA_TOKEN` y `PROMETHEUS_URL` no las lee el código: son las que usa la
plantilla `services.example.json` a través de `${…}`. Puedes llamarlas como quieras.

## `services.json`

```jsonc
{
  "title": "Estado de plataforma",   // cabecera de la página
  "headline": "DevTools *status*",   // titular con todo en verde (*…* en cursiva); por defecto «Todo *funciona*»
  "intervalSeconds": 15,             // cada cuánto se comprueba todo
  "failThreshold": 2,                // fallos seguidos para abrir incidencia
  "recoverThreshold": 2,             // aciertos seguidos para cerrarla
  "historySize": 90,                 // muestras guardadas por servicio (la tira de puntos)
  "publicUrl": "${PUBLIC_URL}",      // o PUBLIC_URL en el entorno
  "hookToken": "${HOOK_TOKEN}",      // o HOOK_TOKEN en el entorno
  "sources": { /* ver abajo */ },
  "gitlab": { /* ver abajo */ },
  "services": [ /* ver abajo */ ]
}
```

### `sources`

Servidores con nombre a los que apuntan las comprobaciones `prometheus` y `grafana-*`.

```json
"sources": {
  "prometheus": { "url": "http://prometheus:9090" },
  "grafana": { "url": "https://grafana.example.com", "token": "${GRAFANA_TOKEN}" },
  "mimir": { "url": "https://mimir.example.com/prometheus", "headers": { "X-Scope-OrgID": "prod" } }
}
```

| Campo | Qué es |
| --- | --- |
| `url` | URL base, sin `/api/...` |
| `token` | Se envía como `Authorization: Bearer <token>` |
| `headers` | Cabeceras extra (multi-tenant, basic auth ya codificada…) |

Si un servicio usa una fuente sin `url`, la página no arranca y lo dice.

### `gitlab`

| Campo | Por defecto | Qué es |
| --- | --- | --- |
| `url`, `token`, `project` | variables de entorno | Igual que `GITLAB_*` |
| `labels` | `["incident", "status-page"]` | Etiquetas fijas de todas las issues. Se usan también para adoptarlas tras un reinicio |
| `assigneeIds` | `[]` | Ids de usuario a asignar |
| `confidential` | `false` | Issues confidenciales |
| `heartbeatMinutes` | `5` | Cada cuánto se refresca el bloque «Estado en vivo» mientras siga abierta |
| `reopenMinutes` | `30` | Si vuelve a fallar dentro de este plazo, reabre la misma issue |
| `closeOnRecover` | `true` | Cerrar la issue al recuperarse |

### `services[]`

| Campo | Obligatorio | Qué es |
| --- | --- | --- |
| `id` | sí | `[a-z0-9][a-z0-9-_]*`, único. Se usa en la etiqueta `service::<id>` |
| `name` | sí | Nombre visible |
| `group` | no | Agrupa en la tabla (Edge, Core, Datos…) |
| `description` | no | Línea pequeña bajo el nombre |
| `check` | sí | Una de las comprobaciones de abajo |

## Comprobaciones

Todas devuelven un estado: **operativo**, **degradado**, **caído** o **sin datos**. «Sin datos» ni
abre ni cierra incidencias.

### `http`

```json
{ "type": "http", "url": "https://api.example.com/healthz",
  "method": "GET", "expectStatus": [200, 204], "bodyContains": "\"status\":\"ok\"",
  "degradedLatencyMs": 800, "timeoutMs": 5000 }
```

| Campo | Por defecto | |
| --- | --- | --- |
| `expectStatus` | cualquier 2xx o 3xx | Código o lista de códigos aceptados |
| `bodyContains` | — | El cuerpo debe contener este texto |
| `degradedLatencyMs` | — | Más lento que esto = degradado |
| `timeoutMs` | `5000` | Más lento que esto = caído (`timeout`) |

No sigue redirecciones.

### `prometheus`

```json
{ "type": "prometheus", "source": "prometheus",
  "query": "sum(rate(http_requests_total{code=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m]))",
  "up": "< 0.01", "degraded": "< 0.05", "noData": "down" }
```

`GET <source>/api/v1/query`. Usa el primer valor del resultado (vector o escalar).

### `grafana-query`

```json
{ "type": "grafana-query", "source": "grafana", "datasourceUid": "P1809F7CD0C75ACF3",
  "expr": "max(pg_replication_lag_seconds)", "up": "< 5", "degraded": "< 30" }
```

`POST <source>/api/ds/query` con una consulta instantánea sobre los últimos 5 minutos. Usa el
último valor de la última serie. Para datasources que no son PromQL, `extra` se mezcla en la
consulta:

```json
{ "type": "grafana-query", "source": "grafana", "datasourceUid": "pg-prod", "expr": "",
  "extra": { "rawSql": "select count(*) from jobs where state = 'failed'", "format": "table" },
  "up": "== 0", "degraded": "< 10" }
```

### Condiciones (`up`, `degraded`)

`"<operador> <número>"` con `>=`, `<=`, `>`, `<`, `==` o `!=`. El orden de evaluación es: si
cumple `up`, operativo; si cumple `degraded`, degradado; si no, caído. `noData` decide qué pasa si
la consulta no devuelve nada (por defecto `down`).

### `grafana-alert`

```json
{ "type": "grafana-alert", "source": "grafana", "rule": "Queue backlog", "firing": "down" }
```

Lee `<source>/api/prometheus/grafana/api/v1/rules` (una petición por ciclo, compartida por todos
los servicios de esa fuente).

| Estado de la regla | Resultado |
| --- | --- |
| Normal | operativo |
| Pending | degradado |
| Firing | `firing` (por defecto caído) |
| Error / No data | degradado |
| No existe | sin datos |

### `grafana-webhook`

```json
{ "type": "grafana-webhook", "match": { "service": "auth" }, "firing": "down" }
```

No consulta: recibe `POST /hooks/grafana` del contact point de Grafana. Un servicio coincide con
una alerta si **todas** las etiquetas de `match` coinciden (por defecto `{ "service": "<id>" }`).
Si alguna alerta coincidente está `firing`, el servicio pasa a `firing`; si todas están
`resolved`, a operativo. Se aplica al momento, sin esperar a `failThreshold`, porque Grafana ya
aplica su propio `for:`.

## API

| Ruta | |
| --- | --- |
| `GET /` | La página |
| `GET /api/status` | Estado completo en JSON |
| `GET /api/events` | El mismo JSON por Server-Sent Events, en cada comprobación o cambio |
| `GET /healthz` | `{"ok":true}` |
| `POST /hooks/grafana` | Webhook de Grafana. `Authorization: Bearer <HOOK_TOKEN>` o `?token=` |

Cualquier otro método devuelve `405`: la página es de solo lectura.
