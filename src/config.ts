import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Service, Source } from "./types.ts";

/** Response headers a maintenance page sends. Names are case-insensitive. */
export interface MaintenanceHeaders {
  /** Present (and not `0`/`false`/`off`/`no`) = the host is in maintenance. */
  flag: string;
  /** ISO 8601 or epoch seconds. */
  start: string;
  /** ISO 8601 or epoch seconds. Without it, `Retry-After` is used. */
  end: string;
  /** What is being maintained. */
  service: string;
}

/** A maintenance window announced ahead of time (`maintenances[]` in services.json). */
export interface ScheduledMaintenance {
  id: string;
  title: string;
  /** Service ids it covers. */
  services: string[];
  start: number;
  end: number;
  description?: string;
  /** Where it was announced (an issue, a mail…). */
  url?: string;
}

export interface Component {
  name: string;
  description?: string;
  /** Brand colour, any CSS colour. */
  color?: string;
  /** Logo URL (absolute, or a path under public/). Without it, a monogram in `color`. */
  logo?: string;
}

/** Paths the server already answers: a component cannot take them. */
const RESERVED = new Set(["api", "healthz", "hooks", "index.html", "app.js", "app.css", "punto.css"]);

export interface Config {
  title: string;
  /**
   * Main headline while everything is up, e.g. "DevTools *status*" (`*…*` is set in italics).
   * Unset: "Todo *funciona*". With something down or degraded the headline says so instead.
   */
  headline?: string;
  intervalSeconds: number;
  /** Consecutive failed checks before an incident opens (debounce). */
  failThreshold: number;
  /** Consecutive good checks before an incident resolves. */
  recoverThreshold: number;
  historySize: number;
  /** Days a resolved incident stays on the page. 0 keeps them (only the last 20). */
  resolvedRetentionDays: number;
  publicUrl?: string;
  hookToken?: string;
  sources: Record<string, Source>;
  gitlab: {
    url?: string;
    token?: string;
    project?: string;
    labels: string[];
    assigneeIds: number[];
    confidential: boolean;
    /** Refresh the live status block in the issue at least this often while open. */
    heartbeatMinutes: number;
    /** A new failure within this window reopens the last issue instead of filing a new one. */
    reopenMinutes: number;
    closeOnRecover: boolean;
  };
  maintenanceHeaders: MaintenanceHeaders;
  maintenances: ScheduledMaintenance[];
  components: Record<string, Component>;
  services: Service[];
}

const time = (v: unknown, what: string): number => {
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t))
    throw new Error(`${what}: "${v}" is not a date (use ISO 8601, e.g. 2026-12-01T20:00:00+01:00)`);
  return t;
};

/** Replaces `${VAR}` / `${VAR:-default}` in every string of the JSON with env values. */
function interpolate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
      return process.env[name] ?? def ?? "";
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

export function loadConfig(path = process.env.CONFIG ?? "config/services.json"): Config {
  const raw = interpolate(JSON.parse(readFileSync(resolve(path), "utf8"))) as Partial<Config>;
  const gl = (raw.gitlab ?? {}) as Partial<Config["gitlab"]>;
  const cfg: Config = {
    title: raw.title ?? "Estado de servicios",
    headline: raw.headline || undefined,
    intervalSeconds: Number(raw.intervalSeconds ?? 15),
    failThreshold: Number(raw.failThreshold ?? 2),
    recoverThreshold: Number(raw.recoverThreshold ?? 2),
    historySize: Number(raw.historySize ?? 90),
    resolvedRetentionDays: Number(raw.resolvedRetentionDays ?? 7),
    publicUrl: raw.publicUrl || process.env.PUBLIC_URL || undefined,
    hookToken: raw.hookToken || process.env.HOOK_TOKEN || undefined,
    sources: raw.sources ?? {},
    gitlab: {
      url: (gl.url || process.env.GITLAB_URL || "").replace(/\/+$/, "") || undefined,
      token: gl.token || process.env.GITLAB_TOKEN || undefined,
      project: gl.project || process.env.GITLAB_PROJECT || undefined,
      labels: gl.labels ?? ["incident", "status-page"],
      assigneeIds: gl.assigneeIds ?? [],
      confidential: gl.confidential ?? false,
      heartbeatMinutes: Number(gl.heartbeatMinutes ?? 5),
      reopenMinutes: Number(gl.reopenMinutes ?? 30),
      closeOnRecover: gl.closeOnRecover ?? true,
    },
    maintenanceHeaders: {
      flag: "x-maintenance",
      start: "x-maintenance-start",
      end: "x-maintenance-end",
      service: "x-maintenance-service",
      ...raw.maintenanceHeaders,
    },
    maintenances: [],
    components: raw.components ?? {},
    services: raw.services ?? [],
  };
  for (const k of Object.keys(cfg.maintenanceHeaders) as (keyof MaintenanceHeaders)[]) {
    cfg.maintenanceHeaders[k] = cfg.maintenanceHeaders[k].toLowerCase();
  }

  const ids = new Set<string>();
  for (const s of cfg.services) {
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(s.id)) throw new Error(`invalid service id "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`duplicate service id "${s.id}"`);
    ids.add(s.id);
    const src = "source" in s.check ? s.check.source : undefined;
    if (src && !cfg.sources[src]?.url) {
      throw new Error(`service "${s.id}" uses source "${src}", which has no url`);
    }
    if (s.maintenanceProbe === true && s.check.type !== "http") {
      throw new Error(`service "${s.id}": maintenanceProbe: true needs an http check; give it a URL instead`);
    }
    if (s.component && !cfg.components[s.component]) {
      throw new Error(`service "${s.id}" uses component "${s.component}", which is not in components`);
    }
  }
  for (const id of Object.keys(cfg.components)) {
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(id) || RESERVED.has(id)) throw new Error(`invalid component id "${id}"`);
  }

  const raws = (raw as { maintenances?: Record<string, unknown>[] }).maintenances ?? [];
  cfg.maintenances = raws.map((m, i) => {
    const what = `maintenances[${i}]`;
    const services = [m.services ?? []].flat().map(String);
    for (const id of services) if (!ids.has(id)) throw new Error(`${what}: unknown service "${id}"`);
    if (!services.length) throw new Error(`${what}: needs at least one service`);
    const start = time(m.start, `${what}.start`);
    const end = time(m.end, `${what}.end`);
    if (end <= start) throw new Error(`${what}: end must be after start`);
    return {
      id: String(m.id ?? `${services.join("+")}-${start}`),
      title: String(m.title ?? "Mantenimiento programado"),
      services,
      start,
      end,
      description: m.description ? String(m.description) : undefined,
      url: m.url ? String(m.url) : undefined,
    };
  });
  return cfg;
}
