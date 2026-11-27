import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MAINTENANCE_HEADERS } from "../src/checks.ts";
import type { Config } from "../src/config.ts";
import type { GitLab } from "../src/gitlab.ts";
import { Monitor } from "../src/monitor.ts";

/** Records what the monitor asks GitLab to do, like a GitLab that always succeeds. */
function fakeGitLab() {
  const calls: { op: string; iid?: number; data?: unknown }[] = [];
  const descriptions = new Map<number, string>();
  let iid = 0;
  const gl = {
    live: true,
    cfg: {},
    async createIssue(title: string, description: string, labels: string[]) {
      iid++;
      descriptions.set(iid, description);
      calls.push({ op: "create", iid, data: { title, labels } });
      return {
        iid,
        web_url: `https://gitlab.test/i/${iid}`,
        title,
        description,
        labels,
        state: "opened",
        created_at: "",
      };
    },
    async getIssue(n: number) {
      return { iid: n, description: descriptions.get(n) ?? "", title: "", labels: [], state: "opened", created_at: "" };
    },
    async updateIssue(n: number, patch: Record<string, unknown>) {
      if (typeof patch.description === "string") descriptions.set(n, patch.description);
      calls.push({ op: "update", iid: n, data: patch });
    },
    async addNote(n: number, body: string) {
      calls.push({ op: "note", iid: n, data: body });
    },
    async listOpen() {
      return [];
    },
  };
  return { gl: gl as unknown as GitLab, calls, descriptions };
}

describe("incident lifecycle", () => {
  let server: Server;
  let url = "";
  let code = 200;

  before(async () => {
    server = createServer((_req, res) => res.writeHead(code).end()).listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => server.close());

  function setup(state?: unknown) {
    const cfg: Config = {
      title: "t",
      intervalSeconds: 60,
      failThreshold: 2,
      recoverThreshold: 2,
      historySize: 10,
      resolvedRetentionDays: 7,
      sources: {},
      gitlab: {
        labels: ["incident", "status-page"],
        assigneeIds: [],
        confidential: false,
        heartbeatMinutes: 5,
        reopenMinutes: 30,
        closeOnRecover: true,
      },
      maintenanceHeaders: DEFAULT_MAINTENANCE_HEADERS,
      maintenances: [],
      components: {},
      services: [{ id: "api", name: "API", check: { type: "http", url } }],
    };
    const { gl, calls, descriptions } = fakeGitLab();
    const file = join(mkdtempSync(join(tmpdir(), "status-")), "state.json");
    if (state) writeFileSync(file, JSON.stringify(state));
    const monitor = new Monitor(cfg, gl, file);
    // Let the per-service GitLab queue drain after a tick.
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const step = async (c: number) => {
      code = c;
      await monitor.tick();
      await settle();
    };
    return { monitor, calls, descriptions, step };
  }

  it("debounces, files one issue, closes it and reopens on flapping", async () => {
    const { monitor, calls, descriptions, step } = setup();

    await step(503);
    assert.equal(calls.length, 0, "a single failure must not open an incident");

    await step(503);
    const created = calls.filter((c) => c.op === "create");
    assert.equal(created.length, 1);
    const first = created[0];
    assert.ok(first);
    assert.deepEqual((first.data as { labels: string[] }).labels, [
      "incident",
      "status-page",
      "service::api",
      "status::down",
    ]);
    assert.equal(monitor.snapshot().active.length, 1);

    // Humans write below the live block; the monitor must keep it.
    descriptions.set(1, `${descriptions.get(1)}\n\nNota humana`);

    await step(200);
    assert.equal(monitor.snapshot().active.length, 1, "one good check is not enough to recover");
    await step(200);
    const close = calls.find((c) => c.op === "update" && (c.data as { state_event?: string }).state_event === "close");
    assert.ok(close, "issue closed on recovery");
    assert.match(descriptions.get(1) ?? "", /Nota humana/);
    assert.match(descriptions.get(1) ?? "", /Resuelto/);
    assert.equal(monitor.snapshot().resolved.length, 1);

    await step(503);
    await step(503);
    const reopen = calls.find(
      (c) => c.op === "update" && (c.data as { state_event?: string }).state_event === "reopen",
    );
    assert.ok(reopen, "a failure inside reopenMinutes reopens the same issue");
    assert.equal(calls.filter((c) => c.op === "create").length, 1, "no second issue");
    monitor.stop();
  });

  it("forgets resolved incidents older than resolvedRetentionDays", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const incident = (id: string, resolvedAt: number) => ({
      id,
      serviceId: "api",
      serviceName: "API",
      startedAt: resolvedAt - 120_000,
      resolvedAt,
      status: "degraded",
      worst: "degraded",
      failedChecks: 2,
      lastMessage: "lento",
      timeline: [],
    });
    const { monitor, step } = setup({
      services: {},
      incidents: [incident("new", now - day), incident("edge", now - 7 * day + 60_000), incident("old", now - 8 * day)],
    });
    assert.deepEqual(
      monitor.snapshot().resolved.map((i) => i.id),
      ["new", "edge"],
      "load drops the expired ones",
    );

    // As if the clock had moved past its seven days.
    const loaded = monitor.resolved.find((i) => i.id === "edge");
    assert.ok(loaded);
    loaded.resolvedAt = now - 7 * day - 1_000;
    await step(200);
    assert.deepEqual(
      monitor.snapshot().resolved.map((i) => i.id),
      ["new"],
      "each tick drops the ones that expired meanwhile",
    );
  });
});

describe("maintenance and reopen", () => {
  let server: Server;
  let base = "";
  let code = 200;
  // `page`: the maintenance page covers the whole host; `root`: only the root, while the
  // check's own path goes below it (like SonarQube's /api/system/status).
  let maint: "off" | "page" | "root" = "off";

  before(async () => {
    server = createServer((req, res) => {
      const covered = maint === "page" || (maint === "root" && req.url === "/");
      if (covered) {
        return res
          .writeHead(503, {
            "x-maintenance": "1",
            "x-maintenance-end": "2026-12-01T21:00:00Z",
            "x-maintenance-service": "Migración",
          })
          .end();
      }
      if (req.url?.startsWith("/api/v1/query")) {
        return res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }));
      }
      res.writeHead(req.url === "/" ? 200 : code).end();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  function setup(extra: Partial<Config> = {}, svc: Record<string, unknown> = {}) {
    maint = "off";
    code = 200;
    const cfg: Config = {
      title: "t",
      intervalSeconds: 60,
      failThreshold: 2,
      recoverThreshold: 2,
      historySize: 10,
      resolvedRetentionDays: 7,
      sources: {},
      gitlab: {
        labels: ["incident", "status-page"],
        assigneeIds: [],
        confidential: false,
        heartbeatMinutes: 5,
        reopenMinutes: 30,
        closeOnRecover: true,
      },
      maintenanceHeaders: DEFAULT_MAINTENANCE_HEADERS,
      maintenances: [],
      components: {},
      services: [{ id: "sonar", name: "SonarQube", check: { type: "http", url: `${base}/api/system/status` }, ...svc }],
      ...extra,
    };
    const { gl, calls } = fakeGitLab();
    const monitor = new Monitor(cfg, gl, join(mkdtempSync(join(tmpdir(), "status-")), "state.json"));
    const step = async (c: number, m: typeof maint = maint) => {
      code = c;
      maint = m;
      await monitor.tick();
      await new Promise((r) => setTimeout(r, 20));
    };
    const svc0 = () => {
      const s = monitor.snapshot().services[0];
      assert.ok(s);
      return s;
    };
    return { monitor, calls, step, svc0 };
  }

  it("the maintenance page opens no incident and does not count for uptime", async () => {
    const { monitor, calls, step, svc0 } = setup();
    await step(200);
    await step(503, "page");
    await step(503, "page");
    await step(503, "page");
    assert.equal(calls.length, 0, "no issue for a maintenance");
    assert.equal(svc0().status, "maintenance");
    assert.equal(svc0().maintenance?.service, "Migración");
    assert.equal(svc0().maintenance?.end, Date.parse("2026-12-01T21:00:00Z"));
    assert.equal(svc0().uptime, 1, "only the healthy sample counts");
    assert.equal(svc0().history, "ummm");
    assert.equal(monitor.snapshot().overall, "maintenance");
    assert.equal(monitor.snapshot().maintenances[0]?.source, "header");

    await step(200, "off");
    assert.equal(svc0().status, "up");
    assert.equal(svc0().maintenance, null);
    assert.equal(monitor.snapshot().maintenances.length, 0);
  });

  it("a failure right after a maintenance needs failThreshold of its own", async () => {
    const { calls, step } = setup();
    await step(503);
    await step(503, "page");
    await step(503, "off");
    assert.equal(calls.length, 0, "the failure before the maintenance does not add up");
    await step(503);
    assert.equal(calls.filter((c) => c.op === "create").length, 1);
  });

  it("maintenanceProbe: true asks the root of the host, which the page covers", async () => {
    const { calls, step, svc0 } = setup({}, { maintenanceProbe: true });
    // The check's own path goes below the page and keeps failing or answering; the root says
    // it is a maintenance.
    await step(503, "root");
    await step(503, "root");
    assert.equal(calls.length, 0);
    assert.equal(svc0().status, "maintenance");
    // Without the probe the same answers open an incident.
    const plain = setup();
    await plain.step(503, "root");
    await plain.step(503, "root");
    assert.equal(plain.calls.filter((c) => c.op === "create").length, 1);
  });

  it("a scheduled window turns failures into maintenance and is announced before it starts", async () => {
    const now = Date.now();
    const soon = { id: "w1", title: "Ensayo", services: ["sonar"], start: now + 3_600_000, end: now + 7_200_000 };
    const later = setup({ maintenances: [soon] });
    await later.step(200);
    const announced = later.monitor.snapshot().maintenances;
    assert.equal(announced.length, 1);
    assert.equal(announced[0]?.active, false);
    assert.deepEqual(announced[0]?.services, [{ id: "sonar", name: "SonarQube" }]);

    const open = { ...soon, start: now - 60_000 };
    const { calls, step, svc0, monitor } = setup({ maintenances: [open] });
    await step(200);
    assert.equal(svc0().status, "up", "healthy inside the window stays healthy");
    await step(503);
    await step(503);
    assert.equal(calls.length, 0);
    assert.equal(svc0().status, "maintenance");
    assert.equal(svc0().maintenance?.title, "Ensayo");
    assert.equal(monitor.snapshot().maintenances[0]?.active, true);

    const past = setup({ maintenances: [{ ...soon, start: now - 7_200_000, end: now - 3_600_000 }] });
    assert.equal(past.monitor.snapshot().maintenances.length, 0, "a finished window is not shown");
  });

  it("webhooks: a firing alert inside a window is maintenance; a reopen starts at the new failure", async () => {
    const now = Date.now();
    const hook = { check: { type: "grafana-webhook" } };
    const fire = (status: string) => [{ status, labels: { service: "sonar", alertname: "A" } }];
    const w = { id: "w", title: "Ensayo", services: ["sonar"], start: now - 60_000, end: now + 60_000 };
    const inWindow = setup({ maintenances: [w] }, hook);
    inWindow.monitor.push(fire("firing"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inWindow.calls.length, 0, "no issue for an alert inside the window");
    assert.equal(inWindow.svc0().status, "maintenance");

    const { monitor, step } = setup({}, hook);
    await step(200);
    monitor.push(fire("firing"));
    monitor.push(fire("resolved"));
    const inc = monitor.resolved[0];
    assert.ok(inc);
    inc.startedAt -= 600_000;
    inc.resolvedAt = (inc.resolvedAt ?? 0) - 600_000;
    await step(200);
    // The last healthy poll was 5 minutes before the alert.
    const last = monitor.state.get("sonar")?.history.at(-1);
    assert.ok(last);
    last.t -= 300_000;
    monitor.push(fire("firing"));
    const paused = monitor.snapshot().active[0]?.pausedMs ?? 0;
    assert.ok(paused >= 599_000, `paused ${paused}: the healthy samples before the alert are not the outage`);
  });

  it("webhooks: a firing alert while the root probe says maintenance stays maintenance", async () => {
    const { monitor, calls, step, svc0 } = setup(
      {},
      { check: { type: "grafana-webhook" }, maintenanceProbe: `${base}/` },
    );
    await step(200, "root");
    assert.equal(svc0().status, "maintenance");
    monitor.push([{ status: "firing", labels: { service: "sonar", alertname: "A" } }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0);
    assert.equal(svc0().status, "maintenance");
  });

  it("no data inside a window stays no data", async () => {
    const now = Date.now();
    const w = { id: "w", title: "Ensayo", services: ["sonar"], start: now - 60_000, end: now + 60_000 };
    const { svc0, step } = setup(
      { maintenances: [w], sources: { p: { url: base } } },
      { check: { type: "prometheus", source: "p", query: "up", up: ">= 1", noData: "unknown" } },
    );
    await step(200);
    assert.equal(svc0().status, "unknown");
  });

  it("a reopen does not count the time the service was fine", async () => {
    const { monitor, step } = setup();
    await step(503);
    await step(503);
    await step(200);
    await step(200);
    const inc = monitor.resolved[0];
    assert.ok(inc);
    // As if it had been fine for 10 minutes before failing again.
    inc.startedAt -= 600_000;
    inc.resolvedAt = (inc.resolvedAt ?? 0) - 600_000 + 5_000;
    await step(503);
    // The new failure began 2 minutes ago, and a sample with no data came in between: that does
    // not end it, so the outage counts from its first failure.
    const hist = monitor.state.get("sonar")?.history ?? [];
    const firstFail = hist.at(-1);
    assert.ok(firstFail);
    firstFail.t -= 120_000;
    hist.push({ t: firstFail.t + 1, s: "unknown" });
    await step(503);
    const reopened = monitor.snapshot().active[0];
    assert.ok(reopened);
    assert.ok(Math.abs((reopened.pausedMs ?? 0) - 475_000) < 2_000, `paused ${reopened.pausedMs}`);
    await step(200);
    await step(200);
    const text = monitor.resolved[0]?.timeline.at(-1)?.text ?? "";
    assert.equal(text, "Recuperado tras 2 min", "the 8 minutes it was fine are not part of it");
  });
});
