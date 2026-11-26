import { DatabaseSync } from "node:sqlite";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH_PREFIX,
  Store,
  isValidGitRefName,
} from "../server/store.ts";
import { ApiRouter } from "../server/api.ts";
import { buildTaskWorkflowSystemContext } from "../server/chat-run-manager.ts";
import { upsertGithubConnection } from "../server/github.ts";

async function startServer(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("RD-29 project delivery branch & prefix configuration", () => {
  const cleanupDirs: string[] = [];
  const cleanupServers: Server[] = [];
  const prevGithubApiBase = process.env.RELAYDESK_GITHUB_API_BASE;

  afterEach(async () => {
    if (prevGithubApiBase === undefined) {
      delete process.env.RELAYDESK_GITHUB_API_BASE;
    } else {
      process.env.RELAYDESK_GITHUB_API_BASE = prevGithubApiBase;
    }
    while (cleanupServers.length > 0) {
      await closeServer(cleanupServers.pop() ?? null);
    }
    while (cleanupDirs.length > 0) {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  it("auto-migrates legacy projects table and preserves default target_branch & branch_prefix", () => {
    const dir = makeTempDir("relaydesk-rd29-mig-");
    const dbPath = join(dir, "legacy.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo TEXT NOT NULL,
        repos TEXT NOT NULL DEFAULT '[]',
        intake_key TEXT NOT NULL,
        bot_key TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        agent_instructions TEXT NOT NULL DEFAULT '',
        automation_paused INTEGER NOT NULL DEFAULT 0,
        delivery_mode TEXT NOT NULL DEFAULT 'pr_automerge',
        widget_code_context INTEGER NOT NULL DEFAULT 1,
        execution_routing_json TEXT NOT NULL DEFAULT '{}',
        deploy_policy_json TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO projects(id, name, repo, repos, intake_key, bot_key, agent_key, created_at)
      VALUES('proj_legacy', 'Legacy', 'acme/web', '["acme/web"]', 'ik', 'bk', 'ak', '2026-01-01T00:00:00Z');
    `);
    raw.close();

    const store = new Store(dbPath);
    const detail = store.getProjectDetail("proj_legacy");
    expect(detail.target_branch).toBe("");
    expect(detail.branch_prefix).toBe(DEFAULT_BRANCH_PREFIX);

    const list = store.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].target_branch).toBe("");
    expect(list[0].branch_prefix).toBe("relaydesk");

    const updated = store.updateProject("proj_legacy", {
      target_branch: "staging",
      branch_prefix: "ai-bot",
    });
    expect(updated.target_branch).toBe("staging");
    expect(updated.branch_prefix).toBe("ai-bot");
    store.close();
  });

  it("validates git ref names for target_branch and branch_prefix on create & update", () => {
    expect(isValidGitRefName("dev")).toBe(true);
    expect(isValidGitRefName("release/v2.1")).toBe(true);
    expect(isValidGitRefName("team_bot/rd")).toBe(true);
    expect(isValidGitRefName("has space")).toBe(false);
    expect(isValidGitRefName("a..b")).toBe(false);
    expect(isValidGitRefName("/leading")).toBe(false);
    expect(isValidGitRefName("trailing/")).toBe(false);
    expect(isValidGitRefName("double//slash")).toBe(false);
    expect(isValidGitRefName("bad.lock")).toBe(false);
    expect(isValidGitRefName("a@{b}")).toBe(false);
    expect(isValidGitRefName("ctrl\x07char")).toBe(false);
    expect(isValidGitRefName("@")).toBe(false);

    const dir = makeTempDir("relaydesk-rd29-store-");
    const store = new Store(join(dir, "store.sqlite"));

    const created = store.createProject({
      name: "App",
      repo: "acme/app",
      delivery_mode: "pr_automerge",
      target_branch: "dev",
      branch_prefix: "bot/fix",
    });
    expect(created.target_branch).toBe("dev");
    expect(created.branch_prefix).toBe("bot/fix");

    // Clearing target_branch keeps "", clearing branch_prefix resets to default "relaydesk"
    const cleared = store.updateProject(created.id, {
      target_branch: "",
      branch_prefix: "",
    });
    expect(cleared.target_branch).toBe("");
    expect(cleared.branch_prefix).toBe("relaydesk");

    // Invalid inputs throw 400 ApiError
    expect(() =>
      store.updateProject(created.id, { target_branch: "bad branch" }),
    ).toThrow(/Invalid target_branch/);
    expect(() =>
      store.updateProject(created.id, { target_branch: "a..b" }),
    ).toThrow(/Invalid target_branch/);
    expect(() =>
      store.updateProject(created.id, { branch_prefix: "/bad" }),
    ).toThrow(/Invalid branch_prefix/);
    expect(() =>
      store.updateProject(created.id, { branch_prefix: "bad/" }),
    ).toThrow(/Invalid branch_prefix/);
    expect(() =>
      store.createProject({
        name: "Bad",
        repo: "acme/bad",
        branch_prefix: "foo..bar",
      }),
    ).toThrow(/Invalid branch_prefix/);

    store.close();
  });

  it("injects target_branch and branch_prefix across pr_automerge, review_only, and direct_push prompts", () => {
    const dir = makeTempDir("relaydesk-rd29-prompt-");
    const store = new Store(join(dir, "prompt.sqlite"));

    const proj = store.createProject({
      name: "StagingApp",
      repo: "acme/staging-app",
      delivery_mode: "pr_automerge",
      target_branch: "staging",
      branch_prefix: "ai-fix",
    });

    // 1. pr_automerge WITH target_branch + custom prefix
    const prPrompt = buildTaskWorkflowSystemContext(proj, 29);
    expect(prPrompt).toContain("git fetch origin");
    expect(prPrompt).toContain("origin/staging");
    expect(prPrompt).toContain("ai-fix/rd-29");
    expect(prPrompt).toContain("gh pr create --base staging --fill");
    expect(prPrompt).toContain("gh pr merge --auto --squash");

    // 2. review_only WITH target_branch + custom prefix
    const revProj = store.updateProject(proj.id, { delivery_mode: "review_only" });
    const revPrompt = buildTaskWorkflowSystemContext(revProj, 29);
    expect(revPrompt).toContain("git fetch origin");
    expect(revPrompt).toContain("origin/staging");
    expect(revPrompt).toContain("ai-fix/rd-29");
    expect(revPrompt).toContain('delivery_ref: "ai-fix/rd-29"');

    // 3. direct_push WITH target_branch
    const directProj = store.updateProject(proj.id, { delivery_mode: "direct_push" });
    const directPrompt = buildTaskWorkflowSystemContext(directProj, 29);
    expect(directPrompt).toContain("target branch `staging`");
    expect(directPrompt).toContain("git push origin staging");
    expect(directPrompt).toContain('delivery_ref: "staging@<shortsha>"');

    // 4. Empty target_branch falls back to default behavior while keeping custom prefix
    const noTargetPr = store.updateProject(proj.id, {
      delivery_mode: "pr_automerge",
      target_branch: "",
      branch_prefix: "custom",
    });
    const noTargetPrompt = buildTaskWorkflowSystemContext(noTargetPr, 7);
    expect(noTargetPrompt).toContain("custom/rd-7");
    expect(noTargetPrompt).toContain("gh pr create --fill");
    expect(noTargetPrompt).not.toContain("--base");

    store.close();
  });

  it("exposes /api/github/branches with default_branch sorting, multi-connection fallback, and graceful error handling", async () => {
    const dir = makeTempDir("relaydesk-rd29-api-");
    const dbPath = join(dir, "api.sqlite");
    const store = new Store(dbPath);
    const api = new ApiRouter({ store });

    // Mock GitHub API server
    const ghMock = await startServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");

      if (auth === "Bearer ghp_wrong_token") {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }

      if (url === "/repos/acme/web" && auth === "Bearer ghp_good_token") {
        res.statusCode = 200;
        res.end(JSON.stringify({ full_name: "acme/web", default_branch: "main" }));
        return;
      }

      if (
        url === "/repos/acme/web/branches?per_page=100&page=1" &&
        auth === "Bearer ghp_good_token"
      ) {
        res.statusCode = 200;
        res.end(
          JSON.stringify([
            { name: "staging", protected: false },
            { name: "dev", protected: false },
            { name: "main", protected: true },
          ]),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    cleanupServers.push(ghMock.server);
    process.env.RELAYDESK_GITHUB_API_BASE = ghMock.url;

    const appServer = await startServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void api.handle(req, res, pathname);
    });
    cleanupServers.push(appServer.server);

    // 1. No GitHub connection -> 409
    const unconfiguredRes = await fetch(
      `${appServer.url}/api/github/branches?repo=acme/web`,
    );
    expect(unconfiguredRes.status).toBe(409);

    // 2. Invalid repo -> 400
    const badRepoRes = await fetch(
      `${appServer.url}/api/github/branches?repo=invalid-repo`,
    );
    expect(badRepoRes.status).toBe(400);

    // 3. Add two connections: first fails 404, second succeeds
    upsertGithubConnection(dbPath, {
      id: "conn_1",
      label: "Other Key",
      token: "ghp_wrong_token",
      viewer: { login: "other", type: "User" },
      owners: [{ login: "other", type: "User" }],
      repo_count: 1,
    });
    upsertGithubConnection(dbPath, {
      id: "conn_2",
      label: "Acme Key",
      token: "ghp_good_token",
      viewer: { login: "alice", type: "User" },
      owners: [{ login: "acme", type: "Organization" }],
      repo_count: 1,
    });

    const okRes = await fetch(`${appServer.url}/api/github/branches?repo=acme/web`);
    expect(okRes.status).toBe(200);
    const body = (await okRes.json()) as {
      repo: string;
      default_branch: string;
      branches: string[];
      items: Array<{ name: string; protected: boolean }>;
    };
    expect(body.repo).toBe("acme/web");
    expect(body.default_branch).toBe("main");
    // Default branch is sorted first, remaining sorted alphabetically
    expect(body.branches).toEqual(["main", "dev", "staging"]);
    expect(body.items[0]).toEqual({ name: "main", protected: true });

    // 4. POST /api/github/branches also works
    const postRes = await fetch(`${appServer.url}/api/github/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "acme/web" }),
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { default_branch: string; branches: string[] };
    expect(postBody.default_branch).toBe("main");
    expect(postBody.branches).toEqual(["main", "dev", "staging"]);

    // 5. Missing repo on GitHub -> 502 with error message
    const missingRes = await fetch(
      `${appServer.url}/api/github/branches?repo=acme/does-not-exist`,
    );
    expect(missingRes.status).toBe(502);

    // 6. Project create & patch APIs persist target_branch and branch_prefix
    const createProjRes = await fetch(`${appServer.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Web",
        repo: "acme/web",
        delivery_mode: "pr_automerge",
        target_branch: "dev",
        branch_prefix: "bot",
      }),
    });
    expect(createProjRes.status).toBe(200);
    const createdPayload = (await createProjRes.json()) as {
      project: { id: string; target_branch: string; branch_prefix: string };
    };
    expect(createdPayload.project.target_branch).toBe("dev");
    expect(createdPayload.project.branch_prefix).toBe("bot");

    const patchProjRes = await fetch(
      `${appServer.url}/api/projects/${createdPayload.project.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_branch: "staging", branch_prefix: "rd" }),
      },
    );
    expect(patchProjRes.status).toBe(200);
    const patchedPayload = (await patchProjRes.json()) as {
      project: { target_branch: string; branch_prefix: string };
    };
    expect(patchedPayload.project.target_branch).toBe("staging");
    expect(patchedPayload.project.branch_prefix).toBe("rd");

    // Invalid branch_prefix via API -> 400
    const invalidPatchRes = await fetch(
      `${appServer.url}/api/projects/${createdPayload.project.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch_prefix: "bad prefix" }),
      },
    );
    expect(invalidPatchRes.status).toBe(400);

    store.close();
  });
});
