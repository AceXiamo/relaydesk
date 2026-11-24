import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot, cn } from "./ui.tsx";
import { formatDateTime, formatRelativeTime, releaseCode, taskCode } from "~/lib/format.ts";
import type { DeployGateEvaluation, DeployGateStatus } from "~/lib/portal-types.ts";

const GATE_STATUS_META: Record<
  DeployGateStatus,
  { label: string; icon: string; pill: string; spin?: boolean; pulse?: "indigo" | "emerald" | "amber" | "rose" }
> = {
  evaluating: {
    label: "AI 评估中",
    icon: "loader-2",
    spin: true,
    pulse: "indigo",
    pill: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
  },
  approved: {
    label: "AI 已放行",
    icon: "shield-check",
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
  },
  deferred: {
    label: "已暂缓发布",
    icon: "clock",
    pill: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
  },
  escalated: {
    label: "待人工确认",
    icon: "shield-alert",
    pulse: "rose",
    pill: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  },
  failed: {
    label: "评估未完成",
    icon: "alert-circle",
    pill: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/25",
  },
};

export function DeployGateStatusBadge({
  status,
  compact = false,
  className,
}: {
  status: DeployGateStatus;
  compact?: boolean;
  className?: string;
}) {
  const meta = GATE_STATUS_META[status] ?? GATE_STATUS_META.failed;
  return (
    <span
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        meta.pill,
        className,
      )}
    >
      <Icon
        name={meta.icon}
        size={compact ? 11 : 12}
        className={meta.spin ? "animate-spin" : undefined}
      />
      <span>{meta.label}</span>
    </span>
  );
}

export function formatGateTriggerSource(source?: string): string {
  if (!source) return "反馈申请";
  if (source === "portal") return "独立反馈面板";
  if (source === "widget") return "嵌入式组件";
  if (source === "preset") return "提单预设";
  return source;
}

export function DeployGateEvaluationRow({
  evaluation,
  compact = false,
  onSelectTask,
  onOpenReleases,
  onTriggerRelease,
  triggeringRelease = false,
}: {
  evaluation: DeployGateEvaluation;
  compact?: boolean;
  onSelectTask?: (taskId: string) => void;
  onOpenReleases?: () => void;
  onTriggerRelease?: () => void;
  triggeringRelease?: boolean;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const isEscalated = evaluation.status === "escalated";
  const isEvaluating = evaluation.status === "evaluating";
  const displayCode =
    evaluation.task_code ||
    (typeof evaluation.task_number === "number" ? taskCode(evaluation.task_number) : "");

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-xl border transition-colors",
        isEscalated
          ? "border-rose-500/30 bg-rose-500/[0.04] dark:bg-rose-500/[0.07]"
          : isEvaluating
            ? "border-indigo-500/30 bg-indigo-500/[0.04]"
            : "border-[var(--border-subtle)] bg-[var(--surface-card)]",
        compact ? "p-3" : "p-3.5",
      )}
    >
      {isEvaluating && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-indigo-500/10"
        >
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-indigo-500 to-transparent animate-rd-gate-scan" />
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {(isEscalated || isEvaluating) && (
              <LivePulseDot
                tone={isEscalated ? "rose" : "indigo"}
                active
                className="mr-0.5"
              />
            )}
            <DeployGateStatusBadge status={evaluation.status} compact />

            {displayCode && (
              onSelectTask ? (
                <button
                  type="button"
                  onClick={() => onSelectTask(evaluation.task_id)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:bg-[var(--surface-hover)] text-[11px] font-mono text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <span>{displayCode}</span>
                  {evaluation.task_title && (
                    <span className="font-sans text-[var(--text-secondary)] truncate max-w-[180px]">
                      {evaluation.task_title}
                    </span>
                  )}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[11px] font-mono text-[var(--text-secondary)]">
                  {displayCode}
                </span>
              )
            )}

            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] text-[11px] text-[var(--text-secondary)]">
              <Icon
                name={evaluation.trigger_source === "widget" ? "code-2" : "user-check"}
                size={11}
                className="text-[var(--text-muted)]"
              />
              <span>
                {evaluation.requested_by_label || "反馈者"} ·{" "}
                {formatGateTriggerSource(evaluation.trigger_source)}
              </span>
            </span>

            {typeof evaluation.release_number === "number" && evaluation.release_number > 0 && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[11px] font-mono">
                <Icon name="rocket" size={11} />
                {releaseCode(evaluation.release_number)}
              </span>
            )}
          </div>

          {evaluation.public_reason && (
            <p className="text-[12.5px] leading-relaxed text-[var(--text-primary)]">
              {evaluation.public_reason}
            </p>
          )}

          {evaluation.reason && (
            <p className="text-[11.5px] text-[var(--text-muted)]">
              申请说明：{evaluation.reason}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
            <span title={formatDateTime(evaluation.created_at)}>
              发起于 {formatRelativeTime(evaluation.created_at)}
            </span>
            {evaluation.finished_at && (
              <span title={formatDateTime(evaluation.finished_at)}>
                · 裁决于 {formatDateTime(evaluation.finished_at)}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {isEscalated && onTriggerRelease && (
            <Button
              type="button"
              variant="primary"
              size="xs"
              icon="rocket"
              loading={triggeringRelease}
              onClick={onTriggerRelease}
            >
              人工确认并发布
            </Button>
          )}
          {isEscalated && !onTriggerRelease && onOpenReleases && (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              icon="rocket"
              onClick={onOpenReleases}
            >
              前往发布审批
            </Button>
          )}
          {evaluation.internal_evidence && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              icon={showEvidence ? "chevron-down" : "eye"}
              onClick={() => setShowEvidence((v) => !v)}
            >
              {showEvidence ? "收起依据" : "评估依据"}
            </Button>
          )}
        </div>
      </div>

      {showEvidence && evaluation.internal_evidence && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--border-subtle)] animate-rd-portal-in">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)] mb-1.5">
            <Icon name="lock" size={11} />
            <span>内部 Pre-flight 评估记录（仅管理员可见，不向反馈侧暴露）</span>
          </div>
          <pre className="p-2.5 rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[11.5px] font-mono leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-56 overflow-y-auto rd-scroll">
            {evaluation.internal_evidence}
          </pre>
        </div>
      )}
    </article>
  );
}
