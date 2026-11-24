import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import {
  DELIVERY_MODE_DESCRIPTIONS,
  DELIVERY_MODE_LABELS,
  OWNER_LABELS,
  PRIORITY_LABELS,
  RELEASE_STATUS_LABELS,
  RELEASE_TRIGGER_LABELS,
  SOURCE_ICONS,
  SOURCE_LABELS,
  STATUS_LABELS,
  TASK_DEPLOY_STATUS_LABELS,
  formatDateTime,
  formatRelativeTime,
  releaseCode,
} from "../lib/format.ts";
import type {
  DeliveryMode,
  ReleaseStatus,
  ReleaseTrigger,
  TaskDeployStatus,
  TaskOwner,
  TaskPriority,
  TaskResolution,
  TaskSource,
  TaskStatus,
} from "../lib/types.ts";
import { Icon } from "./Icon.tsx";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "subtle";
export type ButtonSize = "xs" | "sm" | "md";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: string;
}

const BUTTON_VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--rd-accent)] text-[var(--rd-accent-fg)] border border-transparent hover:bg-[var(--rd-accent-hover)] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(0,0,0,0.12)]",
  secondary:
    "bg-[var(--rd-surface)] dark:bg-[var(--rd-elevated)] text-[var(--rd-ink)] border border-[var(--rd-border)] hover:bg-[var(--rd-hover)] hover:border-[var(--rd-border-strong)] shadow-[var(--rd-shadow-sm)]",
  subtle:
    "bg-[var(--rd-subtle)] text-[var(--rd-ink)] border border-transparent hover:bg-[var(--rd-hover)] hover:border-[var(--rd-border)]",
  ghost:
    "bg-transparent text-[var(--rd-muted)] border border-transparent hover:bg-[var(--rd-hover)] hover:text-[var(--rd-ink)]",
  danger:
    "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/25 hover:bg-rose-600 hover:text-white hover:border-rose-600 dark:hover:bg-rose-500 dark:hover:text-white",
};

const BUTTON_SIZE_STYLES: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-xs gap-1.5 rounded-md",
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
};

const BUTTON_ICON_SIZES: Record<ButtonSize, number> = {
  xs: 13,
  sm: 14,
  md: 15,
};

export function Button({
  variant = "secondary",
  size = "sm",
  loading = false,
  icon,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  const iconSize = BUTTON_ICON_SIZES[size];

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-colors duration-150 rd-focus-ring",
        "disabled:opacity-50 disabled:pointer-events-none",
        BUTTON_VARIANT_STYLES[variant],
        BUTTON_SIZE_STYLES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Icon name="loader-2" size={iconSize} className="animate-spin" />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* StatusBadge                                                                */
/* -------------------------------------------------------------------------- */

export interface StatusBadgeProps {
  status: TaskStatus;
  compact?: boolean;
  className?: string;
}

interface StatusVisual {
  pill: string;
  dot: string;
  pulse?: string;
  icon?: string;
}

const STATUS_VISUALS: Record<TaskStatus, StatusVisual> = {
  triage: {
    pill: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/20",
    dot: "bg-zinc-400 dark:bg-zinc-400",
  },
  ready: {
    pill: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20",
    dot: "bg-indigo-500 dark:bg-indigo-400",
  },
  working: {
    pill: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/25",
    dot: "bg-amber-500 dark:bg-amber-400",
    pulse: "bg-amber-500/60 dark:bg-amber-400/60",
  },
  handoff: {
    pill: "bg-violet-500/12 text-violet-700 dark:text-violet-300 border-violet-500/25",
    dot: "bg-violet-500 dark:bg-violet-400",
    pulse: "bg-violet-500/60 dark:bg-violet-400/60",
  },
  waiting: {
    pill: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25",
    dot: "bg-rose-500 dark:bg-rose-400",
  },
  review: {
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  done: {
    pill: "bg-zinc-500/8 text-zinc-500 dark:text-zinc-400 border-zinc-500/15",
    dot: "bg-zinc-400 dark:bg-zinc-500",
    icon: "check",
  },
};

export function StatusBadge({
  status,
  compact = false,
  className,
}: StatusBadgeProps) {
  const visual = STATUS_VISUALS[status];
  const label = STATUS_LABELS[status];

  return (
    <span
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1.5"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        visual.pill,
        className,
      )}
    >
      {visual.icon ? (
        <Icon name={visual.icon} size={compact ? 11 : 12} />
      ) : (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          {visual.pulse ? (
            <span
              className={cn(
                "absolute inset-0 rounded-full animate-ping opacity-75",
                visual.pulse,
              )}
            />
          ) : null}
          <span
            className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", visual.dot)}
          />
        </span>
      )}
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* PriorityBadge                                                              */
/* -------------------------------------------------------------------------- */

export interface PriorityBadgeProps {
  priority: TaskPriority;
  showLabel?: boolean;
  className?: string;
}

const PRIORITY_VISUALS: Record<
  TaskPriority,
  { icon: string; tone: string; pillTone: string }
> = {
  urgent: {
    icon: "alert-triangle",
    tone: "text-rose-600 dark:text-rose-400",
    pillTone: "bg-rose-500/10 border-rose-500/20",
  },
  high: {
    icon: "signal-high",
    tone: "text-amber-600 dark:text-amber-400",
    pillTone: "bg-amber-500/10 border-amber-500/20",
  },
  normal: {
    icon: "signal-medium",
    tone: "text-zinc-600 dark:text-zinc-300",
    pillTone: "bg-[var(--rd-subtle)] border-[var(--rd-border)]",
  },
  low: {
    icon: "signal-low",
    tone: "text-zinc-400 dark:text-zinc-500",
    pillTone: "bg-transparent border-[var(--rd-border)]",
  },
};

export function PriorityBadge({
  priority,
  showLabel = true,
  className,
}: PriorityBadgeProps) {
  const visual = PRIORITY_VISUALS[priority];
  const label = PRIORITY_LABELS[priority];

  if (!showLabel) {
    return (
      <span
        title={`优先级：${label}`}
        aria-label={`优先级：${label}`}
        className={cn(
          "inline-flex items-center justify-center w-5 h-5 rounded",
          visual.tone,
          className,
        )}
      >
        <Icon name={visual.icon} size={14} />
      </span>
    );
  }

  return (
    <span
      title={`优先级：${label}`}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-xs font-medium leading-4 whitespace-nowrap select-none",
        visual.tone,
        visual.pillTone,
        className,
      )}
    >
      <Icon name={visual.icon} size={12} />
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* OwnerChip                                                                  */
/* -------------------------------------------------------------------------- */

export interface OwnerChipProps {
  owner: TaskOwner;
  lastSeen?: string | null;
  className?: string;
}

export function OwnerChip({ owner, lastSeen, className }: OwnerChipProps) {
  const label = OWNER_LABELS[owner];

  if (owner === "agent") {
    return (
      <span
        title={lastSeen ? `最近心跳：${formatDateTime(lastSeen)}` : label}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium leading-4 whitespace-nowrap select-none border",
          "bg-indigo-500/10 text-indigo-700 border-indigo-500/20 dark:bg-cyan-400/10 dark:text-cyan-300 dark:border-cyan-400/20",
          className,
        )}
      >
        <Icon name="terminal" size={12} />
        <span>{label}</span>
        {lastSeen ? (
          <span
            suppressHydrationWarning
            className="text-[11px] font-mono tabular-nums opacity-75"
          >
            · {formatRelativeTime(lastSeen)}
          </span>
        ) : null}
      </span>
    );
  }

  if (owner === "human") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium leading-4 whitespace-nowrap select-none border",
          "bg-[var(--rd-subtle)] text-[var(--rd-ink)] border-[var(--rd-border)]",
          className,
        )}
      >
        <Icon name="user" size={12} className="text-[var(--rd-muted)]" />
        <span>{label}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium leading-4 whitespace-nowrap select-none border border-dashed",
        "bg-transparent text-[var(--rd-muted)] border-[var(--rd-border)]",
        className,
      )}
    >
      <Icon name="circle-dashed" size={12} className="opacity-70" />
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* SourceBadge                                                                */
/* -------------------------------------------------------------------------- */

export interface SourceBadgeProps {
  source: TaskSource;
  className?: string;
}

export function SourceBadge({ source, className }: SourceBadgeProps) {
  const icon = SOURCE_ICONS[source];
  const label = SOURCE_LABELS[source];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium leading-4 whitespace-nowrap select-none",
        "bg-[var(--rd-subtle)] text-[var(--rd-muted)] border border-[var(--rd-border)]",
        className,
      )}
    >
      <Icon name={icon} size={12} />
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* LivePulseDot                                                               */
/* -------------------------------------------------------------------------- */

export type LivePulseTone = "emerald" | "amber" | "indigo" | "rose" | "zinc";

export interface LivePulseDotProps {
  tone?: LivePulseTone;
  active?: boolean;
  className?: string;
}

const LIVE_PULSE_TONES: Record<
  LivePulseTone,
  { core: string; halo: string; glow: string }
> = {
  emerald: {
    core: "bg-emerald-500 dark:bg-emerald-400",
    halo: "bg-emerald-500/70 dark:bg-emerald-400/70",
    glow: "shadow-[0_0_6px_rgba(16,185,129,0.55)]",
  },
  amber: {
    core: "bg-amber-500 dark:bg-amber-400",
    halo: "bg-amber-500/70 dark:bg-amber-400/70",
    glow: "shadow-[0_0_6px_rgba(245,158,11,0.55)]",
  },
  indigo: {
    core: "bg-indigo-500 dark:bg-indigo-400",
    halo: "bg-indigo-500/70 dark:bg-indigo-400/70",
    glow: "shadow-[0_0_6px_rgba(99,102,241,0.55)]",
  },
  rose: {
    core: "bg-rose-500 dark:bg-rose-400",
    halo: "bg-rose-500/70 dark:bg-rose-400/70",
    glow: "shadow-[0_0_6px_rgba(244,63,94,0.55)]",
  },
  zinc: {
    core: "bg-zinc-400 dark:bg-zinc-500",
    halo: "bg-zinc-400/60 dark:bg-zinc-500/60",
    glow: "",
  },
};

export function LivePulseDot({
  tone = "emerald",
  active = true,
  className,
}: LivePulseDotProps) {
  const palette = LIVE_PULSE_TONES[tone];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-2 w-2 shrink-0 items-center justify-center",
        className,
      )}
    >
      {active ? (
        <span
          data-rd-pulse="true"
          className={cn(
            "absolute inline-flex h-full w-full rounded-full animate-ping opacity-65",
            palette.halo,
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex h-1.5 w-1.5 rounded-full transition-opacity",
          palette.core,
          active ? palette.glow : "opacity-55",
        )}
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* ResolutionBadge                                                            */
/* -------------------------------------------------------------------------- */

export interface ResolutionBadgeProps {
  resolution: TaskResolution;
  triagedBy?: string;
  compact?: boolean;
  className?: string;
}

export function ResolutionBadge({
  resolution,
  triagedBy,
  compact = false,
  className,
}: ResolutionBadgeProps) {
  if (!resolution) return null;

  const iconSize = compact ? 11 : 12;

  let pillClass: string;
  let iconName: string;
  let label: string;

  if (resolution === "shipped") {
    pillClass =
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]";
    iconName = "check-circle-2";
    label = "已自动交付";
  } else if (resolution === "dismissed") {
    pillClass =
      "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/20";
    iconName = triagedBy === "server_ai" ? "shield-check" : "filter";
    label = triagedBy === "server_ai" ? "AI 预筛归档" : "已过滤归档";
  } else {
    pillClass =
      "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25";
    iconName = "git-merge";
    label = "已合并去重";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        pillClass,
        className,
      )}
    >
      <Icon name={iconName} size={iconSize} />
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* DeployStatusBadge                                                          */
/* -------------------------------------------------------------------------- */

export interface DeployStatusBadgeProps {
  status: TaskDeployStatus | undefined;
  releaseNumber?: number | null;
  compact?: boolean;
  className?: string;
}

export function DeployStatusBadge({
  status,
  releaseNumber,
  compact = false,
  className,
}: DeployStatusBadgeProps) {
  if (!status || status === "not_required") return null;

  const iconSize = compact ? 11 : 12;
  let pillClass =
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25";
  let iconName = "clock";
  let spin = false;

  if (status === "deploying") {
    pillClass =
      "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25";
    iconName = "loader-2";
    spin = true;
  } else if (status === "deployed") {
    pillClass =
      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25";
    iconName = "rocket";
  } else if (status === "failed") {
    pillClass =
      "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25";
    iconName = "alert-circle";
  }

  const label = TASK_DEPLOY_STATUS_LABELS[status];
  const relSuffix =
    typeof releaseNumber === "number" && releaseNumber > 0
      ? ` · ${releaseCode(releaseNumber)}`
      : "";

  return (
    <span
      title={`生产发布状态：${label}${relSuffix}`}
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        pillClass,
        className,
      )}
    >
      <Icon name={iconName} size={iconSize} className={spin ? "animate-spin" : undefined} />
      <span>
        {label}
        {relSuffix}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* ReleaseStatusBadge & ReleaseTriggerBadge                                   */
/* -------------------------------------------------------------------------- */

export function ReleaseStatusBadge({
  status,
  compact = false,
  className,
}: {
  status: ReleaseStatus;
  compact?: boolean;
  className?: string;
}) {
  const iconSize = compact ? 11 : 12;
  const styles: Record<ReleaseStatus, { pill: string; icon: string; spin?: boolean }> = {
    running: {
      pill: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
      icon: "loader-2",
      spin: true,
    },
    verifying: {
      pill: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
      icon: "shield-check",
    },
    succeeded: {
      pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
      icon: "check-circle-2",
    },
    failed: {
      pill: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25",
      icon: "x-circle",
    },
    blocked: {
      pill: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
      icon: "ban",
    },
  };
  const cfg = styles[status];

  return (
    <span
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        cfg.pill,
        className,
      )}
    >
      <Icon name={cfg.icon} size={iconSize} className={cfg.spin ? "animate-spin" : undefined} />
      <span>{RELEASE_STATUS_LABELS[status]}</span>
    </span>
  );
}

export function ReleaseTriggerBadge({
  trigger,
  className,
}: {
  trigger: ReleaseTrigger | "ai_gate" | (string & {});
  className?: string;
}) {
  const iconMap: Record<string, string> = {
    immediate: "zap",
    scheduled: "calendar-clock",
    urgent: "alert-triangle",
    manual: "hand",
    ai_gate: "sparkles",
  };
  const toneMap: Record<string, string> = {
    immediate: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
    scheduled: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25",
    urgent: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25",
    manual: "bg-[var(--rd-subtle)] text-[var(--rd-muted)] border-[var(--rd-border)]",
    ai_gate: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  };
  const labelMap: Record<string, string> = {
    ...RELEASE_TRIGGER_LABELS,
    ai_gate: "AI 门禁放行",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-medium leading-none whitespace-nowrap select-none",
        toneMap[trigger] ?? toneMap.manual,
        className,
      )}
    >
      <Icon name={iconMap[trigger] ?? "rocket"} size={11} />
      <span>{labelMap[trigger] ?? trigger}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* DeliveryModeBadge                                                          */
/* -------------------------------------------------------------------------- */

export interface DeliveryModeBadgeProps {
  mode: DeliveryMode;
  compact?: boolean;
  className?: string;
}

const DELIVERY_MODE_VISUALS: Record<
  DeliveryMode,
  { pill: string; icon: "zap" | "git-pull-request" | "eye" }
> = {
  direct_push: {
    pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
    icon: "zap",
  },
  pr_automerge: {
    pill: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25",
    icon: "git-pull-request",
  },
  review_only: {
    pill: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border-zinc-500/20",
    icon: "eye",
  },
};

// Inline Lucide git-pull-request icon so DeliveryModeBadge makes zero CDN requests.
function GitPullRequestGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" x2="6" y1="9" y2="21" />
    </svg>
  );
}

export function DeliveryModeBadge({
  mode,
  compact = false,
  className,
}: DeliveryModeBadgeProps) {
  const visual = DELIVERY_MODE_VISUALS[mode];
  const label = DELIVERY_MODE_LABELS[mode];
  const description = DELIVERY_MODE_DESCRIPTIONS[mode];
  const iconSize = compact ? 11 : 12;

  return (
    <span
      title={description}
      className={cn(
        "inline-flex items-center font-medium border whitespace-nowrap select-none rounded-full",
        compact
          ? "px-1.5 py-0.5 text-[11px] leading-none gap-1"
          : "px-2 py-0.5 text-xs leading-4 gap-1.5",
        visual.pill,
        className,
      )}
    >
      {visual.icon === "git-pull-request" ? (
        <GitPullRequestGlyph size={iconSize} />
      ) : (
        <Icon name={visual.icon} size={iconSize} />
      )}
      <span>{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                      */
/* -------------------------------------------------------------------------- */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  maxWidth?: "sm" | "md" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}

const MODAL_WIDTH_CLASS: Record<NonNullable<ModalProps["maxWidth"]>, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidth = "md",
  children,
  footer,
}: ModalProps) {
  const titleId = useId();
  const subtitleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    const rafId = window.requestAnimationFrame(() => {
      const node = dialogRef.current;
      if (node && !node.contains(document.activeElement)) {
        node.focus();
      }
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-[var(--rd-backdrop)] backdrop-blur-[3px] animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full flex flex-col max-h-[90dvh] sm:max-h-[88vh] overflow-hidden rounded-t-2xl sm:rounded-xl outline-none",
          "bg-[var(--rd-surface)] dark:bg-[var(--rd-elevated)] border-t sm:border border-[var(--rd-border)] shadow-[var(--rd-shadow-lg)] animate-sheet-in sm:animate-modal-in",
          MODAL_WIDTH_CLASS[maxWidth],
        )}
      >
        <div className="flex items-start justify-between gap-3 sm:gap-4 px-4 sm:px-5 py-3.5 sm:py-4 border-b border-[var(--rd-border)]">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--rd-ink)]"
            >
              {title}
            </h2>
            {subtitle ? (
              <p
                id={subtitleId}
                className="mt-1 text-[13px] leading-relaxed text-[var(--rd-muted)]"
              >
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="inline-flex items-center justify-center w-9 h-9 sm:w-7 sm:h-7 -mr-1 sm:mr-0 rounded-lg sm:rounded-md text-[var(--rd-muted)] hover:text-[var(--rd-ink)] hover:bg-[var(--rd-hover)] transition-colors rd-focus-ring shrink-0"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div
          className={cn(
            "px-4 sm:px-5 py-3.5 sm:py-4 overflow-y-auto rd-scroll",
            !footer && "pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4",
          )}
        >
          {children}
        </div>

        {footer ? (
          <div className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:pb-3.5 border-t border-[var(--rd-border)] bg-[var(--rd-subtle)]/55">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CopyButton                                                                 */
/* -------------------------------------------------------------------------- */

export interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  size?: "xs" | "sm";
  variant?: "secondary" | "ghost" | "subtle";
  onCopied?: () => void;
  className?: string;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to textarea fallback.
    }
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return ok;
}

export function CopyButton({
  value,
  label = "复制",
  copiedLabel = "已复制",
  size = "xs",
  variant = "secondary",
  onCopied,
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(value);
    if (!ok) return;
    setCopied(true);
    onCopied?.();
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1800);
  }, [value, onCopied]);

  const iconOnly = label === "";
  const iconSize = size === "xs" ? 13 : 14;

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => {
        void handleCopy();
      }}
      aria-label={copied ? copiedLabel : label || "复制"}
      title={copied ? copiedLabel : label || "复制"}
      className={cn(iconOnly && "px-1.5", className)}
    >
      <Icon
        name={copied ? "check" : "copy"}
        size={iconSize}
        className={copied ? "text-emerald-600 dark:text-emerald-400" : undefined}
      />
      {!iconOnly ? <span>{copied ? copiedLabel : label}</span> : null}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* EmptyState                                                                 */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-8 px-4" : "py-14 px-6",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-xl border border-[var(--rd-border)] bg-[var(--rd-subtle)] text-[var(--rd-muted)] mb-3.5",
          compact ? "w-9 h-9" : "w-11 h-11",
        )}
      >
        <Icon name={icon} size={compact ? 17 : 20} />
      </div>
      <h3 className="text-sm font-medium text-[var(--rd-ink)]">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--rd-muted)] max-w-sm">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Kbd                                                                        */
/* -------------------------------------------------------------------------- */

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cn("rd-kbd", className)}>{children}</kbd>;
}

/* -------------------------------------------------------------------------- */
/* ToastProvider & useToast                                                   */
/* -------------------------------------------------------------------------- */

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_VISUALS: Record<
  ToastTone,
  { icon: string; iconClass: string; borderClass: string }
> = {
  success: {
    icon: "check-circle-2",
    iconClass: "text-emerald-600 dark:text-emerald-400",
    borderClass: "border-emerald-500/25",
  },
  error: {
    icon: "alert-circle",
    iconClass: "text-rose-600 dark:text-rose-400",
    borderClass: "border-rose-500/30",
  },
  info: {
    icon: "circle-dot",
    iconClass: "text-indigo-600 dark:text-indigo-400",
    borderClass: "border-[var(--rd-border)]",
  },
};

export interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const seqRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      seqRef.current += 1;
      const id = `rd-toast-${seqRef.current}`;
      setToasts((prev) => {
        const next = [...prev, { id, tone, message }];
        if (next.length > 5) {
          const dropped = next.shift();
          if (dropped) {
            const oldTimer = timersRef.current.get(dropped.id);
            if (oldTimer !== undefined) {
              window.clearTimeout(oldTimer);
              timersRef.current.delete(dropped.id);
            }
          }
        }
        return next;
      });

      const durationMs = tone === "error" ? 4800 : 3200;
      const timer = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, durationMs);
      timersRef.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push("success", message),
      error: (message: string) => push("error", message),
      info: (message: string) => push("info", message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="fixed top-[max(0.75rem,env(safe-area-inset-top))] inset-x-4 mx-auto sm:top-auto sm:inset-x-auto sm:mx-0 sm:bottom-4 sm:right-4 z-[60] flex flex-col gap-2 w-auto sm:w-[calc(100vw-2rem)] max-w-[360px] pointer-events-none"
      >
        {toasts.map((item) => {
          const visual = TOAST_VISUALS[item.tone];
          return (
            <div
              key={item.id}
              role={item.tone === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border animate-toast-in",
                "bg-[var(--rd-surface)] dark:bg-[var(--rd-elevated)] text-[var(--rd-ink)] shadow-[var(--rd-shadow-md)]",
                visual.borderClass,
              )}
            >
              <Icon
                name={visual.icon}
                size={15}
                className={cn("mt-0.5", visual.iconClass)}
              />
              <p className="flex-1 min-w-0 text-[13px] leading-snug break-words">
                {item.message}
              </p>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="关闭提示"
                className="inline-flex items-center justify-center w-5 h-5 rounded text-[var(--rd-muted)] hover:text-[var(--rd-ink)] hover:bg-[var(--rd-hover)] transition-colors rd-focus-ring shrink-0"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Switch                                                                     */
/* -------------------------------------------------------------------------- */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  description?: string;
  className?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  description,
  className,
}: SwitchProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;

  const toggleButton = (
    <button
      id={controlId}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors duration-150 rd-focus-ring",
        checked
          ? "bg-[var(--rd-accent)]"
          : "bg-zinc-300 dark:bg-zinc-700",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );

  if (!label && !description) {
    return <span className={cn("inline-flex", className)}>{toggleButton}</span>;
  }

  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3",
        disabled && "opacity-60",
        className,
      )}
    >
      <div className="min-w-0">
        {label ? (
          <label
            htmlFor={controlId}
            className={cn(
              "block text-[13px] font-medium text-[var(--rd-ink)] leading-5",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            {label}
          </label>
        ) : null}
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--rd-muted)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="pt-0.5 shrink-0">{toggleButton}</div>
    </div>
  );
}

export {
  Select,
  type SelectOption,
  type SelectProps,
  type SelectSize,
  type SelectVariant,
} from "./Select.tsx";

