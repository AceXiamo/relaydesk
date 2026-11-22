import { useEffect, useState } from "react";
import { api } from "~/lib/api.ts";
import type { SidebarAccount } from "~/lib/types.ts";

const fallbackAvatar = "https://axm.moe/avatar";
type AccountList = SidebarAccount[] | "loading" | "error";

export function useSidebarAccounts(): AccountList {
  const [snapshot, setSnapshot] = useState<AccountList>("loading");
  useEffect(() => {
    let version = 0;
    let timer: number;
    const load = async () => {
      const current = ++version;
      window.clearTimeout(timer);
      let accounts: AccountList = "error";
      try {
        const response = await api.getSidebarAccounts();
        if (Array.isArray(response.accounts)) accounts = response.accounts;
      } catch {
        // Retry transient failures on focus or on the next refresh.
      }
      if (current !== version) return;
      setSnapshot(accounts);
      timer = window.setTimeout(() => {
        if (!document.hidden) void load();
      }, 60_000);
    };
    const onVisible = () => { if (!document.hidden) void load(); };
    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      version++;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return snapshot;
}

function AccountRow({ account }: { account: SidebarAccount }) {
  const name = account.name?.trim() || "AceXiamo";
  const plan = account.service.toLowerCase() === "gemini" && account.plan?.toLowerCase() === "pro"
    ? "Ultra" : account.plan;
  return (
    <li className="px-2 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <img src={account.avatarUrl?.trim() || fallbackAvatar} alt="" referrerPolicy="no-referrer"
          className="size-7 shrink-0 rounded-full bg-[var(--surface-hover)] object-cover"
          onError={({ currentTarget }) => { if (currentTarget.src !== fallbackAvatar) currentTarget.src = fallbackAvatar; }} />
        <div className="min-w-0 break-words">
          <div className="text-xs font-medium text-[var(--text-primary)]">{name}</div>
          {account.identity && account.identity !== name && <div className="break-all">{account.identity}</div>}
          <div className="break-all">{account.nodeName}</div>
          <div>{account.service} · {plan || "订阅未知"}</div>
        </div>
      </div>
      {account.status === "ready" && account.windows?.length ? (
        <dl className="space-y-1">
          {account.windows.map((window, index) => {
            const reset = window.resetsAt ? new Date(window.resetsAt) : null;
            const percent = window.remainingPercent;
            return (
              <div key={`${window.label}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2">
                <dt className="break-words">{window.label}</dt>
                <dd className="tabular-nums text-[var(--text-secondary)]">{typeof percent === "number" && Number.isFinite(percent) ? `剩余 ${percent}%` : "额度未知"}</dd>
                <dd className="col-span-2">{reset && Number.isFinite(reset.getTime())
                  ? <time dateTime={reset.toISOString()}>{reset.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })} 重置</time>
                  : "重置时间未知"}</dd>
              </div>
            );
          })}
        </dl>
      ) : <p>{account.status === "unverified" ? "账号归属未确认" : "额度暂不可用"}</p>}
    </li>
  );
}

export function SidebarAccounts({ accounts }: { accounts: AccountList }) {
  return (
    <section aria-label="绑定账号" className="max-h-[28dvh] overflow-y-auto overscroll-contain rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[11px] text-[var(--text-muted)]">
      {Array.isArray(accounts) && accounts.length > 0 ? (
        <ul className="divide-y divide-[var(--border-subtle)]">{accounts.map(account => <AccountRow key={account.id} account={account} />)}</ul>
      ) : <p className="px-2 py-1.5" role="status">{accounts === "loading" ? "正在读取绑定账号…" : accounts === "error" ? "绑定账号读取失败" : "暂无绑定账号"}</p>}
    </section>
  );
}
