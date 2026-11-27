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
  "resolvedRetentionDays": 7,        // días que una incidencia resuelta sigue en la página; 0 = sin caducar
  "publicUrl": "${PUBLIC_URL}",      // o PUBLIC_URL en el entorno
  "hookToken": "${HOOK_TOKEN}",      // o HOOK_TOKEN en el entorno
  "sources": { /* ver abajo */ },
  "gitlab": { /* ver abajo */ },
  "maintenanceHeaders": { /* ver «Mantenimiento» */ },
  "maintenances": [ /* ver «Mantenimiento» */ ],
  "components": { /* ver «Páginas por componente» */ },
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
| `tokenFile` | Como `token`, leído del fichero en cada petición (token de service account) |
| `caFile` | CA en PEM en la que confiar. Solo la usan las comprobaciones `kubernetes` |
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
| `component` | no | Id de `components`: el servicio sale también en `/<componente>` |
| `maintenanceProbe` | no | Sonda extra que solo busca la página de mantenimiento. `true` = la raíz del host del `check` (solo `http`), o una URL |
| `check` | sí | Una de las comprobaciones de abajo |

## Comprobaciones

Todas devuelven un estado: **operativo**, **degradado**, **caído**, **sin datos** o **en
mantenimiento**. Ni «sin datos» ni «en mantenimiento» abren o cierran incidencias, y ninguno de los
dos cuenta para el uptime.

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

No sigue redirecciones. Si la respuesta trae las cabeceras de la página de mantenimiento, el
resultado es «en mantenimiento», sea cual sea el código.

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

### `kubernetes`

Pregunta a la API de Kubernetes (k3s incluido). La fuente lleva la URL, el token y la CA:

```json
"sources": {
  "k3s": {
    "url": "https://kubernetes.default.svc",
    "tokenFile": "/var/run/secrets/kubernetes.io/serviceaccount/token",
    "caFile": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
  }
}
```

| `probe` | Campos | Operativo si… |
| --- | --- | --- |
| `readyz` | — | `GET /readyz` da 200. Si no, el mensaje dice qué comprobación falló |
| `version` | — | Responde `GET /version`; el mensaje es la versión (`v1.33.5+k3s1`) |
| `nodes` | — | Todos los nodos `Ready`. Alguno no: degradado. Ninguno: caído |
| `deployment` | `namespace`, `name` | `readyReplicas` ≥ `replicas`. Menos: degradado. Cero: caído |
| `primary` | `namespace?`, `cluster?` (uno o lista), `selector?` | Cada clúster de KubeBlocks tiene exactamente un pod `Ready` con `kubeblocks.io/role=primary`. Uno sin primario: caído. Dos: degradado |

`primary` busca por defecto los pods de PostgreSQL de KubeBlocks
(`app.kubernetes.io/managed-by=kubeblocks,apps.kubeblocks.io/component-name=postgresql`) en todo el
clúster y los agrupa por `app.kubernetes.io/instance`. Sin `cluster`, un clúster que pierda todos
sus pods deja de verse: nombra los que deben existir (`"cluster": ["pg-gitlab", "pg-sonarqube"]`) y
uno sin pods cuenta como sin primario. `selector` cambia el selector base.

Permisos que necesita la service account (ver `deploy/kubernetes/status.yaml`): `get` y `list` de
`nodes` y `pods`, `get` de `deployments` y `get` de las rutas `/readyz` y `/version`.

```json
{ "id": "k3s-api", "name": "API de k3s", "component": "k3s", "check": { "type": "kubernetes", "source": "k3s", "probe": "readyz" } },
{ "id": "traefik", "name": "Traefik", "component": "k3s",
  "check": { "type": "kubernetes", "source": "k3s", "probe": "deployment", "namespace": "kube-system", "name": "traefik" } }
```

## Mantenimiento

Un mantenimiento no es una caída: el servicio sale **en mantenimiento** (azul), no abre incidencia,
no cuenta para el uptime y la página enseña el inicio, el fin previsto y el servicio. Llega de dos
sitios.

### La página de mantenimiento (cabeceras)

Cuando la plataforma pone su página delante de un host, cualquier respuesta con estas cabeceras
cuenta como mantenimiento:

| Cabecera (por defecto) | Clave en `maintenanceHeaders` | Valor |
| --- | --- | --- |
| `X-Maintenance` | `flag` | Presente y distinta de `0`, `false`, `off`, `no` |
| `X-Maintenance-Start` | `start` | ISO 8601 o segundos epoch |
| `X-Maintenance-End` | `end` | ISO 8601 o segundos epoch. Sin ella se usa `Retry-After` |
| `X-Maintenance-Service` | `service` | Qué se está manteniendo |

Si la plataforma usa otros nombres, cámbialos:

```json
"maintenanceHeaders": { "flag": "x-mant", "start": "x-mant-desde", "end": "x-mant-hasta", "service": "x-mant-servicio" }
```

La página solo se ve en las rutas que tapa. Si la comprobación de un servicio va por debajo de ella
a propósito (el `/api/system/status` de SonarQube o el `.well-known` de Keycloak), añade
`"maintenanceProbe": true`: en cada ciclo se pide también la raíz del host, que sí la tapa.

```json
{ "id": "sonarqube", "name": "SonarQube", "component": "sonarqube", "maintenanceProbe": true,
  "check": { "type": "http", "url": "https://sonar.example.com/api/system/status", "bodyContains": "\"UP\"" } }
```

### Ventanas programadas (`maintenances`)

Se anuncian en la página desde que se configuran hasta que terminan. Dentro de la ventana, un fallo
de los servicios que cubre cuenta como mantenimiento; lo que siga respondiendo bien sale operativo.

```json
"maintenances": [
  { "id": "ensayo-martes", "title": "Ensayo de migración", "services": ["gitlab", "sonarqube", "keycloak"],
    "start": "2026-12-01T19:00:00+01:00", "end": "2026-12-01T21:00:00+01:00",
    "description": "Tiempos del ensayo y avisos", "url": "https://gitlab.example.com/devops/incidencias/-/issues/84" }
]
```

| Campo | Obligatorio | |
| --- | --- | --- |
| `services` | sí | Ids de servicio |
| `start`, `end` | sí | ISO 8601 con zona |
| `id`, `title`, `description`, `url` | no | `url`: dónde se avisó |

## Páginas por componente (`components`)

Cada componente tiene su página en `/<id>` con sus servicios, su historial completo, sus
incidencias, sus mantenimientos y su marca. En la página principal, el nombre del servicio enlaza a
ella.

```json
"components": {
  "gitlab": { "name": "GitLab", "description": "Código y CI", "color": "#e24329", "logo": "https://gitlab.example.com/favicon.png" },
  "k3s": { "name": "k3s", "color": "#ffc61c" }
}
```

`logo` es opcional: sin él, la inicial sobre `color`. Los ids `api`, `healthz` y `hooks` están
reservados.

## API

| Ruta | |
| --- | --- |
| `GET /` | La página |
| `GET /<componente>` | La página de un componente de `components` |
| `GET /api/status` | Estado completo en JSON |
| `GET /api/events` | El mismo JSON por Server-Sent Events, en cada comprobación o cambio |
| `GET /healthz` | `{"ok":true}` |
| `POST /hooks/grafana` | Webhook de Grafana. `Authorization: Bearer <HOOK_TOKEN>` o `?token=` |

Cualquier otro método devuelve `405`: la página es de solo lectura.
