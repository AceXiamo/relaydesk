// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexChatView } from "../app/components/CodexChatView.tsx";
import { ToastProvider } from "../app/components/ui.tsx";
import { ProjectChatStreams } from "../app/lib/chat-streams.ts";
import type { ChatMessageRecord, ChatSessionRecord, ProjectDetail } from "../app/lib/types.ts";

const mockApi = vi.hoisted(() => ({
  listCodexChatSessions: vi.fn(),
  getCodexChatRuntime: vi.fn(),
  getWorkspaceSummary: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  getCodexChatSession: vi.fn(),
  createCodexChatSession: vi.fn(),
  streamCodexChatMessage: vi.fn(),
  subscribeCodexChatStream: vi.fn(),
  abortCodexChatSession: vi.fn(),
  updateCodexChatSession: vi.fn(),
  deleteCodexChatSession: vi.fn(),
  regenerateCodexChatSessionTitle: vi.fn(),
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

function makeProject(): ProjectDetail {
  return {
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
}

function makeSession(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    id: "sess-1",
    project_id: "proj-1",
    kind: "chat",
    task_id: null,
    release_id: null,
    title: "测试会话",
    runtime: "codex",
    model: "gpt-5.4",
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

describe("CodexChatView empty state and quick-reply removal", () => {
  let root: Root;
  let container: HTMLElement;
  const user = userEvent.setup();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.body.appendChild(document.createElement("main"));
    root = createRoot(container);

    mockApi.getCodexChatRuntime.mockResolvedValue({
      local_clis: { codex: true, claude: true },
      auth_mode: { codex: "local_cli", claude: "local_cli" },
      project_cli: {
        runtime: "codex",
        configured: true,
        endpoint: "",
        model: "gpt-5.4",
        models: [],
        default_effort: "default",
      },
      agents: [],
    });
    mockApi.getWorkspaceSummary.mockResolvedValue({
      files_count: 2,
      databases_count: 1,
      handbook_exists: true,
      repos_status: { repos: [{ id: "r1", ready: true }] },
    });
    mockApi.listWorkspaceDatabases.mockResolvedValue({ databases: [] });
    mockApi.listWorkspaceFiles.mockResolvedValue({ files: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderChatView(streams: ProjectChatStreams) {
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(CodexChatView, {
            streams,
            project: makeProject(),
            tasks: [],
            onNewProject: vi.fn(),
            onOpenWorkspace: vi.fn(),
            onOpenCliSettings: vi.fn(),
            onTaskCreated: vi.fn(),
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders a playful transparent illustration in the empty state instead of starter prompts and cycles on click without sending", async () => {
    mockApi.listCodexChatSessions.mockResolvedValue({ sessions: [] });

    const streams = new ProjectChatStreams({
      streamCodexChatMessage: mockApi.streamCodexChatMessage,
      abortCodexChatSession: mockApi.abortCodexChatSession,
      getCodexChatSession: mockApi.getCodexChatSession,
      subscribeCodexChatStream: mockApi.subscribeCodexChatStream,
    });
    const sendSpy = vi.spyOn(streams, "send");

    await renderChatView(streams);

    expect(container.textContent).not.toContain("快速开始");
    expect(container.textContent).not.toContain("盘点项目空间上下文");

    const trigger = container.querySelector<HTMLButtonElement>("[data-empty-chat-illustration]");
    expect(trigger).not.toBeNull();
    const firstScene = trigger!.dataset.emptyChatIllustration;
    const firstImg = trigger!.querySelector<HTMLImageElement>("img");
    expect(firstImg).not.toBeNull();
    expect(firstImg!.getAttribute("src")).toMatch(/^\/images\/chat\/empty-.*\.webp$/);
    const firstSrc = firstImg!.getAttribute("src");

    await act(() => user.click(trigger!));

    const updatedTrigger = container.querySelector<HTMLButtonElement>("[data-empty-chat-illustration]");
    expect(updatedTrigger).not.toBeNull();
    expect(updatedTrigger!.dataset.emptyChatIllustration).not.toBe(firstScene);
    const secondImg = updatedTrigger!.querySelector<HTMLImageElement>("img");
    expect(secondImg!.getAttribute("src")).toMatch(/^\/images\/chat\/empty-.*\.webp$/);
    expect(secondImg!.getAttribute("src")).not.toBe(firstSrc);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(mockApi.createCodexChatSession).not.toHaveBeenCalled();
  });

  it("does not render contextual follow-up quick replies after a completed assistant turn", async () => {
    const session = makeSession({ id: "sess-done", kind: "chat" });
    const messages: ChatMessageRecord[] = [
      {
        id: "m-user-1",
        session_id: session.id,
        role: "user",
        content: "检查一下代码结构",
        events: [],
        attachments: [],
        status: "done",
        created_at: "2026-11-24T10:00:00.000Z",
      },
      {
        id: "m-assistant-1",
        session_id: session.id,
        role: "assistant",
        content: "已完成检查。\n\n```ts\nexport const ready = true;\n```",
        events: [
          {
            id: "ev-read-1",
            tool: "Read",
            summary: "Read: app/routes/home.tsx",
            status: "done",
          },
        ],
        attachments: [],
        status: "done",
        created_at: "2026-11-24T10:01:00.000Z",
      },
    ];

    mockApi.listCodexChatSessions.mockResolvedValue({ sessions: [session] });
    mockApi.getCodexChatSession.mockResolvedValue({ session, messages });

    const streams = new ProjectChatStreams({
      streamCodexChatMessage: mockApi.streamCodexChatMessage,
      abortCodexChatSession: mockApi.abortCodexChatSession,
      getCodexChatSession: mockApi.getCodexChatSession,
      subscribeCodexChatStream: mockApi.subscribeCodexChatStream,
    });
    streams.select(session.id);

    await renderChatView(streams);

    expect(container.textContent).toContain("已完成检查");
    expect(container.textContent).not.toContain("继续追问");
    expect(container.textContent).not.toContain("展开关键证据与文件位置");
    expect(container.textContent).not.toContain("补充边界情况与验证步骤");
    expect(container.textContent).not.toContain("整理为可执行的下一步清单");
  });
});
