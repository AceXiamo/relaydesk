import { describe, expect, it } from "vitest";
import {
  clampQuotaPercent,
  formatAccountPlan,
  formatResetFull,
  formatResetShort,
  formatWindowLabel,
  getAccountHarnessLogo,
  getQuotaTone,
  selectDualRingWindows,
} from "../app/lib/sidebar-accounts.ts";
import { sanitizeSidebarAccount } from "../server/sidebar-accounts.ts";

describe("sidebar account normalization and formatting", () => {
  it("normalizes Codex prolite to Pro 5x and Gemini Pro to Ultra at the server boundary", () => {
    const codex = sanitizeSidebarAccount("codex", {
      id: "codex:abc",
      name: "AceXiamo",
      avatarUrl: null,
      plan: "prolite",
      status: "ready",
      windows: [{ label: "7d", remainingPercent: 84, resetsAt: "2026-11-28T07:30:00.000Z" }],
    });
    expect(codex).toMatchObject({ service: "Codex", plan: "Pro 5x" });

    const codexMixedCase = sanitizeSidebarAccount("codex", {
      id: "codex:def",
      name: null,
      avatarUrl: null,
      plan: "ProLite",
      status: "ready",
      windows: [],
    });
    expect(codexMixedCase).toMatchObject({ service: "Codex", plan: "Pro 5x" });

    const gemini = sanitizeSidebarAccount("gemini", {
      id: "gemini:abc",
      name: "AceXiamo",
      avatarUrl: null,
      plan: "Pro",
      status: "ready",
      windows: [],
    });
    expect(gemini).toMatchObject({ service: "Gemini", plan: "Ultra" });
  });

  it("formats subscription plans consistently for display", () => {
    expect(formatAccountPlan("Codex", "prolite")).toBe("Pro 5x");
    expect(formatAccountPlan("Codex", "ProLite")).toBe("Pro 5x");
    expect(formatAccountPlan("Codex", "pro")).toBe("Pro");
    expect(formatAccountPlan("Codex", "plus")).toBe("Plus");
    expect(formatAccountPlan("Gemini", "Pro")).toBe("Ultra");
    expect(formatAccountPlan("Gemini", "Ultra")).toBe("Ultra");
    expect(formatAccountPlan("Codex", null)).toBe("订阅未知");
  });

  it("shortens redundant window labels cleanly", () => {
    expect(formatWindowLabel("Gemini", "Gemini 5-hour")).toBe("5h");
    expect(formatWindowLabel("Gemini", "Gemini weekly")).toBe("7d");
    expect(formatWindowLabel("Codex", "7d")).toBe("7d");
    expect(formatWindowLabel("Codex", "5h")).toBe("5h");
    expect(formatWindowLabel("Codex", "Codex Monthly")).toBe("30d");
    expect(formatWindowLabel("Codex", "Codex Custom")).toBe("Custom");
  });

  it("formats reset timestamps concisely for today, tomorrow, same year, and next year", () => {
    const now = new Date(2026, 10, 23, 8, 0, 0);
    const sameDay = new Date(2026, 10, 23, 12, 30, 0).toISOString();
    const tomorrow = new Date(2026, 10, 24, 9, 5, 0).toISOString();
    const sameYear = new Date(2026, 10, 28, 7, 30, 0).toISOString();
    const nextYear = new Date(2027, 0, 2, 10, 0, 0).toISOString();

    expect(formatResetShort(sameDay, now)).toBe("12:30 重置");
    expect(formatResetShort(tomorrow, now)).toBe("明天 09:05 重置");
    expect(formatResetShort(sameYear, now)).toBe("11/28 07:30 重置");
    expect(formatResetShort(nextYear, now)).toBe("2027/01/02 重置");
    expect(formatResetShort(null, now)).toBe("重置未知");
    expect(formatResetFull(sameYear)).toBe("2026/11/28 07:30 重置");
    expect(formatResetFull(null)).toBe("重置时间未知");
  });

  it("maps remaining percentages to semantic quota tones without treating null as zero", () => {
    expect(getQuotaTone(85)).toBe("healthy");
    expect(getQuotaTone(31)).toBe("healthy");
    expect(getQuotaTone(30)).toBe("low");
    expect(getQuotaTone(11)).toBe("low");
    expect(getQuotaTone(10)).toBe("critical");
    expect(getQuotaTone(0)).toBe("critical");
    expect(getQuotaTone(null)).toBe("unknown");
    expect(getQuotaTone(undefined)).toBe("unknown");
  });

  it("clamps quota percentages cleanly without inventing defaults for non-finite values", () => {
    expect(clampQuotaPercent(63.6)).toBe(64);
    expect(clampQuotaPercent(-4)).toBe(0);
    expect(clampQuotaPercent(120)).toBe(100);
    expect(clampQuotaPercent(null)).toBeNull();
    expect(clampQuotaPercent(undefined)).toBeNull();
    expect(clampQuotaPercent(Number.NaN)).toBeNull();
  });

  it("resolves Harness logo paths by service name", () => {
    expect(getAccountHarnessLogo("Codex")).toBe("/runtime-logos/codex.svg");
    expect(getAccountHarnessLogo("openai")).toBe("/runtime-logos/codex.svg");
    expect(getAccountHarnessLogo("Gemini")).toBe("/runtime-logos/agy.svg");
    expect(getAccountHarnessLogo("agy")).toBe("/runtime-logos/agy.svg");
    expect(getAccountHarnessLogo("Antigravity")).toBe("/runtime-logos/agy.svg");
    expect(getAccountHarnessLogo("Claude")).toBe("/runtime-logos/claude.svg");
    expect(getAccountHarnessLogo("anthropic")).toBe("/runtime-logos/claude.svg");
    expect(getAccountHarnessLogo("Other")).toBeNull();
  });

  it("selects outer and inner dual-ring windows in ascending duration order", () => {
    expect(selectDualRingWindows("Codex", [])).toEqual({ outer: null, inner: null });

    const single = [{ label: "5h", remainingPercent: 72, resetsAt: null }];
    expect(selectDualRingWindows("Codex", single)).toEqual({
      outer: single[0],
      inner: null,
    });

    const codexReversed = [
      { label: "7d", remainingPercent: 84, resetsAt: null },
      { label: "5h", remainingPercent: 60, resetsAt: null },
    ];
    expect(selectDualRingWindows("Codex", codexReversed)).toEqual({
      outer: codexReversed[1],
      inner: codexReversed[0],
    });

    const geminiReversed = [
      { label: "Gemini weekly", remainingPercent: 90, resetsAt: null },
      { label: "Gemini 5-hour", remainingPercent: 50, resetsAt: null },
    ];
    expect(selectDualRingWindows("Gemini", geminiReversed)).toEqual({
      outer: geminiReversed[1],
      inner: geminiReversed[0],
    });

    const multi = [
      { label: "30d", remainingPercent: 95, resetsAt: null },
      { label: "5h", remainingPercent: 40, resetsAt: null },
      { label: "5h", remainingPercent: 18, resetsAt: null },
      { label: "7d", remainingPercent: 65, resetsAt: null },
    ];
    expect(selectDualRingWindows("Codex", multi)).toEqual({
      outer: multi[2],
      inner: multi[1],
    });
  });
});
