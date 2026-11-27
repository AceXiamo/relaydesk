// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EffortDetentTrack,
  RollingNumber,
  SegmentedDetent,
  type EffortDetentOption,
} from "../app/components/MotionPrimitives.tsx";
import { CommandPaletteModal } from "../app/components/ProjectModals.tsx";
import { clamp, projectVelocity, rubberband, springStep } from "../app/lib/detent.ts";

vi.mock("../app/components/Icon.tsx", () => ({ Icon: () => null }));

describe("detent spring and rubberband physics", () => {
  it("clamps numbers to inclusive bounds", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(4, 0, 10)).toBe(4);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("applies hyperbolic rubberband diminishing returns beyond edges", () => {
    expect(rubberband(0, 100)).toBe(0);
    const neg = rubberband(-20, 100);
    expect(neg).toBeLessThan(0);
    expect(neg).toBeGreaterThan(-20);
    const small = rubberband(20, 100);
    const large = rubberband(200, 100);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(20);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(100);
  });

  it("projects release velocity symmetrically with exponential decay", () => {
    expect(projectVelocity(0)).toBe(0);
    const pos = projectVelocity(1000, 0.99);
    const neg = projectVelocity(-1000, 0.99);
    expect(pos).toBeGreaterThan(0);
    expect(neg).toBeCloseTo(-pos, 6);
  });

  it("integrates damped spring state until it settles at target", () => {
    const body = { value: 0, target: 100, velocity: 0 };
    let settled = false;
    for (let i = 0; i < 240; i++) {
      settled = springStep(body, { response: 0.28, dampingRatio: 0.86 }, 1 / 60);
      if (settled) break;
    }
    expect(settled).toBe(true);
    expect(body.value).toBe(100);
    expect(body.velocity).toBe(0);
  });
});

describe("MotionPrimitives components", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("renders RollingNumber formatted text and updates when value changes", () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(createElement(RollingNumber, { value: 12 })));
      expect(document.body.textContent).toBe("12");
      expect(document.querySelector(".rd-digit-in-up")).toBeNull();

      act(() =>
        root.render(
          createElement(RollingNumber, {
            value: 48,
            format: (n) => `${n}%`,
          }),
        ),
      );
      expect(document.querySelector(".rd-digit-in-up")).not.toBeNull();
      expect(document.querySelector(".rd-digit-out-up")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(document.body.textContent).toBe("48%");
      expect(document.querySelector(".rd-digit-out-up")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches options in SegmentedDetent with proper tab/group roles", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    act(() =>
      root.render(
        createElement(SegmentedDetent<"a" | "b">, {
          role: "tablist",
          ariaLabel: "视图模式",
          value: "a",
          onChange,
          options: [
            { value: "a", label: "视图 A" },
            { value: "b", label: "视图 B", badge: 3 },
          ],
        }),
      ),
    );

    const tabs = Array.from(document.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");

    await act(() => user.click(tabs[1]!));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("updates EffortDetentTrack via click and keyboard arrows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options: EffortDetentOption[] = [
      { value: "default", label: "默认", shortLabel: "默认", description: "遵循默认" },
      { value: "low", label: "低", shortLabel: "低", description: "快速响应" },
      { value: "high", label: "高", shortLabel: "高", description: "深度思考" },
    ];

    const renderTrack = (val: EffortDetentOption["value"]) => {
      act(() =>
        root.render(
          createElement(EffortDetentTrack, {
            options,
            value: val,
            onChange,
          }),
        ),
      );
    };

    renderTrack("default");
    const radios = Array.from(document.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    expect(radios).toHaveLength(3);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");

    await act(() => user.click(radios[2]!));
    expect(onChange).toHaveBeenLastCalledWith("high");

    renderTrack("low");
    const activeRadio = document.querySelector('[data-effort-value="low"]') as HTMLButtonElement;
    activeRadio.focus();
    await act(() => user.keyboard("{ArrowRight}"));
    expect(onChange).toHaveBeenLastCalledWith("high");
    await act(() => user.keyboard("{Home}"));
    expect(onChange).toHaveBeenLastCalledWith("default");
    await act(() => user.keyboard("{End}"));
    expect(onChange).toHaveBeenLastCalledWith("high");
  });

  it("opens CommandPaletteModal instantly without scale-in animation and supports keyboard nav", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectView = vi.fn();
    const onToggleTheme = vi.fn();

    act(() =>
      root.render(
        createElement(CommandPaletteModal, {
          open: true,
          projects: [
            {
              id: "p1",
              name: "Relaydesk",
              repo: "acexiamo/relaydesk",
              repos: ["acexiamo/relaydesk"],
              automation_paused: false,
              delivery_mode: "direct_push",
              target_branch: "main",
              branch_prefix: "rd/",
              deploy_policy: {
                runtime: null,
                model: null,
                mode: "none",
                window_start: "02:00",
                window_end: "06:00",
                timezone: "Asia/Shanghai",
                allow_urgent_override: false,
                doc_path: "",
              },
              pending_deploy_count: 0,
              widget_code_context: false,
              created_at: "2026-11-27T00:00:00.000Z",
            },
          ],
          tasks: [],
          dark: false,
          onClose,
          onSelectView,
          onSelectProject: vi.fn(),
          onSelectTask: vi.fn(),
          onNewFeedback: vi.fn(),
          onNewProject: vi.fn(),
          onToggleTheme,
        }),
      ),
    );

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.className).not.toContain("animate-modal-in");

    const input = document.querySelector('input[placeholder*="搜索命令"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.focus();

    await act(() => user.keyboard("{ArrowDown}{ArrowDown}{Enter}"));
    expect(onSelectView).toHaveBeenCalledWith("workspace");
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(() => user.keyboard("{Escape}"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
