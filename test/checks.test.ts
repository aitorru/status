import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { matches, probeMaintenance, runCheck } from "../src/checks.ts";

describe("matches", () => {
  it("evaluates every operator", () => {
    assert.equal(matches(">= 1", 1), true);
    assert.equal(matches("> 1", 1), false);
    assert.equal(matches("< 0.05", 0.01), true);
    assert.equal(matches("<= 5", 6), false);
    assert.equal(matches("== 0", 0), true);
    assert.equal(matches("!= 0", 1), true);
    assert.equal(matches(">= 1e-3", 0.002), true);
  });

  it("treats a missing condition as no match", () => {
    assert.equal(matches(undefined, 1), false);
  });

  it("rejects malformed conditions", () => {
    assert.throws(() => matches("about 1", 1), /invalid condition/);
  });
});

describe("runCheck", () => {
  let server: Server;
  let base = "";
  // Each path answers the way a real upstream would; `value` drives the fake Prometheus.
  let value = "1";
  const kube = {
    readyz: true,
    nodes: [true, true],
    traefik: 1,
    pods: [] as [string, string, boolean][],
    selector: "",
  };

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/ok") return res.end("ok");
      if (url.pathname === "/fail") return res.writeHead(503).end("down");
      if (url.pathname === "/slow") return setTimeout(() => res.end("ok"), 120);
      // A fake Kubernetes API.
      const k8s = (body: unknown, code = 200) =>
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      const ready = (ok: boolean) => ({ conditions: [{ type: "Ready", status: ok ? "True" : "False" }] });
      if (url.pathname === "/readyz") {
        if (req.headers.authorization !== "Bearer kube-token") return k8s({}, 401);
        return kube.readyz
          ? res.end("[+]ping ok\nreadyz check passed")
          : res.writeHead(500).end("[+]ping ok\n[-]etcd failed: reason withheld\n");
      }
      if (url.pathname === "/version") return k8s({ gitVersion: "v1.33.5+k3s1" });
      if (url.pathname === "/api/v1/nodes") {
        return k8s({ items: kube.nodes.map((ok, i) => ({ metadata: { name: `n${i}` }, status: ready(ok) })) });
      }
      if (url.pathname === "/apis/apps/v1/namespaces/kube-system/deployments/traefik") {
        return k8s({ metadata: { name: "traefik" }, spec: { replicas: 1 }, status: { readyReplicas: kube.traefik } });
      }
      if (url.pathname === "/api/v1/pods") {
        kube.selector = url.searchParams.get("labelSelector") ?? "";
        return k8s({
          items: kube.pods.map(([cluster, role, ok], i) => ({
            metadata: {
              name: `${cluster}-postgresql-${i}`,
              labels: { "app.kubernetes.io/instance": cluster, "kubeblocks.io/role": role },
            },
            status: ready(ok),
          })),
        });
      }
      if (url.pathname === "/api/v1/query") {
        res.setHeader("content-type", "application/json");
        const result = value === "" ? [] : [{ metric: {}, value: [0, value] }];
        return res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result } }));
      }
      if (url.pathname === "/api/prometheus/grafana/api/v1/rules") {
        return res.end(
          JSON.stringify({
            data: {
              groups: [
                {
                  rules: [
                    { name: "Firing", state: "firing", health: "ok" },
                    { name: "Pending", state: "pending", health: "ok" },
                    { name: "Quiet", state: "inactive", health: "ok" },
                  ],
                },
              ],
            },
          }),
        );
      }
      res.writeHead(404).end();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it("http: 2xx is up, 503 is down, slow is degraded", async () => {
    assert.equal((await runCheck({ type: "http", url: `${base}/ok` }, {})).status, "up");
    const down = await runCheck({ type: "http", url: `${base}/fail` }, {});
    assert.equal(down.status, "down");
    assert.equal(down.message, "HTTP 503");
    const slow = await runCheck({ type: "http", url: `${base}/slow`, degradedLatencyMs: 50 }, {});
    assert.equal(slow.status, "degraded");
  });

  it("http: a refused connection is down, not a crash", async () => {
    const r = await runCheck({ type: "http", url: "http://127.0.0.1:1/", timeoutMs: 1000 }, {});
    assert.equal(r.status, "down");
  });

  it("prometheus: classifies the value with up / degraded", async () => {
    const sources = { prom: { url: base } };
    const check = { type: "prometheus", source: "prom", query: "up", up: ">= 1", degraded: ">= 0.5" } as const;
    value = "1";
    assert.equal((await runCheck(check, sources)).status, "up");
    value = "0.5";
    assert.equal((await runCheck(check, sources)).status, "degraded");
    value = "0";
    assert.equal((await runCheck(check, sources)).status, "down");
    value = "";
    assert.equal((await runCheck({ ...check, noData: "unknown" }, sources)).status, "unknown");
  });

  it("grafana-alert: firing / pending / inactive / missing", async () => {
    const sources = { grafana: { url: base } };
    const rule = (name: string) => runCheck({ type: "grafana-alert", source: "grafana", rule: name }, sources);
    assert.equal((await rule("Firing")).status, "down");
    assert.equal((await rule("Pending")).status, "degraded");
    assert.equal((await rule("Quiet")).status, "up");
    assert.equal((await rule("Nope")).status, "unknown");
  });

  it("kubernetes: readyz, version, nodes, deployment", async () => {
    const sources = { k3s: { url: base, token: "kube-token" } };
    const k = (c: object) => runCheck({ type: "kubernetes", source: "k3s", ...c } as never, sources);
    assert.equal((await k({ probe: "readyz" })).status, "up");
    kube.readyz = false;
    const bad = await k({ probe: "readyz" });
    assert.equal(bad.status, "down");
    assert.match(bad.message, /etcd failed/);
    assert.equal(
      (await runCheck({ type: "kubernetes", source: "k3s", probe: "readyz" }, { k3s: { url: base } })).message,
      "readyz HTTP 401",
    );
    assert.equal((await k({ probe: "version" })).message, "v1.33.5+k3s1");
    assert.equal((await k({ probe: "nodes" })).status, "up");
    kube.nodes = [true, false];
    const nodes = await k({ probe: "nodes" });
    assert.equal(nodes.status, "degraded");
    assert.equal(nodes.message, "1/2 nodos Ready · no: n1");
    kube.nodes = [false];
    assert.equal((await k({ probe: "nodes" })).status, "down");
    const traefik = { probe: "deployment", namespace: "kube-system", name: "traefik" };
    assert.equal((await k(traefik)).status, "up");
    kube.traefik = 0;
    assert.equal((await k(traefik)).status, "down");
  });

  it("kubernetes: every KubeBlocks cluster needs exactly one ready primary", async () => {
    const k = () => runCheck({ type: "kubernetes", source: "k3s", probe: "primary" }, { k3s: { url: base } });
    kube.pods = [
      ["pg-a", "primary", true],
      ["pg-a", "secondary", true],
      ["pg-b", "primary", true],
    ];
    const ok = await k();
    assert.equal(ok.status, "up");
    assert.equal(ok.message, "2 clústeres con primario");
    assert.match(kube.selector, /apps.kubeblocks.io\/component-name=postgresql/);
    kube.pods = [
      ["pg-a", "primary", false],
      ["pg-a", "secondary", true],
      ["pg-b", "primary", true],
    ];
    const down = await k();
    assert.equal(down.status, "down");
    assert.equal(down.message, "sin primario: pg-a");
    kube.pods = [
      ["pg-a", "primary", true],
      ["pg-a", "primary", true],
    ];
    assert.equal((await k()).status, "degraded");
    kube.pods = [];
    assert.equal((await k()).status, "down");
    // A named cluster with no pods left is missing its primary, even if another one is fine.
    kube.pods = [["pg-a", "primary", true]];
    const named = await runCheck(
      { type: "kubernetes", source: "k3s", probe: "primary", cluster: ["pg-a", "pg-b"] },
      { k3s: { url: base } },
    );
    assert.equal(named.status, "down");
    assert.equal(named.message, "sin primario: pg-b");
    assert.match(kube.selector, /app.kubernetes.io\/instance in \(pg-a,pg-b\)/);
  });
});

describe("maintenance headers", () => {
  let server: Server;
  let base = "";
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/maint") {
        return res
          .writeHead(503, {
            "x-maintenance": "1",
            "x-maintenance-start": "2026-12-01T19:00:00Z",
            "x-maintenance-end": "1764622800",
            "x-maintenance-service": "SonarQube",
          })
          .end();
      }
      if (req.url === "/maint-retry")
        return res.writeHead(503, { "x-maintenance": "true", "retry-after": "600" }).end();
      if (req.url === "/maint-off") return res.writeHead(200, { "x-maintenance": "0" }).end("ok");
      if (req.url === "/custom")
        return res.writeHead(503, { "x-mant": "on", "x-mant-hasta": "2026-12-01T21:00:00Z" }).end();
      res.writeHead(503).end();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("http: the maintenance page is maintenance, not down, with start, end and service", async () => {
    const r = await runCheck({ type: "http", url: `${base}/maint` }, {});
    assert.equal(r.status, "maintenance");
    assert.equal(r.maintenance?.source, "header");
    assert.equal(r.maintenance?.start, Date.parse("2026-12-01T19:00:00Z"));
    assert.equal(r.maintenance?.end, 1764622800_000, "epoch seconds");
    assert.equal(r.maintenance?.service, "SonarQube");
    assert.match(r.message, /mantenimiento \(SonarQube\) hasta/);
  });

  it("http: without an end header, Retry-After gives it", async () => {
    const before = Date.now();
    const r = await runCheck({ type: "http", url: `${base}/maint-retry` }, {});
    assert.equal(r.status, "maintenance");
    assert.ok((r.maintenance?.end ?? 0) >= before + 600_000);
  });

  it("http: a 0 flag is not maintenance, and a plain 503 is still down", async () => {
    assert.equal((await runCheck({ type: "http", url: `${base}/maint-off` }, {})).status, "up");
    assert.equal((await runCheck({ type: "http", url: `${base}/plain` }, {})).status, "down");
  });

  it("header names are configurable", async () => {
    const names = { flag: "x-mant", start: "x-mant-desde", end: "x-mant-hasta", service: "x-mant-servicio" };
    const r = await runCheck({ type: "http", url: `${base}/custom` }, {}, names);
    assert.equal(r.status, "maintenance");
    assert.equal(r.maintenance?.end, Date.parse("2026-12-01T21:00:00Z"));
  });

  it("probeMaintenance only answers whether the page is there", async () => {
    assert.equal((await probeMaintenance(`${base}/maint`))?.service, "SonarQube");
    assert.equal(await probeMaintenance(`${base}/plain`), undefined, "a failure is not a maintenance");
    assert.equal(await probeMaintenance("http://127.0.0.1:1/", undefined, 500), undefined, "nor is no answer");
  });
});
