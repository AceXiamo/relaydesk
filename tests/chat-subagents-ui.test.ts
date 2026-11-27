// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolChipsGroup } from "../app/components/agent-chat/AgentPrimitives.tsx";
import { SubagentDock } from "../app/components/agent-chat/SubagentDock.tsx";
import { CodexChatView } from "../app/components/CodexChatView.tsx";
import { TaskAgentSessionPanel } from "../app/components/TaskAgentSessionPanel.tsx";
import { ToastProvider } from "../app/components/ui.tsx";
import { ProjectChatStreams } from "../app/lib/chat-streams.ts";
import { aggregateSessionSubagents } from "../app/lib/subagents.ts";
import type { ChatMessageRecord, ChatSessionRecord, ChatToolEvent, ProjectDetail, TaskRecord } from "../app/lib/types.ts";

const mockApi = vi.hoisted(() => ({
  getTaskAgentSession: vi.fn(),
  listCodexChatSessions: vi.fn(),
  getCodexChatRuntime: vi.fn(),
  getWorkspaceSummary: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  getCodexChatSession: vi.fn(),
  subscribeCodexChatStream: vi.fn(),
  abortCodexChatSession: vi.fn(),
}));

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

vi.mock("../app/components/MarkdownContent.tsx", () => ({
  MarkdownContent: ({ content }: { content: string }) => createElement("div", { "data-markdown": "1" }, content),
}));

vi.mock("../app/lib/api.ts", () => ({
  ClientApiError: class extends Error { status = 500; },
  api: mockApi,
}));

function makeSubagentEvents(): ChatToolEvent[] {
  return [
    {
      id: "sa-run",
      tool: "Agent",
      summary: "审查 server/cli-stream-parser.ts 解析逻辑",
      status: "running",
      subagent: { status: "running", activity: "Read" },
    },
    {
      id: "sa-done",
      tool: "Agent",
      summary: "补充 vitest 单元测试",
      status: "done",
      output: "已新增 6 个测试用例，全部通过。\n覆盖 Codex 与 Claude 子代理快照。",
      subagent: { status: "done", activity: "Bash" },
    },
    {
      id: "sa-err",
      tool: "subagent",
      summary: "验证远端部署配置",
      status: "error",
      output: "Error: ECONNREFUSED 127.0.0.1:8787",
      subagent: { status: "error", activity: "curl /health" },
    },
    {
      id: "sa-int",
      tool: "Agent",
      summary: "重构聊天工具卡片",
      status: "error",
      output: "写入前被用户中止",
      subagent: { status: "interrupted", activity: "Edit" },
    },
    {
      id: "sa-unk",
      tool: "subagent",
      summary: "后台索引仓库依赖",
      status: "done",
      subagent: { status: "unknown", activity: "Grep" },
    },
  ];
}

function makeSession(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    id: "sess-1",
    project_id: "proj-1",
    kind: "chat",
    task_id: null,
    release_id: null,
    title: "RD-19 子代理联调",
    runtime: "claude",
    model: "claude-sonnet-4-6",
    sandbox_mode: "workspace-write",
    network_access: true,
    execution_target: "auto",
    resolved_target: "local:mac",
    reasoning_effort: "default",
    external_session_id: "ext-1",
    status: "idle",
    created_at: "2026-11-24T10:00:00.000Z",
    updated_at: "2026-11-24T10:01:00.000Z",
    ...overrides,
  };
}

function makeMessages(events: ChatToolEvent[]): ChatMessageRecord[] {
  return [
    {
      id: "m-user",
      session_id: "sess-1",
      role: "user",
      content: "并行检查解析器和 UI",
      events: [],
      attachments: [],
      status: "done",
      created_at: "2026-11-24T10:00:00.000Z",
    },
    {
      id: "m-assistant",
      session_id: "sess-1",
      role: "assistant",
      content: "已完成检查。",
      events,
      attachments: [],
      status: "done",
      created_at: "2026-11-24T10:01:00.000Z",
    },
  ];
}

describe("ToolChipsGroup subagent UI", () => {
  let root: Root;
  let container: HTMLElement;
  const user = userEvent.setup();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.body.appendChild(document.createElement("main"));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderTools(events: ChatToolEvent[], isStreaming = false) {
    act(() => root.render(createElement(ToolChipsGroup, { events, isStreaming })));
  }

  it("renders parallel subagents with distinct task, last known status, recent activity, and result/error", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderTools(makeSubagentEvents(), true);

    const section = container.querySelector('section[aria-label="并行子代理任务"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("并行子代理 (5)");
    expect(section!.textContent).toContain("1 运行中");
    expect(section!.textContent).toContain("1 已完成");
    expect(section!.textContent).toContain("1 失败");
    expect(section!.textContent).toContain("1 已中断");
    expect(section!.textContent).toContain("1 未知");

    const rows = [...section!.querySelectorAll<HTMLLIElement>("li[data-subagent-id]")];
    expect(rows.map((r) => [r.dataset.subagentId, r.dataset.subagentStatus])).toEqual([
      ["sa-run", "running"],
      ["sa-done", "done"],
      ["sa-err", "error"],
      ["sa-int", "interrupted"],
      ["sa-unk", "unknown"],
    ]);

    // Parallel lane badges and distinct status / activity / output labels
    expect(rows[0].textContent).toContain("#1");
    expect(rows[0].textContent).toContain("审查 server/cli-stream-parser.ts 解析逻辑");
    expect(rows[0].textContent).toContain("运行中");
    expect(rows[0].textContent).toContain("最近活动");
    expect(rows[0].textContent).toContain("Read");

    expect(rows[1].textContent).toContain("#2");
    expect(rows[1].textContent).toContain("已完成");
    expect(rows[1].textContent).toContain("执行结果");
    expect(rows[1].textContent).toContain("已新增 6 个测试用例，全部通过。");

    expect(rows[2].textContent).toContain("#3");
    expect(rows[2].textContent).toContain("执行失败");
    expect(rows[2].textContent).toContain("错误信息");
    expect(rows[2].textContent).toContain("ECONNREFUSED 127.0.0.1:8787");

    // Interrupted event with tool status="error" must display as interrupted, not error
    expect(rows[3].textContent).toContain("已中断");
    expect(rows[3].textContent).not.toContain("执行失败");
    expect(rows[3].textContent).toContain("中断前输出");
    expect(rows[3].textContent).toContain("写入前被用户中止");

    // Unknown event with tool status="done" must display as unknown, not done
    expect(rows[4].textContent).toContain("状态未知");
    expect(rows[4].textContent).not.toContain("已完成");
    expect(rows[4].textContent).toContain("Grep");

    // Expand error card, verify full error + copy button
    const errToggle = rows[2].querySelector<HTMLButtonElement>("button")!;
    expect(errToggle.getAttribute("aria-expanded")).toBe("false");
    await act(() => user.click(errToggle));
    expect(errToggle.getAttribute("aria-expanded")).toBe("true");
    expect(rows[2].querySelector("pre")?.textContent).toBe("Error: ECONNREFUSED 127.0.0.1:8787");
    const copyBtn = [...rows[2].querySelectorAll("button")].find((b) => b.textContent?.includes("复制错误"))!;
    await act(() => user.click(copyBtn));
    expect(writeText).toHaveBeenCalledWith("Error: ECONNREFUSED 127.0.0.1:8787");
    expect(copyBtn.textContent).toContain("已复制");

    // Collapse the entire subagent panel while preserving summary badges in header
    const groupToggle = section!.querySelector<HTMLButtonElement>(":scope > button")!;
    await act(() => user.click(groupToggle));
    expect(groupToggle.getAttribute("aria-expanded")).toBe("false");
    expect(section!.querySelector("ul")).toBeNull();
    expect(groupToggle.textContent).toContain("并行子代理 (5)");
  });

  it("renders a single subagent cleanly without parallel numbering and disables expansion when no extra detail exists", () => {
    renderTools([
      {
        id: "sa-only",
        tool: "Agent",
        summary: "检查路由配置",
        status: "running",
        subagent: { status: "running" },
      },
    ]);

    const section = container.querySelector('section[aria-label="子代理任务"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("子代理任务");
    expect(section!.textContent).not.toContain("并行子代理");
    expect(section!.textContent).not.toContain("#1");
    expect(section!.textContent).not.toContain("最近活动");

    const cardToggle = section!.querySelector<HTMLButtonElement>("li button")!;
    expect(cardToggle.disabled).toBe(true);
  });

  it("keeps parallel subagents visible alongside truncated ordinary tools and updates live activity in place", () => {
    const regularTools: ChatToolEvent[] = Array.from({ length: 6 }, (_, i) => ({
      id: `t-${i}`,
      tool: "Read",
      summary: `Read: file-${i}.ts`,
      status: "done",
    }));
    const subagents: ChatToolEvent[] = [
      {
        id: "sa-1",
        tool: "Agent",
        summary: "分析后端流解析",
        status: "running",
        subagent: { status: "running", activity: "Grep" },
      },
      {
        id: "sa-2",
        tool: "Agent",
        summary: "分析前端渲染组件",
        status: "done",
        output: "已定位到 ToolChipsGroup",
        subagent: { status: "done", activity: "Read" },
      },
    ];

    renderTools([...regularTools, ...subagents], false);

    // Subagents are never hidden behind the 4-item ordinary tool truncation
    const subagentRows = container.querySelectorAll("li[data-subagent-id]");
    expect(subagentRows).toHaveLength(2);
    expect(container.textContent).toContain("已调用 6 个工具");
    expect(container.textContent).toContain("+2 更多工具调用");

    // Live transition updates activity and final result cleanly
    renderTools(
      [
        ...regularTools,
        {
          ...subagents[0],
          status: "done",
          output: "解析器无异常",
          subagent: { status: "done", activity: "Bash" },
        },
        subagents[1],
      ],
      false,
    );

    const updatedFirst = container.querySelector<HTMLLIElement>('li[data-subagent-id="sa-1"]')!;
    expect(updatedFirst.dataset.subagentStatus).toBe("done");
    expect(updatedFirst.textContent).toContain("已完成");
    expect(updatedFirst.textContent).toContain("Bash");
    expect(updatedFirst.textContent).toContain("解析器无异常");
  });

  it("stays backward-compatible with legacy historical events that lack the subagent field", async () => {
    const legacyEvents: ChatToolEvent[] = [
      { id: "old-1", tool: "Read", summary: "Read: app/lib/types.ts", status: "done" },
      { id: "old-2", tool: "Agent", summary: "Agent: 历史子代理调用", status: "done", output: "历史返回结果" },
    ];

    renderTools(legacyEvents);

    expect(container.querySelector("section")).toBeNull();
    expect(container.textContent).toContain("已调用 2 个工具");
    expect(container.textContent).toContain("历史子代理调用");

    const agentBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("历史子代理调用"),
    )!;
    await act(() => user.click(agentBtn));
    expect(container.textContent).toContain("历史返回结果");
  });

  it("reuses the corner SubagentDock and lightweight inline references across TaskAgentSessionPanel and CodexChatView", async () => {
    const events = makeSubagentEvents().slice(0, 2);
    const messages = makeMessages(events);
    const streams = new ProjectChatStreams({
      streamCodexChatMessage: vi.fn(),
      abortCodexChatSession: vi.fn(),
      getCodexChatSession: vi.fn(),
    });

    // 1) TaskAgentSessionPanel
    const taskSession = makeSession({ id: "task-sess-1", kind: "task", task_id: "task-1" });
    mockApi.getTaskAgentSession.mockResolvedValue({
      session: taskSession,
      messages: messages.map((m) => ({ ...m, session_id: taskSession.id })),
    });
    const task: TaskRecord = {
      id: "task-1",
      project_id: "proj-1",
      number: 19,
      title: "RD-19",
      body: "subagent ui",
      requirements: "",
      source: "console",
      source_url: "",
      status: "working",
      priority: "normal",
      owner: "agent",
      version: 1,
      attempts: 1,
      resolution: null,
      delivery_ref: "",
      deploy_status: "not_required",
      deployed_at: null,
      release_id: null,
      triaged_by: "",
      merged_into: null,
      agent_session_id: taskSession.id,
      agent_session_status: "idle",
      agent_session_target: "local:mac",
      created_at: "2026-11-24T10:00:00.000Z",
      updated_at: "2026-11-24T10:01:00.000Z",
      last_seen: null,
    };

    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(TaskAgentSessionPanel, { task, streams })));
      await Promise.resolve();
    });

    const taskAvatars = [...container.querySelectorAll<HTMLButtonElement>("[data-subagent-avatar]")];
    expect(taskAvatars).toHaveLength(2);
    expect(container.querySelector("[data-subagent-dock-trigger]")).toBeNull();
    expect(taskAvatars[0].dataset.subagentStatus).toBe("running");
    expect(taskAvatars[1].dataset.subagentStatus).toBe("done");
    expect(container.querySelector('section[aria-label="并行子代理任务"]')).toBeNull();

    // Hovering an avatar shows its lightweight status popover (without dumping full output)
    await act(() => user.hover(taskAvatars[0]));
    const taskHoverCard = container.querySelector<HTMLElement>("[data-subagent-hover-card]");
    expect(taskHoverCard).not.toBeNull();
    expect(taskHoverCard!.textContent).toContain("审查 server/cli-stream-parser.ts 解析逻辑");
    expect(taskHoverCard!.textContent).toContain("运行中");

    // Clicking an avatar opens the independent slide-over SubagentDetailPanel
    await act(() => user.click(taskAvatars[0]));
    const taskDetailPanel = container.querySelector<HTMLElement>("[data-subagent-detail-panel]");
    expect(taskDetailPanel).not.toBeNull();
    expect(taskDetailPanel!.textContent).toContain("审查 server/cli-stream-parser.ts 解析逻辑");

    // Escape closes the independent panel
    await act(() => user.keyboard("{Escape}"));
    expect(container.querySelector("[data-subagent-detail-panel]")).toBeNull();

    // Lightweight inline references stay inside the message
    const taskRefs = container.querySelectorAll<HTMLButtonElement>("[data-subagent-ref-trigger]");
    expect(taskRefs).toHaveLength(2);
    expect(container.textContent).toContain("审查 server/cli-stream-parser.ts 解析逻辑");
    expect(container.textContent).toContain("补充 vitest 单元测试");

    // Clicking an inline reference also opens the independent SubagentDetailPanel
    await act(() => user.click(taskRefs[0]));
    expect(container.querySelector("[data-subagent-detail-panel]")).not.toBeNull();

    // Escape closes the panel
    await act(() => user.keyboard("{Escape}"));
    expect(container.querySelector("[data-subagent-detail-panel]")).toBeNull();

    // 2) CodexChatView with cross-turn update (Turn 1 launched as unknown, Turn 2 completed it)
    const crossTurnMessages: ChatMessageRecord[] = [
      ...makeMessages([
        {
          id: "sa-cross",
          tool: "Agent",
          summary: "排查跨轮次子代理生命周期",
          status: "running",
          subagent: { status: "unknown", activity: "Read" },
        },
      ]),
      {
        id: "m-user-2",
        session_id: "chat-sess-1",
        role: "user",
        content: "继续汇报子代理结果",
        events: [],
        attachments: [],
        status: "done",
        created_at: "2026-11-24T10:02:00.000Z",
      },
      {
        id: "m-assistant-2",
        session_id: "chat-sess-1",
        role: "assistant",
        content: "子代理已完成。",
        events: [
          {
            id: "sa-cross",
            tool: "Agent",
            summary: "调用 Agent",
            status: "done",
            output: "已定位跨轮次状态丢失问题",
            subagent: { status: "done", activity: "Done" },
          },
        ],
        attachments: [],
        status: "done",
        created_at: "2026-11-24T10:03:00.000Z",
      },
    ];

    const chatSession = makeSession({ id: "chat-sess-1", kind: "chat" });
    mockApi.listCodexChatSessions.mockResolvedValue({ sessions: [chatSession] });
    mockApi.getCodexChatRuntime.mockResolvedValue({
      local_clis: { codex: true, claude: true },
      auth_mode: { codex: "local_cli", claude: "local_cli" },
      project_cli: { runtime: "claude", configured: true, endpoint: "", model: "", models: [], default_effort: "default" },
      agents: [],
    });
    mockApi.getWorkspaceSummary.mockResolvedValue({
      files_count: 0,
      databases_count: 0,
      handbook_exists: false,
      repos_status: { repos: [] },
    });
    mockApi.listWorkspaceDatabases.mockResolvedValue({ databases: [] });
    mockApi.listWorkspaceFiles.mockResolvedValue({ files: [] });
    mockApi.getCodexChatSession.mockResolvedValue({
      session: chatSession,
      messages: crossTurnMessages.map((m) => ({ ...m, session_id: chatSession.id })),
    });

    const project: ProjectDetail = {
      id: "proj-1",
      name: "Relaydesk",
      repo: "",
      repos: [],
      automation_paused: false,
      delivery_mode: "direct_push",
      target_branch: "",
      branch_prefix: "relaydesk",
      deploy_policy: {
        runtime: null,
        model: null,
        mode: "none",
        window_start: "",
        window_end: "",
        timezone: "UTC",
        allow_urgent_override: false,
        doc_path: "",
      },
      pending_deploy_count: 0,
      widget_code_context: false,
      intake_key: "",
      bot_key: "",
      agent_key: "",
      allowed_origins: [],
      agent_instructions: "",
      created_at: "2026-11-24T10:00:00.000Z",
    };

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(CodexChatView, {
            streams,
            project,
            tasks: [],
            onNewProject: vi.fn(),
            onOpenWorkspace: vi.fn(),
            onOpenCliSettings: vi.fn(),
            onTaskCreated: vi.fn(),
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const chatAvatars = [...container.querySelectorAll<HTMLButtonElement>("[data-subagent-avatar]")];
    expect(chatAvatars).toHaveLength(1);
    expect(container.querySelector("[data-subagent-dock-trigger]")).toBeNull();
    expect(chatAvatars[0].dataset.subagentStatus).toBe("done");

    // Hovering the avatar previews the lightweight status popover
    await act(() => user.hover(chatAvatars[0]));
    const chatHoverCard = container.querySelector<HTMLElement>("[data-subagent-hover-card]");
    expect(chatHoverCard).not.toBeNull();
    expect(chatHoverCard!.textContent).toContain("排查跨轮次子代理生命周期");
    expect(chatHoverCard!.textContent).toContain("已完成");
    expect(chatHoverCard!.textContent).not.toContain("已定位跨轮次状态丢失问题");

    // Clicking the avatar opens the independent detail panel with full output
    await act(() => user.click(chatAvatars[0]));
    const chatDetailPanel = container.querySelector<HTMLElement>("[data-subagent-detail-panel]");
    expect(chatDetailPanel).not.toBeNull();
    expect(chatDetailPanel!.textContent).toContain("排查跨轮次子代理生命周期");
    expect(chatDetailPanel!.textContent).toContain("已定位跨轮次状态丢失问题");

    // Clicking "跳到父消息" scrolls to the originating message and closes the panel
    const originMsg = container.querySelector<HTMLElement>('[data-message-id="m-assistant"]')!;
    const scrollIntoView = vi.fn();
    originMsg.scrollIntoView = scrollIntoView;
    const jumpBtn = [...chatDetailPanel!.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("跳到父消息"),
    )!;
    await act(() => user.click(jumpBtn));
    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector("[data-subagent-detail-panel]")).toBeNull();

    // Inline reference in the earlier message reflects the live merged status ("done"), not stale "unknown"
    const inlineRefs = [...container.querySelectorAll<HTMLButtonElement>("[data-subagent-ref-trigger]")];
    expect(inlineRefs).toHaveLength(2);
    expect(inlineRefs[0].dataset.subagentStatus).toBe("done");
    expect(inlineRefs[0].textContent).toContain("派发子代理");
    expect(inlineRefs[0].textContent).toContain("排查跨轮次子代理生命周期");
    expect(inlineRefs[1].textContent).toContain("子代理更新");

    // Clicking an inline reference opens the independent detail panel
    await act(() => user.click(inlineRefs[0]));
    expect(container.querySelector("[data-subagent-detail-panel]")).not.toBeNull();
    await act(() => user.keyboard("{Escape}"));
    expect(container.querySelector("[data-subagent-detail-panel]")).toBeNull();
  });

  it("renders zero dock DOM when a session has no subagents and aggregates cross-turn states accurately", async () => {
    const summary = aggregateSessionSubagents([
      {
        id: "m1",
        session_id: "s1",
        role: "assistant",
        content: "",
        events: [
          { id: "a1", tool: "Agent", summary: "任务 A", status: "running", subagent: { status: "running", activity: "Read" } },
          { id: "a2", tool: "Agent", summary: "任务 B", status: "running", subagent: { status: "running" } },
        ],
        attachments: [],
        status: "aborted",
        created_at: "2026-11-24T10:00:00.000Z",
      },
      {
        id: "m2",
        session_id: "s1",
        role: "assistant",
        content: "",
        events: [
          { id: "a1", tool: "Agent", summary: "调用 Agent", status: "done", output: "A 完成", subagent: { status: "done" } },
          { id: "a3", tool: "Agent", summary: "任务 C", status: "running", subagent: { status: "running" } },
        ],
        attachments: [],
        status: "streaming",
        created_at: "2026-11-24T10:01:00.000Z",
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.counts).toEqual({ running: 1, done: 1, error: 0, interrupted: 1, unknown: 0 });
    // Running subagent sorted first, then newer turn (a1), then earlier turn (a2)
    expect(summary.items.map((i) => i.id)).toEqual(["a3", "a1", "a2"]);
    expect(summary.byId.get("a1")?.sourceMessageId).toBe("m1");
    expect(summary.byId.get("a1")?.latestMessageId).toBe("m2");
    expect(summary.byId.get("a1")?.event.summary).toBe("任务 A");
    expect(summary.byId.get("a2")?.status).toBe("interrupted");

    const streams = new ProjectChatStreams({
      streamCodexChatMessage: vi.fn(),
      abortCodexChatSession: vi.fn(),
      getCodexChatSession: vi.fn(),
    });
    const taskSession = makeSession({ id: "task-sess-empty", kind: "task", task_id: "task-empty" });
    mockApi.getTaskAgentSession.mockResolvedValue({
      session: taskSession,
      messages: makeMessages([{ id: "r1", tool: "Read", summary: "Read: a.ts", status: "done" }]),
    });
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(TaskAgentSessionPanel, {
            task: {
              id: "task-empty",
              project_id: "proj-1",
              number: 20,
              title: "No subagents",
              body: "",
              requirements: "",
              source: "console",
              source_url: "",
              status: "working",
              priority: "normal",
              owner: "agent",
              version: 1,
              attempts: 1,
              resolution: null,
              delivery_ref: "",
              deploy_status: "not_required",
              deployed_at: null,
              release_id: null,
              triaged_by: "",
              merged_into: null,
              agent_session_id: taskSession.id,
              agent_session_status: "idle",
              agent_session_target: "local:mac",
              created_at: "2026-11-24T10:00:00.000Z",
              updated_at: "2026-11-24T10:01:00.000Z",
              last_seen: null,
            },
            streams,
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(container.querySelector("[data-subagent-dock]")).toBeNull();
  });

  it("renders frameless stacked bot avatars as lightweight entry points with status-only hover popover", async () => {
    const events: ChatToolEvent[] = [
      ...makeSubagentEvents(),
      {
        id: "sa-extra",
        tool: "delegate:agy",
        summary: "检查静态资源体积",
        status: "done",
        output: "总计 59KB",
        subagent: {
          status: "done",
          activity: "Done",
          session_id: "child-sess-1",
          runtime: "agy",
          model: "gemini-3-pro",
          delegated: true,
        },
      },
    ];
    const summary = aggregateSessionSubagents(makeMessages(events));
    const onSelectSubagent = vi.fn();
    const renderDock = (selectedId: string | null = null) => {
      root.render(
        createElement(SubagentDock, {
          summary,
          selectedId,
          onSelectSubagent,
          align: "left",
        }),
      );
    };

    act(() => renderDock());

    // Shows up to 5 visible stacked avatars + "+1" overflow counter, without an outer summary capsule trigger
    expect(container.querySelector("[data-subagent-dock-trigger]")).toBeNull();
    const avatarBtns = [...container.querySelectorAll<HTMLButtonElement>("[data-subagent-avatar]")];
    expect(avatarBtns).toHaveLength(5);
    expect(container.querySelector("[data-subagent-avatar-stack]")?.textContent).toContain("+1");
    const imgs = avatarBtns.map((b) => b.querySelector("img")?.getAttribute("src"));
    expect(imgs.every((src) => src?.startsWith("/images/subagents/") && src.endsWith(".webp"))).toBe(true);
    expect(new Set(imgs).size).toBe(5);

    // Hovering an avatar reveals the lightweight status-only popover (task + status + activity, no bulky output dump)
    await act(() => user.hover(avatarBtns[0]));
    const hoverCard1 = container.querySelector<HTMLElement>("[data-subagent-hover-card]");
    expect(hoverCard1).not.toBeNull();
    expect(hoverCard1!.dataset.subagentHoverId).toBe(avatarBtns[0].dataset.subagentAvatar);
    expect(hoverCard1!.textContent).toContain("审查 server/cli-stream-parser.ts 解析逻辑");
    expect(hoverCard1!.textContent).toContain("运行中");
    expect(hoverCard1!.textContent).toContain("Read");

    // Hovering the second avatar transitions the popover without dumping full output
    await act(() => user.hover(avatarBtns[1]));
    const hoverCard2 = container.querySelector<HTMLElement>("[data-subagent-hover-card]");
    expect(hoverCard2).not.toBeNull();
    expect(hoverCard2!.dataset.subagentHoverId).toBe(avatarBtns[1].dataset.subagentAvatar);
    expect(hoverCard2!.textContent).toContain("补充 vitest 单元测试");
    expect(hoverCard2!.textContent).toContain("已完成");
    expect(hoverCard2!.textContent).not.toContain("已新增 6 个测试用例，全部通过。");

    // Clicking an avatar invokes onSelectSubagent to open the independent panel
    await act(() => user.click(avatarBtns[1]));
    expect(onSelectSubagent).toHaveBeenCalledWith(avatarBtns[1].dataset.subagentAvatar);
    expect(container.querySelector("[data-subagent-hover-card]")).toBeNull();

    // Clicking "+1" overflow badge selects the first overflow subagent for the independent panel
    const overflowBtn = container.querySelector<HTMLButtonElement>("[data-subagent-overflow-trigger]")!;
    await act(() => user.click(overflowBtn));
    expect(onSelectSubagent).toHaveBeenCalledWith(summary.items[5].id);
  });
});
