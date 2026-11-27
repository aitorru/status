import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeCheck, maintenanceMessage, probeMaintenance, runCheck } from "./checks.ts";
import type { Config } from "./config.ts";
import type { GitLab } from "./gitlab.ts";
import {
  type CheckResult,
  downtime,
  type Incident,
  type Maintenance,
  RANK,
  type Sample,
  type Service,
  type Status,
  worst,
} from "./types.ts";

const LABEL: Record<Status, string> = {
  up: "operativo",
  degraded: "degradado",
  down: "caído",
  unknown: "sin datos",
  maintenance: "en mantenimiento",
};
const EMOJI: Record<Status, string> = { up: "🟢", degraded: "🟠", down: "🔴", unknown: "⚪", maintenance: "🔵" };
const SAMPLE: Record<Status, string> = { up: "u", degraded: "d", down: "x", unknown: "-", maintenance: "m" };
const MARK_START = "<!-- status-page -->";
const MARK_END = "<!-- /status-page -->";

const tz = process.env.DISPLAY_TZ ?? "Europe/Madrid";
const when = (t: number) =>
  new Intl.DateTimeFormat("es-ES", {
    timeZone: tz,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(t);
const duration = (ms: number) => {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

interface ServiceState {
  history: Sample[];
  status: Status;
  last?: CheckResult & { at: number };
  fails: number;
  oks: number;
  pushed?: CheckResult;
  incident?: Incident;
  /** Set while the last result was a maintenance. */
  maintenance?: Maintenance;
}

interface Persisted {
  services: Record<string, Pick<ServiceState, "history" | "status" | "incident" | "maintenance">>;
  incidents: Incident[];
}

export class Monitor extends EventEmitter {
  readonly cfg: Config;
  readonly gitlab: GitLab;
  readonly state = new Map<string, ServiceState>();
  /** Resolved incidents, newest first. */
  resolved: Incident[] = [];
  lastTickAt = 0;
  private queues = new Map<string, Promise<void>>();
  private file: string;
  private timer?: NodeJS.Timeout;

  constructor(cfg: Config, gitlab: GitLab, file = process.env.STATE_FILE ?? "data/state.json") {
    super();
    this.cfg = cfg;
    this.gitlab = gitlab;
    this.file = file;
    for (const s of cfg.services) {
      this.state.set(s.id, { history: [], status: "unknown", fails: 0, oks: 0 });
    }
    this.load();
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start() {
    await this.adoptOpenIssues();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalSeconds * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const results = await Promise.all(
      this.cfg.services.map(async (svc) => {
        const st = this.must(svc.id);
        const [r, probed] = await Promise.all([
          svc.check.type === "grafana-webhook" && st.pushed
            ? st.pushed
            : runCheck(svc.check, this.cfg.sources, this.cfg.maintenanceHeaders),
          this.probeFor(svc),
        ]);
        return [svc, this.withMaintenance(svc, r, probed)] as const;
      }),
    );
    for (const [svc, r] of results) this.apply(svc, r);
    this.lastTickAt = Date.now();
    this.expireResolved(this.lastTickAt);
    this.save();
    this.emit("update");
  }

  /** The root-of-host probe for services whose own check does not see the maintenance page. */
  private probeFor(svc: Service): Promise<Maintenance | undefined> {
    const p = svc.maintenanceProbe;
    if (!p) return Promise.resolve(undefined);
    const url = p === true && svc.check.type === "http" ? new URL("/", svc.check.url).href : String(p);
    return probeMaintenance(url, this.cfg.maintenanceHeaders);
  }

  /** Scheduled window covering this service right now, if any. */
  scheduledFor(serviceId: string, now = Date.now()) {
    return this.cfg.maintenances.find((m) => m.services.includes(serviceId) && m.start <= now && now < m.end);
  }

  /**
   * A maintenance announced by the root probe, or a scheduled window, turns a failure into a
   * maintenance. A healthy result inside a window stays healthy.
   */
  private withMaintenance(svc: Service, r: CheckResult, probed?: Maintenance): CheckResult {
    if (r.status === "maintenance") return r;
    if (probed) return { ...r, status: "maintenance", message: maintenanceMessage(probed), maintenance: probed };
    // Only failures: no data inside a window is still no data.
    const window = r.status === "down" || r.status === "degraded" ? this.scheduledFor(svc.id) : undefined;
    if (!window) return r;
    const maintenance: Maintenance = {
      source: "schedule",
      start: window.start,
      end: window.end,
      title: window.title,
      url: window.url,
    };
    return { ...r, status: "maintenance", message: `${maintenanceMessage(maintenance)} · ${r.message}`, maintenance };
  }

  /** Called by POST /hooks/grafana. Returns the service ids it touched. */
  push(alerts: { status?: string; labels?: Record<string, string> }[]): string[] {
    const touched: string[] = [];
    for (const svc of this.cfg.services) {
      if (svc.check.type !== "grafana-webhook") continue;
      const match = svc.check.match ?? { service: svc.id };
      const mine = alerts.filter((a) => Object.entries(match).every(([k, v]) => a.labels?.[k] === v));
      if (!mine.length) continue;
      const firing = mine.filter((a) => a.status === "firing");
      const st = this.must(svc.id);
      st.pushed = firing.length
        ? {
            status: svc.check.firing ?? "down",
            message: `alerta: ${firing.map((a) => a.labels?.alertname ?? "?").join(", ")}`,
          }
        : { status: "up", message: "alertas resueltas" };
      // Webhooks are already debounced by Grafana's `for:`; apply them right away.
      st.fails = st.oks = Math.max(this.cfg.failThreshold, this.cfg.recoverThreshold) - 1;
      // Until the next poll says otherwise, the last probe's maintenance still holds.
      const probed = st.maintenance?.source === "header" ? st.maintenance : undefined;
      this.apply(svc, this.withMaintenance(svc, st.pushed, probed));
      touched.push(svc.id);
    }
    if (touched.length) {
      this.save();
      this.emit("update");
    }
    return touched;
  }

  // ── State machine ────────────────────────────────────────────

  private apply(svc: Service, r: CheckResult) {
    const st = this.must(svc.id);
    const now = Date.now();
    st.last = { ...r, at: now };
    st.history.push({ t: now, s: r.status, ms: r.latencyMs });
    if (st.history.length > this.cfg.historySize) st.history.splice(0, st.history.length - this.cfg.historySize);

    if (r.status === "maintenance") {
      // Announced: not a failure and not a recovery. An open incident waits for the real
      // checks to resume; a closed one is not opened.
      st.maintenance = r.maintenance;
      st.fails = st.oks = 0;
      st.status = "maintenance";
      return;
    }
    st.maintenance = undefined;
    if (st.status === "maintenance") st.status = st.incident?.status ?? "unknown";

    if (r.status === "unknown") {
      // No signal: neither confirms nor clears anything.
      if (!st.incident) st.status = "unknown";
      return;
    }
    if (r.status === "up") {
      st.oks++;
      st.fails = 0;
      if (!st.incident) st.status = "up";
      else if (st.oks >= this.cfg.recoverThreshold) this.resolve(svc, st);
      return;
    }
    st.fails++;
    st.oks = 0;
    if (st.incident) {
      const inc = st.incident;
      inc.failedChecks++;
      inc.lastMessage = r.message;
      if (st.fails >= this.cfg.failThreshold && r.status !== inc.status) {
        this.transition(svc, st, r.status);
      } else if (this.heartbeatDue(inc)) {
        this.enqueue(svc.id, () => this.syncDescription(svc, inc));
      }
      if (!inc.issue && now - (inc.lastSyncAt ?? 0) > 30_000) {
        this.enqueue(svc.id, () => this.fileIssue(svc, inc)); // retry a failed create
      }
    } else if (st.fails >= this.cfg.failThreshold) {
      this.open(svc, st, r);
    } else if (st.status === "unknown") {
      st.status = r.status;
    }
  }

  private open(svc: Service, st: ServiceState, r: CheckResult) {
    const now = Date.now();
    const recent = this.resolved.find(
      (i) => i.serviceId === svc.id && i.issue && now - (i.resolvedAt ?? 0) < this.cfg.gitlab.reopenMinutes * 60_000,
    );
    if (recent) {
      // Flapping: keep following the same issue. The time it was fine in between is not
      // part of the outage.
      // The first failing sample of this run (not `fails` back: a webhook seeds that counter).
      // No data in between does not end the run, as it does not reset `fails`.
      let failedAt = now;
      for (let i = st.history.length - 1; i >= 0; i--) {
        const h = st.history[i];
        if (!h || h.s === "up" || h.s === "maintenance") break;
        if (h.s !== "unknown") failedAt = h.t;
      }
      recent.pausedMs = (recent.pausedMs ?? 0) + Math.max(0, failedAt - (recent.resolvedAt ?? failedAt));
      this.resolved = this.resolved.filter((i) => i !== recent);
      recent.resolvedAt = undefined;
      recent.status = r.status;
      recent.worst = worst(recent.worst, r.status);
      recent.failedChecks += st.fails;
      recent.lastMessage = r.message;
      recent.timeline.push({ t: now, status: "reopened", text: `Vuelve a fallar: ${r.message}` });
      st.incident = recent;
      st.status = r.status;
      console.log(`[incident] ${svc.id} reopened (#${recent.issue?.iid}): ${r.message}`);
      this.enqueue(svc.id, () => this.syncReopen(svc, recent));
      return;
    }
    const inc: Incident = {
      id: `${svc.id}-${now}`,
      serviceId: svc.id,
      serviceName: svc.name,
      startedAt: st.history.at(-st.fails)?.t ?? now,
      status: r.status,
      worst: r.status,
      failedChecks: st.fails,
      lastMessage: r.message,
      timeline: [{ t: now, status: r.status, text: `${LABEL[r.status]}: ${r.message}` }],
    };
    st.incident = inc;
    st.status = r.status;
    console.log(`[incident] ${svc.id} ${r.status}: ${r.message}`);
    this.enqueue(svc.id, () => this.fileIssue(svc, inc));
  }

  private transition(svc: Service, st: ServiceState, to: Status) {
    const inc = st.incident as Incident;
    const from = inc.status;
    inc.status = to;
    inc.worst = worst(inc.worst, to);
    st.status = to;
    inc.timeline.push({ t: Date.now(), status: to, text: `${LABEL[from]} → ${LABEL[to]}: ${inc.lastMessage}` });
    console.log(`[incident] ${svc.id} ${from} → ${to}`);
    this.enqueue(svc.id, () => this.syncTransition(svc, inc, from));
  }

  private resolve(svc: Service, st: ServiceState) {
    const inc = st.incident as Incident;
    const now = Date.now();
    inc.resolvedAt = now;
    inc.timeline.push({ t: now, status: "resolved", text: `Recuperado tras ${duration(downtime(inc, now))}` });
    st.incident = undefined;
    st.status = "up";
    this.resolved.unshift(inc);
    this.resolved = this.resolved.slice(0, 20);
    console.log(`[incident] ${svc.id} resolved after ${duration(downtime(inc, now))}`);
    this.enqueue(svc.id, () => this.syncResolve(svc, inc));
  }

  // ── GitLab sync (serialised per service) ─────────────────────

  private enqueue(id: string, job: () => Promise<void>) {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev
      .then(job)
      .catch((e) => console.error(`[gitlab] ${id}: ${e instanceof Error ? e.message : e}`))
      .then(() => {
        this.save();
        this.emit("update");
      });
    this.queues.set(id, next);
  }

  private heartbeatDue(inc: Incident) {
    return Boolean(inc.issue) && Date.now() - (inc.lastSyncAt ?? 0) > this.cfg.gitlab.heartbeatMinutes * 60_000;
  }

  private labels(svc: Service, status: Status | "resolved") {
    return [...this.cfg.gitlab.labels, `service::${svc.id}`, `status::${status}`];
  }

  private title(svc: Service, status: Status | "resolved") {
    const word = status === "resolved" ? "resuelto" : LABEL[status];
    const icon = status === "resolved" ? "✅" : EMOJI[status];
    return `${icon} ${svc.name} — ${word}`;
  }

  private statusBlock(svc: Service, inc: Incident) {
    const st = this.must(svc.id);
    const src = describeCheck(svc.check);
    const now = Date.now();
    const state = inc.resolvedAt
      ? `✅ **Resuelto** · duró ${duration(downtime(inc))}`
      : `${EMOJI[inc.status]} **${LABEL[inc.status]}** · ${duration(downtime(inc, now))}`;
    const rows = [
      ["Estado", state],
      ["Servicio", `${svc.name} (\`${svc.id}\`)${svc.group ? ` · ${svc.group}` : ""}`],
      ["Inicio", when(inc.startedAt)],
      ...(inc.resolvedAt ? [["Fin", when(inc.resolvedAt)]] : []),
      ["Peor estado", `${EMOJI[inc.worst]} ${LABEL[inc.worst]}`],
      ["Comprobaciones fallidas", String(inc.failedChecks)],
      ["Última comprobación", st.last ? `${when(st.last.at)} — \`${st.last.message}\`` : "—"],
      ["Fuente", `${src.kind} · \`${src.detail.replaceAll("`", "'")}\``],
      ...(this.cfg.publicUrl ? [["Health page", this.cfg.publicUrl]] : []),
    ];
    const timeline = inc.timeline
      .slice(-15)
      .map((e) => `- \`${when(e.t)}\` ${e.text}`)
      .join("\n");
    return [
      MARK_START,
      "### Estado en vivo",
      "",
      "| | |",
      "|---|---|",
      ...rows.map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "<details><summary>Cronología</summary>",
      "",
      timeline,
      "",
      "</details>",
      "",
      `_Bloque actualizado automáticamente por la página de estado (${when(now)}). Lo de debajo es vuestro._`,
      MARK_END,
    ].join("\n");
  }

  private async fileIssue(svc: Service, inc: Incident) {
    if (inc.issue) return;
    inc.lastSyncAt = Date.now();
    const description = `${this.statusBlock(svc, inc)}\n\n### Notas del equipo\n\n_Usad los comentarios para el seguimiento; status añadirá uno en cada cambio de estado._\n`;
    const issue = await this.gitlab.createIssue(this.title(svc, inc.status), description, this.labels(svc, inc.status));
    inc.issue = { iid: issue.iid, url: issue.web_url };
    console.log(`[gitlab] ${svc.id}: issue #${issue.iid} ${issue.web_url ?? "(dry-run)"}`);
  }

  /** Rewrites only the marked block, keeping whatever humans wrote around it. */
  private async syncDescription(svc: Service, inc: Incident, extra: Parameters<GitLab["updateIssue"]>[1] = {}) {
    if (!inc.issue) return this.fileIssue(svc, inc);
    inc.lastSyncAt = Date.now();
    const block = this.statusBlock(svc, inc);
    const current = (await this.gitlab.getIssue(inc.issue.iid))?.description ?? "";
    const start = current.indexOf(MARK_START);
    const end = current.indexOf(MARK_END);
    const description =
      start >= 0 && end > start
        ? current.slice(0, start) + block + current.slice(end + MARK_END.length)
        : `${block}\n\n${current}`;
    await this.gitlab.updateIssue(inc.issue.iid, { ...extra, description });
  }

  private statusLabels(svc: Service, to: Status | "resolved") {
    const all = ["up", "degraded", "down", "unknown", "resolved"].filter((s) => s !== to);
    return {
      add_labels: this.labels(svc, to).join(","),
      remove_labels: all.map((s) => `status::${s}`).join(","),
    };
  }

  private async syncTransition(svc: Service, inc: Incident, from: Status) {
    if (!inc.issue) return this.fileIssue(svc, inc);
    const arrow = RANK[inc.status] > RANK[from] ? "empeora" : "mejora";
    await this.gitlab.addNote(
      inc.issue.iid,
      `${EMOJI[inc.status]} **${LABEL[from]} → ${LABEL[inc.status]}** (${arrow})\n\n\`${inc.lastMessage}\` · ${when(Date.now())}`,
    );
    await this.syncDescription(svc, inc, { title: this.title(svc, inc.status), ...this.statusLabels(svc, inc.status) });
  }

  private async syncResolve(svc: Service, inc: Incident) {
    if (!inc.issue) return;
    const took = duration(downtime(inc));
    await this.gitlab.addNote(
      inc.issue.iid,
      `✅ **Recuperado** tras ${took}. ${this.cfg.recoverThreshold} comprobaciones seguidas correctas.${
        this.cfg.gitlab.closeOnRecover
          ? "\n\nCierro la issue; se reabrirá si vuelve a fallar en los próximos " +
            this.cfg.gitlab.reopenMinutes +
            " min."
          : ""
      }`,
    );
    await this.syncDescription(svc, inc, {
      title: this.title(svc, "resolved"),
      ...this.statusLabels(svc, "resolved"),
      ...(this.cfg.gitlab.closeOnRecover ? { state_event: "close" as const } : {}),
    });
  }

  private async syncReopen(svc: Service, inc: Incident) {
    if (!inc.issue) return this.fileIssue(svc, inc);
    await this.gitlab.addNote(
      inc.issue.iid,
      `${EMOJI[inc.status]} **Vuelve a fallar** (${LABEL[inc.status]}): \`${inc.lastMessage}\``,
    );
    await this.syncDescription(svc, inc, {
      title: this.title(svc, inc.status),
      ...this.statusLabels(svc, inc.status),
      state_event: "reopen",
    });
  }

  /** On boot, pick up issues we opened before a restart instead of filing duplicates. */
  private async adoptOpenIssues() {
    if (!this.gitlab.live) return;
    try {
      for (const issue of await this.gitlab.listOpen()) {
        const id = issue.labels.find((l) => l.startsWith("service::"))?.slice(9);
        const svc = this.cfg.services.find((s) => s.id === id);
        const st = id ? this.state.get(id) : undefined;
        if (!svc || !st || st.incident?.issue?.iid === issue.iid) continue;
        const status = (issue.labels.find((l) => l.startsWith("status::"))?.slice(8) ?? "down") as Status;
        st.incident = {
          id: `${svc.id}-${Date.parse(issue.created_at)}`,
          serviceId: svc.id,
          serviceName: svc.name,
          startedAt: Date.parse(issue.created_at),
          status,
          worst: status,
          failedChecks: 0,
          lastMessage: "retomada tras reinicio",
          issue: { iid: issue.iid, url: issue.web_url },
          timeline: [{ t: Date.now(), status, text: "Seguimiento retomado tras reiniciar la página de estado" }],
        };
        st.status = status;
        console.log(`[gitlab] adopted open issue #${issue.iid} for ${svc.id}`);
      }
    } catch (e) {
      console.error(`[gitlab] could not list open issues: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── Persistence & snapshot ───────────────────────────────────

  private must(id: string): ServiceState {
    const st = this.state.get(id);
    if (!st) throw new Error(`unknown service ${id}`);
    return st;
  }

  private load() {
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      for (const [id, saved] of Object.entries(data.services ?? {})) {
        const st = this.state.get(id);
        if (!st) continue;
        st.history = (saved.history ?? []).slice(-this.cfg.historySize);
        st.status = saved.status ?? "unknown";
        st.incident = saved.incident;
        st.maintenance = saved.maintenance;
      }
      this.resolved = data.incidents ?? [];
      this.expireResolved();
    } catch {
      /* first run */
    }
  }

  /** Drops resolved incidents older than `resolvedRetentionDays`, so the page forgets them. */
  private expireResolved(now = Date.now()) {
    const days = this.cfg.resolvedRetentionDays;
    if (!(days > 0)) return;
    const cutoff = now - days * 86_400_000;
    this.resolved = this.resolved.filter((i) => (i.resolvedAt ?? i.startedAt) >= cutoff);
  }

  private save() {
    const data: Persisted = {
      services: Object.fromEntries(
        [...this.state].map(([id, s]) => [
          id,
          { history: s.history, status: s.status, incident: s.incident, maintenance: s.maintenance },
        ]),
      ),
      incidents: this.resolved,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
    renameSync(`${this.file}.tmp`, this.file);
  }

  snapshot() {
    const services = this.cfg.services.map((svc) => {
      const st = this.must(svc.id);
      // Maintenance, like no data, is left out of the uptime.
      const counted = st.history.filter((h) => h.s !== "unknown" && h.s !== "maintenance");
      const available = counted.filter((h) => h.s !== "down").length;
      return {
        id: svc.id,
        name: svc.name,
        group: svc.group ?? "Servicios",
        description: svc.description,
        component: svc.component ?? null,
        source: describeCheck(svc.check),
        status: st.status,
        message: st.last?.message ?? "pendiente",
        latencyMs: st.last?.latencyMs,
        value: st.last?.value,
        checkedAt: st.last?.at,
        uptime: counted.length ? available / counted.length : null,
        // Compact: one char per sample (u=up, d=degraded, x=down, -=unknown, m=maintenance).
        history: st.history.map((h) => SAMPLE[h.s]).join(""),
        incident: st.incident ?? null,
        maintenance: st.maintenance ?? null,
      };
    });
    const now = Date.now();
    const name = (id: string) => this.cfg.services.find((s) => s.id === id)?.name ?? id;
    // Scheduled windows until they end (so they show before they start), plus what the
    // maintenance pages say right now.
    const maintenances = [
      ...this.cfg.maintenances
        .filter((m) => m.end > now)
        .map((m) => ({
          id: m.id,
          source: "schedule" as const,
          title: m.title,
          description: m.description ?? null,
          url: m.url ?? null,
          start: m.start,
          end: m.end,
          active: m.start <= now,
          services: m.services.map((id) => ({ id, name: name(id) })),
        })),
      ...services
        .filter((s) => s.maintenance?.source === "header")
        .map((s) => ({
          id: `header-${s.id}`,
          source: "header" as const,
          title: s.maintenance?.service ?? "Mantenimiento",
          description: null,
          url: null,
          start: s.maintenance?.start ?? null,
          end: s.maintenance?.end ?? null,
          active: true,
          services: [{ id: s.id, name: s.name }],
        })),
    ].sort((a, b) => Number(b.active) - Number(a.active) || (a.start ?? 0) - (b.start ?? 0));
    const overall = services.reduce<Status>((acc, s) => worst(acc, s.status === "unknown" ? "up" : s.status), "up");
    return {
      title: this.cfg.title,
      headline: this.cfg.headline ?? null,
      generatedAt: Date.now(),
      lastTickAt: this.lastTickAt,
      intervalSeconds: this.cfg.intervalSeconds,
      historySize: this.cfg.historySize,
      overall,
      services,
      active: services.flatMap((s) => (s.incident ? [s.incident] : [])),
      resolved: this.resolved,
      maintenances,
      components: this.cfg.components,
      gitlab: {
        mode: this.gitlab.live ? "live" : "dry-run",
        project: this.cfg.gitlab.project ?? null,
      },
    };
  }
}
