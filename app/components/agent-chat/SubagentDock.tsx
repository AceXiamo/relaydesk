import { useEffect, useId, useRef, useState } from "react";
import {
  SUBAGENT_STATUS_META,
  SUBAGENT_STATUS_ORDER,
  compactWhitespace,
  formatSubagentTask,
  resolveSubagentStatus,
  type AggregatedSubagent,
  type SessionSubagentSummary,
  type SubagentStatus,
  type SubagentToolEvent,
} from "~/lib/subagents.ts";
import { ChatWorkspaceImage } from "../ChatWorkspaceImage.tsx";
import { Icon } from "../Icon.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const DRIVE_DELAYS: Array<number | null> = [0, 110, 220, 110, 220, 330, 220, 330, 440];
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT_DELAYS: Array<number | null> = Array.from({ length: 9 }, (_, i) => {
  const idx = ORBIT_ORDER.indexOf(i);
  return idx === -1 ? null : idx * 105;
});

export function PixelGridMatrix({
  variant = "drive",
  className,
}: {
  variant?: "drive" | "orbit";
  className?: string;
}) {
  const delays = variant === "orbit" ? ORBIT_DELAYS : DRIVE_DELAYS;
  const dur = variant === "orbit" ? 900 : 680;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 grid-cols-[repeat(3,3.5px)] gap-[1.5px]",
        className,
      )}
    >
      {delays.map((delay, idx) => (
        <span
          key={idx}
          className="size-[3.5px] rounded-[1px] bg-[var(--text-primary)]"
          style={{
            opacity: delay === null ? 0.08 : 0.16,
            animation:
              delay === null
                ? "none"
                : `rd-pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

export function renderToolOutputLines(output: string) {
  const lines = output.split(/\r?\n/);
  const looksLikeDiff = lines.some((l) => l.startsWith("+++ ") || l.startsWith("--- ") || l.startsWith("@@ "));
  if (!looksLikeDiff) {
    return (
      <pre className="m-0 font-mono text-[11.5px] leading-[1.55] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
        {output}
      </pre>
    );
  }
  return (
    <pre className="m-0 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words">
      {lines.map((line, idx) => {
        const tone = line.startsWith("+") && !line.startsWith("+++")
          ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/8 block -mx-3 px-3"
          : line.startsWith("-") && !line.startsWith("---")
            ? "text-rose-600 dark:text-rose-400 bg-rose-500/8 block -mx-3 px-3"
            : line.startsWith("@@")
              ? "text-indigo-600 dark:text-indigo-400 block"
              : "text-[var(--text-secondary)] block";
        return (
          <span key={idx} className={tone}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

export interface SubagentListEntry {
  event: SubagentToolEvent;
  status?: SubagentStatus;
  sourceMessageId?: string;
}

export function SubagentTaskList({
  items,
  isStreaming = false,
  expandedIds,
  onToggleItem,
  highlightedId,
  onJumpToMessage,
  listClassName,
}: {
  items: readonly SubagentListEntry[];
  isStreaming?: boolean;
  expandedIds: ReadonlySet<string>;
  onToggleItem: (id: string) => void;
  highlightedId?: string | null;
  onJumpToMessage?: (messageId: string) => void;
  listClassName?: string;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const isParallel = items.length > 1;

  const handleCopyOutput = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1500);
  };

  return (
    <ul className={cn("m-0 list-none p-2 space-y-2", listClassName)}>
      {items.map((entry, idx) => {
        const ev = entry.event;
        const status = entry.status ?? resolveSubagentStatus(ev.subagent.status);
        const statusMeta = SUBAGENT_STATUS_META[status];
        const taskText = formatSubagentTask(ev);
        const activity = ev.subagent.activity?.trim() || "";
        const outputText = ev.output ?? "";
        const hasOutput = outputText.trim().length > 0;
        const hasExitCode = typeof ev.exit_code === "number";
        const hasLongTask = taskText.length > 120 || taskText.includes("\n");
        const hasLongActivity = Boolean(activity && (activity.length > 90 || activity.includes("\n")));
        const hasDetail = hasOutput || hasExitCode || hasLongTask || hasLongActivity;
        const hasDrawerContent = Boolean(activity || hasOutput || hasExitCode);
        const isOpen = expandedIds.has(ev.id);
        const isHighlighted = highlightedId === ev.id;

        return (
          <li
            key={ev.id}
            data-subagent-id={ev.id}
            data-subagent-status={status}
            className={cn(
              "rounded-lg border border-[var(--border-subtle)] border-l-2 bg-[var(--surface-card)] overflow-hidden transition-all",
              statusMeta.accentClass,
              isHighlighted && "ring-2 ring-indigo-500/45 border-indigo-500/50",
            )}
          >
            <div className="flex items-start">
              <button
                type="button"
                onClick={() => hasDetail && onToggleItem(ev.id)}
                disabled={!hasDetail}
                aria-expanded={hasDetail ? isOpen : undefined}
                className={cn(
                  "rd-focus-ring block min-w-0 flex-1 px-3 py-2 text-left transition-colors",
                  hasDetail ? "hover:bg-[var(--surface-hover)]/55 cursor-pointer" : "cursor-default",
                )}
              >
                <span className="flex items-start justify-between gap-2.5">
                  <span className="flex items-start gap-2 min-w-0 flex-1">
                    <Icon
                      name={statusMeta.icon}
                      size={13}
                      className={cn("mt-[2px] shrink-0", statusMeta.iconClass)}
                    />
                    {isParallel && (
                      <span className="mt-[1px] shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1 py-0.5 font-mono text-[10px] leading-none text-[var(--text-muted)] tabular-nums">
                        #{idx + 1}
                      </span>
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-[12.5px] font-medium leading-[1.45] text-[var(--text-primary)] break-words",
                        isOpen ? "whitespace-pre-wrap" : "line-clamp-2",
                      )}
                      title={taskText}
                    >
                      {taskText}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0 pt-[1px]">
                    <span
                      title={`最后已知状态：${statusMeta.label}`}
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap",
                        statusMeta.badgeClass,
                      )}
                    >
                      {statusMeta.label}
                    </span>
                    {hasDetail && (
                      <Icon
                        name="chevron-right"
                        size={12}
                        className={cn(
                          "text-[var(--text-muted)] transition-transform duration-150",
                          isOpen && "rotate-90",
                        )}
                      />
                    )}
                  </span>
                </span>

                {!isOpen && activity && (
                  <span className="mt-1.5 flex items-center gap-1.5 min-w-0 text-[11px] leading-[1.4]">
                    <span className="shrink-0 font-medium text-[var(--text-muted)]">最近活动</span>
                    <span
                      className="min-w-0 truncate rounded border border-[var(--border-subtle)]/80 bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--text-secondary)]"
                      title={activity}
                    >
                      {compactWhitespace(activity)}
                    </span>
                  </span>
                )}

                {!isOpen && hasOutput && (
                  <span
                    className={cn(
                      "mt-1.5 flex items-start gap-1.5 min-w-0 rounded-md border px-2 py-1.5 text-[11.5px] leading-[1.45]",
                      status === "error"
                        ? "border-rose-500/25 bg-rose-500/[0.05] dark:bg-rose-500/[0.08]"
                        : status === "interrupted"
                          ? "border-amber-500/20 bg-amber-500/[0.05] dark:bg-amber-500/[0.08]"
                          : "border-[var(--border-subtle)]/75 bg-[var(--surface-subtle)]/70",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-[1px] shrink-0 text-[10.5px] font-semibold",
                        status === "error"
                          ? "text-rose-600 dark:text-rose-400"
                          : status === "interrupted"
                            ? "text-amber-700 dark:text-amber-300"
                            : status === "done"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-[var(--text-muted)]",
                      )}
                    >
                      {statusMeta.outputLabel}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 line-clamp-2 break-words",
                        status === "error"
                          ? "text-rose-700 dark:text-rose-300"
                          : "text-[var(--text-secondary)]",
                      )}
                    >
                      {compactWhitespace(outputText)}
                    </span>
                  </span>
                )}
              </button>

              {onJumpToMessage && entry.sourceMessageId && (
                <button
                  type="button"
                  title="跳到发起消息"
                  aria-label="跳到发起消息"
                  onClick={() => onJumpToMessage(entry.sourceMessageId!)}
                  className="rd-focus-ring mt-1.5 mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
                >
                  <Icon name="arrow-up-right" size={12} />
                </button>
              )}
            </div>

            {isOpen && hasDrawerContent && (
              <div className="border-t border-[var(--border-subtle)]/80 bg-[var(--surface-subtle)]/65 dark:bg-[#0d0f13]/80 px-3 py-2.5 space-y-2.5 animate-fade-in">
                {activity && (
                  <div className="space-y-1">
                    <div className="text-[10.5px] font-medium text-[var(--text-muted)]">
                      最近活动
                    </div>
                    <p className="m-0 font-mono text-[11.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                      {activity}
                    </p>
                  </div>
                )}

                {(hasOutput || hasExitCode) && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={cn(
                            "font-semibold",
                            status === "error"
                              ? "text-rose-600 dark:text-rose-400"
                              : status === "interrupted"
                                ? "text-amber-700 dark:text-amber-300"
                                : status === "done"
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-[var(--text-muted)]",
                          )}
                        >
                          {statusMeta.outputLabel}
                        </span>
                        {hasExitCode && ev.exit_code !== 0 && (
                          <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400">
                            exit {ev.exit_code}
                          </span>
                        )}
                      </span>
                      {hasOutput && (
                        <button
                          type="button"
                          onClick={() => handleCopyOutput(ev.id, outputText)}
                          className="rd-focus-ring inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer shrink-0"
                        >
                          <Icon name={copiedId === ev.id ? "check" : "copy"} size={11} />
                          {copiedId === ev.id ? "已复制" : status === "error" ? "复制错误" : "复制结果"}
                        </button>
                      )}
                    </div>
                    {hasOutput ? (
                      <div
                        className={cn(
                          "max-h-60 overflow-auto rd-scroll rounded-md border p-2.5",
                          status === "error"
                            ? "border-rose-500/25 bg-rose-500/[0.06] dark:bg-rose-500/[0.09]"
                            : status === "interrupted"
                              ? "border-amber-500/20 bg-amber-500/[0.04]"
                              : "border-[var(--border-subtle)]/70 bg-[var(--surface-card)]/85 dark:bg-[#111215]/90",
                        )}
                      >
                        {status === "error" ? (
                          <pre className="m-0 font-mono text-[11.5px] leading-[1.55] text-rose-700 dark:text-rose-300 whitespace-pre-wrap break-words">
                            {outputText}
                          </pre>
                        ) : (
                          renderToolOutputLines(outputText)
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono text-[var(--text-muted)]">
                        （无输出，退出码 {ev.exit_code}）
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {ev.images && ev.images.length > 0 && (
              <div className="px-3 pb-2.5 pt-1 flex flex-wrap gap-2">
                {ev.images.map((img, imgIdx) => (
                  <ChatWorkspaceImage
                    key={`${imgIdx}:${img.url}`}
                    url={img.url}
                    alt={img.alt || `${ev.tool} 图片`}
                    streaming={isStreaming}
                    linkClassName="block group"
                    className="max-h-64 w-auto max-w-full rounded-xl border border-[var(--border-subtle)] object-contain"
                  />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function buildSettledSummaryText(counts: Record<SubagentStatus, number>): string {
  const parts: string[] = [];
  for (const status of ["error", "interrupted", "unknown", "done"] as const) {
    const count = counts[status];
    if (!count) continue;
    parts.push(`${count} ${SUBAGENT_STATUS_META[status].countLabel}`);
  }
  return parts.length > 0 ? `子代理 · ${parts.join(" · ")}` : "子代理";
}

function hasSubagentDetail(item: AggregatedSubagent): boolean {
  const taskText = formatSubagentTask(item.event);
  const activity = item.event.subagent.activity?.trim() || "";
  const hasOutput = (item.event.output ?? "").trim().length > 0;
  const hasExitCode = typeof item.event.exit_code === "number";
  const hasLongTask = taskText.length > 120 || taskText.includes("\n");
  const hasLongActivity = Boolean(activity && (activity.length > 90 || activity.includes("\n")));
  return hasOutput || hasExitCode || hasLongTask || hasLongActivity;
}

export function SubagentDock({
  summary,
  isStreaming = false,
  open,
  onOpenChange,
  focusedId,
  onClearFocus,
  onJumpToMessage,
  className,
}: {
  summary: SessionSubagentSummary;
  isStreaming?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusedId?: string | null;
  onClearFocus?: () => void;
  onJumpToMessage?: (messageId: string) => void;
  className?: string;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !focusedId) return;
    const match = summary.byId.get(focusedId);
    if (match && hasSubagentDetail(match)) {
      setExpandedIds((prev) => {
        if (prev.has(focusedId)) return prev;
        const next = new Set(prev);
        next.add(focusedId);
        return next;
      });
    }
    setHighlightedId(focusedId);
    const timer = window.setTimeout(() => {
      setHighlightedId((curr) => (curr === focusedId ? null : curr));
    }, 1800);

    const raf = window.requestAnimationFrame(() => {
      const listItems = panelRef.current?.querySelectorAll<HTMLLIElement>("li[data-subagent-id]");
      const targetEl = listItems
        ? Array.from(listItems).find((el) => el.dataset.subagentId === focusedId)
        : undefined;
      targetEl?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });

    onClearFocus?.();
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, [open, focusedId, summary.byId, onClearFocus]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && dockRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-subagent-ref-trigger]")) return;
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onOpenChange]);

  if (summary.total === 0) return null;

  const { counts, items, total } = summary;
  const isParallel = total > 1;
  const runningCount = counts.running;
  const singleRunning = runningCount === 1 ? items.find((item) => item.status === "running") : undefined;
  const singleRunningHint = singleRunning
    ? compactWhitespace(singleRunning.event.subagent.activity?.trim() || formatSubagentTask(singleRunning.event))
    : "";

  const toggleItem = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      ref={dockRef}
      data-subagent-dock="1"
      className={cn(
        "pointer-events-none absolute right-3 sm:right-4 bottom-3 z-30 flex flex-col items-end max-w-[calc(100%-1.5rem)]",
        className,
      )}
    >
      {open && (
        <section
          ref={panelRef}
          id={panelId}
          aria-label={isParallel ? "并行子代理任务" : "子代理任务"}
          className="pointer-events-auto mb-2 w-[min(420px,calc(100vw-1.5rem))] sm:w-[min(440px,calc(100vw-2rem))] max-w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/98 backdrop-blur-md shadow-[var(--rd-shadow-lg)] overflow-hidden animate-popover-in-up"
        >
          <header className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3.5 py-2.5 bg-[var(--surface-subtle)]/40">
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
              {runningCount > 0 ? (
                <PixelGridMatrix variant="orbit" />
              ) : counts.error > 0 ? (
                <Icon name="alert-circle" size={13} className="text-rose-500" />
              ) : counts.interrupted > 0 ? (
                <Icon name="pause-circle" size={13} className="text-amber-500" />
              ) : counts.unknown > 0 ? (
                <Icon name="circle-dashed" size={13} className="text-[var(--text-muted)]" />
              ) : (
                <Icon name="bot" size={13} className="text-emerald-500" />
              )}
              <span
                className={cn(
                  "text-[12px] font-semibold tabular-nums",
                  runningCount > 0 ? "rd-shimmer-text" : "text-[var(--text-primary)]",
                )}
              >
                {isParallel ? `并行子代理 (${total})` : "子代理任务"}
              </span>
              <span className="flex items-center flex-wrap gap-1">
                {SUBAGENT_STATUS_ORDER.map((status) => {
                  const count = counts[status];
                  if (!count) return null;
                  const meta = SUBAGENT_STATUS_META[status];
                  return (
                    <span
                      key={status}
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium leading-none tabular-nums whitespace-nowrap",
                        meta.badgeClass,
                      )}
                    >
                      {isParallel ? `${count} ${meta.countLabel}` : meta.label}
                    </span>
                  );
                })}
              </span>
            </div>
            <button
              type="button"
              aria-label="收起子代理面板"
              title="收起子代理面板"
              onClick={() => onOpenChange(false)}
              className="rd-focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition cursor-pointer"
            >
              <Icon name="x" size={13} />
            </button>
          </header>

          <div className="max-h-[min(56vh,420px)] overflow-y-auto rd-scroll bg-[var(--surface-subtle)]/35 dark:bg-[#0d0f13]/35">
            <SubagentTaskList
              items={items.map((item) => ({
                event: item.event,
                status: item.status,
                sourceMessageId: item.sourceMessageId,
              }))}
              isStreaming={isStreaming}
              expandedIds={expandedIds}
              onToggleItem={toggleItem}
              highlightedId={highlightedId}
              onJumpToMessage={onJumpToMessage}
            />
          </div>
        </section>
      )}

      <button
        type="button"
        data-subagent-dock-trigger="1"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "pointer-events-auto rd-focus-ring inline-flex items-center gap-2 h-8 max-w-full px-3 rounded-full border backdrop-blur-md shadow-[var(--rd-shadow-md)] transition-all cursor-pointer text-[12px]",
          runningCount > 0
            ? "border-indigo-500/35 bg-[var(--surface-card)]/95 text-[var(--text-primary)] hover:border-indigo-500/55"
            : counts.error > 0
              ? "border-rose-500/30 bg-[var(--surface-card)]/95 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-rose-500/45"
              : "border-[var(--border-subtle)] bg-[var(--surface-card)]/95 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]",
        )}
      >
        {runningCount > 0 ? (
          <>
            <PixelGridMatrix variant="orbit" />
            <span className="rd-shimmer-text font-medium tabular-nums whitespace-nowrap">
              {runningCount} 个子代理运行中
            </span>
            {total > runningCount ? (
              <span className="text-[11px] text-[var(--text-muted)] tabular-nums whitespace-nowrap">
                · 共 {total}
              </span>
            ) : singleRunningHint ? (
              <span className="hidden sm:inline max-w-[160px] truncate text-[11px] text-[var(--text-muted)]">
                · {singleRunningHint}
              </span>
            ) : null}
          </>
        ) : (
          <>
            {counts.error > 0 ? (
              <Icon name="alert-circle" size={13} className="text-rose-500" />
            ) : counts.interrupted > 0 ? (
              <Icon name="pause-circle" size={13} className="text-amber-500" />
            ) : counts.unknown > 0 ? (
              <Icon name="circle-dashed" size={13} className="text-[var(--text-muted)]" />
            ) : (
              <Icon name="bot" size={13} className="text-emerald-500" />
            )}
            <span className="font-medium tabular-nums truncate">
              {buildSettledSummaryText(counts)}
            </span>
          </>
        )}
        <Icon
          name="chevron-down"
          size={13}
          className={cn(
            "text-[var(--text-muted)] transition-transform duration-150 shrink-0",
            open ? "rotate-0" : "rotate-180",
          )}
        />
      </button>
    </div>
  );
}
