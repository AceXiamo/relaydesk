import { execFileSync } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBridgeDaemon } from "../agent/bridge/index.ts";
import type { TaskRecord } from "../app/lib/types.ts";
import {
  fetchGithubBranchDetailAcrossConnections,
  fetchGithubRepoBranchOverviewAcrossConnections,
  upsertGithubConnection,
} from "../server/github.ts";
import {
  annotateGitGraphWithOverview,
  matchTasksForBranch,
  mergeRepoBranches,
} from "../server/repo-branches.ts";
import {
  getProjectReposDir,
  getProjectReposStatus,
  sanitizeRepoDirName,
  syncProjectRepos,
} from "../server/repo-workspace.ts";
import { readProjectRepoFileContent } from "../server/workspace.ts";
import { fixture, operator, type Fixture } from "./bridge-fixture.ts";

async function startServer(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

function makeTask(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task_1",
    project_id: "proj_1",
    number: 1,
    title: "Test task",
    body: "",
    requirements: "",
    source: "console",
    source_url: "",
    priority: "normal",
    status: "ready",
    owner: "none",
    version: 1,
    attempts: 0,
    resolution: null,
    delivery_ref: "",
    deploy_status: "not_required",
    deployed_at: null,
    release_id: null,
    triaged_by: "",
    merged_into: null,
    created_at: "2026-11-20T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
    last_seen: null,
    ...overrides,
  };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Relaydesk Test",
      GIT_AUTHOR_EMAIL: "test@relaydesk.local",
      GIT_COMMITTER_NAME: "Relaydesk Test",
      GIT_COMMITTER_EMAIL: "test@relaydesk.local",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

describe("repo branches panel backend", () => {
  const cleanupDirs: string[] = [];
  const cleanupServers: Server[] = [];
  const cleanupFixtures: Fixture[] = [];
  const prevGithubApiBase = process.env.RELAYDESK_GITHUB_API_BASE;

  afterEach(async () => {
    if (prevGithubApiBase === undefined) {
      delete process.env.RELAYDESK_GITHUB_API_BASE;
    } else {
      process.env.RELAYDESK_GITHUB_API_BASE = prevGithubApiBase;
    }
    while (cleanupFixtures.length > 0) {
      await cleanupFixtures.pop()!.close();
    }
    while (cleanupServers.length > 0) {
      const srv = cleanupServers.pop()!;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
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

  it("matches tasks by branch pattern, delivery_ref, and PR without swallowing historical tasks on base branch", () => {
    const tasks: TaskRecord[] = [
      makeTask({
        id: "t_old",
        number: 10,
        title: "Old shipped fix",
        status: "done",
        delivery_ref: "main@aaaa111",
        updated_at: "2026-11-20T00:00:00Z",
      }),
      makeTask({
        id: "t_cur",
        number: 41,
        title: "Current main head",
        status: "done",
        delivery_ref: "main@c7317ae",
        updated_at: "2026-11-27T10:00:00Z",
      }),
      makeTask({
        id: "t_feat",
        number: 39,
        title: "Codex model catalog",
        status: "working",
        delivery_ref: "",
        updated_at: "2026-11-27T09:00:00Z",
      }),
      makeTask({
        id: "t_pr",
        number: 42,
        title: "PR linked task",
        status: "review",
        delivery_ref: "https://github.com/acme/web/pull/88",
        updated_at: "2026-11-27T11:00:00Z",
      }),
      makeTask({
        id: "t_merged",
        number: 99,
        title: "Merged duplicate",
        merged_into: "t_feat",
        delivery_ref: "feat/rd-99",
      }),
    ];

    const mainTasks = matchTasksForBranch(tasks, "main", "c7317ae12345", null, {
      isBaseBranch: true,
    });
    expect(mainTasks.map((t) => t.number)).toEqual([41]);

    const featTasks = matchTasksForBranch(
      tasks,
      "fix/rd-39-codex-catalog",
      "fd97c62",
      {
        number: 88,
        title: "Fix catalog",
        html_url: "https://github.com/acme/web/pull/88",
        draft: false,
        base_ref: "main",
        author: "alice",
        updated_at: "2026-11-27T11:00:00Z",
      },
      { isBaseBranch: false },
    );
    expect(featTasks.map((t) => t.number)).toEqual([42, 39]);

    const mergedIgnored = matchTasksForBranch(tasks, "feat/rd-99", "1234567", null, {
      isBaseBranch: false,
    });
    expect(mergedIgnored).toEqual([]);
  });

  it("merges remote and local branches with multi-repo isolation and deterministic sorting", () => {
    const merged = mergeRepoBranches({
      repo: "acme/web",
      project: {
        repo: "acme/web",
        repos: ["acme/web", "acme/api"],
        delivery_mode: "pr_automerge",
        target_branch: "staging",
        branch_prefix: "relaydesk",
      },
      githubConfigured: true,
      remoteOverview: {
        repo: "acme/web",
        html_url: "https://github.com/acme/web",
        private: true,
        default_branch: "main",
        branches: [
          { name: "main", protected: true, sha: "1111111aaaa" },
          { name: "staging", protected: false, sha: "2222222bbbb" },
          { name: "feat/rd-12-ui", protected: false, sha: "3333333cccc" },
          { name: "chore/old", protected: false, sha: "4444444dddd" },
        ],
        pulls_by_branch: {
          "feat/rd-12-ui": {
            number: 15,
            title: "UI branch",
            html_url: "https://github.com/acme/web/pull/15",
            draft: false,
            base_ref: "staging",
            author: "bob",
            updated_at: "2026-11-27T12:00:00Z",
          },
        },
        prs_unavailable: false,
      },
      mirror: {
        repo: "acme/web",
        ready: true,
        branch: "staging",
        commit: "2222222",
        updated_at: "2026-11-27T12:00:00Z",
      },
      localWorkdir: {
        agent_id: "ag_1",
        agent_name: "MacBook",
        online: true,
        workdir: "/tmp/web",
        remote_repo: "acme/web",
        current_branch: "wip/local",
        detached: false,
        head_sha: "5555555",
        has_dirty_files: true,
        staged_count: 1,
        unstaged_count: 2,
        untracked_count: 0,
        detailed: true,
        branches: [
          {
            name: "wip/local",
            current: true,
            sha: "5555555",
            committed_at: "2026-11-27T13:00:00Z",
            upstream: "",
            ahead: 0,
            behind: 0,
            upstream_gone: false,
            author: "dev",
            subject: "Local WIP",
          },
          {
            name: "feat/rd-12-ui",
            current: false,
            sha: "3333333",
            committed_at: "2026-11-27T11:30:00Z",
            upstream: "origin/feat/rd-12-ui",
            ahead: 1,
            behind: 0,
            upstream_gone: false,
            author: "dev",
            subject: "Update panel",
          },
        ],
      },
      tasks: [makeTask({ id: "t12", number: 12, title: "Panel UI", status: "working" })],
    });

    expect(merged.compare_base).toBe("staging");
    expect(merged.counts).toEqual({
      total: 5,
      remote: 4,
      local_only: 1,
      with_pr: 1,
      with_task: 1,
      merged: 0,
      unmerged: 0,
    });
    expect(merged.branches.map((b) => b.name)).toEqual([
      "main",
      "staging",
      "wip/local",
      "feat/rd-12-ui",
      "chore/old",
    ]);
    expect(merged.branches[1].is_target).toBe(true);
    expect(merged.branches[1].is_mirror_branch).toBe(true);
    expect(merged.branches[2].source).toBe("local");
    expect(merged.branches[2].github_url).toBe("");
    expect(merged.branches[3].source).toBe("both");
    expect(merged.branches[3].linked_tasks[0].number).toBe(12);

    // Multi-repo isolation: local_workdir pointing to acme/web must NOT leak local branches into acme/api
    const apiMerged = mergeRepoBranches({
      repo: "acme/api",
      project: {
        repo: "acme/web",
        repos: ["acme/web", "acme/api"],
        delivery_mode: "pr_automerge",
        target_branch: "",
        branch_prefix: "relaydesk",
      },
      githubConfigured: true,
      remoteOverview: {
        repo: "acme/api",
        html_url: "https://github.com/acme/api",
        private: false,
        default_branch: "main",
        branches: [{ name: "main", protected: true, sha: "9999999" }],
        pulls_by_branch: {},
        prs_unavailable: false,
      },
      mirror: null,
      localWorkdir: merged.local_workdir,
      tasks: [],
    });
    expect(apiMerged.branches.map((b) => b.name)).toEqual(["main"]);
    expect(apiMerged.branches[0].is_local_current).toBe(false);
    expect(apiMerged.local_workdir?.remote_repo).toBe("acme/web");

    // Merge status & graph ref annotation
    const compared = mergeRepoBranches({
      repo: "acme/web",
      project: {
        repo: "acme/web",
        repos: ["acme/web"],
        delivery_mode: "pr_automerge",
        target_branch: "main",
        branch_prefix: "relaydesk",
      },
      githubConfigured: true,
      remoteOverview: {
        repo: "acme/web",
        html_url: "https://github.com/acme/web",
        private: false,
        default_branch: "main",
        branches: [
          { name: "main", protected: true, sha: "1111111" },
          { name: "feat/done", protected: false, sha: "2222222" },
          { name: "feat/open", protected: false, sha: "3333333" },
          { name: "feat/div", protected: false, sha: "4444444" },
        ],
        pulls_by_branch: {
          "feat/open": {
            number: 55,
            title: "Open PR",
            html_url: "https://github.com/acme/web/pull/55",
            draft: false,
            base_ref: "main",
            author: "bob",
            updated_at: "2026-11-27T12:00:00Z",
          },
        },
        prs_unavailable: false,
      },
      remoteCompareByBranch: {
        "feat/done": { ahead_by: 0, behind_by: 2, status: "behind" },
        "feat/open": { ahead_by: 3, behind_by: 0, status: "ahead" },
        "feat/div": { ahead_by: 1, behind_by: 4, status: "diverged" },
      },
      mirror: null,
      localWorkdir: null,
      tasks: [makeTask({ id: "t55", number: 55, title: "Open PR work", delivery_ref: "feat/open" })],
    });
    expect(compared.counts.merged).toBe(1);
    expect(compared.counts.unmerged).toBe(2);
    expect(Object.fromEntries(compared.branches.map((b) => [b.name, b.merge_status]))).toEqual({
      main: "base",
      "feat/done": "merged",
      "feat/open": "ahead",
      "feat/div": "diverged",
    });

    const annotated = annotateGitGraphWithOverview(
      {
        repo: "acme/web",
        source: "local",
        base_branch: "main",
        base_first_parent_shas: ["1111111"],
        commits: [
          {
            sha: "3333333",
            short_sha: "3333333",
            parents: ["1111111"],
            message: "feat: open",
            author_name: "bob",
            date: "2026-11-27T12:00:00Z",
            refs: [
              { name: "feat/open", kind: "remote" },
              { name: "feat/open", kind: "local", is_head: true },
            ],
          },
        ],
        truncated: false,
        fetched_at: "2026-11-27T12:00:00Z",
      },
      compared,
    );
    expect(annotated.commits[0].refs).toEqual([
      expect.objectContaining({
        name: "feat/open",
        kind: "local",
        is_head: true,
        merge_status: "ahead",
        ahead_of_base: 3,
        behind_base: 0,
        open_pr_number: 55,
        linked_task_numbers: [55],
      }),
    ]);
  });

  it("fetches GitHub overview and branch detail across connections with 403 PR fallback and slash-branch compare encoding", async () => {
    const dir = makeTempDir("relaydesk-gh-branches-");
    const dbPath = join(dir, "store.sqlite");

    const ghMock = await startServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      if (auth !== "Bearer ghp_ok") {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (url === "/repos/acme/web") {
        res.end(
          JSON.stringify({
            full_name: "acme/web",
            default_branch: "main",
            html_url: "https://github.com/acme/web",
            private: true,
          }),
        );
        return;
      }
      if (url === "/repos/acme/web/branches?per_page=100&page=1") {
        res.end(
          JSON.stringify([
            { name: "main", protected: true, commit: { sha: "aaaa1111" } },
            { name: "feat/rd-5", protected: false, commit: { sha: "bbbb2222" } },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/pulls?state=open&per_page=100") {
        res.statusCode = 403;
        res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
        return;
      }
      if (url === "/repos/acme/web/commits?sha=feat%2Frd-5&per_page=12") {
        res.end(
          JSON.stringify([
            {
              sha: "bbbb222233334444",
              html_url: "https://github.com/acme/web/commit/bbbb222233334444",
              commit: {
                message: "feat: build branch panel\n\nmore body",
                author: { name: "Alice", date: "2026-11-27T12:00:00Z" },
              },
              author: { login: "alice", avatar_url: "https://avatars.githubusercontent.com/u/1" },
            },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/compare/main...feat/rd-5") {
        res.end(
          JSON.stringify({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            html_url: "https://github.com/acme/web/compare/main...feat/rd-5",
            files: [
              {
                filename: "app/components/RepoBranchesPanel.tsx",
                status: "added",
                additions: 120,
                deletions: 0,
              },
            ],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    cleanupServers.push(ghMock.server);
    process.env.RELAYDESK_GITHUB_API_BASE = ghMock.url;

    upsertGithubConnection(dbPath, {
      id: "bad",
      label: "Wrong",
      token: "ghp_wrong",
      viewer: { login: "other", type: "User" },
      owners: [{ login: "other", type: "User" }],
      repo_count: 0,
    });
    upsertGithubConnection(dbPath, {
      id: "good",
      label: "Acme",
      token: "ghp_ok",
      viewer: { login: "alice", type: "User" },
      owners: [{ login: "acme", type: "Organization" }],
      repo_count: 1,
    });

    const { readGithubConnections } = await import("../server/github.ts");
    const conns = readGithubConnections(dbPath);
    const overview = await fetchGithubRepoBranchOverviewAcrossConnections(conns, "acme/web");
    expect(overview.prs_unavailable).toBe(true);
    expect(overview.default_branch).toBe("main");
    expect(overview.branches).toHaveLength(2);
    expect(overview.branches[1]).toEqual({
      name: "feat/rd-5",
      protected: false,
      sha: "bbbb2222",
    });

    const detail = await fetchGithubBranchDetailAcrossConnections(
      conns,
      "acme/web",
      "feat/rd-5",
      "main",
    );
    expect(detail.commits).toHaveLength(1);
    expect(detail.commits[0].message).toBe("feat: build branch panel");
    expect(detail.commits[0].author_login).toBe("alice");
    expect(detail.compare?.ahead_by).toBe(1);
    expect(detail.compare?.additions).toBe(120);
    expect(detail.compare?.files[0].filename).toBe("app/components/RepoBranchesPanel.tsx");
  });

  it("syncs project mirror to a requested branch and exposes updated branch & files", async () => {
    const dir = makeTempDir("relaydesk-mirror-branch-");
    const dbPath = join(dir, "db.sqlite");
    const bareDir = join(dir, "remote.git");
    const seedDir = join(dir, "seed");
    mkdirSync(bareDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    git(bareDir, ["init", "--bare", "--initial-branch=main"]);
    git(seedDir, ["init", "--initial-branch=main"]);
    writeFileSync(join(seedDir, "README.md"), "on main\n", "utf8");
    git(seedDir, ["add", "."]);
    git(seedDir, ["commit", "-m", "main init"]);
    git(seedDir, ["remote", "add", "origin", bareDir]);
    git(seedDir, ["push", "-u", "origin", "main"]);

    git(seedDir, ["checkout", "-b", "feat/panel"]);
    writeFileSync(join(seedDir, "panel.txt"), "branch panel content\n", "utf8");
    git(seedDir, ["add", "."]);
    git(seedDir, ["commit", "-m", "add panel"]);
    git(seedDir, ["push", "-u", "origin", "feat/panel"]);

    const project = {
      id: "proj_mirror",
      name: "MirrorTest",
      repo: "acme/web",
      repos: ["acme/web"],
      automation_paused: false,
      delivery_mode: "direct_push" as const,
      deploy_policy: {
        runtime: null,
        model: null,
        mode: "none" as const,
        window_start: "02:00",
        window_end: "04:00",
        timezone: "Asia/Shanghai",
        allow_urgent_override: true,
        doc_path: "",
      },
      widget_code_context: true,
      agent_instructions: "",
    };

    const reposDir = getProjectReposDir(dbPath, project.id)!;
    mkdirSync(reposDir, { recursive: true });
    const mirrorDir = join(reposDir, sanitizeRepoDirName("acme/web"));
    git(reposDir, ["clone", "--depth", "1", "--single-branch", "--branch", "main", bareDir, mirrorDir]);

    const before = getProjectReposStatus(dbPath, project);
    expect(before.repos[0].ready).toBe(true);
    expect(before.repos[0].branch).toBe("main");

    const after = await syncProjectRepos(dbPath, project, {
      repo: "acme/web",
      branch: "feat/panel",
    });
    expect(after.repos[0].branch).toBe("feat/panel");

    const file = readProjectRepoFileContent(dbPath, project, {
      repo: "acme/web",
      path: "panel.txt",
    });
    expect(file.content).toContain("branch panel content");

    await expect(
      syncProjectRepos(dbPath, project, { repo: "acme/web", branch: "-bad" }),
    ).rejects.toThrow(/Invalid branch name/);
    await expect(
      syncProjectRepos(dbPath, project, { repo: "acme/web", branch: "a..b" }),
    ).rejects.toThrow(/Invalid branch name/);
  });

  it("integrates /workspace/repos/branches and /branch-detail with GitHub, real Bridge daemon, and legacy Bridge fallback", async () => {
    const f = await fixture();
    cleanupFixtures.push(f);

    const ghMock = await startServer((req, res) => {
      const url = req.url ?? "";
      res.setHeader("Content-Type", "application/json");
      if (url === "/repos/acme/web") {
        res.end(
          JSON.stringify({
            full_name: "acme/web",
            default_branch: "main",
            html_url: "https://github.com/acme/web",
            private: false,
          }),
        );
        return;
      }
      if (url === "/repos/acme/web/branches?per_page=100&page=1") {
        res.end(
          JSON.stringify([
            { name: "main", protected: true, commit: { sha: "1111111aaaa" } },
            { name: "feat/rd-2", protected: false, commit: { sha: "2222222bbbb" } },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/pulls?state=open&per_page=100") {
        res.end(
          JSON.stringify([
            {
              number: 9,
              title: "Add branch overview",
              html_url: "https://github.com/acme/web/pull/9",
              draft: false,
              updated_at: "2026-11-27T11:00:00Z",
              user: { login: "alice" },
              head: { ref: "feat/rd-2", repo: { full_name: "acme/web" } },
              base: { ref: "main" },
            },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/compare/main...feat/rd-2") {
        res.end(
          JSON.stringify({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            total_commits: 1,
            html_url: "https://github.com/acme/web/compare/main...feat/rd-2",
            files: [],
          }),
        );
        return;
      }
      if (url === "/repos/acme/web/commits?sha=main&per_page=40") {
        res.end(
          JSON.stringify([
            {
              sha: "1111111aaaa",
              html_url: "https://github.com/acme/web/commit/1111111aaaa",
              parents: [{ sha: "0000000base" }, { sha: "3333333merged" }],
              commit: {
                message: "Merge pull request #8 from acme/feat/merged",
                author: { name: "Alice", date: "2026-11-27T11:30:00Z" },
              },
              author: { login: "alice" },
            },
            {
              sha: "0000000base",
              html_url: "https://github.com/acme/web/commit/0000000base",
              parents: [],
              commit: {
                message: "chore: init main",
                author: { name: "Alice", date: "2026-11-27T09:00:00Z" },
              },
              author: { login: "alice" },
            },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/commits?sha=feat%2Frd-2&per_page=12") {
        res.end(
          JSON.stringify([
            {
              sha: "2222222bbbb",
              html_url: "https://github.com/acme/web/commit/2222222bbbb",
              parents: [{ sha: "1111111aaaa" }],
              commit: {
                message: "feat: build graph fallback RD-2",
                author: { name: "Bob", date: "2026-11-27T12:00:00Z" },
              },
              author: { login: "bob" },
            },
          ]),
        );
        return;
      }
      if (url === "/repos/acme/web/commits?sha=3333333merged&per_page=5") {
        res.end(
          JSON.stringify([
            {
              sha: "3333333merged",
              html_url: "https://github.com/acme/web/commit/3333333merged",
              parents: [{ sha: "0000000base" }],
              commit: {
                message: "feat: second parent subtree",
                author: { name: "Alice", date: "2026-11-27T10:30:00Z" },
              },
              author: { login: "alice" },
            },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    cleanupServers.push(ghMock.server);
    process.env.RELAYDESK_GITHUB_API_BASE = ghMock.url;

    upsertGithubConnection(f.dbPath, {
      id: "gh_test",
      label: "Test",
      token: "ghp_test_token",
      viewer: { login: "alice", type: "User" },
      owners: [{ login: "acme", type: "Organization" }],
      repo_count: 1,
    });

    const { project } = await f.ok("/projects", "POST", {
      name: "RepoBranches",
      repo: "acme/web",
      target_branch: "main",
    });
    const { task: t1 } = await f.ok(`/projects/${project.id}/tasks`, "POST", {
      title: "Fix branch view",
      body: "test",
    });
    expect(t1.number).toBe(1);
    const { task: t2 } = await f.ok(`/projects/${project.id}/tasks`, "POST", {
      title: "Branch RD-2",
      body: "test",
    });
    expect(t2.number).toBe(2);

    // 1. Legacy Bridge (no git_inspect) falls back cleanly to telemetry git_branch & has_dirty_files
    const legacyReg = await f.register("LegacyNode");
    const legacyConn = await f.connect(legacyReg.token);
    await legacyConn.hello([
      {
        project_id: project.id,
        workdir: "/tmp/legacy-web",
        path_ok: true,
        path_error: "",
        git_branch: "feat/rd-2",
        has_dirty_files: true,
      },
    ]);

    const legacyRes = await f.ok(
      `/projects/${project.id}/workspace/repos/branches?repo=acme/web`,
    );
    expect(legacyRes.local_workdir).toMatchObject({
      agent_name: "LegacyNode",
      current_branch: "feat/rd-2",
      has_dirty_files: true,
      detailed: false,
    });
    const featBranch = legacyRes.branches.find((b: { name: string }) => b.name === "feat/rd-2");
    expect(featBranch.is_local_current).toBe(true);
    expect(featBranch.open_pr.number).toBe(9);
    expect(featBranch.linked_tasks[0].number).toBe(2);

    // Disconnect legacy node and start real Bridge daemon with a real git workdir containing secret in origin URL
    legacyConn.ws.terminate();

    const localRoot = join(f.root, "local-workspace");
    const homeDir = join(f.root, "home");
    const repoWorkdir = join(localRoot, "web");
    mkdirSync(repoWorkdir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    git(repoWorkdir, ["init", "--initial-branch=main"]);
    writeFileSync(join(repoWorkdir, "index.ts"), "export const a = 1;\n", "utf8");
    git(repoWorkdir, ["add", "."]);
    git(repoWorkdir, ["commit", "-m", "initial commit"]);
    git(repoWorkdir, [
      "remote",
      "add",
      "origin",
      "https://x-access-token:SUPER_SECRET_SHOULD_NOT_LEAK@github.com/acme/web.git",
    ]);
    // Create a feature branch and merge it with --no-ff into main so both merged & merge-node paths exist
    git(repoWorkdir, ["checkout", "-b", "feat/merged"]);
    writeFileSync(join(repoWorkdir, "merged.ts"), "export const merged = true;\n", "utf8");
    git(repoWorkdir, ["add", "merged.ts"]);
    git(repoWorkdir, ["commit", "-m", "feat: merged subtree"]);
    git(repoWorkdir, ["checkout", "main"]);
    git(repoWorkdir, ["merge", "--no-ff", "feat/merged", "-m", "Merge feat/merged into main"]);
    // Create a stash commit to verify refs/stash is excluded from the git graph
    writeFileSync(join(repoWorkdir, "temp-stash.txt"), "stashed\n", "utf8");
    git(repoWorkdir, ["stash", "push", "-u", "-m", "secret stash should stay hidden"]);

    git(repoWorkdir, ["checkout", "-b", "local-wip"]);
    writeFileSync(join(repoWorkdir, "wip.ts"), "export const wip = true;\n", "utf8");
    git(repoWorkdir, ["add", "wip.ts"]);
    git(repoWorkdir, ["commit", "-m", "feat: local only branch commit"]);
    writeFileSync(join(repoWorkdir, "untracked.txt"), "dirty\n", "utf8");

    const liveReg = await f.register("RealMac");
    const configPath = join(f.root, "bridge-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        server_url: f.wsUrl,
        agent_token: liveReg.token,
        allowed_roots: [localRoot],
        projects: {
          [project.id]: { workdir: repoWorkdir },
        },
      }),
      { mode: 0o600 },
    );

    const daemon = await startBridgeDaemon({ configPath, homeDir, cacheDir: join(f.root, "cache") });
    try {
      await expect
        .poll(async () => {
          const { agents } = await f.ok("/bridge/agents");
          const a = agents.find((x: { id: string }) => x.id === liveReg.id);
          return Boolean(a?.online && a?.capabilities?.git_inspect && a?.capabilities?.git_graph);
        }, { timeout: 5000 })
        .toBe(true);

      const liveOverview = await f.ok(
        `/projects/${project.id}/workspace/repos/branches?repo=acme/web`,
      );
      expect(JSON.stringify(liveOverview)).not.toContain("SUPER_SECRET_SHOULD_NOT_LEAK");
      expect(liveOverview.local_workdir).toMatchObject({
        agent_name: "RealMac",
        remote_repo: "acme/web",
        current_branch: "local-wip",
        has_dirty_files: true,
        untracked_count: 1,
        detailed: true,
      });
      const mainBranch = liveOverview.branches.find((b: { name: string }) => b.name === "main");
      const mergedBranch = liveOverview.branches.find(
        (b: { name: string }) => b.name === "feat/merged",
      );
      const localOnly = liveOverview.branches.find((b: { name: string }) => b.name === "local-wip");
      expect(mainBranch.merge_status).toBe("base");
      expect(mergedBranch).toMatchObject({
        merge_status: "merged",
        ahead_of_base: 0,
      });
      expect(localOnly).toMatchObject({
        source: "local",
        is_local_current: true,
        merge_status: "ahead",
        ahead_of_base: 1,
        behind_base: 0,
        subject: "feat: local only branch commit",
      });

      const localGraph = await f.ok(
        `/projects/${project.id}/workspace/repos/graph?repo=acme/web`,
      );
      expect(JSON.stringify(localGraph)).not.toContain("SUPER_SECRET_SHOULD_NOT_LEAK");
      expect(JSON.stringify(localGraph)).not.toContain("secret stash should stay hidden");
      expect(localGraph.source).toBe("local");
      expect(localGraph.base_branch).toBe("main");
      expect(localGraph.base_first_parent_shas.length).toBeGreaterThanOrEqual(2);
      const mergeNode = localGraph.commits.find(
        (c: { parents: string[]; message: string }) =>
          c.parents.length === 2 && c.message.includes("Merge feat/merged"),
      );
      expect(mergeNode).toBeDefined();
      expect(localGraph.base_first_parent_shas).toContain(mergeNode.sha);
      expect(
        localGraph.commits.some((c: { sha: string }) => c.sha === mergeNode.parents[1]),
      ).toBe(true);

      const localDetail = await f.ok(
        `/projects/${project.id}/workspace/repos/branch-detail?repo=acme/web&branch=local-wip&source=local&base=main`,
      );
      expect(localDetail.source).toBe("local");
      expect(localDetail.commits[0].message).toBe("feat: local only branch commit");
      expect(localDetail.compare).toMatchObject({
        base: "main",
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        files_count: 1,
      });
      expect(localDetail.compare.files[0].filename).toBe("wip.ts");

      // Validation boundaries
      expect(
        (await f.api(`/projects/${project.id}/workspace/repos/branches?repo=other/repo`)).status,
      ).toBe(400);
      expect(
        (await f.api(`/projects/${project.id}/workspace/repos/graph?repo=other/repo`)).status,
      ).toBe(400);
      expect(
        (
          await f.api(
            `/projects/${project.id}/workspace/repos/graph?repo=acme/web&base=-bad`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(
            `/projects/${project.id}/workspace/repos/branch-detail?repo=acme/web&branch=-bad`,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(`/projects/${project.id}/repos/sync`, "POST", {
            repo: "other/repo",
            branch: "main",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await f.api(`/projects/${project.id}/repos/sync`, "POST", {
            repo: "acme/web",
            branch: "bad..branch",
          })
        ).status,
      ).toBe(400);

      // Disabled binding falls back cleanly to GitHub overview & commit graph
      await f.ok(`/projects/${project.id}/agent-bindings/${liveReg.id}`, "PATCH", {
        enabled: false,
      });
      const disabledOverview = await f.ok(
        `/projects/${project.id}/workspace/repos/branches?repo=acme/web`,
      );
      expect(disabledOverview.local_workdir).toBeNull();
      const disabledGraph = await f.ok(
        `/projects/${project.id}/workspace/repos/graph?repo=acme/web`,
      );
      expect(disabledGraph.source).toBe("remote");
      expect(disabledGraph.base_branch).toBe("main");
      expect(disabledGraph.commits.map((c: { sha: string }) => c.sha)).toEqual([
        "2222222bbbb",
        "1111111aaaa",
        "3333333merged",
        "0000000base",
      ]);
      const rd2Commit = disabledGraph.commits.find(
        (c: { sha: string }) => c.sha === "2222222bbbb",
      );
      expect(rd2Commit.refs[0]).toMatchObject({
        name: "feat/rd-2",
        open_pr_number: 9,
        linked_task_numbers: [2],
      });
    } finally {
      await daemon.close();
    }
  }, 30_000);
});
