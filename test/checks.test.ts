import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { matches, runCheck } from "../src/checks.ts";

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

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/ok") return res.end("ok");
      if (url.pathname === "/fail") return res.writeHead(503).end("down");
      if (url.pathname === "/slow") return setTimeout(() => res.end("ok"), 120);
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
});
