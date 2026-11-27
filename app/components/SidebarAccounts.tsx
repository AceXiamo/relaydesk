import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "~/lib/api.ts";
import {
  clampQuotaPercent,
  formatAccountPlan,
  formatResetFull,
  formatResetShort,
  formatWindowLabel,
  getAccountHarnessLogo,
  getQuotaTone,
  selectDualRingWindows,
  type QuotaTone,
} from "~/lib/sidebar-accounts.ts";
import type { SidebarAccount } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { RollingNumber, SmoothCollapse } from "./MotionPrimitives.tsx";

const FALLBACK_AVATAR = "https://axm.moe/avatar";
export type SidebarAccountList = SidebarAccount[] | "loading" | "error";

const RING_SIZE = 42;
const RING_CENTER = RING_SIZE / 2;
const RING_STROKE_WIDTH = 2.5;
const OUTER_RING_RADIUS = 19;
const INNER_RING_RADIUS = 14.5;
const OUTER_RING_CIRCUMFERENCE = 2 * Math.PI * OUTER_RING_RADIUS;
const INNER_RING_CIRCUMFERENCE = 2 * Math.PI * INNER_RING_RADIUS;

const BAR_FILL_STYLES: Record<QuotaTone, string> = {
  healthy: "bg-emerald-500 dark:bg-emerald-400/90",
  low: "bg-amber-500 dark:bg-amber-400",
  critical: "bg-rose-500 dark:bg-rose-400",
  unknown: "bg-transparent",
};

const OUTER_RING_STROKE_STYLES: Record<QuotaTone, string> = {
  healthy: "stroke-emerald-500 dark:stroke-emerald-400",
  low: "stroke-amber-500 dark:stroke-amber-400",
  critical: "stroke-rose-500 dark:stroke-rose-400",
  unknown: "stroke-transparent",
};

const INNER_RING_STROKE_STYLES: Record<QuotaTone, string> = {
  healthy: "stroke-teal-500 dark:stroke-teal-400",
  low: "stroke-amber-500 dark:stroke-amber-400",
  critical: "stroke-rose-500 dark:stroke-rose-400",
  unknown: "stroke-transparent",
};

const PERCENT_TEXT_STYLES: Record<QuotaTone, string> = {
  healthy: "text-[var(--text-primary)]",
  low: "text-amber-700 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
  unknown: "text-[var(--text-muted)]",
};

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
  sizeClass = "size-[22px]",
  iconSize = 12,
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
  ringHint?: "外环" | "内环";
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
            <span className="rounded px-1 py-[1px] text-[9px] font-medium bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-muted)] shrink-0">
              {ringHint}
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

function CompactAccountRingItem({
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
        className="relative size-[42px] rounded-full flex items-center justify-center transition-transform duration-150 hover:scale-[1.04] active:scale-[0.96] rd-focus-ring cursor-pointer"
      >
        <svg
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          width={RING_SIZE}
          height={RING_SIZE}
          aria-hidden="true"
          className="pointer-events-none"
        >
          {account.status === "ready" && outer ? (
            <>
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={OUTER_RING_RADIUS}
                fill="none"
                strokeWidth={RING_STROKE_WIDTH}
                className="stroke-black/[0.08] dark:stroke-white/[0.09]"
              />
              {outerPercent !== null && outerPercent > 0 && (
                <circle
                  data-ring="outer"
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={OUTER_RING_RADIUS}
                  fill="none"
                  strokeWidth={RING_STROKE_WIDTH}
                  strokeLinecap="round"
                  strokeDasharray={OUTER_RING_CIRCUMFERENCE}
                  strokeDashoffset={OUTER_RING_CIRCUMFERENCE * (1 - outerPercent / 100)}
                  transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                  className={`transition-[stroke-dashoffset,stroke] duration-500 ease-[var(--ease-out)] ${OUTER_RING_STROKE_STYLES[outerTone]}`}
                />
              )}
              {inner && (
                <>
                  <circle
                    cx={RING_CENTER}
                    cy={RING_CENTER}
                    r={INNER_RING_RADIUS}
                    fill="none"
                    strokeWidth={RING_STROKE_WIDTH}
                    className="stroke-black/[0.08] dark:stroke-white/[0.09]"
                  />
                  {innerPercent !== null && innerPercent > 0 && (
                    <circle
                      data-ring="inner"
                      cx={RING_CENTER}
                      cy={RING_CENTER}
                      r={INNER_RING_RADIUS}
                      fill="none"
                      strokeWidth={RING_STROKE_WIDTH}
                      strokeLinecap="round"
                      strokeDasharray={INNER_RING_CIRCUMFERENCE}
                      strokeDashoffset={INNER_RING_CIRCUMFERENCE * (1 - innerPercent / 100)}
                      transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
                      className={`transition-[stroke-dashoffset,stroke] duration-500 ease-[var(--ease-out)] ${INNER_RING_STROKE_STYLES[innerTone]}`}
                    />
                  )}
                </>
              )}
            </>
          ) : account.status === "unverified" ? (
            <>
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={OUTER_RING_RADIUS}
                fill="none"
                strokeWidth={2}
                strokeDasharray="3.5 3"
                className="stroke-amber-500/80 dark:stroke-amber-400/80"
              />
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={INNER_RING_RADIUS}
                fill="none"
                strokeWidth={2}
                className="stroke-black/[0.05] dark:stroke-white/[0.06]"
              />
            </>
          ) : (
            <>
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={OUTER_RING_RADIUS}
                fill="none"
                strokeWidth={2}
                strokeDasharray="3.5 3"
                className="stroke-black/20 dark:stroke-white/20"
              />
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={INNER_RING_RADIUS}
                fill="none"
                strokeWidth={2}
                className="stroke-black/[0.05] dark:stroke-white/[0.06]"
              />
            </>
          )}
        </svg>

        <span className="absolute inset-0 m-auto size-[22px] flex items-center justify-center pointer-events-none">
          <HarnessLogoBadge service={account.service} sizeClass="size-[22px]" iconSize={12} />
        </span>

        {account.status === "unverified" && (
          <span
            aria-hidden="true"
            className="absolute right-0.5 top-0.5 size-2 rounded-full bg-amber-500 ring-2 ring-[var(--surface-sidebar)] pointer-events-none"
          />
        )}
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
                          ? "外环"
                          : window === inner
                            ? "内环"
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
      return (
        <section
          aria-label="绑定账号"
          role="status"
          className="flex justify-center py-0.5"
        >
          <span className="sr-only">正在读取绑定账号…</span>
          <div
            aria-hidden="true"
            className="size-[42px] rounded-full border-2 border-dashed border-[var(--border-strong)]/60 animate-pulse flex items-center justify-center"
          >
            <div className="size-[22px] rounded-full bg-[var(--surface-hover)]" />
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
            className="size-[42px] rounded-full border-2 border-dashed border-rose-500/45 bg-rose-500/[0.05] text-rose-600 dark:text-rose-400 flex items-center justify-center hover:bg-rose-500/12 active:scale-[0.95] transition-[background-color,transform] duration-150 rd-focus-ring cursor-pointer"
          >
            <Icon name="alert-circle" size={16} />
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
      <section aria-label="绑定账号" className="w-full max-h-[28dvh] overflow-y-auto rd-scroll py-0.5">
        <ul className="flex flex-col items-center gap-2">
          {accounts.map((account) => {
            const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "未命名账号").toLowerCase()}`;
            return (
              <CompactAccountRingItem
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
