import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { api } from "~/lib/api.ts";
import {
  clampQuotaPercent,
  computeArcLength,
  describeSemiArcPath,
  formatAccountPlan,
  formatResetFull,
  formatResetShort,
  formatWindowLabel,
  getAccountHarnessLogo,
  getQuotaTone,
  polarToCartesian,
  selectDualRingWindows,
  type QuotaTone,
} from "~/lib/sidebar-accounts.ts";
import type { SidebarAccount } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { RollingNumber, SmoothCollapse } from "./MotionPrimitives.tsx";

const FALLBACK_AVATAR = "https://axm.moe/avatar";
export type SidebarAccountList = SidebarAccount[] | "loading" | "error";

const GAUGE_SIZE = 48;
const GAUGE_CX = 24;
const GAUGE_CY = 23.5;
const GAUGE_START_DEG = 172;
const GAUGE_END_DEG = 368;
const GAUGE_SWEEP_DEG = GAUGE_END_DEG - GAUGE_START_DEG;
const OUTER_ARC_RADIUS = 18.5;
const INNER_ARC_RADIUS = 14.0;
const OUTER_ARC_STROKE = 2.8;
const INNER_ARC_STROKE = 2.2;
const TICK_INNER_RADIUS = 21.1;
const TICK_OUTER_RADIUS = 22.4;
const TICK_RATIOS = [0, 0.25, 0.5, 0.75, 1] as const;

const OUTER_ARC_PATH = describeSemiArcPath(
  GAUGE_CX,
  GAUGE_CY,
  OUTER_ARC_RADIUS,
  GAUGE_START_DEG,
  GAUGE_END_DEG,
);
const INNER_ARC_PATH = describeSemiArcPath(
  GAUGE_CX,
  GAUGE_CY,
  INNER_ARC_RADIUS,
  GAUGE_START_DEG,
  GAUGE_END_DEG,
);
const OUTER_ARC_LEN = Math.round(computeArcLength(OUTER_ARC_RADIUS, GAUGE_SWEEP_DEG) * 100) / 100;
const INNER_ARC_LEN = Math.round(computeArcLength(INNER_ARC_RADIUS, GAUGE_SWEEP_DEG) * 100) / 100;

const GAUGE_TICKS = TICK_RATIOS.map((ratio) => {
  const angle = GAUGE_START_DEG + GAUGE_SWEEP_DEG * ratio;
  return {
    ratio,
    p1: polarToCartesian(GAUGE_CX, GAUGE_CY, TICK_INNER_RADIUS, angle),
    p2: polarToCartesian(GAUGE_CX, GAUGE_CY, TICK_OUTER_RADIUS, angle),
  };
});

const BAR_FILL_STYLES: Record<QuotaTone, string> = {
  healthy: "bg-emerald-500 dark:bg-emerald-400/90",
  low: "bg-amber-500 dark:bg-amber-400",
  critical: "bg-rose-500 dark:bg-rose-400",
  unknown: "bg-transparent",
};

const PERCENT_TEXT_STYLES: Record<QuotaTone, string> = {
  healthy: "text-[var(--text-primary)]",
  low: "text-amber-700 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
  unknown: "text-[var(--text-muted)]",
};

const OUTER_DOT_STYLES: Record<QuotaTone, string> = {
  healthy: "bg-emerald-500 dark:bg-emerald-400",
  low: "bg-amber-500 dark:bg-amber-400",
  critical: "bg-rose-500 dark:bg-rose-400",
  unknown: "bg-[var(--text-muted)]",
};

const INNER_DOT_STYLES: Record<QuotaTone, string> = {
  healthy: "bg-sky-500 dark:bg-sky-400",
  low: "bg-amber-500 dark:bg-amber-400",
  critical: "bg-rose-500 dark:bg-rose-400",
  unknown: "bg-[var(--text-muted)]",
};

const GAUGE_OUTER_READOUT_STYLES: Record<QuotaTone, string> = {
  healthy: "text-emerald-600 dark:text-emerald-400",
  low: "text-amber-600 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
  unknown: "text-[var(--text-muted)]",
};

const GAUGE_INNER_READOUT_STYLES: Record<QuotaTone, string> = {
  healthy: "text-sky-600 dark:text-sky-400",
  low: "text-amber-600 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
  unknown: "text-[var(--text-muted)]",
};

function getArcGradientStops(tone: QuotaTone, layer: "outer" | "inner") {
  if (tone === "low") {
    return layer === "outer"
      ? [
          { offset: "0%", color: "#f59e0b" },
          { offset: "100%", color: "#fbbf24" },
        ]
      : [
          { offset: "0%", color: "#d97706" },
          { offset: "100%", color: "#fbbf24" },
        ];
  }
  if (tone === "critical") {
    return [
      { offset: "0%", color: "#e11d48" },
      { offset: "100%", color: "#fb7185" },
    ];
  }
  if (tone === "unknown") {
    return [
      { offset: "0%", color: "#a1a1aa" },
      { offset: "100%", color: "#a1a1aa" },
    ];
  }
  if (layer === "inner") {
    return [
      { offset: "0%", color: "#0284c7" },
      { offset: "50%", color: "#38bdf8" },
      { offset: "100%", color: "#22d3ee" },
    ];
  }
  return [
    { offset: "0%", color: "#10b981" },
    { offset: "50%", color: "#34d399" },
    { offset: "100%", color: "#2dd4bf" },
  ];
}

function getTipAccentColor(tone: QuotaTone, layer: "outer" | "inner"): string {
  if (tone === "low") return "#fbbf24";
  if (tone === "critical") return "#fb7185";
  if (tone === "unknown") return "#a1a1aa";
  return layer === "inner" ? "#38bdf8" : "#34d399";
}

function getHarnessGlowColor(service: string): string {
  switch (service.trim().toLowerCase()) {
    case "codex":
    case "openai":
      return "rgba(99, 102, 241, 0.22)";
    case "gemini":
    case "agy":
    case "antigravity":
      return "rgba(56, 189, 248, 0.22)";
    case "claude":
    case "anthropic":
      return "rgba(217, 119, 87, 0.24)";
    default:
      return "rgba(99, 102, 241, 0.16)";
  }
}

export function useSidebarAccounts(): { accounts: SidebarAccountList; reload: () => void } {
  const [snapshot, setSnapshot] = useState<SidebarAccountList>("loading");
  const versionRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  const load = useCallback(async (showLoading = false) => {
    const current = ++versionRef.current;
    window.clearTimeout(timerRef.current);
    if (showLoading) setSnapshot("loading");
    let accounts: SidebarAccountList = "error";
    try {
      const response = await api.getSidebarAccounts();
      if (Array.isArray(response.accounts)) accounts = response.accounts;
    } catch {
      // Retry transient failures on focus, manual retry, or the next refresh.
    }
    if (current !== versionRef.current) return;
    setSnapshot(accounts);
    timerRef.current = window.setTimeout(() => {
      if (!document.hidden) void load(false);
    }, 60_000);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void load(false);
    };
    void load(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      versionRef.current++;
      window.clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const reload = useCallback(() => {
    void load(true);
  }, [load]);

  return { accounts: snapshot, reload };
}

function HarnessLogoBadge({
  service,
  sizeClass = "size-[20px]",
  iconSize = 11,
}: {
  service: string;
  sizeClass?: string;
  iconSize?: number;
}) {
  const logoSrc = getAccountHarnessLogo(service);
  const isCodex = logoSrc === "/runtime-logos/codex.svg";

  return (
    <span
      className={`${sizeClass} rounded-full bg-[var(--surface-card)] ring-1 ring-black/[0.07] dark:ring-white/[0.09] flex items-center justify-center overflow-hidden shadow-2xs shrink-0`}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          className={isCodex ? "w-full h-full rounded-full object-cover" : "w-[64%] h-[64%] object-contain"}
        />
      ) : (
        <Icon name="sparkles" size={iconSize} className="text-[var(--text-secondary)]" />
      )}
    </span>
  );
}

function getAccountDisplayMeta(account: SidebarAccount, preferIdentitySubtitle: boolean) {
  const name = account.name?.trim() || "未命名账号";
  const plan = formatAccountPlan(account.service, account.plan);
  const subtitleParts = [name];
  if (preferIdentitySubtitle && account.identity && account.identity !== name) {
    subtitleParts.push(account.identity);
  } else if (account.nodeName) {
    subtitleParts.push(account.nodeName);
  }
  const subtitle = subtitleParts.join(" · ");
  const headerTitle = [
    `${account.service} · ${plan}`,
    name,
    account.identity && account.identity !== name ? account.identity : null,
    account.nodeName ?? null,
  ]
    .filter(Boolean)
    .join(" — ");
  return { name, plan, subtitle, headerTitle };
}

function QuotaWindowBar({
  service,
  window,
  ringHint,
}: {
  service: string;
  window: SidebarAccount["windows"][number];
  ringHint?: { label: "外弧" | "内弧"; dotClass: string };
}) {
  const shortLabel = formatWindowLabel(service, window.label);
  const clamped = clampQuotaPercent(window.remainingPercent);
  const tone = getQuotaTone(clamped);
  const resetDate = window.resetsAt ? new Date(window.resetsAt) : null;
  const hasReset = Boolean(resetDate && Number.isFinite(resetDate.getTime()));
  const shortReset = formatResetShort(window.resetsAt);
  const fullReset = formatResetFull(window.resetsAt);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 leading-none">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span
            className="font-mono text-[10.5px] font-medium text-[var(--text-secondary)] shrink-0"
            title={window.label !== shortLabel ? window.label : undefined}
          >
            {shortLabel}
          </span>
          {ringHint && (
            <span className="inline-flex items-center gap-1 rounded px-1 py-[1px] text-[9px] font-medium bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-muted)] shrink-0">
              <span aria-hidden="true" className={`size-[5px] rounded-full ${ringHint.dotClass}`} />
              {ringHint.label}
            </span>
          )}
          {hasReset && resetDate ? (
            <time
              dateTime={resetDate.toISOString()}
              title={fullReset}
              className="text-[10px] text-[var(--text-muted)] tabular-nums truncate"
            >
              {shortReset}
            </time>
          ) : (
            <span className="text-[10px] text-[var(--text-muted)] truncate">{shortReset}</span>
          )}
        </div>
        <span
          className={`font-mono text-[11px] font-semibold tabular-nums shrink-0 ${PERCENT_TEXT_STYLES[tone]}`}
        >
          {clamped !== null ? (
            <RollingNumber value={clamped} format={(n) => `${n}%`} />
          ) : (
            "未知"
          )}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${service} ${window.label} 剩余额度`}
        aria-valuenow={clamped ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={clamped !== null ? `剩余 ${clamped}%` : "额度未知"}
        className="h-[6px] w-full overflow-hidden rounded-full bg-[var(--rd-tray)] ring-1 ring-inset ring-black/[0.04] dark:ring-white/[0.05]"
      >
        {clamped !== null && clamped > 0 && (
          <div
            className={`h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] transition-[width] duration-500 ease-[var(--ease-out)] ${BAR_FILL_STYLES[tone]}`}
            style={{ width: `${clamped}%`, minWidth: clamped < 3 ? "4px" : undefined }}
          />
        )}
      </div>
    </div>
  );
}

function AccountCard({
  account,
  preferIdentitySubtitle,
}: {
  account: SidebarAccount;
  preferIdentitySubtitle: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { plan, subtitle, headerTitle } = getAccountDisplayMeta(account, preferIdentitySubtitle);

  return (
    <li className="rounded-xl border border-[var(--border-subtle)] rd-plate px-2.5 py-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        title={headerTitle}
        onClick={() => setExpanded((prev) => !prev)}
        className="group w-full flex items-center gap-2 text-left rounded-lg -mx-1 px-1 py-0.5 transition-colors duration-150 hover:bg-[var(--surface-hover)]/80 active:bg-[var(--surface-active)] rd-press rd-focus-ring cursor-pointer"
      >
        <img
          src={account.avatarUrl?.trim() || FALLBACK_AVATAR}
          alt=""
          referrerPolicy="no-referrer"
          className="size-6 shrink-0 rounded-full bg-[var(--surface-hover)] object-cover ring-1 ring-black/10 dark:ring-white/10"
          onError={({ currentTarget }) => {
            if (currentTarget.src !== FALLBACK_AVATAR) currentTarget.src = FALLBACK_AVATAR;
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <span className="text-[12px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] truncate leading-tight">
              {account.service}
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <span className="inline-flex items-center rounded-[5px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1.5 py-[2px] text-[10px] font-medium leading-none text-[var(--text-secondary)]">
                {plan}
              </span>
              <Icon
                name="chevron-down"
                size={12}
                className={`text-[var(--text-muted)] opacity-55 group-hover:opacity-100 transition-transform duration-150 ease-out ${
                  expanded ? "rotate-180 opacity-100" : ""
                }`}
              />
            </span>
          </div>
          <div className="mt-0.5 text-[10.5px] leading-tight text-[var(--text-muted)] truncate">
            {subtitle}
          </div>
        </div>
      </button>

      {account.status === "ready" && account.windows?.length ? (
        <div className="mt-1.5 space-y-1.5">
          {account.windows.map((window, index) => (
            <QuotaWindowBar
              key={`${window.label}-${index}`}
              service={account.service}
              window={window}
            />
          ))}
        </div>
      ) : account.status === "unverified" ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10.5px] text-amber-700 dark:text-amber-300">
          <Icon name="shield-alert" size={12} className="shrink-0" />
          <span className="truncate">账号归属未确认</span>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-1 text-[10.5px] text-[var(--text-muted)]">
          <Icon name="alert-circle" size={12} className="shrink-0" />
          <span className="truncate">额度暂不可用</span>
        </div>
      )}

      <SmoothCollapse open={expanded} id={detailsId}>
        <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-1 text-[10.5px] leading-snug text-[var(--text-muted)] select-text">
          {account.identity && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="user" size={11} className="shrink-0 opacity-70" />
              <span className="font-mono truncate" title={account.identity}>
                {account.identity}
              </span>
            </div>
          )}
          {account.nodeName && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="monitor" size={11} className="shrink-0 opacity-70" />
              <span className="truncate" title={account.nodeName}>
                {account.nodeName}
              </span>
            </div>
          )}
          {account.status === "ready" && account.windows?.length > 0 && (
            <div className="pt-0.5 space-y-0.5">
              {account.windows.map((window, index) => (
                <div
                  key={`detail-${window.label}-${index}`}
                  className="flex items-center justify-between gap-2 text-[10px] tabular-nums"
                >
                  <span className="truncate text-[var(--text-secondary)]">{window.label}</span>
                  <span className="shrink-0">{formatResetFull(window.resetsAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </SmoothCollapse>
    </li>
  );
}

function CompactAccountGaugeItem({
  account,
  preferIdentitySubtitle,
}: {
  account: SidebarAccount;
  preferIdentitySubtitle: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const uid = useId().replace(/:/g, "");

  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 70, bottom: 16 });
  const open = hovered || pinned;

  const { plan, subtitle, headerTitle } = getAccountDisplayMeta(account, preferIdentitySubtitle);
  const { outer, inner } = selectDualRingWindows(account.service, account.windows ?? []);
  const outerPercent = outer ? clampQuotaPercent(outer.remainingPercent) : null;
  const innerPercent = inner ? clampQuotaPercent(inner.remainingPercent) : null;
  const outerTone = getQuotaTone(outerPercent);
  const innerTone = getQuotaTone(innerPercent);

  const outerOffset =
    outerPercent !== null
      ? Math.round(OUTER_ARC_LEN * (1 - outerPercent / 100) * 100) / 100
      : OUTER_ARC_LEN;
  const innerOffset =
    innerPercent !== null
      ? Math.round(INNER_ARC_LEN * (1 - innerPercent / 100) * 100) / 100
      : INNER_ARC_LEN;

  const outerTip =
    account.status === "ready" && outer && outerPercent !== null && outerPercent > 0
      ? polarToCartesian(
          GAUGE_CX,
          GAUGE_CY,
          OUTER_ARC_RADIUS,
          GAUGE_START_DEG + GAUGE_SWEEP_DEG * (outerPercent / 100),
        )
      : null;
  const innerTip =
    account.status === "ready" && inner && innerPercent !== null && innerPercent > 0
      ? polarToCartesian(
          GAUGE_CX,
          GAUGE_CY,
          INNER_ARC_RADIUS,
          GAUGE_START_DEG + GAUGE_SWEEP_DEG * (innerPercent / 100),
        )
      : null;

  const clearHoverTimers = useCallback(() => {
    window.clearTimeout(openTimerRef.current);
    window.clearTimeout(closeTimerRef.current);
  }, []);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: rect.right + 10,
      bottom: Math.max(12, Math.min(window.innerHeight - 120, window.innerHeight - rect.bottom)),
    });
  }, []);

  useEffect(() => () => clearHoverTimers(), [clearHoverTimers]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const onReposition = () => updatePosition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      clearHoverTimers();
      setPinned(false);
      setHovered(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearHoverTimers();
        setPinned(false);
        setHovered(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, clearHoverTimers]);

  const scheduleOpen = () => {
    window.clearTimeout(closeTimerRef.current);
    if (open) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => {
      updatePosition();
      setHovered(true);
    }, 80);
  };

  const scheduleClose = () => {
    window.clearTimeout(openTimerRef.current);
    if (pinned) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
    }, 160);
  };

  const summaryParts: string[] = [`${account.service} · ${plan}`];
  if (account.status === "ready" && outer) {
    const outerShort = formatWindowLabel(account.service, outer.label);
    summaryParts.push(`${outerShort} ${outerPercent !== null ? `${outerPercent}%` : "未知"}`);
    if (inner) {
      const innerShort = formatWindowLabel(account.service, inner.label);
      summaryParts.push(`${innerShort} ${innerPercent !== null ? `${innerPercent}%` : "未知"}`);
    }
  } else if (account.status === "unverified") {
    summaryParts.push("账号归属未确认");
  } else {
    summaryParts.push("额度暂不可用");
  }
  const ariaSummary = summaryParts.join("，");
  const showDualHint = Boolean(account.status === "ready" && outer && inner);
  const outerStops = getArcGradientStops(outerTone, "outer");
  const innerStops = getArcGradientStops(innerTone, "inner");
  const outerGradientId = `${uid}-outer`;
  const innerGradientId = `${uid}-inner`;

  return (
    <li className="relative flex justify-center">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={ariaSummary}
        title={headerTitle}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onClick={() => {
          clearHoverTimers();
          updatePosition();
          setPinned((prev) => {
            const next = !prev;
            if (!next) setHovered(false);
            return next;
          });
        }}
        className={`group relative w-[48px] h-[48px] rounded-[14px] flex items-center justify-center border transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[0.95] rd-focus-ring cursor-pointer overflow-visible ${
          open
            ? "bg-[var(--surface-card)] border-[var(--border-strong)]/70 shadow-[var(--rd-shadow-sm)]"
            : "bg-[var(--rd-tray)]/55 hover:bg-[var(--surface-card)] border-transparent hover:border-[var(--border-subtle)] hover:shadow-[var(--rd-shadow-sm)]"
        }`}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[14px] overflow-hidden"
        >
          <span
            style={{
              background: `radial-gradient(circle at 50% 42%, ${getHarnessGlowColor(account.service)}, transparent 72%)`,
            }}
            className={`absolute inset-0 transition-opacity duration-200 ${
              open ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          />
        </span>

        <svg
          viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
          width={GAUGE_SIZE}
          height={GAUGE_SIZE}
          aria-hidden="true"
          className="pointer-events-none relative z-10"
        >
          <defs>
            <linearGradient id={outerGradientId} x1="0%" y1="50%" x2="100%" y2="50%">
              {outerStops.map((stop) => (
                <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
            <linearGradient id={innerGradientId} x1="0%" y1="50%" x2="100%" y2="50%">
              {innerStops.map((stop) => (
                <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          </defs>

          {GAUGE_TICKS.map((tick) => (
            <line
              key={tick.ratio}
              data-gauge-tick=""
              x1={tick.p1.x}
              y1={tick.p1.y}
              x2={tick.p2.x}
              y2={tick.p2.y}
              strokeWidth={1}
              strokeLinecap="round"
              className="stroke-black/20 dark:stroke-white/20"
            />
          ))}

          {account.status === "ready" && outer ? (
            <>
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={OUTER_ARC_STROKE}
                strokeLinecap="round"
                className="stroke-black/[0.09] dark:stroke-white/[0.1]"
              />
              {outerPercent !== null && outerPercent > 0 && (
                <path
                  data-ring="outer"
                  d={OUTER_ARC_PATH}
                  fill="none"
                  stroke={`url(#${outerGradientId})`}
                  strokeWidth={OUTER_ARC_STROKE}
                  strokeLinecap="round"
                  strokeDasharray={OUTER_ARC_LEN}
                  strokeDashoffset={outerOffset}
                  style={
                    {
                      "--gauge-len": OUTER_ARC_LEN,
                      "--gauge-offset": outerOffset,
                    } as CSSProperties
                  }
                  className="rd-gauge-arc transition-[stroke-dashoffset] duration-500 ease-[var(--ease-out)]"
                />
              )}
              {outerTip && (
                <g data-gauge-tip="outer">
                  <circle
                    cx={outerTip.x}
                    cy={outerTip.y}
                    r={3.6}
                    fill={getTipAccentColor(outerTone, "outer")}
                    opacity={0.34}
                    className={outerTone === "critical" ? "animate-pulse" : undefined}
                  />
                  <circle cx={outerTip.x} cy={outerTip.y} r={1.55} fill="#ffffff" />
                </g>
              )}

              {inner && (
                <>
                  <path
                    d={INNER_ARC_PATH}
                    fill="none"
                    strokeWidth={INNER_ARC_STROKE}
                    strokeLinecap="round"
                    className="stroke-black/[0.08] dark:stroke-white/[0.09]"
                  />
                  {innerPercent !== null && innerPercent > 0 && (
                    <path
                      data-ring="inner"
                      d={INNER_ARC_PATH}
                      fill="none"
                      stroke={`url(#${innerGradientId})`}
                      strokeWidth={INNER_ARC_STROKE}
                      strokeLinecap="round"
                      strokeDasharray={INNER_ARC_LEN}
                      strokeDashoffset={innerOffset}
                      style={
                        {
                          "--gauge-len": INNER_ARC_LEN,
                          "--gauge-offset": innerOffset,
                        } as CSSProperties
                      }
                      className="rd-gauge-arc transition-[stroke-dashoffset] duration-500 ease-[var(--ease-out)]"
                    />
                  )}
                  {innerTip && (
                    <g data-gauge-tip="inner">
                      <circle
                        cx={innerTip.x}
                        cy={innerTip.y}
                        r={2.8}
                        fill={getTipAccentColor(innerTone, "inner")}
                        opacity={0.34}
                        className={innerTone === "critical" ? "animate-pulse" : undefined}
                      />
                      <circle cx={innerTip.x} cy={innerTip.y} r={1.15} fill="#ffffff" />
                    </g>
                  )}
                </>
              )}
            </>
          ) : account.status === "unverified" ? (
            <>
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="3.5 3"
                className="stroke-amber-500/80 dark:stroke-amber-400/80"
              />
              <path
                d={INNER_ARC_PATH}
                fill="none"
                strokeWidth={1.8}
                strokeLinecap="round"
                className="stroke-black/[0.06] dark:stroke-white/[0.07]"
              />
            </>
          ) : (
            <>
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="3.5 3"
                className="stroke-black/20 dark:stroke-white/20"
              />
              <path
                d={INNER_ARC_PATH}
                fill="none"
                strokeWidth={1.8}
                strokeLinecap="round"
                className="stroke-black/[0.06] dark:stroke-white/[0.07]"
              />
            </>
          )}
        </svg>

        <span
          className={`absolute top-[13.5px] left-1/2 -translate-x-1/2 size-[20px] flex items-center justify-center pointer-events-none z-10 transition-transform duration-300 ease-[var(--ease-spring)] group-hover:-translate-y-[1px] group-hover:-rotate-6 group-hover:scale-[1.08] ${
            open ? "-translate-y-[1px] -rotate-6 scale-[1.08]" : ""
          }`}
        >
          <HarnessLogoBadge service={account.service} sizeClass="size-[20px]" iconSize={11} />
        </span>

        {account.status === "unverified" && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-amber-500 ring-2 ring-[var(--surface-sidebar)] animate-pulse pointer-events-none z-20"
          />
        )}

        <span className="absolute bottom-[1.5px] inset-x-0 flex justify-center pointer-events-none z-20">
          <span
            data-gauge-readout=""
            className="inline-flex items-center px-1.5 py-[1px] rounded-full bg-[var(--surface-sidebar)]/90 border border-[var(--border-subtle)]/75 text-[8.5px] leading-none font-mono font-semibold tabular-nums shadow-2xs"
          >
            {account.status === "ready" && outer && inner ? (
              <>
                <span className={GAUGE_OUTER_READOUT_STYLES[outerTone]}>
                  {outerPercent ?? "--"}
                </span>
                <span className="opacity-40 mx-[1px]">·</span>
                <span className={GAUGE_INNER_READOUT_STYLES[innerTone]}>
                  {innerPercent ?? "--"}
                </span>
              </>
            ) : account.status === "ready" && outer ? (
              <span className={GAUGE_OUTER_READOUT_STYLES[outerTone]}>
                {outerPercent !== null ? `${outerPercent}%` : "--"}
              </span>
            ) : account.status === "unverified" ? (
              <span className="text-amber-600 dark:text-amber-400">?!</span>
            ) : (
              <span className="text-[var(--text-muted)]">--</span>
            )}
          </span>
        </span>
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`${account.service} 额度详情`}
            onMouseEnter={() => {
              window.clearTimeout(closeTimerRef.current);
              setHovered(true);
            }}
            onMouseLeave={scheduleClose}
            style={{ left: pos.left, bottom: pos.bottom, transformOrigin: "bottom left" }}
            className="fixed z-50 w-[252px] rounded-xl border border-[var(--border-strong)]/80 bg-[var(--rd-plate)]/98 backdrop-blur-md shadow-[var(--rd-shadow-lg)] p-2.5 animate-popover-in"
          >
            <div className="flex items-center gap-2 pb-2 border-b border-[var(--border-subtle)]">
              <HarnessLogoBadge service={account.service} sizeClass="size-6" iconSize={13} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[12px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] truncate leading-tight">
                    {account.service}
                  </span>
                  <span className="inline-flex items-center rounded-[5px] border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1.5 py-[2px] text-[10px] font-medium leading-none text-[var(--text-secondary)] shrink-0">
                    {plan}
                  </span>
                </div>
                <div className="mt-0.5 text-[10.5px] leading-tight text-[var(--text-muted)] truncate">
                  {subtitle}
                </div>
              </div>
            </div>

            {account.status === "ready" && account.windows?.length ? (
              <div className="mt-2 space-y-2">
                {account.windows.map((window, index) => (
                  <QuotaWindowBar
                    key={`${window.label}-${index}`}
                    service={account.service}
                    window={window}
                    ringHint={
                      showDualHint
                        ? window === outer
                          ? { label: "外弧", dotClass: OUTER_DOT_STYLES[outerTone] }
                          : window === inner
                            ? { label: "内弧", dotClass: INNER_DOT_STYLES[innerTone] }
                            : undefined
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : account.status === "unverified" ? (
              <div className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10.5px] text-amber-700 dark:text-amber-300">
                <Icon name="shield-alert" size={12} className="shrink-0" />
                <span className="truncate">账号归属未确认</span>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-1 text-[10.5px] text-[var(--text-muted)]">
                <Icon name="alert-circle" size={12} className="shrink-0" />
                <span className="truncate">额度暂不可用</span>
              </div>
            )}

            {(account.identity || account.nodeName || (account.status === "ready" && account.windows?.length > 0)) && (
              <div className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-1 text-[10.5px] leading-snug text-[var(--text-muted)] select-text">
                {account.identity && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon name="user" size={11} className="shrink-0 opacity-70" />
                    <span className="font-mono truncate" title={account.identity}>
                      {account.identity}
                    </span>
                  </div>
                )}
                {account.nodeName && (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon name="monitor" size={11} className="shrink-0 opacity-70" />
                    <span className="truncate" title={account.nodeName}>
                      {account.nodeName}
                    </span>
                  </div>
                )}
                {account.status === "ready" && account.windows?.length > 0 && (
                  <div className="pt-0.5 space-y-0.5">
                    {account.windows.map((window, index) => (
                      <div
                        key={`pop-detail-${window.label}-${index}`}
                        className="flex items-center justify-between gap-2 text-[10px] tabular-nums"
                      >
                        <span className="truncate text-[var(--text-secondary)]">{window.label}</span>
                        <span className="shrink-0">{formatResetFull(window.resetsAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </li>
  );
}

export function SidebarAccounts({
  accounts,
  onRetry,
  compact = false,
}: {
  accounts: SidebarAccountList;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (compact) {
    if (accounts === "loading") {
      const scanSeg = Math.round(OUTER_ARC_LEN * 0.36);
      return (
        <section aria-label="绑定账号" role="status" className="flex justify-center py-0.5">
          <span className="sr-only">正在读取绑定账号…</span>
          <div
            aria-hidden="true"
            className="w-[48px] h-[48px] rounded-[14px] bg-[var(--rd-tray)]/55 flex items-center justify-center relative"
          >
            <svg
              viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
              width={GAUGE_SIZE}
              height={GAUGE_SIZE}
              className="pointer-events-none"
            >
              {GAUGE_TICKS.map((tick) => (
                <line
                  key={tick.ratio}
                  x1={tick.p1.x}
                  y1={tick.p1.y}
                  x2={tick.p2.x}
                  y2={tick.p2.y}
                  strokeWidth={1}
                  strokeLinecap="round"
                  className="stroke-black/15 dark:stroke-white/15"
                />
              ))}
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={OUTER_ARC_STROKE}
                strokeLinecap="round"
                className="stroke-black/[0.08] dark:stroke-white/[0.08]"
              />
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={OUTER_ARC_STROKE}
                strokeLinecap="round"
                strokeDasharray={`${scanSeg} ${Math.round(OUTER_ARC_LEN)}`}
                style={
                  {
                    "--gauge-scan-start": scanSeg,
                    "--gauge-scan-end": -Math.round(OUTER_ARC_LEN),
                  } as CSSProperties
                }
                className="stroke-indigo-400/75 rd-gauge-scan"
              />
            </svg>
            <div className="absolute top-[13.5px] left-1/2 -translate-x-1/2 size-[20px] rounded-full bg-[var(--surface-hover)] animate-pulse" />
          </div>
        </section>
      );
    }

    if (accounts === "error") {
      return (
        <section aria-label="绑定账号" role="status" className="flex justify-center py-0.5">
          <button
            type="button"
            onClick={onRetry}
            aria-label="额度读取失败，点击重试"
            title="额度读取失败，点击重试"
            className="w-[48px] h-[48px] rounded-[14px] bg-rose-500/[0.05] hover:bg-rose-500/12 active:scale-[0.95] transition-[background-color,transform] duration-150 rd-focus-ring cursor-pointer relative flex items-center justify-center"
          >
            <svg
              viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
              width={GAUGE_SIZE}
              height={GAUGE_SIZE}
              aria-hidden="true"
              className="pointer-events-none"
            >
              <path
                d={OUTER_ARC_PATH}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="3.5 3"
                className="stroke-rose-500/55 dark:stroke-rose-400/55"
              />
            </svg>
            <Icon
              name="alert-circle"
              size={14}
              className="text-rose-600 dark:text-rose-400 absolute top-[17px] left-1/2 -translate-x-1/2"
            />
          </button>
        </section>
      );
    }

    if (accounts.length === 0) {
      return null;
    }

    const serviceNameCounts = new Map<string, number>();
    for (const account of accounts) {
      const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "未命名账号").toLowerCase()}`;
      serviceNameCounts.set(key, (serviceNameCounts.get(key) ?? 0) + 1);
    }

    return (
      <section
        aria-label="绑定账号"
        className="w-full max-h-[30dvh] overflow-y-auto overflow-x-hidden rd-scroll py-0.5"
      >
        <ul className="flex flex-col items-center gap-2">
          {accounts.map((account) => {
            const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "未命名账号").toLowerCase()}`;
            return (
              <CompactAccountGaugeItem
                key={account.id}
                account={account}
                preferIdentitySubtitle={(serviceNameCounts.get(key) ?? 0) > 1}
              />
            );
          })}
        </ul>
      </section>
    );
  }

  if (accounts === "loading") {
    return (
      <section aria-label="绑定账号" role="status" className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-2 shadow-2xs">
        <span className="sr-only">正在读取绑定账号…</span>
        <div aria-hidden="true" className="animate-pulse space-y-2">
          <div className="flex items-center gap-2">
            <div className="size-6 rounded-full bg-[var(--surface-hover)] shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2.5 w-16 rounded bg-[var(--surface-hover)]" />
              <div className="h-2 w-24 rounded bg-[var(--surface-hover)]" />
            </div>
          </div>
          <div className="h-1 w-full rounded-full bg-[var(--surface-hover)]" />
        </div>
      </section>
    );
  }

  if (accounts === "error") {
    return (
      <section
        aria-label="绑定账号"
        role="status"
        className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/20 bg-rose-500/[0.04] px-2.5 py-2 text-[11px] text-rose-700 dark:text-rose-300"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <Icon name="alert-circle" size={13} className="shrink-0" />
          <span className="truncate">额度读取失败</span>
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-md border border-rose-500/25 bg-[var(--surface-card)] px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 active:scale-[0.96] transition-[background-color,transform] duration-150 rd-focus-ring shrink-0 cursor-pointer"
          >
            <Icon name="refresh-cw" size={10} />
            重试
          </button>
        )}
      </section>
    );
  }

  if (accounts.length === 0) {
    return (
      <section
        aria-label="绑定账号"
        role="status"
        className="rounded-lg border border-dashed border-[var(--border-subtle)] px-2.5 py-2 text-[11px] text-[var(--text-muted)]"
      >
        暂无在线节点账号
      </section>
    );
  }

  // If multiple accounts share the same service and display name, show identity (email) in the subtitle to disambiguate.
  const serviceNameCounts = new Map<string, number>();
  for (const account of accounts) {
    const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "未命名账号").toLowerCase()}`;
    serviceNameCounts.set(key, (serviceNameCounts.get(key) ?? 0) + 1);
  }

  return (
    <section aria-label="绑定账号" className="max-h-[34dvh] overflow-y-auto rd-scroll">
      <ul className="space-y-1.5">
        {accounts.map((account) => {
          const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "未命名账号").toLowerCase()}`;
          return (
            <AccountCard
              key={account.id}
              account={account}
              preferIdentitySubtitle={(serviceNameCounts.get(key) ?? 0) > 1}
            />
          );
        })}
      </ul>
    </section>
  );
}
