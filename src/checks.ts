import type { Check, CheckResult, Source, Status } from "./types.ts";

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

export async function runCheck(check: Check, sources: Record<string, Source>): Promise<CheckResult> {
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
  }
}
