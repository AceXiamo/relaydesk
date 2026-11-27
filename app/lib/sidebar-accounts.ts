import type { SidebarAccount } from "./types.ts";

export type QuotaTone = "healthy" | "low" | "critical" | "unknown";

export function clampQuotaPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function getAccountHarnessLogo(service: string): string | null {
  switch (service.trim().toLowerCase()) {
    case "codex":
    case "openai":
      return "/runtime-logos/codex.svg";
    case "gemini":
    case "agy":
    case "antigravity":
      return "/runtime-logos/agy.svg";
    case "claude":
    case "anthropic":
      return "/runtime-logos/claude.svg";
    default:
      return null;
  }
}

function parseWindowDurationHours(service: string, rawLabel: string): number {
  const short = formatWindowLabel(service, rawLabel).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/.exec(short);
  if (!match) return Number.POSITIVE_INFINITY;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return Number.POSITIVE_INFINITY;
  const unit = match[2];
  if (unit === "m") return amount / 60;
  if (unit === "h") return amount;
  return amount * 24;
}

export function selectDualRingWindows(
  service: string,
  windows: SidebarAccount["windows"],
): {
  outer: SidebarAccount["windows"][number] | null;
  inner: SidebarAccount["windows"][number] | null;
} {
  if (windows.length === 0) return { outer: null, inner: null };
  if (windows.length === 1) return { outer: windows[0]!, inner: null };

  const ranked = windows.map((window, index) => ({
    window,
    index,
    durationHours: parseWindowDurationHours(service, window.label),
    remaining: clampQuotaPercent(window.remainingPercent) ?? Number.POSITIVE_INFINITY,
  }));

  ranked.sort((a, b) => {
    if (a.durationHours !== b.durationHours) {
      return a.durationHours - b.durationHours;
    }
    if (windows.length > 2 && a.remaining !== b.remaining) {
      return a.remaining - b.remaining;
    }
    return a.index - b.index;
  });

  return {
    outer: ranked[0]?.window ?? null,
    inner: ranked[1]?.window ?? null,
  };
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: roundCoord(cx + radius * Math.cos(rad)),
    y: roundCoord(cy + radius * Math.sin(rad)),
  };
}

export function describeSemiArcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): string {
  const start = polarToCartesian(cx, cy, radius, startDeg);
  const end = polarToCartesian(cx, cy, radius, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function computeArcLength(radius: number, sweepDeg: number): number {
  return (Math.abs(sweepDeg) / 360) * 2 * Math.PI * radius;
}

const KNOWN_PLAN_LABELS: Record<string, string> = {
  pro: "Pro",
  plus: "Plus",
  team: "Team",
  free: "Free",
  enterprise: "Enterprise",
  ultra: "Ultra",
};

export function formatAccountPlan(service: string, plan: string | null | undefined): string {
  const trimmed = plan?.trim();
  if (!trimmed) return "订阅未知";
  const lowerService = service.trim().toLowerCase();
  const lowerPlan = trimmed.toLowerCase();
  if (lowerService === "codex" && lowerPlan === "prolite") return "Pro 5x";
  if (lowerService === "gemini" && lowerPlan === "pro") return "Ultra";
  return KNOWN_PLAN_LABELS[lowerPlan] ?? trimmed;
}

export function formatWindowLabel(service: string, rawLabel: string): string {
  const trimmed = rawLabel.trim();
  if (!trimmed) return "额度";
  const escaped = service.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = escaped
    ? trimmed.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim() || trimmed
    : trimmed;
  const lower = stripped.toLowerCase();
  if (/^5[\s-]*h(?:our)?s?$/.test(lower)) return "5h";
  if (/^(?:weekly|7[\s-]*d(?:ay)?s?)$/.test(lower)) return "7d";
  if (/^(?:daily|24[\s-]*h(?:our)?s?|1[\s-]*d(?:ay)?)$/.test(lower)) return "1d";
  if (/^(?:monthly|30[\s-]*d(?:ay)?s?)$/.test(lower)) return "30d";
  return stripped;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatResetShort(resetsAt: string | null | undefined, now: Date = new Date()): string {
  if (!resetsAt) return "重置未知";
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime())) return "重置未知";
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameLocalDay(date, now)) return `${time} 重置`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (isSameLocalDay(date, tomorrow)) return `明天 ${time} 重置`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${time} 重置`;
  }
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} 重置`;
}

export function formatResetFull(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "重置时间未知";
  const date = new Date(resetsAt);
  if (!Number.isFinite(date.getTime())) return "重置时间未知";
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())} 重置`;
}

export function getQuotaTone(remainingPercent: number | null | undefined): QuotaTone {
  if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) return "unknown";
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 30) return "low";
  return "healthy";
}
