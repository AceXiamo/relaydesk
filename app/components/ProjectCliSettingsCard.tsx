import { useEffect, useState, type FormEvent } from "react";
import { api } from "~/lib/api.ts";
import { formatDateTime } from "~/lib/format.ts";
import { effortLabels, validCatalogId } from "~/lib/model-catalog.ts";
import type { ChatReasoningEffort, ModelCatalogItem, ProjectCliPatch, ProjectCliStatus } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot, Select, Switch } from "./ui.tsx";

const secrets = [
  { name: "api_key", label: "API 密钥", flag: "configured" },
  { name: "github_token", label: "GitHub 令牌", flag: "github_configured" },
] as const;
const inputClass = "w-full h-9.5 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:opacity-60";
const hintClass = "block text-[11.5px] leading-relaxed text-[var(--text-muted)]";

type EffortLevel = Exclude<ChatReasoningEffort, "default">;
const levels: EffortLevel[] = ["off", "low", "medium", "high", "max"];
const efforts: ChatReasoningEffort[] = ["default", ...levels];
const catalogLimit = 50;
const modelKey = ({ runtime, id }: ModelCatalogItem) => `${runtime}:${id.trim()}`;
const runtimeName = (runtime: ModelCatalogItem["runtime"]) => runtime === "codex" ? "Codex" : "Claude";

function savedSettings({ runtime, endpoint, model, public_ai_enabled, models = [], default_effort = "default" }: ProjectCliStatus): ProjectCliPatch {
  return { runtime, endpoint, model, public_ai_enabled, models, default_effort };
}

function catalogError(models: ModelCatalogItem[]) {
  const keys = new Set<string>();
  for (const [i, item] of models.entries()) {
    const id = item.id.trim();
    if (!id) return `请填写第 ${i + 1} 个模型的 ID。`;
    if (!validCatalogId(id)) return `第 ${i + 1} 个模型的 ID 最多 160 个可见 ASCII 字符，不能包含空格或以连字符开头。`;
    if (keys.has(modelKey(item))) return `第 ${i + 1} 个模型的运行工具和 ID 与已有条目重复。`;
    if (item.context_window !== undefined && (!Number.isSafeInteger(item.context_window) || item.context_window < 1 || item.context_window > 10_000_000)) return `第 ${i + 1} 个模型的上下文窗口须为 1 至 1000 万之间的整数。`;
    if (item.supports_effort !== false && item.effort_levels?.length === 0) return `请为第 ${i + 1} 个模型选择至少一个思考档位，或关闭思考强度调节。`;
    keys.add(modelKey(item));
  }
  return "";
}

function ModelFields({ item, onChange }: { item: ModelCatalogItem; onChange: (changes: Partial<ModelCatalogItem>) => void }) {
  const supported = item.effort_levels ?? levels;
  return (
    <div className="grid gap-3 sm:grid-cols-2 border-t border-[var(--border-subtle)] p-3">
      <label className="space-y-1"><span>模型 ID</span><input className={`${inputClass} font-mono`} value={item.id} maxLength={160} spellCheck={false} onChange={e => onChange({ id: e.target.value })} /></label>
      <label className="space-y-1"><span>显示名称（可选）</span><input className={inputClass} value={item.label ?? ""} maxLength={120} onChange={e => onChange({ label: e.target.value || undefined })} /></label>
      <div className="space-y-1">
        <span>运行工具</span>
        <Select<ModelCatalogItem["runtime"]>
          fullWidth
          value={item.runtime}
          options={[{ value: "codex", label: "Codex CLI" }, { value: "claude", label: "Claude Code" }]}
          onChange={runtime => onChange({ runtime })}
        />
      </div>
      <label className="space-y-1"><span>上下文窗口（词元数，可选）</span><input className={inputClass} type="number" min={1} max={10_000_000} step={1} value={item.context_window ?? ""} onChange={e => onChange({ context_window: e.target.value === "" ? undefined : e.target.valueAsNumber })} /></label>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={item.supports_effort !== false} onChange={e => onChange(e.target.checked ? { supports_effort: true } : { supports_effort: false, effort_levels: undefined, default_effort: undefined })} />支持调节思考强度</label>
      {item.supports_effort !== false && <>
        <fieldset className="min-w-0 space-y-2"><legend>支持的思考档位</legend><div className="flex flex-wrap gap-3">
          {levels.map(level => <label key={level} className="inline-flex items-center gap-1"><input type="checkbox" checked={supported.includes(level)} onChange={e => {
            const next = levels.filter(v => v === level ? e.target.checked : supported.includes(v));
            onChange({ effort_levels: next, default_effort: item.default_effort && next.includes(item.default_effort) ? item.default_effort : undefined });
          }} />{effortLabels[level]}</label>)}
        </div></fieldset>
        <div className="space-y-1">
          <span>模型默认思考强度</span>
          <Select<ChatReasoningEffort>
            fullWidth
            value={item.default_effort ?? "default"}
            options={[{ value: "default", label: "不指定" }, ...supported.map(v => ({ value: v, label: effortLabels[v] }))]}
            onChange={v => onChange({ default_effort: v === "default" ? undefined : v })}
          />
        </div>
      </>}
    </div>
  );
}

function ModelDiscovery({ projectId, form, models, blocked, onMerge }: {
  projectId: string; form: ProjectCliPatch; models: ModelCatalogItem[]; blocked: boolean; onMerge: (items: ModelCatalogItem[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ModelCatalogItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const existing = new Set(models.map(modelKey));
  const additions = candidates?.filter(item => !existing.has(modelKey(item)) && checked.has(modelKey(item))) ?? [];
  const remaining = catalogLimit - models.length;

  async function discover() {
    if (blocked || loading) return;
    setLoading(true);
    setCandidates(null);
    setChecked(new Set());
    setError("");
    try {
      const { models: found } = await api.discoverProjectCliModels(projectId, {
        runtime: form.runtime, endpoint: form.endpoint.trim(), ...(form.api_key !== undefined ? { api_key: form.api_key } : {}),
      });
      setCandidates([...new Map(found.map(item => [modelKey(item), item])).values()]);
    } catch (err) {
      setError(err instanceof Error ? `模型发现失败：${err.message}` : "模型发现失败，请重试。");
    } finally {
      setLoading(false);
    }
  }

  return <div className="space-y-2">
    <Button loading={loading} disabled={blocked || remaining === 0} onClick={discover}>从 API 拉取 /v1/models</Button>
    <p role="status" className={hintClass}>{error || (loading ? "正在请求模型列表…" : blocked ? "请先确认目标服务的密钥或勾选不保存密钥。" : "发现只读取候选列表，不会更改已配置的模型。")}</p>
    {candidates && <div className="rounded-lg border border-[var(--border-subtle)] p-3 space-y-2">
      <p className="font-medium">{candidates.length ? `发现 ${candidates.length} 个候选模型` : "当前地址没有返回可导入的模型。"}</p>
      {!!candidates.length && <div className="max-h-48 overflow-y-auto space-y-1">
        {candidates.map(item => {
          const key = modelKey(item);
          const alreadyAdded = existing.has(key);
          return <label key={key} className="flex items-center gap-2 break-all">
            <input type="checkbox" disabled={alreadyAdded || (!checked.has(key) && additions.length >= remaining)} checked={alreadyAdded || checked.has(key)} onChange={e => {
              const next = new Set(checked);
              if (e.target.checked) next.add(key); else next.delete(key);
              setChecked(next);
            }} />{item.id}<span className={hintClass}>{runtimeName(item.runtime)}{alreadyAdded && " · 已在列表中"}</span>
          </label>;
        })}
      </div>}
      <div className="flex flex-wrap gap-2">
        {!!candidates.length && <Button disabled={!additions.length || additions.length > remaining} onClick={() => { onMerge(additions); setCandidates(null); }}>添加所选模型（{additions.length}）</Button>}
        <Button onClick={() => setCandidates(null)}>关闭候选列表</Button>
      </div>
    </div>}
  </div>;
}

export function ProjectCliSettingsCard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [status, setStatus] = useState<ProjectCliStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<ProjectCliPatch | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [editingModel, setEditingModel] = useState<number | null>(null);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);

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
    if ("runtime" in changes || "endpoint" in changes || "api_key" in changes) setDiscoveryVersion(v => v + 1);
    setDraft({ ...form, ...changes });
    setMessage("");
  }

  const destinationChanged = !!(form && status && (form.runtime !== status.runtime || form.endpoint.trim() !== status.endpoint));
  const needsKeyDecision = destinationChanged && form?.api_key === undefined;
  const models = form?.models ?? [];
  const invalidCatalog = catalogError(models);
  const dirty = !!(draft && status && (destinationChanged || draft.model.trim() !== status.model ||
    draft.default_effort !== (status.default_effort ?? "default") || JSON.stringify(models) !== JSON.stringify(status.models ?? []) ||
    draft.public_ai_enabled !== status.public_ai_enabled || secrets.some(({ name }) => draft[name] !== undefined)));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !status || !dirty || saving || loadFailed || needsKeyDecision || invalidCatalog) return;
    const cleared = secrets.filter(({ name, flag }) => draft[name] === "" && status[flag]).map(({ label }) => label);
    if (cleared.length && !window.confirm(`确定清除「${projectName}」的${cleared.join("和")}？清除后需重新输入才能恢复。`)) return;
    setSaving(true);
    setMessage("");
    try {
      const next = await api.updateProjectCliConfig(projectId, {
        ...draft, endpoint: draft.endpoint.trim(), model: draft.model.trim(),
        models: models.map(item => ({ ...item, id: item.id.trim(), label: item.label?.trim() || undefined })),
      });
      setStatus(next);
      setDraft(null);
      setEditingModel(null);
      setDiscoveryVersion(v => v + 1);
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
            <span className="font-medium">默认模型（可选）</span>
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
          <section className="sm:col-span-2 border-t pt-4 border-[var(--border-subtle)] space-y-3" aria-labelledby="cli-model-list">
            <div className="flex items-center justify-between gap-3">
              <h3 id="cli-model-list" className="font-semibold">云端可选模型列表 <span className="ml-1 text-xs font-normal text-[var(--text-muted)]">{models.length} / {catalogLimit}</span></h3>
              <Button disabled={models.length >= catalogLimit} onClick={() => {
                edit({ models: [...models, { id: "", runtime: form.runtime }] });
                setEditingModel(models.length);
              }}>手动添加模型</Button>
            </div>
            {!models.length && <p className={hintClass}>尚未配置可选模型。可以手动添加，也可以从当前 API 地址发现。</p>}
            {models.map((item, i) => <div key={i} className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 break-all"><b>{item.label || item.id || "未命名模型"}</b><span className={hintClass}>{runtimeName(item.runtime)}{item.label && item.id && ` · ${item.id}`}</span></span>
                <Button aria-expanded={editingModel === i} aria-label={`${editingModel === i ? "收起" : "编辑"}第 ${i + 1} 个模型`} onClick={() => setEditingModel(editingModel === i ? null : i)}>{editingModel === i ? "收起" : "编辑"}</Button>
                <Button aria-label={`删除第 ${i + 1} 个模型`} onClick={() => {
                  edit({ models: models.filter((_, n) => n !== i) });
                  setEditingModel(n => n === null || n === i ? null : n > i ? n - 1 : n);
                }}>删除</Button>
              </div>
              {editingModel === i && <ModelFields item={item} onChange={changes => edit({ models: models.map((m, n) => n === i ? { ...m, ...changes } : m) })} />}
            </div>)}
            {invalidCatalog && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">{invalidCatalog}</p>}
            <ModelDiscovery key={`${form.runtime}:${form.endpoint}:${discoveryVersion}`} projectId={projectId} form={form} models={models} blocked={needsKeyDecision} onMerge={items => edit({ models: [...models, ...items] })} />
          </section>
          <div className="space-y-1.5 sm:col-span-2">
            <span id="cli-default-effort-label" className="font-medium">项目默认思考强度</span>
            <Select<ChatReasoningEffort> ariaLabelledBy="cli-default-effort-label" fullWidth value={form.default_effort ?? "default"} disabled={saving}
              options={efforts.map(value => ({ value, label: effortLabels[value] }))}
              onChange={default_effort => edit({ default_effort })} />
          </div>
          <div className="sm:col-span-2 border-t pt-4 border-[var(--border-subtle)]">
            <Switch checked={form.public_ai_enabled} disabled={saving} onChange={(enabled) => edit({ public_ai_enabled: enabled })}
              label="允许反馈组件和预筛使用此模型" description="开启后，访客对话和反馈预筛可直接请求官方 API，不会执行 CLI。公开功能仅支持上述官方基础地址；自定义网关仅供项目 CLI 使用。访客始终可以手动提交反馈。" />
          </div>
        </fieldset>
      )}
      <div className="px-5 py-3.5 bg-[var(--surface-subtle)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="text-[12px] text-[var(--text-secondary)]">{message}</span>
        <Button type="submit" variant="primary" icon="check" loading={saving} disabled={!dirty || needsKeyDecision || loadFailed || !!invalidCatalog}>保存 CLI 设置</Button>
      </div>
    </form>
  );
}
