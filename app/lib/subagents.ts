import type { ChatMessageRecord, ChatToolEvent } from "./types.ts";

export type SubagentStatus = NonNullable<ChatToolEvent["subagent"]>["status"];
export type SubagentToolEvent = ChatToolEvent & { subagent: NonNullable<ChatToolEvent["subagent"]> };

export interface SubagentStatusMeta {
  label: string;
  countLabel: string;
  icon: string;
  iconClass: string;
  badgeClass: string;
  accentClass: string;
  outputLabel: string;
}

export interface AggregatedSubagent {
  id: string;
  event: SubagentToolEvent;
  status: SubagentStatus;
  sourceMessageId: string;
  latestMessageId: string;
  sourceMessageIndex: number;
  latestMessageIndex: number;
  launchIndex: number;
}

export interface SessionSubagentSummary {
  items: AggregatedSubagent[];
  byId: ReadonlyMap<string, AggregatedSubagent>;
  counts: Record<SubagentStatus, number>;
  total: number;
}

export const SUBAGENT_STATUS_ORDER: readonly SubagentStatus[] = [
  "running",
  "done",
  "error",
  "interrupted",
  "unknown",
];

export const SUBAGENT_STATUS_META: Record<SubagentStatus, SubagentStatusMeta> = {
  running: {
    label: "运行中",
    countLabel: "运行中",
    icon: "loader-2",
    iconClass: "animate-spin text-indigo-500",
    badgeClass: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
    accentClass: "border-l-indigo-500/70",
    outputLabel: "最近输出",
  },
  done: {
    label: "已完成",
    countLabel: "已完成",
    icon: "check-circle-2",
    iconClass: "text-emerald-500",
    badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    accentClass: "border-l-emerald-500/70",
    outputLabel: "执行结果",
  },
  error: {
    label: "执行失败",
    countLabel: "失败",
    icon: "x-circle",
    iconClass: "text-rose-500",
    badgeClass: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
    accentClass: "border-l-rose-500/80",
    outputLabel: "错误信息",
  },
  interrupted: {
    label: "已中断",
    countLabel: "已中断",
    icon: "pause-circle",
    iconClass: "text-amber-500",
    badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
    accentClass: "border-l-amber-500/80",
    outputLabel: "中断前输出",
  },
  unknown: {
    label: "状态未知",
    countLabel: "未知",
    icon: "circle-dashed",
    iconClass: "text-[var(--text-muted)]",
    badgeClass: "bg-[var(--surface-subtle)] text-[var(--text-muted)] border-[var(--border-subtle)]",
    accentClass: "border-l-[var(--border-strong)]",
    outputLabel: "最后已知输出",
  },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripToolPrefix(tool: string, summary: string): string {
  if (!tool) return summary;
  return summary.replace(new RegExp(`^${escapeRegExp(tool)}\\s*:\\s*`, "i"), "").trim();
}

export function resolveSubagentStatus(status: string | undefined): SubagentStatus {
  if (status && status in SUBAGENT_STATUS_META) {
    return status as SubagentStatus;
  }
  return "unknown";
}

export function formatSubagentTask(ev: ChatToolEvent): string {
  const summary = ev.summary.trim();
  const cleaned = stripToolPrefix(ev.tool, summary);
  return cleaned || summary || "子代理任务";
}

const GENERIC_SUMMARY_RE = /^(?:Codex\s*子代理|调用\s*(?:Agent|Task)|子代理任务|spawn_agent|Agent|Task)$/i;

export function isGenericSubagentSummary(summary: string): boolean {
  const trimmed = summary.trim();
  return !trimmed || GENERIC_SUMMARY_RE.test(trimmed);
}

function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === "done" || status === "error" || status === "interrupted";
}

function toToolStatus(status: SubagentStatus): ChatToolEvent["status"] {
  if (status === "done") return "done";
  if (status === "error" || status === "interrupted") return "error";
  return "running";
}

/**
 * Aggregates all subagent events across every message in a session, merging
 * cross-turn updates by subagent id while preserving the originating message.
 */
export function aggregateSessionSubagents(
  messages: readonly ChatMessageRecord[],
): SessionSubagentSummary {
  const map = new Map<string, AggregatedSubagent>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (!msg.events?.length) continue;

    for (const ev of msg.events) {
      if (!ev.subagent) continue;

      let nextStatus = resolveSubagentStatus(ev.subagent.status);
      if (nextStatus === "running" && msg.status === "aborted") {
        nextStatus = "interrupted";
      }

      const prev = map.get(ev.id);
      if (!prev) {
        const activity = ev.subagent.activity?.trim();
        const normalizedEvent: SubagentToolEvent = {
          ...ev,
          status: toToolStatus(nextStatus),
          subagent: {
            status: nextStatus,
            ...(activity ? { activity } : {}),
          },
        };
        map.set(ev.id, {
          id: ev.id,
          event: normalizedEvent,
          status: nextStatus,
          sourceMessageId: msg.id,
          latestMessageId: msg.id,
          sourceMessageIndex: msgIdx,
          latestMessageIndex: msgIdx,
          launchIndex: map.size + 1,
        });
        continue;
      }

      const mergedStatus =
        isTerminalSubagentStatus(prev.status) && nextStatus === "unknown"
          ? prev.status
          : nextStatus;

      const nextSummary = !isGenericSubagentSummary(ev.summary)
        ? ev.summary
        : !isGenericSubagentSummary(prev.event.summary)
          ? prev.event.summary
          : ev.summary || prev.event.summary;

      const nextTool = !isGenericSubagentSummary(ev.summary) ? ev.tool : prev.event.tool || ev.tool;
      const activity = ev.subagent.activity?.trim() || prev.event.subagent.activity?.trim();
      const output = ev.output?.trim() ? ev.output : prev.event.output;
      const exitCode = ev.exit_code !== undefined ? ev.exit_code : prev.event.exit_code;
      const images = ev.images?.length ? ev.images : prev.event.images;

      const mergedEvent: SubagentToolEvent = {
        ...prev.event,
        ...ev,
        tool: nextTool,
        summary: nextSummary,
        status: toToolStatus(mergedStatus),
        ...(output !== undefined ? { output } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(images?.length ? { images } : {}),
        subagent: {
          status: mergedStatus,
          ...(activity ? { activity } : {}),
        },
      };

      map.set(ev.id, {
        ...prev,
        event: mergedEvent,
        status: mergedStatus,
        latestMessageId: msg.id,
        latestMessageIndex: msgIdx,
      });
    }
  }

  const items = Array.from(map.values()).sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    if (a.latestMessageIndex !== b.latestMessageIndex) {
      return b.latestMessageIndex - a.latestMessageIndex;
    }
    return a.launchIndex - b.launchIndex;
  });

  const counts: Record<SubagentStatus, number> = {
    running: 0,
    done: 0,
    error: 0,
    interrupted: 0,
    unknown: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }

  const byId = new Map<string, AggregatedSubagent>();
  for (const item of items) {
    byId.set(item.id, item);
  }

  return {
    items,
    byId,
    counts,
    total: items.length,
  };
}
