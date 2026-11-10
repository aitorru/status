# Montar la página de estado

Esta guía lleva de cero a una página de estado en producción que vigila tus servicios y abre
issues en GitLab cuando algo falla. Calcula una hora, casi toda en decidir qué vigilar.

1. [Requisitos](#1-requisitos)
2. [Probar la demo](#2-probar-la-demo)
3. [Decidir qué vigilar](#3-decidir-qué-vigilar)
4. [Conectar las fuentes de datos](#4-conectar-las-fuentes-de-datos)
5. [Conectar GitLab](#5-conectar-gitlab)
6. [Desplegar](#6-desplegar)
7. [Verificar](#7-verificar)
8. [Operación diaria](#8-operación-diaria)
9. [Problemas frecuentes](#9-problemas-frecuentes)

---

## 1. Requisitos

| Necesitas | Para qué |
| --- | --- |
| Node 24 o superior, **o** Docker / Kubernetes | Ejecutar la página. No hay build ni `npm install` |
| Acceso de red desde donde corra a lo que vigila | Rutas `/healthz`, Prometheus, Grafana |
| Un proyecto de GitLab para las incidencias | Donde se abren las issues. Suele ser uno dedicado, p. ej. `devops/incidents` |
| (Opcional) Grafana con una *service account* | Consultar datasources y reglas de alerta |
| (Opcional) Prometheus, Mimir, Thanos o VictoriaMetrics | Consultas PromQL directas |

Una sola instancia basta y es lo soportado: ver [arquitectura](arquitectura.md#límites-conocidos).

## 2. Probar la demo

Antes de configurar nada, mira cómo se comporta:

```bash
npm run demo          # o: devenv shell -- dev
```

Abre http://localhost:34100 y, al lado, http://localhost:34101/gitlab/issues (un GitLab simulado).
En unos dos minutos verás abrirse issues, cambiar de estado, cerrarse y reabrirse.

## 3. Decidir qué vigilar

Cada entrada de `config/services.json` es un servicio con **una** comprobación. Empieza copiando la
plantilla:

```bash
cp config/services.example.json config/services.json
```

Elige la comprobación según lo que ya tengas:

| Si tienes… | Usa | Ejemplo |
| --- | --- | --- |
| Una ruta de salud (`/healthz`, `/ready`) | `http` | Web pública, APIs |
| Métricas en Prometheus | `prometheus` | `avg(up{job="api"})`, tasa de errores, réplicas vivas |
| Una métrica en cualquier datasource de Grafana (Loki, SQL, CloudWatch…) | `grafana-query` | Lag de réplica, colas |
| Una regla de alerta en Grafana | `grafana-alert` | Reutilizar umbrales que ya afinasteis |
| Alertas que Grafana ya envía | `grafana-webhook` | Grafana empuja y la página no consulta |

Consejos:

- **Vigila síntomas, no causas.** «Checkout responde» es mejor que «CPU del nodo 3». La página es
  para saber qué está roto, no por qué.
- **Agrupa con `group`** (Edge, Core, Datos…): la tabla los muestra juntos.
- **Una regla de alerta de Grafana ya afinada vale más que un umbral nuevo**: usa `grafana-alert`.
- Mantén la lista corta. Diez servicios bien elegidos se leen de un vistazo; cincuenta no.

Ejemplo mínimo:

```json
{
  "title": "Estado de plataforma",
  "intervalSeconds": 15,
  "failThreshold": 2,
  "recoverThreshold": 3,
  "publicUrl": "${PUBLIC_URL}",
  "sources": {
    "prometheus": { "url": "${PROMETHEUS_URL}" },
    "grafana": { "url": "${GRAFANA_URL}", "token": "${GRAFANA_TOKEN}" }
  },
  "services": [
    { "id": "web", "name": "Web pública", "group": "Edge",
      "check": { "type": "http", "url": "https://www.example.com/healthz", "degradedLatencyMs": 800 } },
    { "id": "api", "name": "API", "group": "Core",
      "check": { "type": "prometheus", "source": "prometheus",
                 "query": "avg(up{job=\"api\"})", "up": ">= 1", "degraded": ">= 0.5" } }
  ]
}
```

Los valores `${VAR}` y `${VAR:-por defecto}` se leen del entorno, así que los secretos van en
`.env`, no en el JSON. Referencia completa de campos: [configuracion.md](configuracion.md).

## 4. Conectar las fuentes de datos

### Rutas HTTP

No hace falta nada más que red. Por defecto, cualquier 2xx o 3xx es «operativo»; afina con
`expectStatus`, `bodyContains` y `degradedLatencyMs`. Las redirecciones **no** se siguen: una ruta
que redirige al login cuenta como sana si devuelve 302, así que apunta a la ruta de salud real.

### Prometheus (y compatibles)

1. Pon la URL base en `PROMETHEUS_URL` (sin `/api/v1`).
2. Si está detrás de autenticación, añade `"token"` (Bearer) o `"headers"` a la fuente.
3. Escribe consultas que devuelvan **un solo número**. Agrega en PromQL (`avg`, `max`, `sum`): si
   devuelve varias series, se usa la primera.
4. Define `up` (sano si…) y opcionalmente `degraded`. Lo que no cumple ninguna es «caído». Sin
   datos cuenta como «caído» salvo que pongas `"noData": "unknown"`.

### Grafana

1. **Crea una service account**: *Administration → Users and access → Service accounts → Add
   service account*, rol **Viewer**. Dentro, *Add service account token* y cópialo a
   `GRAFANA_TOKEN`. Pon la URL base en `GRAFANA_URL`.
2. **Para `grafana-query`** necesitas el UID del datasource: *Connections → Data sources*, abre el
   datasource y cópialo de la URL (`…/datasources/edit/<uid>`). La consulta va en `expr`; para
   datasources que no son PromQL, pasa sus campos en `extra` (p. ej. `{"rawSql": "…", "format":
   "table"}`).
3. **Para `grafana-alert`** basta el nombre exacto de la regla (`"rule": "Queue backlog"`).
   *Normal* = operativo, *Pending* = degradado, *Firing* = caído (configurable con `firing`).
   Una regla con error o *No data* cuenta como degradado.

### Alertas empujadas por Grafana (`grafana-webhook`)

Útil si ya tenéis alertas con su `for:` y no queréis duplicar umbrales.

1. Elige un secreto y ponlo en `HOOK_TOKEN`.
2. En Grafana, *Alerting → Contact points → Add contact point*, integración **Webhook**:
   - URL: `https://<tu-página>/hooks/grafana`
   - *Optional Webhook settings → Authorization Header*: esquema `Bearer`, credenciales = `HOOK_TOKEN`.
3. En *Notification policies*, enruta a ese contact point las alertas que quieras reflejar.
   Activa *Continue matching* si también deben ir a otros sitios.
4. Pon en esas reglas una etiqueta que identifique el servicio, p. ej. `service=auth`.
5. En `services.json`:

   ```json
   { "id": "auth", "name": "Auth / SSO", "check": { "type": "grafana-webhook", "match": { "service": "auth" } } }
   ```

Hasta que llega el primer webhook el servicio aparece como operativo: Grafana solo llama cuando
algo dispara o se resuelve.

## 5. Conectar GitLab

1. **Proyecto**: usa uno dedicado (p. ej. `devops/incidents`) para no mezclar incidencias con el
   backlog. Ponlo en `GITLAB_PROJECT` (ruta `grupo/proyecto` o id numérico) y la instancia en
   `GITLAB_URL`.
2. **Token**: en el proyecto, *Settings → Access tokens → Add new token*, rol **Reporter**
   (o superior) y scope **`api`**. Cópialo a `GITLAB_TOKEN`. Un token de proyecto es mejor que uno
   personal: no depende de una persona y solo ve ese proyecto.
3. **Etiquetas**: GitLab crea las que falten la primera vez que se usan. Se usan `incident`,
   `status-page` (cámbialas con `gitlab.labels`), `service::<id>` y `status::down|degraded|resolved`.
   Las etiquetas con `::` son exclusivas en GitLab Premium; en Free la página quita la anterior ella misma.
4. **`PUBLIC_URL`**: la URL de la página. Aparece en cada issue para saltar al estado en vivo.
5. Opcional, en `services.json` → `gitlab`:
   - `assigneeIds`: ids de usuario a los que asignar cada issue (p. ej. quien está de guardia).
   - `confidential: true` si las incidencias no deben verlas todos los miembros.
   - `heartbeatMinutes` (5), `reopenMinutes` (30), `closeOnRecover` (true).

**Sin token funciona en dry-run**: escribe en el log lo que haría. Es útil para afinar umbrales
antes de abrir issues de verdad.

Qué hace en GitLab, en una línea por evento:

| Evento | En la issue |
| --- | --- |
| Falla `failThreshold` veces seguidas | Crea la issue con título `🔴 Servicio — caído` y etiquetas |
| Sigue caído | Reescribe el bloque «Estado en vivo» de la descripción cada `heartbeatMinutes` |
| Degradado ⇄ caído | Comentario + título + etiqueta `status::` |
| `recoverThreshold` comprobaciones correctas | Comentario «✅ Recuperado tras X», `status::resolved`, cierra |
| Vuelve a fallar antes de `reopenMinutes` | Reabre la misma issue en vez de crear otra |

Solo se toca el bloque entre `<!-- status-page -->` y `<!-- /status-page -->`. Lo que el equipo
escriba debajo en la descripción se conserva, y los comentarios son vuestros.

## 6. Desplegar

Elige una opción. En todas: **una réplica**, el fichero de estado en almacenamiento persistente y
la página detrás de vuestro SSO o red interna (no tiene login).

### Docker

```bash
docker build -t status .
docker run -d --name status --restart unless-stopped -p 8080:8080 \
  --env-file .env \
  -v "$PWD/config/services.json:/config/services.json:ro" \
  -v status-data:/data \
  status
```

O con Compose: `docker compose -f deploy/docker-compose.yml up -d`.

### Kubernetes

[`deploy/kubernetes/status.yaml`](../deploy/kubernetes/status.yaml) trae Deployment (1 réplica,
`Recreate`), PVC, Service e Ingress:

```bash
docker build -t ghcr.io/<org>/status:<versión> . && docker push ghcr.io/<org>/status:<versión>
kubectl create namespace status
kubectl -n status create secret generic status-env --from-env-file=.env
kubectl -n status create configmap status-config --from-file=services.json=config/services.json
kubectl -n status apply -f deploy/kubernetes/status.yaml   # ajusta image y host antes
```

Para cambiar servicios: actualiza el ConfigMap y `kubectl -n status rollout restart deploy/status`.
Si vigilas cosas dentro del clúster, usa nombres de Service (`http://api.prod.svc:8080/healthz`).

### VM con systemd

```bash
sudo useradd --system --home /opt/status status
sudo git clone https://github.com/aitorru/status /opt/status
sudo mkdir -p /etc/status && sudo cp /opt/status/.env.example /etc/status/status.env
sudo cp /opt/status/config/services.example.json /etc/status/services.json
# edita /etc/status/status.env y /etc/status/services.json
sudo cp /opt/status/deploy/status.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now status
journalctl -u status -f
```

Necesita Node 24 en `/usr/bin/node` (ajusta `ExecStart` si está en otra ruta).

### Proxy inverso

La página se actualiza por **Server-Sent Events** en `/api/events`. Cualquier proxy delante debe
**desactivar el buffering** en esa ruta y permitir conexiones largas, o la página se quedará
congelada. Hay un ejemplo para nginx en [`deploy/nginx.conf`](../deploy/nginx.conf); en
ingress-nginx, las anotaciones están en el manifiesto de Kubernetes.

Restringe `/hooks/` a las IPs de Grafana si puedes. Ya exige `HOOK_TOKEN`, pero no necesita ser
público.

## 7. Verificar

1. `curl -s https://<tu-página>/healthz` devuelve `{"ok":true}`.
2. El log de arranque dice `GitLab: live → …` (o `dry-run` si falta algo).
3. La página muestra todos los servicios y ninguno se queda en «Sin datos». Si alguno sí, mira su
   mensaje en la columna «Última comprobación».
4. **Prueba de incidente**: añade temporalmente un servicio que falle siempre:

   ```json
   { "id": "prueba", "name": "Prueba", "check": { "type": "http", "url": "https://example.invalid/" } }
   ```

   Tras `failThreshold` comprobaciones aparece una issue en GitLab. Quita el servicio y reinicia:
   esa issue queda abierta (el servicio ya no existe). Ciérrala a mano.
5. Si usas el webhook: en el contact point de Grafana, botón *Test*. El log muestra la petición; si
   devuelve `401`, el token no coincide.

## 8. Operación diaria

- **Añadir o quitar servicios**: edita `services.json` y reinicia. El histórico y las incidencias
  abiertas se conservan en el fichero de estado (`STATE_FILE`).
- **Reinicios**: al arrancar adopta las issues abiertas con sus etiquetas, así que no duplica
  incidencias aunque se pierda el fichero de estado.
- **Pantalla en la pared**: `?theme=oled` (negro puro) o `?theme=light`. `?palette=marea|siena|punto|citrico`
  cambia la paleta.
- **Actualizar el diseño**: `devenv shell -- sync-punto` regenera el CSS desde `aitorru/desing`.
  El commit usado aparece en el pie de la página.
- **Umbrales**: si salen issues por fallos de un solo ciclo, sube `failThreshold`. Si tardan en
  cerrarse, baja `recoverThreshold`.

## 9. Problemas frecuentes

| Síntoma | Causa probable |
| --- | --- |
| Arranca y se para con `uses source "x", which has no url` | Falta la variable de entorno de esa fuente (`GRAFANA_URL`, `PROMETHEUS_URL`…) |
| Todo «caído» con `fetch failed (ENOTFOUND)` | DNS: el contenedor no resuelve esos nombres |
| Grafana devuelve `HTTP 401` / `403` | Token de service account caducado o sin rol Viewer |
| `regla "…" no encontrada` | El nombre de `rule` no coincide exactamente (mayúsculas, espacios) |
| La página no se actualiza sola, pero al recargar sí | El proxy está bufferizando `/api/events` (sección 6) |
| `[gitlab] … 401` en el log | `GITLAB_TOKEN` inválido o caducado |
| `[gitlab] … 403` | El token no tiene rol Reporter o scope `api` |
| `[gitlab] … 404` | `GITLAB_PROJECT` mal escrito, o el token es de otro proyecto |
| Siguen llegando comentarios a una issue cerrada a mano | Se cerró mientras el servicio seguía caído; se recupera sola cuando el servicio vuelve |
| Las fuentes tipográficas no cargan | La página carga Google Fonts; en redes aisladas se ve con fuentes del sistema |
