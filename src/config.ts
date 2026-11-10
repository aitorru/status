import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Service, Source } from "./types.ts";

export interface Config {
  title: string;
  intervalSeconds: number;
  /** Consecutive failed checks before an incident opens (debounce). */
  failThreshold: number;
  /** Consecutive good checks before an incident resolves. */
  recoverThreshold: number;
  historySize: number;
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
  services: Service[];
}

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
    intervalSeconds: Number(raw.intervalSeconds ?? 15),
    failThreshold: Number(raw.failThreshold ?? 2),
    recoverThreshold: Number(raw.recoverThreshold ?? 2),
    historySize: Number(raw.historySize ?? 90),
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
    services: raw.services ?? [],
  };

  const ids = new Set<string>();
  for (const s of cfg.services) {
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(s.id)) throw new Error(`invalid service id "${s.id}"`);
    if (ids.has(s.id)) throw new Error(`duplicate service id "${s.id}"`);
    ids.add(s.id);
    const src = "source" in s.check ? s.check.source : undefined;
    if (src && !cfg.sources[src]?.url) {
      throw new Error(`service "${s.id}" uses source "${src}", which has no url`);
    }
  }
  return cfg;
}
