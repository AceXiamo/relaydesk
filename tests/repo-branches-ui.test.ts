// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoBranchesPanel } from "../app/components/RepoBranchesPanel.tsx";
import { api } from "../app/lib/api.ts";
import type {
  ProjectDetail,
  RepoBranchDetailPayload,
  RepoBranchesOverviewPayload,
  RepoGitGraphPayload,
  TaskRecord,
} from "../app/lib/types.ts";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: ProjectDetail = {
  id: "proj_1",
  name: "Relaydesk",
  repo: "acme/web",
  repos: ["acme/web"],
  automation_paused: false,
  delivery_mode: "pr_automerge",
  target_branch: "staging",
  branch_prefix: "relaydesk",
  deploy_policy: {
    runtime: null,
    model: null,
    mode: "none",
    window_start: "02:00",
    window_end: "04:00",
    timezone: "Asia/Shanghai",
    allow_urgent_override: true,
    doc_path: "",
  },
  pending_deploy_count: 0,
  widget_code_context: true,
  created_at: "2026-11-01T00:00:00Z",
  intake_key: "ik",
  bot_key: "bk",
  agent_key: "ak",
  allowed_origins: [],
  agent_instructions: "",
};

const TASKS: TaskRecord[] = [
  {
    id: "task_39",
    project_id: "proj_1",
    number: 39,
    title: "分支展示面板",
    body: "",
    requirements: "",
    status: "working",
    priority: "high",
    source: "console",
    source_url: "",
    owner: "none",
    version: 1,
    attempts: 0,
    resolution: null,
    delivery_ref: "feat/rd-39",
    deploy_status: "not_required",
    deployed_at: null,
    release_id: null,
    triaged_by: "",
    merged_into: null,
    created_at: "2026-11-27T09:00:00Z",
    updated_at: "2026-11-27T12:00:00Z",
    last_seen: null,
  },
];

const OVERVIEW: RepoBranchesOverviewPayload = {
  repo: "acme/web",
  html_url: "https://github.com/acme/web",
  private: true,
  default_branch: "main",
  target_branch: "staging",
  branch_prefix: "relaydesk",
  delivery_mode: "pr_automerge",
  compare_base: "staging",
  github_configured: true,
  mirror: {
    repo: "acme/web",
    ready: true,
    branch: "main",
    commit: "1111111",
    updated_at: "2026-11-27T10:00:00Z",
  },
  local_workdir: {
    agent_id: "ag_1",
    agent_name: "MacBook Pro",
    online: true,
    workdir: "/work/web",
    remote_repo: "acme/web",
    current_branch: "feat/rd-39",
    detached: false,
    head_sha: "3333333",
    has_dirty_files: true,
    staged_count: 1,
    unstaged_count: 1,
    untracked_count: 1,
    detailed: true,
    branches: [],
  },
  branches: [
    {
      name: "main",
      source: "both",
      is_default: true,
      is_target: false,
      is_mirror_branch: true,
      is_local_current: false,
      protected: true,
      remote_sha: "1111111aaaa",
      local_sha: "1111111aaaa",
      sha: "1111111aaaa",
      committed_at: "2026-11-27T08:00:00Z",
      author: "alice",
      subject: "release v1",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      upstream_gone: false,
      merge_status: "merged",
      ahead_of_base: 0,
      behind_base: 1,
      open_pr: null,
      linked_tasks: [],
      github_url: "https://github.com/acme/web/tree/main",
    },
    {
      name: "staging",
      source: "remote",
      is_default: false,
      is_target: true,
      is_mirror_branch: false,
      is_local_current: false,
      protected: false,
      remote_sha: "1111111aaaa",
      local_sha: "",
      sha: "1111111aaaa",
      committed_at: "2026-11-27T08:30:00Z",
      author: "alice",
      subject: "staging baseline",
      upstream: "",
      ahead: null,
      behind: null,
      upstream_gone: false,
      merge_status: "base",
      ahead_of_base: 0,
      behind_base: 0,
      open_pr: null,
      linked_tasks: [],
      github_url: "https://github.com/acme/web/tree/staging",
    },
    {
      name: "feat/rd-39",
      source: "both",
      is_default: false,
      is_target: false,
      is_mirror_branch: false,
      is_local_current: true,
      protected: false,
      remote_sha: "333333399999",
      local_sha: "333333399999",
      sha: "333333399999",
      committed_at: "2026-11-27T12:00:00Z",
      author: "bob",
      subject: "build branch panel",
      upstream: "origin/feat/rd-39",
      ahead: 2,
      behind: 0,
      upstream_gone: false,
      merge_status: "ahead",
      ahead_of_base: 2,
      behind_base: 0,
      open_pr: {
        number: 42,
        title: "Add branch panel",
        html_url: "https://github.com/acme/web/pull/42",
        draft: false,
        base_ref: "staging",
        author: "bob",
        updated_at: "2026-11-27T12:00:00Z",
      },
      linked_tasks: [
        {
          id: "task_39",
          number: 39,
          title: "分支展示面板",
          status: "working",
          priority: "high",
          delivery_ref: "feat/rd-39",
        },
      ],
      github_url: "https://github.com/acme/web/tree/feat/rd-39",
    },
    {
      name: "local-draft",
      source: "local",
      is_default: false,
      is_target: false,
      is_mirror_branch: false,
      is_local_current: false,
      protected: false,
      remote_sha: "",
      local_sha: "4444444aaaa",
      sha: "4444444aaaa",
      committed_at: "2026-11-27T11:00:00Z",
      author: "bob",
      subject: "local experiment",
      upstream: "",
      ahead: null,
      behind: null,
      upstream_gone: false,
      merge_status: "ahead",
      ahead_of_base: 1,
      behind_base: 0,
      open_pr: null,
      linked_tasks: [],
      github_url: "",
    },
  ],
  counts: {
    total: 4,
    remote: 3,
    local_only: 1,
    with_pr: 1,
    with_task: 1,
    merged: 1,
    unmerged: 2,
  },
  fetched_at: "2026-11-27T12:05:00Z",
};

const GRAPH: RepoGitGraphPayload = {
  repo: "acme/web",
  source: "local",
  base_branch: "staging",
  base_first_parent_shas: [
    "1111111aaaa",
    "s4aaaa00000",
    "s3aaaa00000",
    "s2aaaa00000",
    "s1aaaa00000",
    "c0aaaa00000",
  ],
  commits: [
    {
      sha: "333333399999",
      short_sha: "3333333",
      parents: ["s4aaaa00000"],
      message: "feat: build graph branch panel RD-39",
      author_name: "Bob",
      author_login: "bob",
      date: "2026-11-27T12:00:00Z",
      refs: [
        { name: "feat/rd-39", kind: "local", is_head: true },
        { name: "feat/rd-39", kind: "remote" },
      ],
    },
    {
      sha: "4444444aaaa",
      short_sha: "4444444",
      parents: ["s4aaaa00000"],
      message: "wip: local experiment",
      author_name: "Bob",
      date: "2026-11-27T11:00:00Z",
      refs: [{ name: "local-draft", kind: "local" }],
    },
    {
      sha: "1111111aaaa",
      short_sha: "1111111",
      parents: ["s4aaaa00000", "f999999aaaa"],
      message: "Merge pull request #10 from acme/feat/done",
      author_name: "Alice",
      author_login: "alice",
      date: "2026-11-27T08:30:00Z",
      refs: [
        { name: "staging", kind: "remote" },
        { name: "main", kind: "remote" },
      ],
    },
    {
      sha: "s4aaaa00000",
      short_sha: "s4aaaa0",
      parents: ["s3aaaa00000"],
      message: "chore: middle commit 4",
      author_name: "Alice",
      date: "2026-11-27T08:00:00Z",
      refs: [],
    },
    {
      sha: "s3aaaa00000",
      short_sha: "s3aaaa0",
      parents: ["s2aaaa00000"],
      message: "chore: middle commit 3",
      author_name: "Alice",
      date: "2026-11-27T07:30:00Z",
      refs: [],
    },
    {
      sha: "s2aaaa00000",
      short_sha: "s2aaaa0",
      parents: ["s1aaaa00000"],
      message: "chore: middle commit 2",
      author_name: "Alice",
      date: "2026-11-27T07:00:00Z",
      refs: [],
    },
    {
      sha: "s1aaaa00000",
      short_sha: "s1aaaa0",
      parents: ["c0aaaa00000"],
      message: "chore: middle commit 1",
      author_name: "Alice",
      date: "2026-11-27T06:30:00Z",
      refs: [],
    },
    {
      sha: "f999999aaaa",
      short_sha: "f999999",
      parents: ["c0aaaa00000"],
      message: "feat: merged work",
      author_name: "Alice",
      date: "2026-11-27T06:15:00Z",
      refs: [],
    },
    {
      sha: "c0aaaa00000",
      short_sha: "c0aaaa0",
      parents: [],
      message: "chore: initial commit",
      author_name: "Alice",
      date: "2026-11-27T06:00:00Z",
      refs: [],
    },
  ],
  truncated: false,
  fetched_at: "2026-11-27T12:05:00Z",
};

const DETAIL_MAP: Record<string, RepoBranchDetailPayload> = {
  "feat/rd-39": {
    repo: "acme/web",
    branch: "feat/rd-39",
    source: "remote",
    commits: [
      {
        sha: "333333399999",
        short_sha: "3333333",
        message: "feat: render branches inspector",
        author_name: "Bob",
        author_login: "bob",
        date: "2026-11-27T12:00:00Z",
        html_url: "https://github.com/acme/web/commit/333333399999",
      },
    ],
    compare: {
      base: "staging",
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      files_count: 1,
      additions: 88,
      deletions: 4,
      files: [
        {
          filename: "app/components/RepoBranchesPanel.tsx",
          status: "added",
          additions: 88,
          deletions: 4,
        },
      ],
    },
  },
  "local-draft": {
    repo: "acme/web",
    branch: "local-draft",
    source: "local",
    commits: [
      {
        sha: "4444444aaaa",
        short_sha: "4444444",
        message: "wip: local draft",
        author_name: "Bob",
        date: "2026-11-27T11:00:00Z",
      },
    ],
    compare: null,
  },
};

describe("RepoBranchesPanel UI", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders tree topology graph by default, expands straight runs, inspects merge commits, and switches to grouped branch list", async () => {
    const detailSpy = vi
      .spyOn(api, "getWorkspaceRepoBranchDetail")
      .mockImplementation(async (_projectId, params) => {
        return (
          DETAIL_MAP[params.branch] ?? {
            repo: "acme/web",
            branch: params.branch,
            source: params.source ?? "remote",
            commits: [],
            compare: null,
          }
        );
      });

    const onBrowseBranchCode = vi.fn();
    const onSelectTask = vi.fn();
    const onOpenChatWithContext = vi.fn();

    await act(async () => {
      root.render(
        createElement(RepoBranchesPanel, {
          project: PROJECT,
          repo: "acme/web",
          mirror: OVERVIEW.mirror,
          repoSyncing: false,
          overview: OVERVIEW,
          overviewLoading: false,
          overviewError: "",
          graph: GRAPH,
          graphLoading: false,
          graphError: "",
          tasks: TASKS,
          mobilePane: "list",
          onMobilePaneChange: vi.fn(),
          onRefresh: vi.fn(),
          onBrowseBranchCode,
          onSelectTask,
          onOpenChatWithContext,
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Default graph mode renders SVG rails, curves, nodes, merge badges & collapsed run
    expect(document.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("svg path").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("svg circle").length).toBeGreaterThan(0);

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("MacBook Pro");
    expect(bodyText).toContain("未提交 (3)");
    expect(bodyText).toContain("尚未合并到 staging（领先 2 个提交）");
    expect(bodyText).toContain("未合并 +2");
    expect(bodyText).toContain("已合并");
    expect(bodyText).toContain("展开 3 个中间提交");
    expect(bodyText).not.toContain("chore: middle commit 2");
    expect(bodyText).toContain("PR #42");
    expect(bodyText).toContain("RD-039");
    expect(bodyText).toContain("feat: render branches inspector");
    expect(bodyText).toContain("app/components/RepoBranchesPanel.tsx");
    expect(detailSpy).toHaveBeenCalledWith(
      "proj_1",
      { repo: "acme/web", branch: "feat/rd-39", source: "remote", base: "staging" },
      expect.any(AbortSignal),
    );

    // Click linked task row -> opens task drawer
    const taskBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("分支展示面板"),
    );
    expect(taskBtn).toBeDefined();
    await act(async () => {
      taskBtn!.click();
    });
    expect(onSelectTask).toHaveBeenCalledWith("task_39");

    // Click browse code -> triggers branch sync callback
    const browseBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("浏览此分支源码"),
    );
    expect(browseBtn).toBeDefined();
    await act(async () => {
      browseBtn!.click();
    });
    expect(onBrowseBranchCode).toHaveBeenCalledWith("feat/rd-39");

    // Click discuss in Codex -> passes branch prompt context
    const chatBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("在 Codex 中讨论"),
    );
    expect(chatBtn).toBeDefined();
    await act(async () => {
      chatBtn!.click();
    });
    expect(onOpenChatWithContext).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining("feat/rd-39"),
    );

    // Expand collapsed straight commits
    const expandBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("展开 3 个中间提交"),
    );
    expect(expandBtn).toBeDefined();
    await act(async () => {
      expandBtn!.click();
    });
    expect(document.body.textContent).toContain("chore: middle commit 2");

    // Click merge commit row -> renders Commit Inspector with parent SHA jump buttons
    const mergeRow = Array.from(document.querySelectorAll('[role="button"]')).find((el) =>
      el.textContent?.includes("Merge pull request #10 from acme/feat/done"),
    ) as HTMLElement | undefined;
    expect(mergeRow).toBeDefined();
    await act(async () => {
      mergeRow!.click();
    });
    expect(document.body.textContent).toContain("合并提交 · 2 父节点");
    expect(document.body.textContent).toContain("合入分支父提交 (P2)");

    const p2JumpBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("feat: merged work"),
    );
    expect(p2JumpBtn).toBeDefined();
    await act(async () => {
      p2JumpBtn!.click();
    });
    expect(document.body.textContent).toContain("f999999aaaa");

    // Switch SegmentedDetent to grouped "分支清单"
    const listTabBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("分支清单"),
    );
    expect(listTabBtn).toBeDefined();
    await act(async () => {
      listTabBtn!.click();
    });
    expect(document.body.textContent).toContain("基线主干");
    expect(document.body.textContent).toContain("未合并分支");
    expect(document.body.textContent).toContain("已合并分支");

    // Filter to local_only -> loads local branch detail
    const localFilterBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("仅本机"),
    );
    expect(localFilterBtn).toBeDefined();
    await act(async () => {
      localFilterBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(detailSpy).toHaveBeenLastCalledWith(
      "proj_1",
      { repo: "acme/web", branch: "local-draft", source: "local", base: "staging" },
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain("wip: local draft");

    // Search filters branches by PR / task / name and resets cleanly
    const searchInput = document.querySelector(
      'input[placeholder="搜索分支、PR、RD 工单或提交…"]',
    ) as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    const allFilterBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("全部"),
    );
    await act(async () => {
      allFilterBtn!.click();
    });
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(searchInput, "RD-039");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("feat/rd-39");
    expect(document.body.textContent).not.toContain("local-draft");
  });
});
