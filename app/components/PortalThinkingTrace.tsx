import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { cn } from "./ui.tsx";

const DRIVE_DELAYS: Array<number | null> = [
  0, 110, 220, 110, 220, 330, 220, 330, 440,
];

function PortalPixelMatrix({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 grid-cols-[repeat(3,3px)] gap-[1.5px]",
        className,
      )}
    >
      {DRIVE_DELAYS.map((delay, idx) => (
        <span
          key={idx}
          className="size-[3px] rounded-[0.75px] bg-[var(--p-cobalt)]"
          style={{
            opacity: delay === null ? 0.1 : 0.2,
            animation:
              delay === null
                ? "none"
                : `rd-pixel-on 680ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function formatThoughtDuration(ms: number): string {
  const sec = Math.max(0.1, ms / 1000);
  if (sec < 60) {
    return sec < 10 ? `${sec.toFixed(1)} 秒` : `${Math.round(sec)} 秒`;
  }
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem > 0 ? `${mins} 分 ${rem} 秒` : `${mins} 分钟`;
}

function cleanStepLabel(step: string): string {
  return step.replace(/[…\.]+$/, "").trim() || step;
}

export interface PortalThinkingTraceProps {
  active: boolean;
  statusLabel?: string;
  elapsedMs?: number;
  durationMs?: number;
  reasoning?: string;
  steps?: string[];
}

/**
 * Expandable thinking & chain-of-thought trace modeled after Beautiful UI's
 * Thinking primitive, styled with Relaydesk's editorial portal tokens.
 */
export function PortalThinkingTrace({
  active,
  statusLabel = "正在思考…",
  elapsedMs = 0,
  durationMs,
  reasoning = "",
  steps = [],
}: PortalThinkingTraceProps) {
  const [userPref, setUserPref] = useState<"expanded" | "collapsed" | null>(
    null,
  );

  const trimmedReasoning = reasoning.trim();
  const hasReasoning = trimmedReasoning.length > 0;
  const hasSteps = steps.length > 0;
  const hasDetails = hasReasoning || hasSteps;

  if (!active && !hasDetails) return null;

  // Auto-open while actively streaming reasoning; auto-collapse once settled.
  // Explicit user clicks always take precedence.
  const isOpen =
    hasDetails &&
    (userPref !== null ? userPref === "expanded" : active && hasReasoning);

  const settledSummary =
    typeof durationMs === "number" && durationMs > 0
      ? `已思考 ${formatThoughtDuration(durationMs)}`
      : hasReasoning
        ? "查看思考过程"
        : `排查过程 · ${steps.length} 个步骤`;

  const handleToggle = () => {
    if (!hasDetails) return;
    setUserPref(isOpen ? "collapsed" : "expanded");
  };

  return (
    <div
      data-testid="portal-thinking-trace"
      data-state={active ? "active" : "settled"}
      className="mb-1.5"
    >
      <button
        type="button"
        data-testid="portal-thinking-toggle"
        onClick={handleToggle}
        disabled={!hasDetails}
        aria-expanded={isOpen}
        className={cn(
          "group inline-flex items-center gap-2 py-0.5 pr-1.5 rounded-[6px] text-left transition-colors",
          hasDetails
            ? "hover:bg-[var(--p-hover)] px-1.5 -ml-1.5 cursor-pointer"
            : "cursor-default",
        )}
      >
        {active ? (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 select-none"
          >
            <PortalPixelMatrix />
            <span className="rd-shimmer-text text-[11.5px] font-medium leading-tight">
              {statusLabel || "正在思考…"}
            </span>
            <span className="text-[10.5px] font-mono tabular-nums text-[var(--p-ink-3)]">
              {(Math.max(0, elapsedMs) / 1000).toFixed(1)}s
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--p-ink-3)] group-hover:text-[var(--p-ink-2)] transition-colors">
            <Icon
              name="sparkles"
              size={11}
              className="text-[var(--p-ink-3)] group-hover:text-[var(--p-cobalt)] transition-colors"
            />
            <span>{settledSummary}</span>
          </span>
        )}

        {hasDetails && (
          <Icon
            name="chevron-down"
            size={12}
            className={cn(
              "text-[var(--p-ink-3)] transition-transform duration-200",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        )}
      </button>

      {isOpen && (
        <div
          data-testid="portal-thinking-content"
          className="mt-1 ml-[5px] pl-3 pr-1 border-l border-[var(--p-line)] space-y-2 max-h-60 overflow-y-auto rd-scroll animate-fade-in"
        >
          {hasSteps && (
            <ul className="space-y-1">
              {steps.map((step, idx) => {
                const isCurrent = active && idx === steps.length - 1;
                return (
                  <li
                    key={`${idx}-${step}`}
                    className="flex items-center gap-1.5 text-[11px] leading-snug text-[var(--p-ink-3)]"
                  >
                    {isCurrent ? (
                      <span
                        aria-hidden="true"
                        className="w-1.5 h-1.5 rounded-full bg-[var(--p-cobalt)] animate-pulse shrink-0"
                      />
                    ) : (
                      <Icon
                        name="check"
                        size={10.5}
                        className="text-[var(--p-ink-3)]/80 shrink-0"
                      />
                    )}
                    <span className={cn(isCurrent && "text-[var(--p-ink-2)]")}>
                      {isCurrent ? step : cleanStepLabel(step)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {hasReasoning && (
            <div
              data-testid="portal-thinking-reasoning"
              className="text-[11.5px] leading-[1.65] text-[var(--p-ink-2)] whitespace-pre-wrap break-words"
            >
              {trimmedReasoning}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
