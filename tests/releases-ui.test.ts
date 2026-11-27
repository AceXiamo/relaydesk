// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleasesView } from "../app/components/ReleasesView.tsx";
import { ToastProvider } from "../app/components/ui.tsx";
import { api, ClientApiError } from "../app/lib/api.ts";
import type { ProjectDetail, ReleaseRecord, ReleaseStatus } from "../app/lib/types.ts";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: ProjectDetail = {
  id: "proj_1",
  name: "Relaydesk",
  repo: "acme/web",
  repos: ["acme/web"],
  automation_paused: false,
  delivery_mode: "pr_automerge",
  target_branch: "main",
  branch_prefix: "relaydesk",
  deploy_policy: {
    runtime: null,
    model: null,
    mode: "manual",
    window_start: "02:00",
    window_end: "04:00",
    timezone: "Asia/Shanghai",
    allow_urgent_override: true,
    doc_path: "DEPLOY.md",
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

function makeRelease(
  id: string,
  number: number,
  status: ReleaseStatus,
  overrides: Partial<ReleaseRecord> = {},
): ReleaseRecord {
  return {
    id,
    project_id: PROJECT.id,
    number,
    trigger: "manual",
    status,
    session_id: `sess_${id}`,
    task_ids: ["task_48"],
    task_snapshot: [
      {
        id: "task_48",
        number: 48,
        title: "发布手动验收操作",
        priority: "normal",
        delivery_ref: "main",
      },
    ],
    target_sha: "abcdef1234567890",
    deploy_ref: "main@abcdef12",
    summary: "",
    verification_context: {},
    created_at: "2026-11-28T02:00:00Z",
    updated_at: "2026-11-28T02:05:00Z",
    finished_at: status === "succeeded" || status === "failed" || status === "blocked" ? "2026-11-28T02:10:00Z" : null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RD-48 release manual approval UI", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderView(onMutated = vi.fn()) {
    act(() => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(ReleasesView, {
            project: PROJECT,
            onNewProject: vi.fn(),
            onOpenReleaseSession: vi.fn(),
            onSelectTask: vi.fn(),
            onEditDeployDoc: vi.fn(),
            onOpenDeploySettings: vi.fn(),
            onMutated,
          }),
        ),
      );
    });
    return onMutated;
  }

  it("calls POST /api/projects/:projectId/releases/:releaseId/approve with URL-encoded segments", async () => {
    const approved = makeRelease("rel/48", 8, "succeeded");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ release: approved }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await api.approveProjectRelease("proj/1", "rel/48");
    expect(res.release.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/proj%2F1/releases/rel%2F48/approve");
    expect(init.method).toBe("POST");
  });

  it("renders manual approval only for verifying releases and hides it for running, failed, blocked, and succeeded", async () => {
    const verifying = makeRelease("rel_verifying", 8, "verifying");
    const failed = makeRelease("rel_failed", 7, "failed");
    const blocked = makeRelease("rel_blocked", 6, "blocked");
    const succeeded = makeRelease("rel_succeeded", 5, "succeeded");

    vi.spyOn(api, "listProjectReleases").mockResolvedValue({
      releases: [verifying, failed, blocked, succeeded],
      pending_tasks: [],
      failed_tasks: [],
      active_release: verifying,
      deploy_policy: PROJECT.deploy_policy,
      deploy_doc_exists: true,
    });
    vi.spyOn(api, "listProjectDeployGates").mockResolvedValue({ evaluations: [] });

    renderView();
    await flush();

    // Active banner + verifying history card both expose manual approval.
    const approveButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "手动验收",
    );
    expect(approveButtons).toHaveLength(2);

    // Inspect each history article individually to confirm strict verifying-only gating.
    const articles = Array.from(document.querySelectorAll("article"));
    expect(articles).toHaveLength(4);
    const hasApproveIn = (article: Element) =>
      Array.from(article.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "手动验收",
      );
    const hasReverifyIn = (article: Element) =>
      Array.from(article.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "重新验收",
      );

    expect(hasApproveIn(articles[0]!)).toBe(true); // verifying
    expect(hasApproveIn(articles[1]!)).toBe(false); // failed
    expect(hasReverifyIn(articles[1]!)).toBe(true); // failed still supports reverify
    expect(hasApproveIn(articles[2]!)).toBe(false); // blocked
    expect(hasReverifyIn(articles[2]!)).toBe(true); // blocked still supports reverify
    expect(hasApproveIn(articles[3]!)).toBe(false); // succeeded

    // Unmount and verify running release never shows manual approval.
    act(() => root.unmount());
    root = createRoot(container);

    const running = makeRelease("rel_running", 9, "running");
    vi.mocked(api.listProjectReleases).mockResolvedValue({
      releases: [running],
      pending_tasks: [],
      failed_tasks: [],
      active_release: running,
      deploy_policy: PROJECT.deploy_policy,
      deploy_doc_exists: true,
    });

    renderView();
    await flush();

    const runningApproveButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "手动验收",
    );
    expect(runningApproveButtons).toHaveLength(0);
  });

  it("requires double confirmation, cancels cleanly without calling API, and refreshes after confirming", async () => {
    const verifying = makeRelease("rel_48", 8, "verifying");
    const approved = makeRelease("rel_48", 8, "succeeded", {
      summary: "操作者已手动确认验证通过。",
    });

    const listSpy = vi
      .spyOn(api, "listProjectReleases")
      .mockResolvedValueOnce({
        releases: [verifying],
        pending_tasks: [],
        failed_tasks: [],
        active_release: verifying,
        deploy_policy: PROJECT.deploy_policy,
        deploy_doc_exists: true,
      })
      .mockResolvedValueOnce({
        releases: [approved],
        pending_tasks: [],
        failed_tasks: [],
        active_release: null,
        deploy_policy: PROJECT.deploy_policy,
        deploy_doc_exists: true,
      });
    vi.spyOn(api, "listProjectDeployGates").mockResolvedValue({ evaluations: [] });
    const approveSpy = vi
      .spyOn(api, "approveProjectRelease")
      .mockResolvedValue({ release: approved });

    const onMutated = renderView();
    await flush();

    // First click opens confirmation dialog without calling approve API.
    const manualBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "手动验收",
    );
    expect(manualBtn).toBeDefined();
    await act(async () => {
      manualBtn!.click();
    });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("确认手动验收 REL-8？");
    expect(dialog!.textContent).toContain("包含 1 个任务");
    expect(approveSpy).not.toHaveBeenCalled();

    // Cancel closes dialog without mutating or calling API.
    const cancelBtn = Array.from(dialog!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "取消",
    );
    expect(cancelBtn).toBeDefined();
    await act(async () => {
      cancelBtn!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(approveSpy).not.toHaveBeenCalled();
    expect(onMutated).not.toHaveBeenCalled();

    // Re-open and confirm -> calls approve API, triggers onMutated, reloads list, removes verifying UI.
    await act(async () => {
      manualBtn!.click();
    });
    const confirmDialog = document.querySelector('[role="dialog"]');
    expect(confirmDialog).not.toBeNull();
    const confirmBtn = Array.from(confirmDialog!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "确认验收通过",
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
    });
    await flush();

    expect(approveSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledWith(PROJECT.id, verifying.id);
    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("已手动验收通过 REL-8");

    // After refresh, status is succeeded so no manual approval button remains.
    const remainingApproveButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "手动验收",
    );
    expect(remainingApproveButtons).toHaveLength(0);
  });

  it("surfaces API error via toast and does not call onMutated when approval fails", async () => {
    const verifying = makeRelease("rel_48", 8, "verifying");
    vi.spyOn(api, "listProjectReleases").mockResolvedValue({
      releases: [verifying],
      pending_tasks: [],
      failed_tasks: [],
      active_release: verifying,
      deploy_policy: PROJECT.deploy_policy,
      deploy_doc_exists: true,
    });
    vi.spyOn(api, "listProjectDeployGates").mockResolvedValue({ evaluations: [] });
    vi.spyOn(api, "approveProjectRelease").mockRejectedValue(
      new ClientApiError(409, "发布单当前不是待验收状态"),
    );

    const onMutated = renderView();
    await flush();

    const manualBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "手动验收",
    );
    await act(async () => {
      manualBtn!.click();
    });

    const confirmBtn = Array.from(
      document.querySelector('[role="dialog"]')!.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "确认验收通过");
    await act(async () => {
      confirmBtn!.click();
    });
    await flush();

    expect(onMutated).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("发布单当前不是待验收状态");
  });
});
