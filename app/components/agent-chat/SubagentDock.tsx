import { useCallback, useEffect, useRef, useState } from "react";
import {
  SUBAGENT_STATUS_META,
  compactWhitespace,
  formatSubagentRuntimeLabel,
  formatSubagentTask,
  resolveSubagentAvatar,
  resolveSubagentStatus,
  type AggregatedSubagent,
  type SessionSubagentSummary,
  type SubagentAvatarMeta,
  type SubagentStatus,
  type SubagentToolEvent,
} from "~/lib/subagents.ts";
import { ChatWorkspaceImage } from "../ChatWorkspaceImage.tsx";
import { Icon } from "../Icon.tsx";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function SubagentStatusDot({
  status,
  size = "sm",
}: {
  status: SubagentStatus;
  size?: "xs" | "sm" | "md";
}) {
  const dim =
    size === "md"
      ? "h-3.5 w-3.5 ring-[2px]"
      : size === "xs"
        ? "h-2.5 w-2.5 ring-[1.5px]"
        : "h-3 w-3 ring-[2px]";

  if (status === "running") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-indigo-500 ring-[var(--surface-canvas)]",
          dim,
        )}
      >
        <span className="absolute inset-0 rounded-full bg-indigo-400 animate-ping opacity-75" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-white" />
      </span>
    );
  }

  if (status === "done") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-emerald-500 text-white ring-[var(--surface-canvas)] animate-rd-badge-pop",
          dim,
        )}
      >
        <svg viewBox="0 0 12 12" className="h-[68%] w-[68%]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.3 5 8.8 9.5 3.4" />
        </svg>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-rose-500 text-white ring-[var(--surface-canvas)] animate-rd-badge-pop",
          dim,
        )}
      >
        <svg viewBox="0 0 12 12" className="h-[68%] w-[68%]" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
          <path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7" />
        </svg>
      </span>
    );
  }

  if (status === "interrupted") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-amber-500 text-white ring-[var(--surface-canvas)] animate-rd-badge-pop",
          dim,
        )}
      >
        <svg viewBox="0 0 12 12" className="h-[64%] w-[64%]" fill="currentColor">
          <rect x="3" y="2.8" width="2.1" height="6.4" rx="0.8" />
          <rect x="6.9" y="2.8" width="2.1" height="6.4" rx="0.8" />
        </svg>
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-zinc-400 dark:bg-zinc-500 ring-[var(--surface-canvas)]",
        dim,
      )}
    />
  );
}

export function SubagentAvatar({
  avatar,
  status,
  size = "sm",
  bobbing = false,
  bobDelayMs = 0,
  elevated = false,
  showStatusBadge = true,
  className,
}: {
  avatar: SubagentAvatarMeta;
  status: SubagentStatus;
  size?: "xs" | "sm" | "md";
  bobbing?: boolean;
  bobDelayMs?: number;
  elevated?: boolean;
  showStatusBadge?: boolean;
  className?: string;
}) {
  const isRunning = status === "running";
  const boxSize =
    size === "md" ? "h-10 w-10" : size === "xs" ? "h-[22px] w-[22px]" : "h-7 w-7";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full select-none",
        boxSize,
        bobbing && isRunning && "animate-rd-avatar-bob",
        className,
      )}
      style={bobbing && isRunning ? { animationDelay: `${bobDelayMs}ms` } : undefined}
    >
      {isRunning && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[2px] rounded-full animate-rd-avatar-orbit"
          style={{
            background: `conic-gradient(from 0deg, ${avatar.accentHex} 0deg, #38bdf8 110deg, transparent 210deg, transparent 360deg)`,
            WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px))",
          }}
        />
      )}
      <span
        className={cn(
          "relative block h-full w-full overflow-hidden rounded-full bg-[var(--surface-elevated)] ring-2 ring-[var(--surface-canvas)] transition-shadow duration-200",
        )}
        style={
          elevated
            ? {
                boxShadow: `0 8px 18px -4px ${avatar.glowRgba}, 0 0 0 2px ${avatar.accentHex}`,
              }
            : isRunning
              ? {
                  boxShadow: `0 0 12px -2px ${avatar.glowRgba}`,
                }
              : undefined
        }
      >
        <img
          src={avatar.src}
          alt={avatar.name}
          draggable={false}
          className="h-full w-full object-cover"
        />
      </span>
      {showStatusBadge && <SubagentStatusDot status={status} size={size} />}
    </span>
  );
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
  launchIndex?: number;
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
              "rounded-lg border border-[var(--border-subtle)] border-l-2 bg-[var(--rd-plate)] overflow-hidden transition-[border-color,box-shadow,background-color] duration-150",
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
                    <SubagentAvatar
                      avatar={resolveSubagentAvatar(ev.id, entry.launchIndex)}
                      status={status}
                      size="xs"
                      showStatusBadge={false}
                      className="mt-[1px]"
                    />
                    {isParallel && (
                      <span className="mt-[2px] shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1 py-0.5 font-mono text-[10px] leading-none text-[var(--text-muted)] tabular-nums">
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

const MAX_VISIBLE_AVATARS = 5;

function SubagentStatusPopover({
  item,
  index,
  total,
  align,
  caretOffsetPx,
  onOpenPanel,
  onMouseEnter,
  onMouseLeave,
}: {
  item: AggregatedSubagent;
  index: number;
  total: number;
  align: "left" | "right";
  caretOffsetPx: number | null;
  onOpenPanel: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const avatar = resolveSubagentAvatar(item.id, item.launchIndex);
  const statusMeta = SUBAGENT_STATUS_META[item.status];
  const taskText = formatSubagentTask(item.event);
  const activity = item.event.subagent.activity?.trim() || "";
  const runtimeLabel = formatSubagentRuntimeLabel(item.event.subagent.runtime);
  const modelLabel = item.event.subagent.model?.trim() || "";
  const isRunning = item.status === "running";

  return (
    <div
      role="tooltip"
      data-subagent-hover-card="1"
      data-subagent-hover-id={item.id}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "absolute bottom-full mb-3 z-40 w-[min(300px,calc(100vw-2rem))] rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/96 backdrop-blur-xl shadow-[var(--rd-shadow-lg)] overflow-visible animate-rd-hover-card-in",
        "before:content-[''] before:absolute before:inset-x-0 before:-bottom-3 before:h-3",
        align === "right" ? "-right-2" : "-left-2",
      )}
    >
      <div className="overflow-hidden rounded-2xl">
        <div
          aria-hidden="true"
          className="h-[2.5px] w-full transition-colors duration-300"
          style={{
            background: `linear-gradient(90deg, ${avatar.accentHex}, color-mix(in srgb, ${avatar.accentHex} 28%, transparent))`,
          }}
        />

        <div key={item.id} className="p-3 space-y-2 animate-rd-content-swap">
          <div className="flex items-start gap-2.5">
            <SubagentAvatar
              avatar={avatar}
              status={item.status}
              size="sm"
              bobbing={isRunning}
              elevated={isRunning}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1.5">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] truncate">
                    {avatar.name}
                  </span>
                  {runtimeLabel && (
                    <span className="rounded bg-[var(--surface-subtle)] border border-[var(--border-subtle)] px-1.5 py-[1px] font-mono text-[10px] text-[var(--text-secondary)] truncate max-w-[110px]">
                      {modelLabel ? `${runtimeLabel} · ${modelLabel}` : runtimeLabel}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-none whitespace-nowrap shrink-0",
                    statusMeta.badgeClass,
                  )}
                >
                  {isRunning && <PixelGridMatrix variant="orbit" className="scale-[0.78] -ml-0.5" />}
                  <span>{statusMeta.label}</span>
                </span>
              </div>
              <p className="mt-1 text-[12px] font-medium leading-[1.4] text-[var(--text-primary)] line-clamp-2 break-words">
                {taskText}
              </p>
            </div>
          </div>

          {activity && (
            <div className="flex items-center gap-1.5 min-w-0 rounded-lg border border-[var(--border-subtle)]/80 bg-[var(--surface-subtle)]/75 px-2 py-1 text-[11px]">
              <span className="shrink-0 text-[var(--text-muted)]">
                {isRunning ? "进行中" : "状态"}
              </span>
              <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                {compactWhitespace(activity)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-0.5 text-[10.5px] text-[var(--text-muted)]">
            <span className="tabular-nums">
              {total > 1 ? `小队成员 ${index + 1} / ${total}` : "点击头像查看完整对话"}
            </span>
            <button
              type="button"
              onClick={onOpenPanel}
              className="rd-focus-ring inline-flex items-center gap-0.5 rounded px-1 py-0.5 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
            >
              <span>打开面板</span>
              <Icon name="arrow-up-right" size={11} />
            </button>
          </div>
        </div>
      </div>

      {/* Gliding pointer caret anchored under the hovered avatar */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-[5px] h-2.5 w-2.5 rotate-45 rounded-[2px] border-r border-b border-[var(--border-subtle)] bg-[var(--surface-card)] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          align === "right" ? "transition-[right]" : "transition-[left]",
        )}
        style={
          align === "right"
            ? { right: `${caretOffsetPx ?? 17}px` }
            : { left: `${caretOffsetPx ?? 17}px` }
        }
      />
    </div>
  );
}

export function SubagentDock({
  summary,
  selectedId,
  onSelectSubagent,
  align = "left",
  className,
}: {
  summary: SessionSubagentSummary;
  selectedId?: string | null;
  onSelectSubagent: (id: string) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  const avatarBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [stackHovered, setStackHovered] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [caretOffsetPx, setCaretOffsetPx] = useState<number | null>(null);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const scheduleHoverClose = useCallback(() => {
    cancelHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      setStackHovered(false);
      setHoveredId(null);
      hoverCloseTimerRef.current = null;
    }, 150);
  }, [cancelHoverClose]);

  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);

  useEffect(() => {
    if (selectedId) {
      cancelHoverClose();
      setStackHovered(false);
      setHoveredId(null);
    }
  }, [selectedId, cancelHoverClose]);

  const updateCaretForElement = useCallback(
    (btnEl: HTMLElement | null | undefined) => {
      const dockEl = dockRef.current;
      if (!dockEl || !btnEl) return;
      const dockRect = dockEl.getBoundingClientRect();
      const btnRect = btnEl.getBoundingClientRect();
      if (!dockRect.width || !btnRect.width) return;
      const btnCenter = btnRect.left + btnRect.width / 2;
      const offset =
        align === "right"
          ? dockRect.right - btnCenter + 3
          : btnCenter - dockRect.left + 3;
      const clamped = Math.max(14, Math.min(268, Math.round(offset)));
      setCaretOffsetPx(clamped);
    },
    [align],
  );

  const updateCaretForAvatar = useCallback(
    (id: string) => {
      updateCaretForElement(avatarBtnRefs.current.get(id));
    },
    [updateCaretForElement],
  );

  useEffect(() => {
    if (!hoveredId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelHoverClose();
        setStackHovered(false);
        setHoveredId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hoveredId, cancelHoverClose]);

  if (summary.total === 0) return null;

  const { items, total } = summary;
  const visibleItems = items.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = Math.max(0, total - visibleItems.length);

  const hoveredIndex = hoveredId ? items.findIndex((i) => i.id === hoveredId) : -1;
  const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : null;
  const hoveredVisibleIndex = hoveredId ? visibleItems.findIndex((i) => i.id === hoveredId) : -1;

  const handlePreviewItem = (id: string) => {
    cancelHoverClose();
    setStackHovered(true);
    setHoveredId(id);
    updateCaretForAvatar(id);
  };

  const handleAvatarClick = (item: AggregatedSubagent) => {
    cancelHoverClose();
    setStackHovered(false);
    setHoveredId(null);
    onSelectSubagent(item.id);
  };

  return (
    <div
      ref={dockRef}
      data-subagent-dock="1"
      onMouseEnter={cancelHoverClose}
      onMouseLeave={scheduleHoverClose}
      className={cn("relative inline-flex h-7 items-center max-w-full overflow-visible", className)}
    >
      {/* Lightweight Status-Only Hover Popover */}
      {!selectedId && hoveredItem && (
        <SubagentStatusPopover
          item={hoveredItem}
          index={hoveredIndex}
          total={total}
          align={align}
          caretOffsetPx={caretOffsetPx}
          onOpenPanel={() => handleAvatarClick(hoveredItem)}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
        />
      )}

      {/* Frameless Composer-aligned Overlapping Avatar Stack (entry point to independent panel) */}
      <div
        role="group"
        aria-label="子代理入口列表"
        data-subagent-avatar-stack="1"
        className="inline-flex h-7 items-center overflow-visible"
      >
        {visibleItems.map((item, idx) => {
          const avatar = resolveSubagentAvatar(item.id, item.launchIndex);
          const isSelected = selectedId === item.id;
          const isDirectHover = hoveredVisibleIndex === idx;
          const isNeighborHover =
            hoveredVisibleIndex !== -1 && Math.abs(hoveredVisibleIndex - idx) === 1;
          const isOtherFocused = hoveredVisibleIndex !== -1 && !isDirectHover && !isNeighborHover;
          const tiltDeg = idx % 2 === 0 ? -4 : 4;
          const neighborTiltDeg = hoveredVisibleIndex > idx ? -2 : 2;
          const transform = isDirectHover
            ? `translateY(-5px) scale(1.18) rotate(${tiltDeg}deg)`
            : isNeighborHover
              ? `translateY(-2px) scale(1.06) rotate(${neighborTiltDeg}deg)`
              : "translateY(0) scale(1) rotate(0deg)";

          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) avatarBtnRefs.current.set(item.id, node);
                else avatarBtnRefs.current.delete(item.id);
              }}
              type="button"
              data-subagent-avatar={item.id}
              data-subagent-status={item.status}
              aria-pressed={isSelected}
              aria-label={`${avatar.name} · ${SUBAGENT_STATUS_META[item.status].label} · ${formatSubagentTask(item.event)}`}
              onMouseEnter={() => handlePreviewItem(item.id)}
              onFocus={() => handlePreviewItem(item.id)}
              onClick={() => handleAvatarClick(item)}
              className={cn(
                "rd-focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-full cursor-pointer animate-rd-avatar-pop",
                idx > 0 && (stackHovered ? "ml-1" : "-ml-2"),
                isOtherFocused && "opacity-80",
              )}
              style={{
                transform,
                zIndex: isDirectHover || isSelected ? 30 : isNeighborHover ? 20 : MAX_VISIBLE_AVATARS - idx,
                transition:
                  "transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1), margin-left 280ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 180ms ease",
              }}
            >
              <SubagentAvatar
                avatar={avatar}
                status={item.status}
                size="sm"
                bobbing={item.status === "running" && !isDirectHover}
                bobDelayMs={idx * 240}
                elevated={isDirectHover || isSelected}
              />
            </button>
          );
        })}

        {overflowCount > 0 && (
          <button
            type="button"
            data-subagent-overflow-trigger="1"
            aria-label={`还有 ${overflowCount} 个子代理，点击打开独立面板`}
            onMouseEnter={(e) => {
              cancelHoverClose();
              setStackHovered(true);
              if (items[MAX_VISIBLE_AVATARS]) {
                setHoveredId(items[MAX_VISIBLE_AVATARS].id);
                updateCaretForElement(e.currentTarget);
              }
            }}
            onClick={() => {
              cancelHoverClose();
              setStackHovered(false);
              setHoveredId(null);
              const firstOverflow = items[MAX_VISIBLE_AVATARS] ?? items[0];
              if (firstOverflow) onSelectSubagent(firstOverflow.id);
            }}
            className={cn(
              "rd-focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-elevated)] ring-2 ring-[var(--surface-canvas)] text-[10px] font-semibold tabular-nums text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:-translate-y-1 hover:scale-110 cursor-pointer",
              stackHovered ? "ml-1" : "-ml-2",
            )}
            style={{
              transition:
                "transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1), margin-left 280ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            }}
          >
            +{overflowCount}
          </button>
        )}
      </div>
    </div>
  );
}
