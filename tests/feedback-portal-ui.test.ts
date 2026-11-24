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
  getProjectCliConfig: vi.fn(),
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
        '[data-testid="portal-chat-input"]',
      )!;
      await act(async () => {
        setReactValue(input, text);
      });
      const btn = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-chat-send"]',
      )!;
      await act(async () => {
        btn.click();
      });
    };

    await sendMsg("收不到通知");
    expect(container.querySelector('[data-testid="portal-outcome-clarify"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="portal-draft-card"]')).toBeNull();

    await sendMsg("我还没打开通知开关");
    expect(container.querySelector('[data-testid="portal-outcome-usage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="portal-draft-card"]')).toBeNull();
    expect(onCreateTask).not.toHaveBeenCalled();

    await sendMsg("打开开关保存后依然收不到通知");
    expect(
      container.querySelector('[data-testid="portal-outcome-suspected_bug"]'),
    ).not.toBeNull();
    const draftCard = container.querySelector('[data-testid="portal-draft-card"]');
    expect(draftCard).not.toBeNull();
    expect(onCreateTask).not.toHaveBeenCalled();

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
        '[data-testid="portal-chat-input"]',
      )!;
      await act(async () => {
        setReactValue(input, text);
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="portal-chat-send"]')!
          .click();
      });
    };

    await sendMsg("第一次描述被取消");
    expect(
      container.querySelector('[data-testid="portal-diagnose-error"]')?.textContent,
    ).toContain("已取消本轮诊断");

    await sendMsg("补充具体报错 500");
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1]?.messages).toEqual([
      { role: "user", text: "第一次描述被取消\n\n补充具体报错 500" },
    ]);
    expect(container.querySelector('[data-testid="portal-outcome-clarify"]')).not.toBeNull();
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

  it("loads and saves independent feedback agent runtime, model, and public guide", async () => {
    mockApi.getProjectFeedbackAgent.mockResolvedValue({
      enabled: false,
      runtime: "codex",
      model: "gpt-5.3-codex",
      public_guide: "初始说明",
    });
    mockApi.getProjectCliConfig.mockResolvedValue({
      runtime: "claude",
      model: "claude-sonnet-4-6",
      has_api_key: true,
    });
    mockApi.updateProjectFeedbackAgent.mockResolvedValue({
      enabled: true,
      runtime: "claude",
      model: "claude-sonnet-4-6",
      public_guide: "更新后的公开使用指南",
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

    const claudeBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Claude"),
    )!;
    await act(async () => {
      claudeBtn.click();
    });

    const modelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder*="claude"], input[placeholder*="gpt"]',
    )!;
    await act(async () => {
      setReactValue(modelInput, "claude-sonnet-4-6");
    });

    const guideTextarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      setReactValue(guideTextarea, "更新后的公开使用指南");
    });

    const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => {
      toggle.click();
    });

    const saveBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存反馈 Agent 配置"),
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(mockApi.updateProjectFeedbackAgent).toHaveBeenCalledWith("proj-1", {
      enabled: true,
      runtime: "claude",
      model: "claude-sonnet-4-6",
      public_guide: "更新后的公开使用指南",
    });
  });
});
