import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import { formatDateTime } from "~/lib/format.ts";
import type { CodexRunnerCredentials, CodexRunnerStatus } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot } from "./ui.tsx";

const fields = [
  { name: "api_key", label: "Codex API 密钥", flag: "configured" },
  { name: "github_token", label: "GitHub 令牌", flag: "github_configured" },
] as const;

export function CodexRunnerSettingsCard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [status, setStatus] = useState<CodexRunnerStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // An absent field keeps its credential. Only the explicit clear control sets an empty string.
  const [draft, setDraft] = useState<CodexRunnerCredentials>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (saving) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const next = await api.getCodexRunner(projectId);
        if (active) {
          setStatus(next);
          setLoadFailed(false);
        }
      } catch {
        if (active) {
          setStatus(null);
          setLoadFailed(true);
        }
      } finally {
        if (active) timer = window.setTimeout(poll, 15_000);
      }
    }
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, saving]);

  function edit(name: keyof CodexRunnerCredentials, value: string | undefined) {
    setDraft((previous) => ({ ...previous, [name]: value }));
    setMessage("");
  }

  const hasChanges = fields.some(({ name }) => draft[name] !== undefined);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !hasChanges || !status) return;
    const cleared = fields.filter(({ name }) => draft[name] === "").map(({ label }) => label);
    if (cleared.length && !window.confirm(`确定清除「${projectName}」的${cleared.join("和")}？清除后需重新输入才能恢复。`)) return;
    setSaving(true);
    setMessage("");
    try {
      const next = await api.updateCodexRunner(projectId, draft);
      setStatus(next);
      setLoadFailed(false);
      setDraft({});
      setMessage("凭据已保存");
    } catch {
      setMessage("保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  let runnerLabel = loadFailed ? "状态读取失败，稍后重试" : "正在读取状态…";
  if (status) {
    runnerLabel = "未检测到执行器";
    if (status.online) {
      const mode = status.managed ? "托管执行器" : "手动执行器";
      runnerLabel = `${mode}在线 · ${status.ready ? "已就绪" : "未就绪"}`;
    }
  }

  return (
    <form onSubmit={save} autoComplete="off" className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
      <header className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
            <Icon name="terminal" size={16} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">Codex 执行器凭据</h2>
            <p className="text-[12px] text-[var(--text-muted)] break-words">供「{projectName}」的托管 Codex 执行器使用。</p>
          </div>
        </div>
        <div className="text-[11.5px] text-[var(--text-muted)]">
          <span role="status" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface-subtle)]">
            <LivePulseDot active={!!status?.online} tone={status?.online ? (status.ready ? "emerald" : "amber") : "zinc"} />
            {runnerLabel}
          </span>
          {status?.last_seen_at && <p className="mt-1">上次在线 {formatDateTime(status.last_seen_at)}</p>}
        </div>
      </header>

      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        {fields.map(({ name, label, flag }) => {
          const clearing = draft[name] === "";
          return (
            <div key={name} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`codex-${name}`} className="text-[12.5px] font-medium text-[var(--text-primary)]">{label}</label>
                {status && <span className="text-[11.5px] text-[var(--text-muted)]">{status[flag] ? "已配置" : "未配置"}</span>}
              </div>
              <input
                id={`codex-${name}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={saving || clearing}
                placeholder={clearing ? "保存后清除" : "输入新值，留空保留现有配置"}
                value={draft[name] ?? ""}
                onChange={(event) => edit(name, event.target.value.trim() || undefined)}
                className="w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60"
              />
              <p className="text-[11.5px] text-[var(--text-muted)]">
                {name === "api_key" ? "使用专用 OpenAI API Key；保存不会发起模型请求。" : "公开仓库可留空。私有仓库仅需 Contents 和 Pull requests 读权限。"}
              </p>
              {(status?.[flag] || clearing) && (
                <label className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-secondary)]">
                  <input type="checkbox" checked={clearing} disabled={saving} onChange={(e) => edit(name, e.target.checked ? "" : undefined)} />
                  清除已保存的{label}
                </label>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="text-[12px] text-[var(--text-secondary)]">{message}</span>
        <Button type="submit" variant="primary" icon="check" loading={saving} disabled={!status || !hasChanges}>保存凭据</Button>
      </div>
    </form>
  );
}
