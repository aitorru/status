import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

  function setup() {
    const cfg: Config = {
      title: "t",
      intervalSeconds: 60,
      failThreshold: 2,
      recoverThreshold: 2,
      historySize: 10,
      sources: {},
      gitlab: {
        labels: ["incident", "status-page"],
        assigneeIds: [],
        confidential: false,
        heartbeatMinutes: 5,
        reopenMinutes: 30,
        closeOnRecover: true,
      },
      services: [{ id: "api", name: "API", check: { type: "http", url } }],
    };
    const { gl, calls, descriptions } = fakeGitLab();
    const file = join(mkdtempSync(join(tmpdir(), "status-")), "state.json");
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
});
