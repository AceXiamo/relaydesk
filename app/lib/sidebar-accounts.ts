export type QuotaTone = "healthy" | "low" | "critical" | "unknown";

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
