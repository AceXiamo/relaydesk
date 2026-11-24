import { useId, useState } from "react";
import type { ChatSessionRecord } from "../../lib/types.ts";

type Reading = Pick<ChatSessionRecord, "context_used_tokens" | "context_window_tokens"> &
  Partial<Pick<ChatSessionRecord, "runtime">>;

const tokens = new Intl.NumberFormat("en-US");
const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ContextUsageLabelProps {
  session?: Reading | null;
  variant?: "pill" | "ghost";
  align?: "left" | "right";
}

export function ContextUsageLabel({
  session,
  variant = "pill",
  align = "right",
}: ContextUsageLabelProps) {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);

  const used = session?.context_used_tokens;
  const capacity = session?.context_window_tokens;
  const known = used != null && Number.isSafeInteger(used) && used >= 0;
  const hasWindow = capacity != null && Number.isSafeInteger(capacity) && capacity > 0;
  const ratio = known && hasWindow ? used / capacity : undefined;
  const clampedRatio = ratio === undefined ? 0 : Math.min(1, Math.max(0, ratio));
  const percent =
    ratio === undefined ? "" : ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.round(ratio * 100)}%`;

  const tone =
    ratio === undefined
      ? "neutral"
      : ratio >= 0.85
        ? "danger"
        : ratio >= 0.65
          ? "warn"
          : "normal";

  const strokeClass =
    tone === "danger"
      ? "stroke-rose-500"
      : tone === "warn"
        ? "stroke-amber-500"
        : tone === "normal"
          ? "stroke-indigo-500"
          : "stroke-[var(--text-muted)]";

  const barClass =
    tone === "danger"
      ? "bg-rose-500"
      : tone === "warn"
        ? "bg-amber-500"
        : "bg-indigo-500";

  const textToneClass =
    tone === "danger"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : known
          ? "text-[var(--text-secondary)]"
          : "text-[var(--text-muted)]";

  const explanation =
    session?.runtime === "claude"
      ? "Claude 最近一次调用的输入 token（含缓存），不是累计计费用量。"
      : "Harness 最近一次上报的上下文用量，不是会话累计计费 token。";

  const strokeOffset =
    ratio === undefined
      ? RING_CIRCUMFERENCE
      : RING_CIRCUMFERENCE * (1 - (ratio > 0 ? Math.max(0.03, clampedRatio) : 0));

  const triggerClass =
    variant === "pill"
      ? "inline-flex items-center gap-1.5 h-7 px-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]/90 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-[11.5px] font-medium tabular-nums transition-all duration-150 cursor-default select-none rd-focus-ring"
      : "inline-flex items-center gap-1.5 h-6 px-1.5 rounded-md hover:bg-[var(--surface-hover)] text-[11px] font-medium tabular-nums transition-colors duration-150 cursor-default select-none rd-focus-ring";

  const popoverAlignClass = align === "left" ? "left-0" : "right-0";

  return (
    <span
      className="group/ctx relative inline-flex shrink-0"
      onMouseEnter={() => setDismissed(false)}
    >
      <button
        type="button"
        aria-label={
          known
            ? `上下文用量：${tokens.format(used)}${hasWindow ? ` / ${tokens.format(capacity)}` : ""} tokens${percent ? ` (${percent})` : ""}`
            : "上下文：用量未上报"
        }
        aria-describedby={tooltipId}
        onFocus={() => setDismissed(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDismissed(true);
        }}
        className={`${triggerClass} ${textToneClass}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0 -rotate-90"
        >
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            strokeWidth="1.75"
            strokeDasharray={ratio === undefined ? "2 2" : undefined}
            className="stroke-[var(--border-strong)]/80"
          />
          {ratio !== undefined && (
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={strokeOffset}
              className={`${strokeClass} transition-[stroke-dashoffset,stroke] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]`}
            />
          )}
        </svg>
        <span className={percent || known ? "font-mono text-[11px]" : "text-[11px]"}>
          {percent || (known ? compactTokens.format(used) : "上下文")}
        </span>
      </button>

      <div
        id={tooltipId}
        role="tooltip"
        className={[
          "pointer-events-none invisible opacity-0 translate-y-1 scale-[0.98]",
          "absolute bottom-full mb-2 z-40 w-64 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)]/95 backdrop-blur-md p-2.5 shadow-[var(--rd-shadow-lg)]",
          "transition-all duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
          popoverAlignClass,
          !dismissed &&
            "group-hover/ctx:visible group-hover/ctx:opacity-100 group-hover/ctx:translate-y-0 group-hover/ctx:scale-100 group-focus-within/ctx:visible group-focus-within/ctx:opacity-100 group-focus-within/ctx:translate-y-0 group-focus-within/ctx:scale-100",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-[var(--text-primary)]">上下文</span>
          {percent ? (
            <span className={`font-mono font-medium tabular-nums ${textToneClass}`}>
              {percent}
            </span>
          ) : !known ? (
            <span className="text-[var(--text-muted)]">用量未上报</span>
          ) : null}
        </div>

        {ratio !== undefined && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            <div
              className={`h-full rounded-full ${barClass} transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]`}
              style={{ width: `${Math.max(ratio > 0 ? 2 : 0, Math.round(clampedRatio * 100))}%` }}
            />
          </div>
        )}

        <div className="mt-1.5 text-[11.5px] leading-4 tabular-nums">
          {known ? (
            <span className="font-mono text-[var(--text-secondary)]">
              {tokens.format(used)}
              {hasWindow && ` / ${tokens.format(capacity)}`} tokens
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">等待本轮对话上报 token 用量</span>
          )}
        </div>

        <p className="mt-1.5 border-t border-[var(--border-subtle)]/70 pt-1.5 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          {explanation}
        </p>
      </div>
    </span>
  );
}
