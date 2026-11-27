// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailDrawer } from "../app/components/TaskDetailDrawer.tsx";
import { filterTasksForView, TaskQueueView } from "../app/components/TaskQueueView.tsx";
import { ToastProvider } from "../app/components/ui.tsx";
import { api } from "../app/lib/api.ts";
import { ProjectChatStreams } from "../app/lib/chat-streams.ts";
import type { ProjectDetail, TaskDetailPayload, TaskRecord } from "../app/lib/types.ts";

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: ProjectDetail = {
  id: "proj_1",
  name: "Relaydesk",
  repo: "acexiamo/relaydesk",
  repos: ["acexiamo/relaydesk"],
  automation_paused: false,
  delivery_mode: "direct_push",
  target_branch: "main",
  branch_prefix: "rd",
  deploy_policy: {
    runtime: null,
    model: null,
    mode: "immediate",
    window_start: "00:00",
    window_end: "23:59",
    timezone: "Asia/Shanghai",
    allow_urgent_override: true,
    doc_path: "DEPLOY.md",
  },
  pending_deploy_count: 0,
  widget_code_context: true,
  created_at: "2026-11-28T00:00:00.000Z",
  intake_key: "ik",
  bot_key: "bk",
  agent_key: "ak",
  allowed_origins: [],
  agent_instructions: "",
};

function makeTask(id: string, number: number, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    project_id: PROJECT.id,
    number,
    title: `任务 ${number}`,
    body: `详情 ${number}`,
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
    triaged_by: "",
    merged_into: null,
    deploy_status: "not_required",
    deployed_at: null,
    release_id: null,
    created_at: "2026-11-28T00:00:00.000Z",
    updated_at: `2026-11-28T00:00:0${Math.min(9, number)}.000Z`,
    last_seen: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Task ignore workflow UI", () => {
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
  });

  it("filters ignored tasks separately from completed tasks in filterTasksForView", () => {
    const openTask = makeTask("t1", 1, { status: "ready" });
    const shippedTask = makeTask("t2", 2, { status: "done", resolution: "shipped" });
    const ignoredTask = makeTask("t3", 3, { status: "done", resolution: "wontfix" });
    const tasks = [openTask, shippedTask, ignoredTask];

    expect(filterTasksForView(tasks, "queue", "", "", "", "number").map((t) => t.id)).toEqual([
      "t3",
      "t2",
      "t1",
    ]);
    expect(filterTasksForView(tasks, "queue", "", "done", "", "number").map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(
      filterTasksForView(tasks, "queue", "", "ignored", "", "number").map((t) => t.id),
    ).toEqual(["t3"]);
  });

  it("renders ignored badges and triggers ignore / un-ignore quick actions in TaskQueueView", async () => {
    const openTask = makeTask("t_open", 11, { title: "需要判断是否忽略的需求", status: "triage" });
    const ignoredTask = makeTask("t_ign", 12, {
      title: "暂不实施的用户建议",
      status: "done",
      resolution: "wontfix",
    });
    const onQuickAction = vi.fn().mockResolvedValue(undefined);
    const onReopenTask = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(TaskQueueView, {
            project: PROJECT,
            tasks: [openTask, ignoredTask],
            view: "queue",
            selectedTaskId: null,
            search: "",
            statusFilter: "",
            sourceFilter: "",
            cockpitFilter: "",
            sortMode: "number",
            loading: false,
            onSearchChange: vi.fn(),
            onStatusFilterChange: vi.fn(),
            onSourceFilterChange: vi.fn(),
            onSortModeChange: vi.fn(),
            onClearFilters: vi.fn(),
            onSelectTask: vi.fn(),
            onQuickAction,
            onReopenTask,
            onToggleAutomation: vi.fn().mockResolvedValue(undefined),
            onNewFeedback: vi.fn(),
            onNewProject: vi.fn(),
            onRefresh: vi.fn(),
            onNavigateView: vi.fn(),
            searchInputRef: { current: null },
          }),
        ),
      );
    });
    await flush();

    expect(container.textContent).toContain("已忽略");
    expect(container.textContent).toContain("暂不实施");

    const ignoreBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "忽略",
    );
    expect(ignoreBtn).toBeDefined();
    await act(async () => {
      ignoreBtn!.click();
    });
    expect(onQuickAction).toHaveBeenCalledWith(openTask, "ignore");

    const unignoreBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "取消忽略",
    );
    expect(unignoreBtn).toBeDefined();
    await act(async () => {
      unignoreBtn!.click();
    });
    expect(onReopenTask).toHaveBeenCalledWith(ignoredTask);
  });

  it("opens ignore modal with reason in TaskDetailDrawer and supports un-ignoring ignored tasks", async () => {
    const openTask = makeTask("t_open", 21, { title: "用户新需求", status: "ready", version: 3 });
    const ignoredTask = makeTask("t_ign", 21, {
      title: "用户新需求",
      status: "done",
      resolution: "wontfix",
      version: 4,
    });

    vi.spyOn(api, "listProjectDeployGates").mockResolvedValue({ evaluations: [] });
    vi.spyOn(api, "listCliRuns").mockResolvedValue({ runs: [] });
    const actionSpy = vi.spyOn(api, "taskAction").mockResolvedValue({ task: ignoredTask });
    const onRefreshTask = vi.fn().mockResolvedValue(undefined);

    const openDetail: TaskDetailPayload = { task: openTask, messages: [], merged: [] };
    const streams = new ProjectChatStreams(api);

    act(() => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(TaskDetailDrawer, {
            detail: openDetail,
            loading: false,
            allTasks: [openTask],
            project: PROJECT,
            canGoBack: false,
            onGoBack: vi.fn(),
            onClose: vi.fn(),
            onOpenRelated: vi.fn(),
            onRefreshTask,
            onOpenCliSettings: vi.fn(),
            streams,
            onRefreshTasks: vi.fn(),
          }),
        ),
      );
    });
    await flush();

    const ignoreTrigger = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "忽略",
    );
    expect(ignoreTrigger).toBeDefined();
    await act(async () => {
      ignoreTrigger!.click();
    });

    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const confirmModal = dialogs.find((d) => d.textContent?.includes("忽略此任务？"));
    expect(confirmModal).toBeDefined();
    const textarea = confirmModal!.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "与当前规划不符");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const confirmBtn = Array.from(confirmModal!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "确认忽略",
    );
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      confirmBtn!.click();
    });
    await flush();

    expect(actionSpy).toHaveBeenCalledWith("t_open", {
      action: "ignore",
      version: 3,
      body: "与当前规划不符",
    });
    expect(onRefreshTask).toHaveBeenCalledWith("t_open");

    // Render ignored state -> shows 已忽略 / 暂不实施 / 取消忽略
    actionSpy.mockResolvedValueOnce({ task: openTask });
    const ignoredDetail: TaskDetailPayload = { task: ignoredTask, messages: [], merged: [] };
    act(() => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(TaskDetailDrawer, {
            detail: ignoredDetail,
            loading: false,
            allTasks: [ignoredTask],
            project: PROJECT,
            canGoBack: false,
            onGoBack: vi.fn(),
            onClose: vi.fn(),
            onOpenRelated: vi.fn(),
            onRefreshTask,
            onOpenCliSettings: vi.fn(),
            streams,
            onRefreshTasks: vi.fn(),
          }),
        ),
      );
    });
    await flush();

    expect(document.body.textContent).toContain("已忽略");
    expect(document.body.textContent).toContain("暂不实施");
    const unignoreBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "取消忽略",
    );
    expect(unignoreBtn).toBeDefined();

    await act(async () => {
      unignoreBtn!.click();
    });
    await flush();

    expect(actionSpy).toHaveBeenLastCalledWith("t_ign", {
      action: "reopen",
      version: 4,
    });
  });
});
