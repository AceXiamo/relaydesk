// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import {
  DIAGNOSE_MAX_MESSAGE_CHARS,
  DIAGNOSE_MAX_MESSAGES,
  DIAGNOSE_MAX_TOTAL_CHARS,
  normalizeDiagnosePayload,
} from "../app/lib/feedback-diagnose.ts";
import { PortalFeedbackConversation } from "../app/components/PortalFeedbackConversation.tsx";
import { FeedbackAgentSettingsCard } from "../app/components/FeedbackAgentSettingsCard.tsx";
import { ToastProvider } from "../app/components/ui.tsx";
import type { PortalConfig, PortalTaskDetail } from "../app/lib/portal-types.ts";
import type { ProjectDetail } from "../app/lib/types.ts";

const mockApi = vi.hoisted(() => ({
  getProjectFeedbackAgent: vi.fn(),
  updateProjectFeedbackAgent: vi.fn(),
  getProjectExecutionRouting: vi.fn(),
}));

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

vi.mock("../app/components/MarkdownContent.tsx", () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    createElement("div", { "data-markdown": "1" }, content),
}));

vi.mock("../app/lib/api.ts", () => ({
  ClientApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  api: mockApi,
}));

function setReactValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("normalizeDiagnosePayload", () => {
  it("merges consecutive user messages after stop or failure into strictly alternating turns", () => {
    const res = normalizeDiagnosePayload([
      { role: "user", text: "第一条尝试" },
      { role: "user", text: "停止后补充的第二条" },
      { role: "assistant", text: "收到，请说明浏览器版本" },
      { role: "user", text: "Chrome 130" },
      { role: "user", text: "以及 macOS 15" },
    ]);
    expect(res.messages).toEqual([
      { role: "user", text: "第一条尝试\n\n停止后补充的第二条" },
      { role: "assistant", text: "收到，请说明浏览器版本" },
      { role: "user", text: "Chrome 130\n\n以及 macOS 15" },
    ]);
    expect(res.trimmedHistory).toBe(false);
    expect(res.clampedMessage).toBe(false);
  });

  it("smoothly trims history beyond 25 messages while keeping alternation and newest user turn", () => {
    const raw = [];
    for (let i = 0; i < 15; i += 1) {
      raw.push({ role: "user" as const, text: `用户问题 ${i}` });
      if (i < 14) {
        raw.push({ role: "assistant" as const, text: `助手回复 ${i}` });
      }
    }
    expect(raw).toHaveLength(29);
    const res = normalizeDiagnosePayload(raw);
    expect(res.messages).toHaveLength(DIAGNOSE_MAX_MESSAGES);
    expect(res.trimmedHistory).toBe(true);
    expect(res.messages[0]?.role).toBe("user");
    expect(res.messages.at(-1)).toEqual({ role: "user", text: "用户问题 14" });
    for (let i = 0; i < res.messages.length; i += 1) {
      expect(res.messages[i]?.role).toBe(i % 2 === 0 ? "user" : "assistant");
    }
  });

  it("clamps oversized single messages to <= 6000 chars and caps total chars to <= 32000", () => {
    const huge = `${"HEAD_".repeat(500)}${"M".repeat(6000)}TAIL_END`;
    const single = normalizeDiagnosePayload([{ role: "user", text: huge }]);
    expect(single.clampedMessage).toBe(true);
    expect(single.messages[0]!.text.length).toBeLessThanOrEqual(
      DIAGNOSE_MAX_MESSAGE_CHARS,
    );
    expect(single.messages[0]!.text.startsWith("HEAD_")).toBe(true);
    expect(single.messages[0]!.text.endsWith("TAIL_END")).toBe(true);

    const manyLong = [];
    for (let i = 0; i < 9; i += 1) {
      manyLong.push({ role: "user" as const, text: `U${i}-` + "a".repeat(4500) });
      if (i < 8) {
        manyLong.push({
          role: "assistant" as const,
          text: `A${i}-` + "b".repeat(4500),
        });
      }
    }
    const capped = normalizeDiagnosePayload(manyLong);
    const total = capped.messages.reduce((s, m) => s + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(DIAGNOSE_MAX_TOTAL_CHARS);
    expect(capped.messages[0]?.role).toBe("user");
    expect(capped.messages.at(-1)?.role).toBe("user");
    expect(capped.trimmedHistory).toBe(true);
  });

  it("sanitizes image URLs and drops query/hash/credential links", () => {
    const res = normalizeDiagnosePayload(
      [{ role: "user", text: "截图如下" }],
      [
        "https://cdn.example.com/a.png",
        "https://cdn.example.com/a.png",
        "https://cdn.example.com/b.png?sig=secret",
        "https://user:pass@cdn.example.com/c.png",
        "https://cdn.example.com/d.png#frag",
        "javascript:alert(1)",
        "https://cdn.example.com/e.webp",
      ],
    );
    expect(res.images).toEqual([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/e.webp",
    ]);
  });
});

describe("PortalFeedbackConversation UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  const baseConfig: PortalConfig = {
    project_name: "RelayDesk Demo",
    label: "Tester",
    can_view_team: true,
    can_request_deploy: false,
    upload_enabled: true,
    ai_enabled: true,
    agent_enabled: true,
    release_window: "",
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("handles clarify -> usage (0 tasks) -> suspected_bug draft edit -> explicit confirm", async () => {
    let turn = 0;
    const onDiagnose = vi.fn(async () => {
      turn += 1;
      if (turn === 1) {
        return { reply: "请补充触发页面与操作步骤。", outcome: "clarify" as const };
      }
      if (turn === 2) {
        return {
          reply: "请先在设置中启用通知开关即可恢复。",
          outcome: "usage" as const,
        };
      }
      return {
        reply: "开启后仍无法推送属于疑似缺陷，请核对草稿后确认提交。",
        outcome: "suspected_bug" as const,
        draft: {
          title: "通知开关开启后仍不推送",
          body: "已在设置中启用通知，但保存后未收到任何提醒。",
        },
      };
    });

    const onCreateTask = vi.fn(
      async (payload): Promise<PortalTaskDetail> => ({
        task: {
          id: "t-1",
          code: "RD-101",
          title: payload.title,
          owned: true,
          created_at: new Date().toISOString(),
          status_label: "已提交，等待处理",
          can_reply: false,
          can_request_deploy: false,
          can_accept: false,
        },
        messages: [],
        gate: null,
      }),
    );

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(PortalFeedbackConversation, {
            config: baseConfig,
            stagedImages: [],
            onUploadFiles: vi.fn(async () => {}),
            onRemoveStagedImage: vi.fn(),
            onClearStagedImages: vi.fn(),
            onOpenLightbox: vi.fn(),
            onDiagnose,
            onCreateTask,
            onSwitchToManual: vi.fn(),
            onPossibleAuthError: () => false,
          }),
        ),
      );
    });

    const sendMsg = async (text: string) => {
      const input = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="portal-agent-input"]',
      )!;
      await act(async () => {
        setReactValue(input, text);
      });
      const btn = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-agent-send"]',
      )!;
      await act(async () => {
        btn.click();
      });
    };

    await sendMsg("收不到通知");
    expect(
      container.querySelector('[data-testid="portal-turn-assistant"][data-outcome="clarify"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="portal-bug-draft-card"]')).toBeNull();

    await sendMsg("我还没打开通知开关");
    expect(
      container.querySelector('[data-testid="portal-turn-assistant"][data-outcome="usage"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="portal-bug-draft-card"]')).toBeNull();
    expect(onCreateTask).not.toHaveBeenCalled();

    await sendMsg("打开开关保存后依然收不到通知");
    expect(
      container.querySelector(
        '[data-testid="portal-turn-assistant"][data-outcome="suspected_bug"]',
      ),
    ).not.toBeNull();
    const draftCard = container.querySelector('[data-testid="portal-bug-draft-card"]');
    expect(draftCard).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-draft-title-preview"]')?.textContent,
    ).toBe("通知开关开启后仍不推送");
    expect(onCreateTask).not.toHaveBeenCalled();

    // Expand compact draft card to edit title before explicit confirmation
    const expandBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-draft-toggle-edit"]',
    )!;
    await act(async () => {
      expandBtn.click();
    });

    const titleEl = container.querySelector<HTMLInputElement>(
      '[data-testid="portal-draft-title"]',
    )!;
    expect(titleEl.value).toBe("通知开关开启后仍不推送");
    await act(async () => {
      setReactValue(titleEl, "通知开关开启后仍不推送（已验证）");
    });

    const confirmBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-draft-confirm"]',
    )!;
    await act(async () => {
      confirmBtn.click();
    });

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "通知开关开启后仍不推送（已验证）",
        type: "功能异常",
      }),
    );
  });

  it("streams status and delta tokens incrementally before finalizing outcome", async () => {
    const onDiagnose = vi.fn(async (_payload, _signal, onEvent) => {
      onEvent?.({ type: "status", label: "正在读取项目配置与代码…" });
      onEvent?.({ type: "delta", text: "请先开启通知权限，" });
      onEvent?.({ type: "delta", text: "保存后即可生效。" });
      return {
        reply: "请先开启通知权限，保存后即可生效。",
        outcome: "usage" as const,
      };
    });

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(PortalFeedbackConversation, {
            config: { ...baseConfig, agent_available: true },
            stagedImages: [],
            onUploadFiles: vi.fn(async () => {}),
            onRemoveStagedImage: vi.fn(),
            onClearStagedImages: vi.fn(),
            onOpenLightbox: vi.fn(),
            onDiagnose,
            onCreateTask: vi.fn(),
            onSwitchToManual: vi.fn(),
            onPossibleAuthError: () => false,
          }),
        ),
      );
    });

    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="portal-agent-input"]',
    )!;
    await act(async () => {
      setReactValue(input, "为什么没有推送提醒");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-agent-send"]')!
        .click();
    });

    const replyTurn = container.querySelector(
      '[data-testid="portal-turn-assistant"][data-outcome="usage"]',
    );
    expect(replyTurn).not.toBeNull();
    expect(replyTurn?.textContent).toContain("请先开启通知权限，保存后即可生效。");
    expect(container.querySelector('[data-testid="portal-bug-draft-card"]')).toBeNull();
  });

  it("merges consecutive user messages cleanly when user follows up after an abort or error", async () => {
    const receivedPayloads: Array<{ messages: Array<{ role: string; text: string }> }> = [];
    let call = 0;
    const onDiagnose = vi.fn(async (payload) => {
      receivedPayloads.push(payload);
      call += 1;
      if (call === 1) {
        throw new DOMException("Aborted", "AbortError");
      }
      return { reply: "已合并你的补充说明，请继续确认复现步骤。", outcome: "clarify" as const };
    });

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(PortalFeedbackConversation, {
            config: baseConfig,
            stagedImages: [],
            onUploadFiles: vi.fn(async () => {}),
            onRemoveStagedImage: vi.fn(),
            onClearStagedImages: vi.fn(),
            onOpenLightbox: vi.fn(),
            onDiagnose,
            onCreateTask: vi.fn(),
            onSwitchToManual: vi.fn(),
            onPossibleAuthError: () => false,
          }),
        ),
      );
    });

    const sendMsg = async (text: string) => {
      const input = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="portal-agent-input"]',
      )!;
      await act(async () => {
        setReactValue(input, text);
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="portal-agent-send"]')!
          .click();
      });
    };

    await sendMsg("第一次描述被取消");
    expect(
      container.querySelector('[data-testid="portal-diagnose-error"]')?.textContent,
    ).toContain("已停止本轮排查");

    await sendMsg("补充具体报错 500");
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1]?.messages).toEqual([
      { role: "user", text: "第一次描述被取消\n\n补充具体报错 500" },
    ]);
    expect(
      container.querySelector('[data-testid="portal-turn-assistant"][data-outcome="clarify"]'),
    ).not.toBeNull();
  });

  it("renders streaming and settled thinking trace and toggles reasoning visibility", async () => {
    let resolveDiagnose!: (res: {
      reply: string;
      outcome: "usage";
      reasoning: string;
    }) => void;
    let emitStream!: (ev: { type: "status"; label: string } | { type: "reasoning"; text: string } | { type: "delta"; text: string }) => void;

    const onDiagnose = vi.fn().mockImplementation(
      (
        _payload: unknown,
        _signal?: AbortSignal,
        onEvent?: typeof emitStream,
      ) => {
        emitStream = onEvent!;
        return new Promise((resolve) => {
          resolveDiagnose = resolve;
        });
      },
    );

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(PortalFeedbackConversation, {
            projectId: "proj-trace-test",
            config: baseConfig,
            stagedImages: [],
            onUploadFiles: vi.fn(),
            onRemoveStagedImage: vi.fn(),
            onClearStagedImages: vi.fn(),
            onOpenLightbox: vi.fn(),
            onDiagnose,
            onCreateTask: vi.fn(),
            onSwitchToManual: vi.fn(),
            onPossibleAuthError: () => false,
          }),
        ),
      );
    });

    const input = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="portal-agent-input"]',
    )!;
    await act(async () => {
      setReactValue(input, "为什么无法保存设置？");
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-agent-send"]')!
        .click();
    });

    // Stream status & reasoning: trace auto-expands during active reasoning
    await act(async () => {
      emitStream({ type: "status", label: "正在查阅产品实现…" });
      emitStream({ type: "reasoning", text: "先检查设置表单的提交状态和权限校验。" });
    });

    expect(
      container.querySelector('[data-testid="portal-thinking-reasoning"]')?.textContent,
    ).toContain("先检查设置表单的提交状态和权限校验。");

    // Stream answer & finish: trace settles and auto-collapses
    await act(async () => {
      emitStream({ type: "delta", text: "请先在右上角点击保存按钮。" });
      resolveDiagnose({
        reply: "请先在右上角点击保存按钮。",
        outcome: "usage",
        reasoning: "先检查设置表单的提交状态和权限校验。",
      });
    });

    const trace = container.querySelector('[data-testid="portal-thinking-trace"]')!;
    expect(trace.getAttribute("data-state")).toBe("settled");
    expect(
      container.querySelector('[data-testid="portal-thinking-content"]'),
    ).toBeNull();

    // Clicking toggle expands the saved reasoning and steps
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-thinking-toggle"]')!
        .click();
    });
    expect(
      container.querySelector('[data-testid="portal-thinking-reasoning"]')?.textContent,
    ).toContain("先检查设置表单的提交状态和权限校验。");
  });

  it("persists conversations across remount and supports history switching and deletion", async () => {
    window.localStorage.clear();
    const projectId = "proj-persist-test";
    const onDiagnose = vi
      .fn()
      .mockImplementationOnce(async (_p, _s, onEvent) => {
        onEvent?.({ type: "reasoning", text: "第一段推理链内容" });
        return {
          reply: "第一段助手回复",
          outcome: "clarify" as const,
          reasoning: "第一段推理链内容",
        };
      })
      .mockImplementationOnce(async (_p, _s, onEvent) => {
        onEvent?.({ type: "reasoning", text: "第二段推理链内容" });
        return {
          reply: "第二段助手回复",
          outcome: "usage" as const,
          reasoning: "第二段推理链内容",
        };
      });

    const renderPortal = async () => {
      await act(async () => {
        root.render(
          createElement(
            ToastProvider,
            null,
            createElement(PortalFeedbackConversation, {
              projectId,
              config: baseConfig,
              stagedImages: [],
              onUploadFiles: vi.fn(),
              onRemoveStagedImage: vi.fn(),
              onClearStagedImages: vi.fn(),
              onOpenLightbox: vi.fn(),
              onDiagnose,
              onCreateTask: vi.fn(),
              onSwitchToManual: vi.fn(),
              onPossibleAuthError: () => false,
            }),
          ),
        );
      });
    };

    const sendMsg = async (text: string) => {
      const input = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="portal-agent-input"]',
      )!;
      await act(async () => {
        setReactValue(input, text);
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="portal-agent-send"]')!
          .click();
      });
    };

    await renderPortal();
    await sendMsg("第一次提问：导出失败");
    expect(container.textContent).toContain("第一段助手回复");

    // Unmount and remount (simulating page reload or returning to feedback center)
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderPortal();

    // Previous conversation + thinking trace are automatically restored
    expect(container.textContent).toContain("第一次提问：导出失败");
    expect(container.textContent).toContain("第一段助手回复");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-thinking-toggle"]')!
        .click();
    });
    expect(
      container.querySelector('[data-testid="portal-thinking-reasoning"]')?.textContent,
    ).toContain("第一段推理链内容");

    // Start a new conversation (preserves the first one in history)
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-new-conversation"]')!
        .click();
    });
    expect(container.querySelectorAll('[data-testid="portal-turn-user"]')).toHaveLength(0);

    await sendMsg("第二次提问：如何配置通知");
    expect(container.textContent).toContain("第二段助手回复");

    // Open history popover and switch back to the first conversation
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-history-toggle"]')!
        .click();
    });
    const historyItems = container.querySelectorAll('[data-testid="portal-history-item"]');
    expect(historyItems).toHaveLength(2);

    const firstHistoryBtn = Array.from(historyItems)
      .find((el) => el.textContent?.includes("第一次提问：导出失败"))!
      .querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      firstHistoryBtn.click();
    });

    expect(container.textContent).toContain("第一段助手回复");
    expect(container.textContent).not.toContain("第二段助手回复");

    // Delete the active conversation from history
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="portal-history-toggle"]')!
        .click();
    });
    const activeDeleteBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-history-item"][data-active="true"] [data-testid="portal-history-delete"]',
    )!;
    await act(async () => {
      activeDeleteBtn.click();
    });

    expect(container.querySelectorAll('[data-testid="portal-history-item"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="portal-turn-user"]')).toHaveLength(0);
    window.localStorage.clear();
  });
});

describe("FeedbackAgentSettingsCard UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  const project = {
    id: "proj-1",
    name: "Demo",
    slug: "demo",
    repo: "acme/demo",
    default_branch: "main",
    created_at: new Date().toISOString(),
  } as unknown as ProjectDetail;

  const mockAgents = [
    {
      id: "agent-mac",
      name: "MacBook Pro",
      online: true,
      active_runs: 0,
      max_concurrency: 2,
      accept_cli_runs: true,
      platform: "darwin",
      hostname: "mbp",
      bridge_version: "1.0.0",
      capabilities: {},
      last_seen_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      bindings: [
        {
          id: "bind-1",
          agent_id: "agent-mac",
          project_id: "proj-1",
          workdir: "/Users/dev/demo",
          allow_datasource_secrets: false,
          enabled: true,
          path_ok: true,
          git_ok: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      runtimes: {
        codex: { available: true, default_model: "gpt-5.3-codex" },
        claude: { available: true, default_model: "claude-sonnet-4-6" },
      },
      models: [
        {
          id: "gpt-5.3-codex",
          label: "GPT-5.3 Codex",
          runtime: "codex",
          is_default: true,
        },
        {
          id: "claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          runtime: "claude",
          is_default: true,
        },
      ],
    },
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("loads local bridge agents and saves execution_target, runtime, model, effort, and system_prompt", async () => {
    mockApi.getProjectFeedbackAgent.mockResolvedValue({
      enabled: false,
      available: false,
      execution_target: "auto",
      runtime: "codex",
      model: "",
      reasoning_effort: "default",
      system_prompt: "初始系统提示词",
      resolved_agent: {
        id: "agent-mac",
        name: "MacBook Pro",
        online: true,
        model: "gpt-5.3-codex",
      },
      unavailable_reason: null,
    });
    mockApi.getProjectExecutionRouting.mockResolvedValue({
      routing: {
        priority: ["local:agent-mac"],
        auto_fallback: false,
        route_cli_runs: true,
        auto_dispatch_tasks: false,
        task_network_access: false,
      },
      effective_priority: ["local:agent-mac"],
      agents: mockAgents,
    });
    mockApi.updateProjectFeedbackAgent.mockResolvedValue({
      enabled: true,
      available: true,
      execution_target: "local:agent-mac",
      runtime: "claude",
      model: "",
      reasoning_effort: "default",
      system_prompt: "只读排查并面向终端用户回答",
      resolved_agent: {
        id: "agent-mac",
        name: "MacBook Pro",
        online: true,
        model: "claude-sonnet-4-6",
      },
      unavailable_reason: null,
    });

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(FeedbackAgentSettingsCard, { project }),
        ),
      );
    });

    await vi.waitFor(() =>
      expect(mockApi.getProjectFeedbackAgent).toHaveBeenCalledWith("proj-1"),
    );
    await vi.waitFor(() =>
      expect(mockApi.getProjectExecutionRouting).toHaveBeenCalledWith("proj-1"),
    );

    // Select specific local computer node
    const targetTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="反馈诊断执行节点"]',
    )!;
    await act(async () => {
      targetTrigger.click();
    });
    const macOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent?.includes("MacBook Pro") && el.textContent?.includes("在线 · 已绑定"),
    )!;
    await act(async () => {
      macOption.click();
    });

    // Switch harness to Claude Code
    const runtimeTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="反馈诊断 Harness"]',
    )!;
    await act(async () => {
      runtimeTrigger.click();
    });
    const claudeOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent?.includes("Claude Code"),
    )!;
    await act(async () => {
      claudeOption.click();
    });

    // Edit System Prompt
    const promptTextarea = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="feedback-agent-system-prompt"]',
    )!;
    await act(async () => {
      setReactValue(promptTextarea, "只读排查并面向终端用户回答");
    });

    // Enable switch
    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => {
      toggle.click();
    });

    // Submit form
    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存配置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(mockApi.updateProjectFeedbackAgent).toHaveBeenCalledWith("proj-1", {
      enabled: true,
      execution_target: "local:agent-mac",
      runtime: "claude",
      model: "",
      reasoning_effort: "default",
      system_prompt: "只读排查并面向终端用户回答",
    });

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="feedback-agent-status-pill"]')?.textContent,
      ).toContain("在线 · MacBook Pro"),
    );
  });

  it("displays honest offline status pill when enabled but local node is offline", async () => {
    mockApi.getProjectFeedbackAgent.mockResolvedValue({
      enabled: true,
      available: false,
      execution_target: "local:agent-mac",
      runtime: "codex",
      model: "",
      reasoning_effort: "default",
      system_prompt: "",
      resolved_agent: {
        id: "agent-mac",
        name: "MacBook Pro",
        online: false,
        model: "gpt-5.3-codex",
      },
      unavailable_reason: "MacBook Pro 当前离线",
    });
    mockApi.getProjectExecutionRouting.mockResolvedValue({
      routing: {
        priority: ["local:agent-mac"],
        auto_fallback: false,
        route_cli_runs: true,
        auto_dispatch_tasks: false,
        task_network_access: false,
      },
      effective_priority: ["local:agent-mac"],
      agents: [{ ...mockAgents[0], online: false }],
    });

    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(FeedbackAgentSettingsCard, { project }),
        ),
      );
    });

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="feedback-agent-status-pill"]')?.textContent,
      ).toContain("MacBook Pro 当前离线"),
    );
  });
});
