import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import { formatDateTime } from "~/lib/format.ts";
import type { ProjectCliPatch, ProjectCliStatus } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot, Select, Switch } from "./ui.tsx";

const secrets = [
  { name: "api_key", label: "API 密钥", flag: "configured" },
  { name: "github_token", label: "GitHub 令牌", flag: "github_configured" },
] as const;
const inputClass = "w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60";
const hintClass = "block text-[11.5px] leading-relaxed text-[var(--text-muted)]";

function savedSettings({ runtime, endpoint, model, public_ai_enabled }: ProjectCliStatus): ProjectCliPatch {
  return { runtime, endpoint, model, public_ai_enabled };
}

export function ProjectCliSettingsCard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [status, setStatus] = useState<ProjectCliStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<ProjectCliPatch | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (saving) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const next = await api.getProjectCliConfig(projectId);
        if (active) {
          setStatus(next);
          setLoadFailed(false);
        }
      } catch {
        if (active) setLoadFailed(true);
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

  const form = draft ?? (status && savedSettings(status));
  function edit(changes: Partial<ProjectCliPatch>) {
    if (!form) return;
    setDraft({ ...form, ...changes });
    setMessage("");
  }

  const destinationChanged = !!(form && status && (form.runtime !== status.runtime || form.endpoint.trim() !== status.endpoint));
  const needsKeyDecision = destinationChanged && form?.api_key === undefined;
  const dirty = !!(draft && status && (destinationChanged || draft.model.trim() !== status.model ||
    draft.public_ai_enabled !== status.public_ai_enabled || secrets.some(({ name }) => draft[name] !== undefined)));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !status || !dirty || saving || loadFailed || needsKeyDecision) return;
    const cleared = secrets.filter(({ name, flag }) => draft[name] === "" && status[flag]).map(({ label }) => label);
    if (cleared.length && !window.confirm(`确定清除「${projectName}」的${cleared.join("和")}？清除后需重新输入才能恢复。`)) return;
    setSaving(true);
    setMessage("");
    try {
      const next = await api.updateProjectCliConfig(projectId, { ...draft, endpoint: draft.endpoint.trim(), model: draft.model.trim() });
      setStatus(next);
      setDraft(null);
      setMessage("项目 CLI 设置已保存");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  const runnerLabel = loadFailed ? "无法读取执行器状态，正在重试" : !status ? "正在读取状态…" : !status.online ? "执行器离线" :
    `${status.managed ? "托管" : "手动"}执行器在线 · ${status.ready ? "已就绪" : "未就绪"}`;
  return (
    <form onSubmit={save} autoComplete="off" className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden shadow-2xs">
      <header className="px-5 py-4 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0"><Icon name="terminal" size={16} /></div>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">项目 CLI · {projectName}</h2>
            <p className={hintClass}>控制台的任务讨论和 PR 审计都由这个项目的 CLI 执行。</p>
          </div>
        </div>
        <div className={hintClass}>
          <span role="status" className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--surface-subtle)]">
            <LivePulseDot active={!loadFailed && !!status?.online} tone={!loadFailed && status?.online ? (status.ready ? "emerald" : "amber") : "zinc"} />
            {runnerLabel}
          </span>
          {status?.last_seen_at && <p className="mt-1">上次在线 {formatDateTime(status.last_seen_at)}</p>}
        </div>
      </header>
      {status && form && (
        <fieldset disabled={saving} className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-[12.5px] text-[var(--text-primary)]">
          <div className="space-y-1.5">
            <span id="cli-runtime-label" className="font-medium">运行工具</span>
            <Select<ProjectCliPatch["runtime"]> ariaLabelledBy="cli-runtime-label" fullWidth value={form.runtime} disabled={saving}
              options={[{ value: "codex", label: "Codex CLI" }, { value: "claude", label: "Claude Code" }]}
              onChange={(runtime) => { if (runtime !== form.runtime) edit({ runtime, endpoint: "", model: "", api_key: undefined }); }} />
          </div>
          <label className="block space-y-1.5">
            <span className="font-medium">模型（可选）</span>
            <input value={form.model} spellCheck={false} onChange={(e) => edit({ model: e.target.value })} className={inputClass} />
            <span className={hintClass}>留空使用所选 CLI 的官方默认模型。</span>
          </label>
          <label className="block space-y-1.5 sm:col-span-2">
            <span className="font-medium">API 基础地址（可选）</span>
            <input type="url" value={form.endpoint} spellCheck={false} placeholder={form.runtime === "codex" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
              onChange={(e) => edit({ endpoint: e.target.value, api_key: undefined })} className={inputClass} />
            <span className={hintClass}>{form.runtime === "codex"
              ? "Codex 使用 OpenAI Responses API。基础地址包含 /v1，不含 /responses；留空使用官方地址 https://api.openai.com/v1。"
              : "Claude 使用 Anthropic Messages API。基础地址不含 /v1 或 /messages；留空使用官方地址 https://api.anthropic.com。"}</span>
          </label>
          <p className={`${hintClass} sm:col-span-2 border-t pt-3 border-[var(--border-subtle)]`}>密钥和令牌只能写入，不能回读。运行工具和地址不变时，留空会保留原值。要删除凭据，勾选清除后保存。</p>
          {secrets.map(({ name, label, flag }) => {
            const clearing = form[name] === "";
            const changedKey = name === "api_key" && destinationChanged;
            return (
              <div key={name} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`cli-${name}`} className="font-medium">{label}</label>
                  <span className={hintClass}>{status[flag] ? "已配置" : "未配置"}</span>
                </div>
                <input id={`cli-${name}`} type="password" autoComplete="new-password" spellCheck={false} disabled={clearing} value={form[name] ?? ""}
                  aria-describedby={`cli-${name}-hint`} onChange={(e) => edit({ [name]: e.target.value.trim() || undefined })} className={inputClass} />
                <p id={`cli-${name}-hint`} className={hintClass}>{name === "github_token" ? "公开仓库可留空；私有仓库需要 Contents 和 Pull requests 读权限。" : changedKey
                  ? "运行工具或地址已更改。请输入目标服务的密钥，或明确选择不保存密钥。"
                  : "仅使用为本项目和当前 API 地址签发的密钥。"}</p>
                {(status[flag] || changedKey || clearing) && (
                  <label className="inline-flex items-center gap-1.5 text-[11.5px]">
                    <input type="checkbox" checked={clearing} onChange={(e) => edit({ [name]: e.target.checked ? "" : undefined })} />
                    {status[flag] ? `清除已保存的${label}` : `不保存${label}`}
                  </label>
                )}
              </div>
            );
          })}
          <div className="sm:col-span-2 border-t pt-4 border-[var(--border-subtle)]">
            <Switch checked={form.public_ai_enabled} disabled={saving} onChange={(enabled) => edit({ public_ai_enabled: enabled })}
              label="允许反馈组件和预筛使用此模型" description="开启后，访客对话和反馈预筛可直接请求官方 API，不会执行 CLI。公开功能仅支持上述官方基础地址；自定义网关仅供项目 CLI 使用。访客始终可以手动提交反馈。" />
          </div>
        </fieldset>
      )}
      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="text-[12px] text-[var(--text-secondary)]">{message}</span>
        <Button type="submit" variant="primary" icon="check" loading={saving} disabled={!dirty || needsKeyDecision || loadFailed}>保存 CLI 设置</Button>
      </div>
    </form>
  );
}
