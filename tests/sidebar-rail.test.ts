// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../app/components/Sidebar.tsx";
import { SidebarAccounts } from "../app/components/SidebarAccounts.tsx";
import type { ProjectDetail, ProjectSummary, SidebarAccount } from "../app/lib/types.ts";

const mockApi = vi.hoisted(() => ({
  getSidebarAccounts: vi.fn(),
}));

vi.mock("../app/components/Icon.tsx", () => ({
  Icon: ({ name }: { name: string }) => createElement("span", { "data-icon": name }),
}));

vi.mock("../app/lib/api.ts", () => ({
  api: mockApi,
}));

function makeProjectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "proj-1",
    name: "Relaydesk",
    repo: "owner/relaydesk",
    repos: ["owner/relaydesk"],
    automation_paused: false,
    delivery_mode: "direct_push",
    target_branch: "main",
    branch_prefix: "rd",
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
    created_at: "2026-11-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeProjectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    ...makeProjectSummary(),
    intake_key: "intake",
    bot_key: "bot",
    agent_key: "agent",
    allowed_origins: [],
    agent_instructions: "",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<SidebarAccount> = {}): SidebarAccount {
  return {
    id: "codex:1",
    name: "AceXiamo",
    identity: "ace@example.com",
    nodeName: "mbp-node",
    avatarUrl: "https://example.com/user-avatar.png",
    service: "Codex",
    plan: "Pro 5x",
    status: "ready",
    windows: [
      { label: "5h", remainingPercent: 76, resetsAt: "2026-11-28T05:00:00.000Z" },
      { label: "7d", remainingPercent: 48, resetsAt: "2026-12-01T00:00:00.000Z" },
    ],
    ...overrides,
  };
}

describe("Sidebar Icon Rail & compact dual-ring accounts", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mockApi.getSidebarAccounts.mockResolvedValue({ accounts: [makeAccount()] });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders expanded sidebar and transitions into an interactive Icon Rail when collapsed", async () => {
    const user = userEvent.setup();
    const onSelectView = vi.fn();
    const onSelectProject = vi.fn();
    const onToggleCollapse = vi.fn();
    const project1 = makeProjectSummary({ id: "proj-1", name: "Relaydesk" });
    const project2 = makeProjectSummary({ id: "proj-2", name: "SecondApp", repo: "owner/second" });

    const baseProps = {
      projects: [project1, project2],
      currentProject: makeProjectDetail(),
      tasks: [],
      view: "queue" as const,
      authStatus: null,
      online: true,
      dark: false,
      onToggleCollapse,
      mobileOpen: false,
      onCloseMobile: vi.fn(),
      onSelectProject,
      onSelectView,
      onNewProject: vi.fn(),
      onOpenCommand: vi.fn(),
      onToggleTheme: vi.fn(),
      onLogout: vi.fn(),
    };

    await act(async () => {
      root.render(createElement(Sidebar, { ...baseProps, collapsed: false }));
    });

    const expandedAside = document.querySelector("aside[data-collapsed='false']");
    expect(expandedAside).not.toBeNull();
    expect(expandedAside?.className).toContain("lg:w-[252px]");
    expect(expandedAside?.className).toContain("rd-sidebar-shell");

    await act(async () => {
      root.render(createElement(Sidebar, { ...baseProps, collapsed: true }));
    });

    const collapsedAside = document.querySelector("aside[data-collapsed='true']");
    expect(collapsedAside).not.toBeNull();
    expect(collapsedAside?.className).toContain("lg:w-[60px]");
    expect(collapsedAside?.className).toContain("rd-sidebar-shell");

    // Clicking nav items works while collapsed
    const chatNavBtn = collapsedAside?.querySelector('button[aria-label="Codex 对话"]') as HTMLButtonElement;
    expect(chatNavBtn).not.toBeNull();
    await user.click(chatNavBtn);
    expect(onSelectView).toHaveBeenCalledWith("chat");

    // Clicking Project Switcher opens portal menu to the right while collapsed
    const switcherBtn = collapsedAside?.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
    expect(switcherBtn).not.toBeNull();
    await user.click(switcherBtn);

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("SecondApp");
    const secondBtn = Array.from(menu!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("SecondApp"),
    );
    expect(secondBtn).toBeDefined();
    await user.click(secondBtn!);
    expect(onSelectProject).toHaveBeenCalledWith("proj-2");

    // Clicking expand button triggers toggle callback
    const expandBtn = collapsedAside?.querySelector('button[aria-label="展开左侧导航栏"]') as HTMLButtonElement;
    expect(expandBtn).not.toBeNull();
    await user.click(expandBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    // Mobile drawer stays expanded even when desktop is collapsed
    await act(async () => {
      root.render(createElement(Sidebar, { ...baseProps, collapsed: true, mobileOpen: true }));
    });
    const asides = Array.from(document.querySelectorAll("aside"));
    expect(asides).toHaveLength(2);
    expect(asides[0]?.getAttribute("data-collapsed")).toBe("true");
    expect(asides[1]?.getAttribute("data-collapsed")).toBe("false");
  });

  it("renders concentric dual rings with Harness Logos and interactive detail popover in compact mode", async () => {
    const user = userEvent.setup();
    const accounts: SidebarAccount[] = [
      makeAccount({
        id: "codex:1",
        service: "Codex",
        avatarUrl: "https://example.com/user-codex.png",
        windows: [
          { label: "5h", remainingPercent: 80, resetsAt: "2026-11-28T05:00:00.000Z" },
          { label: "7d", remainingPercent: 25, resetsAt: "2026-12-01T00:00:00.000Z" },
        ],
      }),
      makeAccount({
        id: "gemini:1",
        service: "Gemini",
        plan: "Ultra",
        avatarUrl: "https://example.com/user-gemini.png",
        windows: [
          { label: "Gemini 5-hour", remainingPercent: 95, resetsAt: null },
          { label: "Gemini weekly", remainingPercent: 60, resetsAt: null },
        ],
      }),
      makeAccount({
        id: "claude:1",
        service: "Claude",
        plan: "Pro",
        avatarUrl: "https://example.com/user-claude.png",
        windows: [{ label: "5h", remainingPercent: 55, resetsAt: null }],
      }),
    ];

    act(() => {
      root.render(createElement(SidebarAccounts, { accounts, compact: true }));
    });

    const list = document.querySelector("ul");
    expect(list?.className).toContain("flex-col");

    const outerRings = document.querySelectorAll('[data-ring="outer"]');
    const innerRings = document.querySelectorAll('[data-ring="inner"]');
    expect(outerRings).toHaveLength(3);
    expect(innerRings).toHaveLength(2);

    const imgs = Array.from(document.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(imgs).toEqual([
      "/runtime-logos/codex.svg",
      "/runtime-logos/agy.svg",
      "/runtime-logos/claude.svg",
    ]);

    // Clicking opens detail popover with full quota bars
    const firstBtn = document.querySelector("button[aria-haspopup='dialog']") as HTMLButtonElement;
    await user.click(firstBtn);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Codex");
    expect(dialog?.textContent).toContain("80%");
    expect(dialog?.textContent).toContain("25%");
    expect(dialog?.textContent).toContain("外环");
    expect(dialog?.textContent).toContain("内环");

    // Escape closes popover
    await user.keyboard("{Escape}");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    // Outside click closes popover
    await user.click(firstBtn);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("handles unverified, unavailable, error retry, loading, and empty states in compact mode", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    act(() => {
      root.render(createElement(SidebarAccounts, { accounts: "loading", compact: true }));
    });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("正在读取绑定账号");

    act(() => {
      root.render(createElement(SidebarAccounts, { accounts: "error", onRetry, compact: true }));
    });
    const retryBtn = document.querySelector('button[aria-label="额度读取失败，点击重试"]') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    await user.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(createElement(SidebarAccounts, { accounts: [], compact: true }));
    });
    expect(document.querySelector("section")).toBeNull();

    const specialAccounts: SidebarAccount[] = [
      makeAccount({ id: "u1", service: "Codex", status: "unverified", windows: [] }),
      makeAccount({ id: "u2", service: "Gemini", status: "unavailable", windows: [] }),
    ];
    act(() => {
      root.render(createElement(SidebarAccounts, { accounts: specialAccounts, compact: true }));
    });
    expect(document.querySelectorAll('[data-ring="outer"]')).toHaveLength(0);
    const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="dialog"]'));
    expect(buttons[0]?.getAttribute("aria-label")).toContain("账号归属未确认");
    expect(buttons[1]?.getAttribute("aria-label")).toContain("额度暂不可用");
  });
});
