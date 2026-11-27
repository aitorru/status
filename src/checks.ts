import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { MaintenanceHeaders } from "./config.ts";
import type { Check, CheckResult, KubeProbe, Maintenance, Source, Status } from "./types.ts";

export const DEFAULT_MAINTENANCE_HEADERS: MaintenanceHeaders = {
  flag: "x-maintenance",
  start: "x-maintenance-start",
  end: "x-maintenance-end",
  service: "x-maintenance-service",
};

/** ISO 8601, epoch seconds or epoch ms. */
function headerTime(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** `Retry-After`: seconds from now or an HTTP date. */
function retryAfter(v: string | null, now: number): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return now + Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Reads the maintenance page's headers; `undefined` when the response is not one. */
export function maintenanceFrom(h: Headers, names: MaintenanceHeaders = DEFAULT_MAINTENANCE_HEADERS) {
  const flag = h.get(names.flag);
  if (flag === null || /^(0|false|off|no)$/i.test(flag.trim())) return undefined;
  const now = Date.now();
  const m: Maintenance = {
    source: "header",
    start: headerTime(h.get(names.start)),
    end: headerTime(h.get(names.end)) ?? retryAfter(h.get("retry-after"), now),
    service: h.get(names.service)?.trim() || undefined,
  };
  return m;
}

const hhmm = (t: number) =>
  new Intl.DateTimeFormat("es-ES", {
    timeZone: process.env.DISPLAY_TZ ?? "Europe/Madrid",
    dateStyle: "short",
    timeStyle: "short",
  }).format(t);

export function maintenanceMessage(m: Maintenance): string {
  const what = m.service ?? m.title;
  const until = m.end ? ` hasta ${hhmm(m.end)}` : "";
  return `en mantenimiento${what ? ` (${what})` : ""}${until}`;
}

/**
 * Only asks whether `url` answers with the maintenance page. Any other answer, or none, is
 * "not in maintenance": the service's own check decides the rest.
 */
export async function probeMaintenance(
  url: string,
  names: MaintenanceHeaders = DEFAULT_MAINTENANCE_HEADERS,
  timeoutMs = 5000,
): Promise<Maintenance | undefined> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return maintenanceFrom(res.headers, names);
  } catch {
    return undefined;
  }
}

const OPS = {
  ">=": (a: number, b: number) => a >= b,
  "<=": (a: number, b: number) => a <= b,
  ">": (a: number, b: number) => a > b,
  "<": (a: number, b: number) => a < b,
  "==": (a: number, b: number) => a === b,
  "!=": (a: number, b: number) => a !== b,
} as const;

/** Evaluates a condition such as `">= 0.99"` against a number. */
export function matches(cond: string | undefined, value: number): boolean {
  if (!cond) return false;
  const m = /^\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i.exec(cond);
  if (!m) throw new Error(`invalid condition "${cond}" (use e.g. ">= 0.99")`);
  return OPS[m[1] as keyof typeof OPS](value, Number(m[2]));
}

function classify(value: number, up: string, degraded?: string): Status {
  if (matches(up, value)) return "up";
  if (matches(degraded, value)) return "degraded";
  return "down";
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, ""));

function headers(src: Source, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json",
    ...(src.token ? { authorization: `Bearer ${src.token}` } : {}),
    ...src.headers,
    ...extra,
  };
}

async function getJson(url: string, init: RequestInit, timeoutMs: number) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const errMessage = (e: unknown) => {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "timeout";
    const cause = (e as Error & { cause?: { code?: string } }).cause?.code;
    return cause ? `${e.message} (${cause})` : e.message;
  }
  return String(e);
};

/** Grafana rules are fetched once per tick, however many services read them. */
const rulesCache = new Map<string, { at: number; data: Promise<GrafanaRule[]> }>();
interface GrafanaRule {
  name: string;
  state: string;
  health?: string;
  lastError?: string;
}

function grafanaRules(src: Source, timeoutMs: number): Promise<GrafanaRule[]> {
  const hit = rulesCache.get(src.url);
  if (hit && Date.now() - hit.at < 2000) return hit.data;
  const data = getJson(`${src.url}/api/prometheus/grafana/api/v1/rules`, { headers: headers(src) }, timeoutMs).then(
    (j) => (j?.data?.groups ?? []).flatMap((g: { rules?: GrafanaRule[] }) => g.rules ?? []),
  );
  rulesCache.set(src.url, { at: Date.now(), data });
  data.catch(() => rulesCache.delete(src.url));
  return data;
}

// ── Kubernetes API ──────────────────────────────────────────────
// node:https instead of fetch so the cluster CA can be passed per source, without
// NODE_EXTRA_CA_CERTS or turning verification off.

function kubeGet(src: Source, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const url = new URL(`${src.url.replace(/\/+$/, "")}${path}`);
  const token = src.tokenFile ? readFileSync(src.tokenFile, "utf8").trim() : src.token;
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...src.headers },
        ...(src.caFile ? { ca: readFileSync(src.caFile) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function kubeJson(src: Source, path: string, timeoutMs: number) {
  const r = await kubeGet(src, path, timeoutMs);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 160)}`);
  return JSON.parse(r.body);
}

interface KubeCondition {
  type: string;
  status: string;
}
interface KubeObject {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { conditions?: KubeCondition[]; phase?: string; readyReplicas?: number };
  spec?: { replicas?: number };
}
const isReady = (o: KubeObject) => o.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");

const KB_PG = "app.kubernetes.io/managed-by=kubeblocks,apps.kubeblocks.io/component-name=postgresql";

async function kubeCheck(c: KubeProbe, src: Source, timeoutMs: number): Promise<Omit<CheckResult, "latencyMs">> {
  switch (c.probe) {
    case "readyz": {
      const r = await kubeGet(src, "/readyz?verbose", timeoutMs);
      if (r.status === 200) return { status: "up", message: "readyz ok" };
      const failed = r.body.split("\n").find((l) => l.startsWith("[-]"));
      return { status: "down", message: `readyz HTTP ${r.status}${failed ? `: ${failed.slice(3).trim()}` : ""}` };
    }
    case "version": {
      const j = await kubeJson(src, "/version", timeoutMs);
      return { status: "up", message: String(j.gitVersion ?? "versión desconocida") };
    }
    case "nodes": {
      const items: KubeObject[] = (await kubeJson(src, "/api/v1/nodes", timeoutMs)).items ?? [];
      const ready = items.filter(isReady);
      const missing = items.filter((n) => !isReady(n)).map((n) => n.metadata.name);
      const msg = `${ready.length}/${items.length} nodos Ready${missing.length ? ` · no: ${missing.join(", ")}` : ""}`;
      const status = !items.length || !ready.length ? "down" : missing.length ? "degraded" : "up";
      return { status, value: ready.length, message: msg };
    }
    case "deployment": {
      const ns = encodeURIComponent(c.namespace);
      const d: KubeObject = await kubeJson(
        src,
        `/apis/apps/v1/namespaces/${ns}/deployments/${encodeURIComponent(c.name)}`,
        timeoutMs,
      );
      const want = d.spec?.replicas ?? 1;
      const ready = d.status?.readyReplicas ?? 0;
      const status = ready >= want && want > 0 ? "up" : ready > 0 ? "degraded" : "down";
      return { status, value: ready, message: `${c.name}: ${ready}/${want} réplicas listas` };
    }
    case "primary": {
      // Named clusters are expected even when none of their pods is left.
      const expected = [c.cluster ?? []].flat();
      const selector = [
        c.selector ?? KB_PG,
        ...(expected.length ? [`app.kubernetes.io/instance in (${expected.join(",")})`] : []),
      ].join(",");
      const base = c.namespace ? `/api/v1/namespaces/${encodeURIComponent(c.namespace)}/pods` : "/api/v1/pods";
      const pods: KubeObject[] = (
        await kubeJson(src, `${base}?labelSelector=${encodeURIComponent(selector)}`, timeoutMs)
      ).items;
      const clusters = new Map<string, string[]>(expected.map((n) => [n, []]));
      for (const p of pods ?? []) {
        const name = p.metadata.labels?.["app.kubernetes.io/instance"] ?? "?";
        const list = clusters.get(name) ?? [];
        if (p.metadata.labels?.["kubeblocks.io/role"] === "primary" && isReady(p)) list.push(p.metadata.name);
        clusters.set(name, list);
      }
      if (!clusters.size) return { status: "down", message: `ningún pod con ${selector}` };
      const none = [...clusters].filter(([, p]) => p.length === 0).map(([n]) => n);
      const many = [...clusters].filter(([, p]) => p.length > 1).map(([n]) => n);
      if (none.length) return { status: "down", message: `sin primario: ${none.join(", ")}` };
      if (many.length) return { status: "degraded", message: `varios primarios: ${many.join(", ")}` };
      const primaries = [...clusters.values()].map((p) => p[0]);
      return {
        status: "up",
        value: clusters.size,
        message: clusters.size === 1 ? `primario: ${primaries[0]}` : `${clusters.size} clústeres con primario`,
      };
    }
  }
}

export async function runCheck(
  check: Check,
  sources: Record<string, Source>,
  maintenanceHeaders: MaintenanceHeaders = DEFAULT_MAINTENANCE_HEADERS,
): Promise<CheckResult> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  try {
    switch (check.type) {
      case "http": {
        const res = await fetch(check.url, {
          method: check.method ?? "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(check.timeoutMs ?? 5000),
        });
        // The maintenance page covers this path: whatever the code or body, it is announced.
        const maintenance = maintenanceFrom(res.headers, maintenanceHeaders);
        if (maintenance) {
          await res.body?.cancel();
          return { status: "maintenance", latencyMs: elapsed(), message: maintenanceMessage(maintenance), maintenance };
        }
        let body = "";
        if (check.bodyContains) body = await res.text();
        else await res.body?.cancel();
        const ms = elapsed();
        const expected = check.expectStatus;
        const okStatus =
          expected === undefined ? res.status >= 200 && res.status < 400 : [expected].flat().includes(res.status);
        if (!okStatus) return { status: "down", latencyMs: ms, message: `HTTP ${res.status}` };
        if (check.bodyContains && !body.includes(check.bodyContains)) {
          return { status: "down", latencyMs: ms, message: `respuesta sin "${check.bodyContains}"` };
        }
        if (check.degradedLatencyMs && ms > check.degradedLatencyMs) {
          return { status: "degraded", latencyMs: ms, message: `lento: ${ms} ms` };
        }
        return { status: "up", latencyMs: ms, message: `HTTP ${res.status}` };
      }

      case "prometheus": {
        const src = sources[check.source] as Source;
        const url = `${src.url}/api/v1/query?query=${encodeURIComponent(check.query)}`;
        const j = await getJson(url, { headers: headers(src) }, check.timeoutMs ?? 5000);
        const r = j?.data?.result;
        const raw = j?.data?.resultType === "scalar" ? r?.[1] : r?.[0]?.value?.[1];
        if (raw === undefined) {
          return { status: check.noData ?? "down", latencyMs: elapsed(), message: "sin datos" };
        }
        const value = Number(raw);
        return {
          status: classify(value, check.up, check.degraded),
          latencyMs: elapsed(),
          value,
          message: `valor ${fmt(value)}`,
        };
      }

      case "grafana-query": {
        const src = sources[check.source] as Source;
        const j = await getJson(
          `${src.url}/api/ds/query`,
          {
            method: "POST",
            headers: headers(src, { "content-type": "application/json" }),
            body: JSON.stringify({
              from: "now-5m",
              to: "now",
              queries: [
                {
                  refId: "A",
                  datasource: { uid: check.datasourceUid },
                  expr: check.expr,
                  instant: true,
                  range: false,
                  ...check.extra,
                },
              ],
            }),
          },
          check.timeoutMs ?? 8000,
        );
        const result = j?.results?.A;
        if (result?.error) throw new Error(result.error);
        const frame = result?.frames?.at(-1);
        const column = frame?.data?.values?.at(-1);
        const raw = Array.isArray(column) ? column.at(-1) : undefined;
        if (raw === undefined || raw === null) {
          return { status: check.noData ?? "down", latencyMs: elapsed(), message: "sin datos" };
        }
        const value = Number(raw);
        return {
          status: classify(value, check.up, check.degraded),
          latencyMs: elapsed(),
          value,
          message: `valor ${fmt(value)}`,
        };
      }

      case "grafana-alert": {
        const src = sources[check.source] as Source;
        const rules = await grafanaRules(src, check.timeoutMs ?? 5000);
        const rule = rules.find((r) => r.name === check.rule);
        if (!rule) return { status: "unknown", message: `regla "${check.rule}" no encontrada` };
        const state = rule.state.toLowerCase();
        if (state === "firing" || state === "alerting") {
          return { status: check.firing ?? "down", latencyMs: elapsed(), message: "alerta activa" };
        }
        if (state === "pending") {
          return { status: "degraded", latencyMs: elapsed(), message: "alerta pendiente" };
        }
        if (rule.health && rule.health !== "ok") {
          const why = rule.lastError ? `: ${rule.lastError}` : "";
          return { status: "degraded", latencyMs: elapsed(), message: `regla ${rule.health}${why}` };
        }
        return { status: "up", latencyMs: elapsed(), message: "sin alertas" };
      }

      case "grafana-webhook":
        // Push-based: Grafana only calls when something fires, so silence means healthy.
        return { status: "up", message: "sin alertas recibidas" };

      case "kubernetes": {
        const r = await kubeCheck(check, sources[check.source] as Source, check.timeoutMs ?? 5000);
        return { ...r, latencyMs: elapsed() };
      }
    }
  } catch (e) {
    return { status: "down", latencyMs: elapsed(), message: errMessage(e) };
  }
}

/** One-line description of where a service's data comes from (shown in the UI and issues). */
export function describeCheck(check: Check): { kind: string; detail: string } {
  switch (check.type) {
    case "http":
      return { kind: "http", detail: `${check.method ?? "GET"} ${check.url}` };
    case "prometheus":
      return { kind: "prometheus", detail: check.query };
    case "grafana-query":
      return { kind: "grafana", detail: check.expr };
    case "grafana-alert":
      return { kind: "grafana", detail: `regla «${check.rule}»` };
    case "grafana-webhook":
      return { kind: "grafana", detail: "webhook de alertas" };
    case "kubernetes": {
      const detail = {
        readyz: "GET /readyz",
        version: "GET /version",
        nodes: "nodos Ready",
        deployment: check.probe === "deployment" ? `deployment ${check.namespace}/${check.name}` : "",
        primary:
          check.probe === "primary"
            ? `primario KubeBlocks${check.cluster ? ` ${check.cluster}` : ""}${check.namespace ? ` en ${check.namespace}` : ""}`
            : "",
      }[check.probe];
      return { kind: "kubernetes", detail };
    }
  }
}
