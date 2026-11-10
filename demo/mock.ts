/**
 * Fake upstreams for the demo: a few HTTP services, a Prometheus, a Grafana and a
 * GitLab, all on one port. Failures follow a fixed cycle so every flow shows up
 * within a couple of minutes: open → worsen/improve → resolve → reopen.
 */
import { createServer } from "node:http";

export const CYCLE = 150; // seconds
export const phase = () => (Date.now() / 1000) % CYCLE;
const between = (a: number, b: number) => phase() >= a && phase() < b;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Issue {
  id: number;
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: "opened" | "closed";
  created_at: string;
  updated_at: string;
  web_url: string;
  notes: { body: string; created_at: string }[];
}

export function startMock(port: number) {
  const issues: Issue[] = [];
  const base = process.env.MOCK_PUBLIC_URL ?? `http://localhost:${port}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};

    // ── HTTP services ─────────────────────────────────────────
    if (url.pathname === "/svc/web") {
      await sleep(30 + Math.random() * 90);
      return send(200, "ok", "text/plain");
    }
    if (url.pathname === "/svc/checkout") {
      await sleep(60 + Math.random() * 60);
      return between(40, 85) ? send(503, "upstream unavailable", "text/plain") : send(200, "ok", "text/plain");
    }
    if (url.pathname === "/svc/search") {
      await sleep(between(95, 125) ? 1100 + Math.random() * 300 : 80 + Math.random() * 80);
      return send(200, "ok", "text/plain");
    }

    // ── Prometheus ────────────────────────────────────────────
    if (url.pathname === "/prom/api/v1/query") {
      const q = url.searchParams.get("query") ?? "";
      let v = 1;
      if (q.includes("payments")) v = between(15, 40) ? 0.5 : between(40, 60) ? 0 : 1;
      if (q.includes("error_ratio")) v = 0.002 + Math.random() * 0.003;
      return send(200, {
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [Date.now() / 1000, String(v)] }] },
      });
    }

    // ── Grafana ───────────────────────────────────────────────
    if (url.pathname === "/grafana/api/ds/query" && req.method === "POST") {
      const lag = 0.4 + Math.random() * 0.8;
      return send(200, {
        results: {
          A: {
            frames: [{ data: { values: [[Date.now()], [lag]] } }],
          },
        },
      });
    }
    if (url.pathname === "/grafana/api/prometheus/grafana/api/v1/rules") {
      const state = between(100, 110) ? "pending" : between(110, 140) ? "firing" : "inactive";
      return send(200, {
        status: "success",
        data: {
          groups: [
            {
              name: "messaging",
              rules: [
                { name: "Queue backlog", state, health: "ok" },
                { name: "Disk almost full", state: "inactive", health: "ok" },
              ],
            },
          ],
        },
      });
    }

    // ── GitLab ────────────────────────────────────────────────
    const m = /^\/gitlab\/api\/v4\/projects\/[^/]+\/issues(?:\/(\d+))?(\/notes)?$/.exec(url.pathname);
    if (m) {
      if (req.headers["private-token"] !== "demo-token") return send(401, { message: "401 Unauthorized" });
      const now = new Date().toISOString();
      if (!m[1] && req.method === "GET") {
        const want = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
        const state = url.searchParams.get("state");
        return send(
          200,
          issues.filter((i) => (!state || i.state === state) && want.every((l) => i.labels.includes(l))),
        );
      }
      if (!m[1] && req.method === "POST") {
        const iid = issues.length + 1;
        const issue: Issue = {
          id: 1000 + iid,
          iid,
          title: body.title,
          description: body.description ?? "",
          labels: String(body.labels ?? "")
            .split(",")
            .filter(Boolean),
          state: "opened",
          created_at: now,
          updated_at: now,
          web_url: `${base}/gitlab/issues/${iid}`,
          notes: [],
        };
        issues.push(issue);
        return send(201, issue);
      }
      const issue = issues.find((i) => i.iid === Number(m[1]));
      if (!issue) return send(404, { message: "404 Not found" });
      if (m[2] && req.method === "POST") {
        issue.notes.push({ body: body.body, created_at: now });
        issue.updated_at = now;
        return send(201, { id: issue.notes.length, body: body.body });
      }
      if (req.method === "GET") return send(200, issue);
      if (req.method === "PUT") {
        if (body.title) issue.title = body.title;
        if (body.description !== undefined) issue.description = body.description;
        const remove = String(body.remove_labels ?? "").split(",");
        const add = String(body.add_labels ?? "")
          .split(",")
          .filter(Boolean);
        issue.labels = [...new Set([...issue.labels.filter((l) => !remove.includes(l)), ...add])];
        if (body.state_event === "close") issue.state = "closed";
        if (body.state_event === "reopen") issue.state = "opened";
        issue.updated_at = now;
        return send(200, issue);
      }
    }

    // Human-readable view of the fake GitLab, to watch issues update live.
    const view = /^\/gitlab\/issues(?:\/(\d+))?$/.exec(url.pathname);
    if (view) {
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const list = view[1] ? issues.filter((i) => i.iid === Number(view[1])) : [...issues].reverse();
      const html = list
        .map(
          (i) => `<article><h2>#${i.iid} ${esc(i.title)} <small>${i.state}</small></h2>
<p>${i.labels.map((l) => `<code>${esc(l)}</code>`).join(" ")}</p>
<pre>${esc(i.description)}</pre>
<h3>Comentarios</h3>${i.notes.map((n) => `<blockquote><small>${n.created_at}</small><pre>${esc(n.body)}</pre></blockquote>`).join("") || "<p>—</p>"}</article>`,
        )
        .join("<hr>");
      return send(
        200,
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Mock GitLab</title>
<style>body{font:14px system-ui;max-width:860px;margin:24px auto;padding:0 16px}pre{white-space:pre-wrap;background:#f4f4f6;padding:12px;border-radius:8px}code{background:#eee;padding:1px 6px;border-radius:6px}small{color:#777}</style>
<h1>Mock GitLab · issues <small>(se refresca cada 5 s)</small></h1>${html || "<p>Aún no hay issues.</p>"}`,
        "text/html; charset=utf-8",
      );
    }

    send(404, { error: "not found" });
  });

  server.listen(port);
  return server;
}
