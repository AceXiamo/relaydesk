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
      remote_sha: "1111111",
      local_sha: "1111111",
      sha: "1111111",
      committed_at: "2026-11-27T08:00:00Z",
      author: "alice",
      subject: "release v1",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      upstream_gone: false,
      open_pr: null,
      linked_tasks: [],
      github_url: "https://github.com/acme/web/tree/main",
    },
    {
      name: "feat/rd-39",
      source: "both",
      is_default: false,
      is_target: false,
      is_mirror_branch: false,
      is_local_current: true,
      protected: false,
      remote_sha: "3333333",
      local_sha: "3333333",
      sha: "3333333",
      committed_at: "2026-11-27T12:00:00Z",
      author: "bob",
      subject: "build branch panel",
      upstream: "origin/feat/rd-39",
      ahead: 2,
      behind: 0,
      upstream_gone: false,
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
      local_sha: "4444444",
      sha: "4444444",
      committed_at: "2026-11-27T11:00:00Z",
      author: "bob",
      subject: "local experiment",
      upstream: "",
      ahead: null,
      behind: null,
      upstream_gone: false,
      open_pr: null,
      linked_tasks: [],
      github_url: "",
    },
  ],
  counts: {
    total: 3,
    remote: 2,
    local_only: 1,
    with_pr: 1,
    with_task: 1,
  },
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

  it("renders status strip, filters, branch details, and wires task/code/chat actions", async () => {
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

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain("MacBook Pro");
    expect(bodyText).toContain("未提交 (3)");
    expect(bodyText).toContain("PR #42");
    expect(bodyText).toContain("RD-039");
    expect(bodyText).toContain("feat: render branches inspector");
    expect(bodyText).toContain("领先 +2");
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
