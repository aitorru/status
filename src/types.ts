export type Status = "up" | "degraded" | "down" | "unknown";

/** Worse statuses rank higher. */
export const RANK: Record<Status, number> = { up: 0, unknown: 1, degraded: 2, down: 3 };
export const worst = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);

export interface Source {
  url: string;
  /** Sent as `Authorization: Bearer <token>` (Grafana service account, Prom proxy…). */
  token?: string;
  headers?: Record<string, string>;
}

export type Check =
  | {
      type: "http";
      url: string;
      method?: string;
      /** Exact code(s) that count as healthy. Default: any 2xx/3xx. */
      expectStatus?: number | number[];
      bodyContains?: string;
      degradedLatencyMs?: number;
      timeoutMs?: number;
    }
  | {
      /** Direct PromQL against Prometheus/Mimir/Thanos (`/api/v1/query`). */
      type: "prometheus";
      source: string;
      query: string;
      up: string;
      degraded?: string;
      noData?: Status;
      timeoutMs?: number;
    }
  | {
      /** Any Grafana datasource through Grafana's `/api/ds/query`. */
      type: "grafana-query";
      source: string;
      datasourceUid: string;
      expr: string;
      /** Extra fields merged into the query (e.g. `rawSql`, `format` for SQL datasources). */
      extra?: Record<string, unknown>;
      up: string;
      degraded?: string;
      noData?: Status;
      timeoutMs?: number;
    }
  | {
      /** State of a Grafana-managed alert rule (firing / pending / normal). */
      type: "grafana-alert";
      source: string;
      rule: string;
      firing?: Status;
      timeoutMs?: number;
    }
  | {
      /** Pushed by a Grafana webhook contact point to POST /hooks/grafana. */
      type: "grafana-webhook";
      /** Alert labels that must match; default `{ service: <id> }`. */
      match?: Record<string, string>;
      firing?: Status;
    };

export interface Service {
  id: string;
  name: string;
  group?: string;
  description?: string;
  check: Check;
}

export interface CheckResult {
  status: Status;
  latencyMs?: number;
  value?: number;
  message: string;
}

export interface Sample {
  t: number;
  s: Status;
  ms?: number;
}

export interface TimelineEntry {
  t: number;
  status: Status | "resolved" | "reopened";
  text: string;
}

export interface Incident {
  id: string;
  serviceId: string;
  serviceName: string;
  startedAt: number;
  resolvedAt?: number;
  status: Status;
  worst: Status;
  failedChecks: number;
  lastMessage: string;
  issue?: { iid: number; url?: string };
  lastSyncAt?: number;
  timeline: TimelineEntry[];
}
