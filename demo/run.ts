/**
 * `npm run demo`: starts the fake upstreams + fake GitLab and the health page against
 * them. Open http://localhost:34100 (page) and http://localhost:34101/gitlab/issues.
 */
import { CYCLE, phase, startMock } from "./mock.ts";

const MOCK = Number(process.env.STATUS_MOCK_PORT ?? 34101);
// Host used in links shown to people (e.g. a tailnet name); checks still go to localhost.
const HOST = process.env.DEMO_HOST ?? "localhost";
process.env.MOCK_PUBLIC_URL ??= `http://${HOST}:${MOCK}`;
startMock(MOCK);

process.env.CONFIG ??= "config/demo.json";
process.env.STATE_FILE ??= "data/demo-state.json";
process.env.PORT ??= "34100";
process.env.PUBLIC_URL ??= `http://${HOST}:${process.env.PORT}`;
process.env.MOCK_URL = `http://localhost:${MOCK}`;
process.env.GITLAB_URL ??= `http://localhost:${MOCK}/gitlab`;
process.env.GITLAB_TOKEN ??= "demo-token";
process.env.GITLAB_PROJECT ??= "devops/incidents";
process.env.HOOK_TOKEN ??= "demo-hook";

await import("../src/server.ts");

// Simulate a Grafana contact point firing for "auth" in part of each cycle.
let firing = false;
setInterval(async () => {
  const should = phase() >= 120 && phase() < 145;
  if (should === firing) return;
  firing = should;
  const alert = { status: should ? "firing" : "resolved", labels: { alertname: "AuthLatencyHigh", service: "auth" } };
  await fetch(`http://localhost:${process.env.PORT}/hooks/grafana`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.HOOK_TOKEN}` },
    body: JSON.stringify({ status: alert.status, alerts: [alert] }),
  }).catch(() => {});
}, 1000);

console.log(`demo: failures repeat every ${CYCLE}s · mock GitLab → http://localhost:${MOCK}/gitlab/issues`);
