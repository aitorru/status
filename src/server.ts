import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { GitLab } from "./gitlab.ts";
import { Monitor } from "./monitor.ts";

const cfg = loadConfig();
const gitlab = new GitLab(cfg.gitlab);
const monitor = new Monitor(cfg, gitlab);
const port = Number(process.env.PORT ?? 34100);
const publicDir = new URL("../public/", import.meta.url).pathname;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const clients = new Set<ServerResponse>();
monitor.on("update", () => {
  const payload = `data: ${JSON.stringify(monitor.snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
});
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 20_000).unref();

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const tokenOk = (given: string | null) => {
  if (!cfg.hookToken) return true;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(cfg.hookToken);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readBody(req: import("node:http").IncomingMessage, limit = 1_000_000) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, monitor.snapshot());
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`retry: 3000\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Grafana webhook contact point → push-based services. Machine-to-machine only.
    if (req.method === "POST" && url.pathname === "/hooks/grafana") {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      if (!tokenOk(url.searchParams.get("token") ?? bearer)) return json(res, 401, { error: "bad token" });
      const body = JSON.parse(await readBody(req));
      const touched = monitor.push(Array.isArray(body?.alerts) ? body.alerts : []);
      return json(res, 200, { ok: true, touched });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "read only" });

    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = join(publicDir, path);
    if (!file.startsWith(publicDir)) return json(res, 404, { error: "not found" });
    const body = await readFile(file).catch(() => null);
    if (!body) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  }
});

server.listen(port, () => {
  console.log(`status on http://localhost:${port} · ${cfg.services.length} services · every ${cfg.intervalSeconds}s`);
  console.log(
    gitlab.live
      ? `GitLab: live → ${cfg.gitlab.url} project ${cfg.gitlab.project}`
      : "GitLab: dry-run (set GITLAB_URL, GITLAB_TOKEN and GITLAB_PROJECT to file real issues)",
  );
});
await monitor.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    monitor.stop();
    server.close();
    process.exit(0);
  });
}
