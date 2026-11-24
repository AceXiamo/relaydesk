// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptBar, type PromptBarProps } from "../app/components/agent-chat/AgentPrimitives.tsx";
import type { ChatRuntimeInfo } from "../app/lib/types.ts";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));

function runtimeInfo(harnessDefault?: "on" | "off"): ChatRuntimeInfo {
  return {
    local_clis: { codex: true, claude: true }, auth_mode: { codex: "local_cli", claude: "local_cli" },
    project_cli: { runtime: "codex", configured: true, endpoint: "", model: "shared", default_effort: "default",
      models: [{ runtime: "codex", id: "shared", supports_fast: true }] },
    agents: [{ id: "test", name: "Test", online: true, accept_cli_runs: true, active_runs: 0, max_concurrency: 1,
      token_prefix: "", hostname: "", platform: "", bridge_version: "", last_seen_at: null, created_at: "", updated_at: "",
      bindings: [], capabilities: {}, runtimes: { codex: { available: true, default_fast_mode: harnessDefault } },
      models: [
        { runtime: "codex", id: "fast", supports_fast: true }, { runtime: "codex", id: "fast-2", supports_fast: true },
        { runtime: "codex", id: "shared", supports_fast: false }, { runtime: "codex", id: "unknown" },
      ],
    }],
  };
}

describe("Codex Fast in the composer", () => {
  let root: Root;
  let props: PromptBarProps;
  const user = userEvent.setup();
  function render(patch: Partial<PromptBarProps> = {}) {
    Object.assign(props, patch);
    act(() => root.render(createElement(PromptBar, props)));
  }
  const fast = () => document.querySelector<HTMLButtonElement>('button[aria-label="GPT Fast"]')!;
  const hint = () => document.getElementById(fast().getAttribute("aria-describedby")!)!.textContent;
  const modelButton = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.body.appendChild(document.createElement("main")));
    props = {
      runtime: "codex", model: "fast", runtimeInfo: runtimeInfo("on"), executionTarget: "local:test",
      effort: "default", fastMode: "default", input: "draft", attachments: [], openTasks: [], workspaceDatabases: [], workspaceFiles: [],
      sandboxMode: "workspace-write", networkAccess: true, settingsBusy: false, streaming: false, statusLine: "",
      sendBlocked: false, stopBlocked: true, authUnavailable: false, composerRef: { current: null },
      onChangeFastMode: vi.fn(mode => render({ fastMode: mode })), onChangeModel: vi.fn(), onSend: vi.fn(),
      onChangeEffort: vi.fn(), onInputChange: vi.fn(), onToggleAttachment: vi.fn(), onChangeSandboxMode: vi.fn(),
      onToggleNetworkAccess: vi.fn(), onOpenCliSettings: vi.fn(), onOpenWorkspace: vi.fn(), onNewSession: vi.fn(), onAbort: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("follows the reported default and toggles once per keyboard activation", async () => {
    render();
    expect(hint()).toContain("跟随 Codex 默认设置（已开启）");
    expect(fast().getAttribute("aria-pressed")).toBe("true");
    modelButton().focus();
    await act(() => user.tab());
    expect(document.activeElement).toBe(fast());
    await act(() => user.keyboard("{Enter}"));
    expect(fast().getAttribute("aria-pressed")).toBe("false");
    expect(hint()).toContain("当前会话（已关闭）");
    await act(() => user.keyboard(" "));
    expect(vi.mocked(props.onChangeFastMode).mock.calls).toEqual([["off"], ["default"]]);
    expect(props.onSend).not.toHaveBeenCalled();
    render({ runtimeInfo: runtimeInfo("off") });
    expect(fast().getAttribute("aria-pressed")).toBe("false");
    await act(() => user.click(fast()));
    expect(props.onChangeFastMode).toHaveBeenLastCalledWith("on");
  });

  it("allows explicit choices when support is known but the default is unreported", async () => {
    render({ runtimeInfo: runtimeInfo() });
    expect(hint()).toContain("默认状态未知");
    await act(() => user.click(fast()));
    await act(() => user.click(fast()));
    expect(vi.mocked(props.onChangeFastMode).mock.calls).toEqual([["on"], ["off"]]);
  });

  it.each([["shared", "不支持"], ["unknown", "能力未知"], ["custom", "能力未知"]])(
    "disables %s even with a saved override", async (model, reason) => {
      render({ model, fastMode: "on" });
      expect(fast().getAttribute("aria-disabled")).toBe("true");
      expect(fast().getAttribute("aria-pressed")).toBe("false");
      expect(hint()).toContain(reason);
      await act(() => user.click(fast()));
      await act(() => user.keyboard("{Enter} "));
      expect(props.onChangeFastMode).not.toHaveBeenCalled();
    },
  );

  it("uses the selected node's capability and default and respects pending settings", async () => {
    render({ model: "shared", executionTarget: "cloud" });
    expect(fast().getAttribute("aria-disabled")).toBe("false");
    expect(hint()).toContain("默认状态未知");
    render({ executionTarget: "local:missing" });
    expect(hint()).toContain("能力未知");
    render({ executionTarget: "local:test" });
    expect(hint()).toContain("不支持");
    render({ model: "fast", settingsBusy: true });
    await act(() => user.click(fast()));
    render({ settingsBusy: false, streaming: true });
    await act(() => user.click(fast()));
    expect(props.onChangeFastMode).not.toHaveBeenCalled();
  });

  it("carries the override only to supporting models and hides Fast for Claude", async () => {
    render({ fastMode: "off" });
    for (const [model, expectedMode] of [["fast-2", "off"], ["shared", "default"], ["unknown", "default"]]) {
      await act(() => user.click(modelButton()));
      expect(document.querySelector('[role="dialog"] [aria-label="GPT Fast"]')).toBeNull();
      const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(el => el.textContent?.trim() === model)!;
      await act(() => user.click(option));
      expect(props.onChangeModel).toHaveBeenLastCalledWith("codex", model, "default", expectedMode);
    }
    await act(() => user.click(modelButton()));
    const claude = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(el => el.textContent === "Claude Code")!;
    await act(() => user.click(claude));
    expect(props.onChangeModel).toHaveBeenLastCalledWith("claude", "", "default", "default");
    render({ runtime: "claude" });
    expect(fast()).toBeNull();
  });
});
