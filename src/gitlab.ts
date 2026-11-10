import type { Config } from "./config.ts";

export interface Issue {
  iid: number;
  web_url?: string;
  title: string;
  description: string | null;
  labels: string[];
  state: string;
  created_at: string;
}

interface IssuePatch {
  title?: string;
  description?: string;
  add_labels?: string;
  remove_labels?: string;
  state_event?: "close" | "reopen";
}

/**
 * Thin GitLab REST v4 client. Without a token it runs in dry-run mode: every call is
 * logged and returns a fake issue, so the rest of the flow behaves the same.
 */
export class GitLab {
  readonly cfg: Config["gitlab"];
  private fakeIid = 0;

  constructor(cfg: Config["gitlab"]) {
    this.cfg = cfg;
  }

  get live(): boolean {
    return Boolean(this.cfg.url && this.cfg.token && this.cfg.project);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const project = encodeURIComponent(this.cfg.project as string);
    const url = `${this.cfg.url}/api/v4/projects/${project}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "private-token": this.cfg.token as string,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitLab ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private dry(action: string, detail: string) {
    console.log(`[gitlab:dry-run] ${action} ${detail}`);
  }

  async createIssue(title: string, description: string, labels: string[]): Promise<Issue> {
    if (!this.live) {
      this.dry("create issue", `"${title}" [${labels.join(", ")}]`);
      return {
        iid: ++this.fakeIid,
        title,
        description,
        labels,
        state: "opened",
        created_at: new Date().toISOString(),
      };
    }
    return this.req<Issue>("POST", "/issues", {
      title,
      description,
      labels: labels.join(","),
      confidential: this.cfg.confidential,
      ...(this.cfg.assigneeIds.length ? { assignee_ids: this.cfg.assigneeIds } : {}),
    });
  }

  async getIssue(iid: number): Promise<Issue | null> {
    if (!this.live) return null;
    return this.req<Issue>("GET", `/issues/${iid}`);
  }

  async updateIssue(iid: number, patch: IssuePatch): Promise<void> {
    if (!this.live) {
      const parts = Object.entries(patch)
        .filter(([k]) => k !== "description")
        .map(([k, v]) => `${k}=${v}`);
      this.dry(`update #${iid}`, parts.join(" ") || "(description)");
      return;
    }
    await this.req("PUT", `/issues/${iid}`, patch);
  }

  async addNote(iid: number, body: string): Promise<void> {
    if (!this.live) {
      this.dry(`note #${iid}`, body.split("\n")[0] ?? "");
      return;
    }
    await this.req("POST", `/issues/${iid}/notes`, { body });
  }

  /** Open issues carrying all of our labels, to adopt incidents across restarts. */
  async listOpen(): Promise<Issue[]> {
    if (!this.live) return [];
    const labels = encodeURIComponent(this.cfg.labels.join(","));
    return this.req<Issue[]>("GET", `/issues?state=opened&per_page=100&labels=${labels}`);
  }
}
