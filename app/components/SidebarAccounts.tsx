import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import {
  formatAccountPlan,
  formatResetFull,
  formatResetShort,
  formatWindowLabel,
  getQuotaTone,
  type QuotaTone,
} from "~/lib/sidebar-accounts.ts";
import type { SidebarAccount } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";

const FALLBACK_AVATAR = "https://axm.moe/avatar";
export type SidebarAccountList = SidebarAccount[] | "loading" | "error";

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

function QuotaWindowBar({
  service,
  window,
}: {
  service: string;
  window: SidebarAccount["windows"][number];
}) {
  const shortLabel = formatWindowLabel(service, window.label);
  const hasPercent = typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent);
  const clamped = hasPercent ? Math.max(0, Math.min(100, Math.round(window.remainingPercent!))) : null;
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
          {clamped !== null ? `${clamped}%` : "未知"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${service} ${window.label} 剩余额度`}
        aria-valuenow={clamped ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={clamped !== null ? `剩余 ${clamped}%` : "额度未知"}
        className="h-[4px] w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/[0.08]"
      >
        {clamped !== null && clamped > 0 && (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${BAR_FILL_STYLES[tone]}`}
            style={{ width: `${clamped}%`, minWidth: clamped < 3 ? "3px" : undefined }}
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
  const name = account.name?.trim() || "AceXiamo";
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

  return (
    <li className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-[7px] shadow-2xs">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        title={headerTitle}
        onClick={() => setExpanded((prev) => !prev)}
        className="group w-full flex items-center gap-2 text-left rounded-md -mx-1 px-1 py-0.5 transition-colors duration-150 hover:bg-[var(--surface-hover)]/80 active:bg-[var(--surface-active)] rd-focus-ring cursor-pointer"
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

      {expanded && (
        <div
          id={detailsId}
          className="mt-2 pt-2 border-t border-[var(--border-subtle)] space-y-1 text-[10.5px] leading-snug text-[var(--text-muted)] select-text"
        >
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
      )}
    </li>
  );
}

export function SidebarAccounts({
  accounts,
  onRetry,
}: {
  accounts: SidebarAccountList;
  onRetry?: () => void;
}) {
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
    const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "AceXiamo").toLowerCase()}`;
    serviceNameCounts.set(key, (serviceNameCounts.get(key) ?? 0) + 1);
  }

  return (
    <section aria-label="绑定账号" className="max-h-[34dvh] overflow-y-auto rd-scroll">
      <ul className="space-y-1.5">
        {accounts.map((account) => {
          const key = `${account.service.toLowerCase()}::${(account.name?.trim() || "AceXiamo").toLowerCase()}`;
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
