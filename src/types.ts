/**
 * `maintenance` is announced (a maintenance page's headers or a scheduled window): it is not a
 * failure, opens no incident and does not count for uptime.
 */
export type Status = "up" | "degraded" | "down" | "unknown" | "maintenance";

/** Worse statuses rank higher. */
export const RANK: Record<Status, number> = { up: 0, unknown: 1, maintenance: 2, degraded: 3, down: 4 };
export const worst = (a: Status, b: Status): Status => (RANK[b] > RANK[a] ? b : a);

export interface Source {
  url: string;
  /** Sent as `Authorization: Bearer <token>` (Grafana service account, Prom proxy…). */
  token?: string;
  /** Like `token`, read from this file on every request (a Kubernetes service account token). */
  tokenFile?: string;
  /** PEM bundle to trust for this source (the cluster CA). Only `kubernetes` checks use it. */
  caFile?: string;
  headers?: Record<string, string>;
}

/** What the Kubernetes API is asked; see docs/configuracion.md § kubernetes. */
export type KubeProbe =
  | { probe: "readyz" }
  | { probe: "version" }
  | { probe: "nodes" }
  | { probe: "deployment"; namespace: string; name: string }
  | {
      /** KubeBlocks clusters: each one must have exactly one Ready pod with role primary. */
      probe: "primary";
      namespace?: string;
      /**
       * These clusters (`app.kubernetes.io/instance`), each required even if all its pods are gone.
       * Default: every cluster the selector finds.
       */
      cluster?: string | string[];
      /** Default: KubeBlocks' PostgreSQL pods. */
      selector?: string;
    };

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
    }
  | ({ type: "kubernetes"; source: string; timeoutMs?: number } & KubeProbe);

export interface Service {
  id: string;
  name: string;
  group?: string;
  description?: string;
  /** Component page this service belongs to (`/<component>`), see `components` in the config. */
  component?: string;
  /**
   * A second request that only looks for the maintenance headers, for checks that go to a path
   * the maintenance page does not cover. `true` = the root of the check's host.
   */
  maintenanceProbe?: string | boolean;
  check: Check;
}

/** A maintenance in progress or announced. Times are epoch ms. */
export interface Maintenance {
  /** `header`: the maintenance page said so; `schedule`: a window from the config. */
  source: "header" | "schedule";
  start?: number;
  end?: number;
  /** What is being maintained, as the header or the schedule name it. */
  service?: string;
  title?: string;
  url?: string;
}

export interface CheckResult {
  status: Status;
  latencyMs?: number;
  value?: number;
  message: string;
  maintenance?: Maintenance;
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
  /** Time it was back up between a resolve and a reopen: not part of the outage. */
  pausedMs?: number;
  lastMessage: string;
  issue?: { iid: number; url?: string };
  lastSyncAt?: number;
  timeline: TimelineEntry[];
}

/** How long an incident has been (or was) down: wall time minus the gaps it was back up. */
export const downtime = (inc: Incident, now = Date.now()) =>
  Math.max(0, (inc.resolvedAt ?? now) - inc.startedAt - (inc.pausedMs ?? 0));
