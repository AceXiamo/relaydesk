import { describe, expect, it } from "vitest";
import {
  formatAccountPlan,
  formatResetFull,
  formatResetShort,
  formatWindowLabel,
  getQuotaTone,
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
});
