import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatDateTime, formatRelativeTime } from "~/lib/format.ts";
import { effortLabels } from "~/lib/model-catalog.ts";
import type { BridgeAgentSummary, BridgeAgentTokenResponse } from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, CopyButton, LivePulseDot, useToast } from "./ui.tsx";

const codeBox = "rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 font-mono text-xs whitespace-pre-wrap break-all";

type SetupReceipt = Pick<BridgeAgentTokenResponse, "agent" | "token"> & Partial<Pick<BridgeAgentTokenResponse, "quickstart_config" | "start_command">>;

function SetupInstructions({ receipt, dismiss }: { receipt: SetupReceipt; dismiss: () => void }) {
  const [reveal, setReveal] = useState(false);
  const config = receipt.quickstart_config ? JSON.stringify(receipt.quickstart_config, null, 2) : "";
  const startCommand = receipt.start_command || "pnpm bridge";
  const masked = `${receipt.agent.token_prefix}…`;
  return <section className="mx-5 mb-4 space-y-3 rounded-xl border border-amber-500/35 p-4" aria-label="一次性接入凭据">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold">保存「{receipt.agent.name}」的设备 Token</h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">凭据仅在本次显示。关闭后无法找回，只能重新轮换。</p>
      </div>
      <Button size="xs" variant="ghost" onClick={dismiss}>我已保存，关闭</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all text-xs">{reveal ? receipt.token : masked}</code>
      <Button size="xs" variant="ghost" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "隐藏" : "显示 Token"}</Button>
      <CopyButton size="xs" value={receipt.token} label="复制 Token" />
    </div>
    {config ? <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="break-all">在本机保存为 <code>~/.config/relaydesk-bridge/config.json</code>（权限 0600）</span>
        <CopyButton size="xs" value={config} label="复制完整配置" />
      </div>
      <pre className={codeBox}>{reveal ? config : config.replaceAll(receipt.token, masked)}</pre>
    </> : <p className="break-all text-xs">更新本机 <code>~/.config/relaydesk-bridge/config.json</code> 中的 <code>agent_token</code>，保留其他配置。</p>}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span>在 Relaydesk 仓库内运行 <code>{startCommand}</code></span>
      <CopyButton size="xs" value={startCommand} label="复制启动命令" />
    </div>
  </section>;
}

function AgentDetails({ agent }: { agent: BridgeAgentSummary }) {
  return <>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
      {(["claude", "codex"] as const).map(runtime => <span key={runtime}>
        <code>{runtime}</code> {agent.runtimes[runtime]?.available ? (agent.runtimes[runtime]?.version || "可用") : "未检测到"}
      </span>)}
    </div>
    <details className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">模型目录 · {agent.models.length}</summary>
      {agent.models.length ? <ul className="mt-2 divide-y divide-[var(--border-subtle)]">{agent.models.map(m => <li key={`${m.runtime}:${m.id}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2">
        <strong>{m.label || m.id}</strong><code className="break-all text-[var(--text-muted)]">{m.runtime} / {m.id}</code>
        {m.context_window && <span className="rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 tabular-nums">上下文 {m.context_window.toLocaleString()}</span>}
        {m.supports_effort === false ? <span>不可调思考强度</span> : m.effort_levels?.length ? <span>思考：{m.effort_levels.map(e => effortLabels[e]).join(" / ")}</span> : null}
      </li>)}</ul> : <p className="mt-2 text-[var(--text-muted)]">此设备尚未上报模型。</p>}
    </details>
    {agent.bindings.length ? <ul className="space-y-1 text-xs">{agent.bindings.map(b => <li key={b.project_id} className="flex flex-wrap items-baseline gap-2">
      <span className="font-medium">{b.project_name || b.project_id}</span>
      <code className="break-all text-[var(--text-muted)]">{b.workdir || "未设置目录"}</code>
      <span className={b.enabled && b.path_ok ? "text-emerald-700 dark:text-emerald-300" : "text-[var(--text-muted)]"}>{!b.enabled ? "已禁用" : b.path_ok ? "目录已验证" : (b.path_error || "目录未验证")}</span>
    </li>)}</ul> : <p className="text-xs text-[var(--text-muted)]">未绑定项目目录</p>}
  </>;
}

export function LocalAgentsSettingsCard() {
  const toast = useToast();
  const [agents, setAgents] = useState<BridgeAgentSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [receipt, setReceipt] = useState<SetupReceipt | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const result = await api.listBridgeAgents();
      if (seq.current === n) { setAgents(result.agents); setError(""); }
    } catch (err) {
      if (seq.current === n) setError(err instanceof Error ? err.message : "无法加载设备列表");
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15000);
    return () => { seq.current++; window.clearInterval(timer); };
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); await load(); }
    catch (err) { toast.error(err instanceof Error ? err.message : "设备操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs">
    <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-700 dark:text-teal-300"><Icon name="monitor" size={16} /></span>
        <div><h2 className="text-[14.5px] font-semibold">本机执行节点 · Local Agents</h2>
          <p className="text-xs text-[var(--text-muted)]">注册设备后，在本机启动 Bridge 并绑定项目工作目录。</p></div>
      </div>
      {!adding && <Button size="sm" icon="plus" disabled={busy || !!receipt} onClick={() => setAdding(true)}>添加本机 Agent</Button>}
    </header>
    {adding && <form className="flex flex-wrap items-end gap-2 px-5 pb-4" onSubmit={e => {
      e.preventDefault(); if (!name.trim() || busy) return;
      void run(async () => { const result = await api.createBridgeAgent(name.trim()); setReceipt(result); setAdding(false); setName(""); });
    }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">设备名称
        <input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="例如：工作室 Mac" className="h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-2 text-sm" />
      </label>
      <Button variant="primary" type="submit" disabled={busy || !name.trim()}>生成接入配置</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setAdding(false)}>取消</Button>
    </form>}
    {receipt && <SetupInstructions key={receipt.token} receipt={receipt} dismiss={() => setReceipt(null)} />}
    {error && <div role="alert" className="flex items-center gap-2 px-5 pb-3 text-xs text-rose-600">{error}<Button size="xs" onClick={() => void load()}>重试</Button></div>}
    {!agents?.length && !error && <p className="border-t border-[var(--border-subtle)] px-5 py-4 text-xs text-[var(--text-muted)]">{agents ? "尚未注册本机执行节点。" : "正在读取设备列表…"}</p>}
    {agents?.map(agent => <article key={agent.id} className="space-y-3 border-t border-[var(--border-subtle)] px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2"><LivePulseDot active={agent.online} tone={agent.online ? "emerald" : "zinc"} /><h3 className="break-all text-sm font-semibold">{agent.name}</h3>
          <span className="text-xs text-[var(--text-muted)]">{agent.online ? "在线" : "离线"} · 运行 {agent.active_runs} / {agent.max_concurrency}</span></div>
        <span className="text-xs text-[var(--text-muted)]" title={formatDateTime(agent.last_seen_at)}>{agent.last_seen_at ? `最近在线 ${formatRelativeTime(agent.last_seen_at)}` : "尚未连接"}</span>
      </div>
      <p className="break-all font-mono text-xs text-[var(--text-muted)]">{[agent.hostname, agent.platform, agent.bridge_version && `Bridge ${agent.bridge_version}`].filter(Boolean).join(" · ") || "等待设备上报主机信息"}</p>
      <AgentDetails agent={agent} />
      <div className="flex flex-wrap gap-2">
        <Button size="xs" icon="refresh-cw" disabled={!agent.online || busy} onClick={() => void run(async () => { await api.refreshBridgeAgent(agent.id); toast.success("已请求设备刷新目录"); })}>刷新目录</Button>
        <Button size="xs" variant="ghost" disabled={busy || !!receipt} onClick={() => {
          if (window.confirm(`轮换「${agent.name}」的 Token？旧凭据将立即失效，设备需更新配置后重新连接。`)) void run(async () => {
            const rotated = await api.rotateBridgeAgentToken(agent.id);
            setReceipt({ agent: rotated.agent, token: rotated.token });
          });
        }}>轮换 Token</Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => {
          if (window.confirm(`删除「${agent.name}」？连接将断开，该设备的项目目录绑定也会被移除。`)) void run(async () => {
            await api.deleteBridgeAgent(agent.id); if (receipt?.agent.id === agent.id) setReceipt(null); toast.info("设备已删除");
          });
        }}>删除</Button>
      </div>
    </article>)}
  </section>;
}
