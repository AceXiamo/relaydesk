import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import type {
  BridgeAgentBindingSummary,
  BridgeAgentSummary,
  ProjectRoutingConfig,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { Button, LivePulseDot, Select, useToast } from "./ui.tsx";

interface ProjectRoutingCardProps {
  projectId: string;
  projectName: string;
  onOpenGlobalAgents?: () => void;
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        checked
          ? "border-indigo-500/80 bg-[var(--rd-accent)]"
          : "border-[var(--border-strong)] bg-[var(--surface-subtle)]"
      }`}
    >
      <span
        className={`inline-block size-3.5 rounded-full bg-white shadow-xs transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}

export function ProjectRoutingCard({
  projectId,
  projectName,
  onOpenGlobalAgents,
}: ProjectRoutingCardProps) {
  const toast = useToast();
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [routing, setRouting] = useState<ProjectRoutingConfig | null>(null);
  const [effectivePriority, setEffectivePriority] = useState<string[]>([]);
  const [agents, setAgents] = useState<BridgeAgentSummary[]>([]);
  const [workdirDrafts, setWorkdirDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingRouting, setSavingRouting] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await api.getProjectExecutionRouting(projectId);
      if (seq.current !== n) return;
      setRouting(res.routing);
      setEffectivePriority(res.effective_priority);
      setAgents(res.agents);
      setWorkdirDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const agent of res.agents) {
          const binding = agent.bindings.find((b) => b.project_id === projectId);
          next[agent.id] = prev[agent.id] !== undefined ? prev[agent.id] : (binding?.workdir ?? "");
        }
        return next;
      });
      setError("");
    } catch (err) {
      if (seq.current !== n) return;
      setError(err instanceof Error ? err.message : "无法读取项目执行路由配置");
    } finally {
      if (seq.current === n) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    setWorkdirDrafts({});
    setModelDraft(null);
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      seq.current++;
      window.clearInterval(timer);
    };
  }, [load]);

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const getBinding = (agent: BridgeAgentSummary): BridgeAgentBindingSummary | undefined =>
    agent.bindings.find((b) => b.project_id === projectId);

  const saveRouting = async (patch: Parameters<typeof api.updateProjectExecutionRouting>[1], successMessage?: string) => {
    setSavingRouting(true);
    try {
      const res = await api.updateProjectExecutionRouting(projectId, patch);
      setRouting(res.routing);
      setEffectivePriority(res.effective_priority);
      setAgents(res.agents);
      if (patch.task_model !== undefined) setModelDraft(null);
      if (successMessage) toast.success(successMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新执行路由失败");
    } finally {
      setSavingRouting(false);
    }
  };

  const movePriority = (index: number, delta: -1 | 1) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= effectivePriority.length) return;
    const next = [...effectivePriority];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    setEffectivePriority(next);
    void saveRouting({ priority: next }, "已更新执行优先级");
  };

  const updateBinding = async (
    agentId: string,
    patch: { workdir?: string; enabled?: boolean; allow_datasource_secrets?: boolean },
    successMessage: string,
  ) => {
    setBusyAgentId(agentId);
    try {
      const res = await api.updateProjectAgentBinding(projectId, agentId, patch);
      setWorkdirDrafts((prev) => ({ ...prev, [agentId]: res.binding.workdir }));
      toast.success(successMessage);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新节点绑定失败");
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <section id="relaydesk-project-routing" className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-primary)] shadow-2xs">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
            <Icon name="git-branch" size={16} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-semibold">
              项目执行优先级与节点绑定 · {projectName}
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              配置对话与工单/PR 审计的节点承接顺序（越靠前越优先，默认优先消耗本机订阅），并绑定各本机设备的工作目录。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenGlobalAgents && (
            <Button size="xs" variant="secondary" icon="monitor" onClick={onOpenGlobalAgents}>
              管理本机节点
            </Button>
          )}
          <Button size="xs" variant="ghost" icon="refresh-cw" disabled={loading || savingRouting} onClick={() => void load()}>
            刷新状态
          </Button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex items-center gap-2 px-5 py-3 text-xs text-rose-600">
          {error}
          <Button size="xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {loading ? (
        <p className="px-5 py-4 text-xs text-[var(--text-muted)]">正在加载执行路由配置…</p>
      ) : (
        <div className="divide-y divide-[var(--border-subtle)]">
          {/* 1. Priority Order List */}
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold">执行优先级顺序（自动路由模式）</h3>
              <span className="text-[11.5px] text-[var(--text-muted)]">
                排名越靠前越优先使用，离线或满载时按顺位向下尝试
              </span>
            </div>

            <ol className="space-y-2">
              {effectivePriority.map((target, idx) => {
                const isCloud = target === "cloud";
                const agentId = isCloud ? null : target.slice("local:".length);
                const agent = agentId ? agentMap.get(agentId) : undefined;
                const binding = agent ? getBinding(agent) : undefined;
                const readyLocal = Boolean(agent?.online && binding?.enabled && binding?.path_ok);

                return (
                  <li
                    key={target}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3.5 py-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className={`inline-flex h-5 min-w-[24px] items-center justify-center rounded-md px-1.5 font-mono text-[11px] font-semibold ${
                          idx === 0
                            ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                            : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                        }`}
                      >
                        #{idx + 1}
                      </span>
                      <Icon
                        name={isCloud ? "cloud" : "monitor"}
                        size={14}
                        className="text-[var(--text-muted)] shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium truncate">
                            {isCloud ? "云端执行器（Relaydesk Server）" : agent?.name || target}
                          </span>
                          {idx === 0 && (
                            <span className="rounded bg-indigo-500/12 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                              首选
                            </span>
                          )}
                          {!isCloud && agent && (
                            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                              <LivePulseDot active={agent.online} tone={agent.online ? "emerald" : "zinc"} />
                              {agent.online
                                ? readyLocal
                                  ? `就绪 · ${agent.active_runs}/${agent.max_concurrency}`
                                  : "在线 · 待绑定/启用目录"
                                : "离线"}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--text-muted)] truncate">
                          {isCloud
                            ? "使用项目 CLI 配置的云端 API 凭据与容器内隔离工作区"
                            : binding?.path_ok && binding.workdir
                              ? binding.workdir
                              : "尚未在本机绑定并验证此项目的本地目录"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="arrow-up"
                        disabled={savingRouting || idx === 0}
                        onClick={() => movePriority(idx, -1)}
                        title="上移优先级"
                      >
                        上移
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="arrow-down"
                        disabled={savingRouting || idx === effectivePriority.length - 1}
                        onClick={() => movePriority(idx, 1)}
                        title="下移优先级"
                      >
                        下移
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* 2. Routing Policy Switches */}
          {routing && (
            <div className="p-5 grid gap-3 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-3.5">
                <div className="space-y-0.5">
                  <div className="text-[12.5px] font-medium">首选不可用时自动降级</div>
                  <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    当首选本机节点离线、满载或缺少对应 CLI 时，自动切换到下一顺位节点或云端兜底，并携带近期上下文无感续聊。
                  </p>
                </div>
                <ToggleSwitch
                  checked={routing.auto_fallback}
                  disabled={savingRouting}
                  ariaLabel="首选不可用时自动降级"
                  onChange={(next) =>
                    void saveRouting({ auto_fallback: next }, next ? "已开启自动降级" : "已关闭自动降级")
                  }
                />
              </div>

              <div className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-3.5">
                <div className="space-y-0.5">
                  <div className="text-[12.5px] font-medium">工单讨论与 PR 审计优先走本机</div>
                  <p className="text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                    触发工单讨论或 PR 独立审计时，优先派发给开启承接的在线本机 Agent 执行（不消耗云端 API Key），离线时自动回退云端。
                  </p>
                </div>
                <ToggleSwitch
                  checked={routing.route_cli_runs}
                  disabled={savingRouting}
                  ariaLabel="工单讨论与 PR 审计优先走本机"
                  onChange={(next) =>
                    void saveRouting(
                      { route_cli_runs: next },
                      next ? "已开启工单/审计本机优先" : "工单/审计将仅由云端承接",
                    )
                  }
                />
              </div>
            </div>
          )}

          {routing && <section className="space-y-3 p-5">
            <h3 className="text-[13px] font-semibold">任务自动直派（事件驱动）</h3>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-[12.5px] font-medium">新任务创建即自动分配 Local Agent</p>
                <p className="max-w-3xl text-xs leading-relaxed text-[var(--text-muted)]">开启后，来自控制台、Widget 和 Bot 的新任务会立即交给优先级最高的在线本机节点，在共享目录中处理，跳过定时 Loop。本机离线或忙碌时自动排队，执行失败或中断时转为待人工，可在任务会话中插话继续。</p>
              </div>
              <ToggleSwitch checked={Boolean(routing.auto_dispatch_tasks)} disabled={savingRouting} ariaLabel="新任务创建即自动分配 Local Agent" onChange={next => void saveRouting({ auto_dispatch_tasks: next })} />
            </div>
            <div className="grid items-start gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]/40 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5"><p className="text-xs text-[var(--text-secondary)]">运行时</p>
                <Select<"default" | "codex" | "claude"> ariaLabel="任务运行时" fullWidth size="sm" value={routing.task_runtime ?? "default"} disabled={savingRouting}
                  options={[{ value: "default", label: "跟随项目默认" }, { value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }]}
                  onChange={value => void saveRouting({ task_runtime: value === "default" ? null : value })} />
              </div>
              <form onSubmit={e => { e.preventDefault(); if (modelDraft !== null) void saveRouting({ task_model: modelDraft.trim() }, "已保存任务模型"); }}>
                <label className="block space-y-1.5 text-xs text-[var(--text-secondary)]"><span>模型</span>
                  <input value={modelDraft ?? routing.task_model ?? ""} onChange={e => setModelDraft(e.target.value)} disabled={savingRouting} placeholder="留空使用节点默认模型" className="h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 rd-focus-ring" />
                </label>
                {modelDraft !== null && modelDraft !== (routing.task_model ?? "") && <Button type="submit" size="xs" variant="secondary" className="mt-1.5" disabled={savingRouting}>保存模型</Button>}
              </form>
              <div className="space-y-1.5"><p className="text-xs text-[var(--text-secondary)]">推理强度</p>
                <Select ariaLabel="任务推理强度" fullWidth size="sm" disabled={savingRouting} value={routing.task_reasoning_effort ?? "default"}
                  options={([ ["default", "默认"], ["off", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"], ["max", "最高"] ] as const).map(([value, label]) => ({ value, label }))}
                  onChange={value => void saveRouting({ task_reasoning_effort: value })} />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3 text-xs sm:col-span-2 lg:col-span-3">
                <span>允许联网（git push / 装包 / gh pr）</span>
                <ToggleSwitch checked={routing.task_network_access ?? true} disabled={savingRouting} ariaLabel="允许任务联网" onChange={next => void saveRouting({ task_network_access: next })} />
              </div>
            </div>
          </section>}

          {/* 3. Per-Agent Workdir Binding & Permissions */}
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold">本机节点目录绑定与权限</h3>
              <span className="text-[11.5px] text-[var(--text-muted)]">
                远程绑定要求本机配置了 <code>allowed_roots</code>，也可在本机 <code>config.json</code> 的 <code>projects</code> 中直接声明
              </span>
            </div>

            {agents.length === 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-4 text-xs text-[var(--text-muted)]">
                <span>
                  暂无已注册的本机执行节点。请先在「全局设置 → 本机执行节点」中添加设备并完成连线，再回到此处为当前项目绑定本机目录。
                </span>
                {onOpenGlobalAgents && (
                  <Button size="xs" variant="secondary" icon="arrow-right" onClick={onOpenGlobalAgents}>
                    前往全局设置添加节点
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {agents.map((agent) => {
                  const binding = getBinding(agent);
                  const draft = workdirDrafts[agent.id] ?? "";
                  const busy = busyAgentId === agent.id;
                  const canRemoteBind = agent.online && agent.capabilities.allowed_roots_enabled === true;

                  return (
                    <div
                      key={agent.id}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <LivePulseDot active={agent.online} tone={agent.online ? "emerald" : "zinc"} />
                          <span className="text-[13px] font-semibold">{agent.name}</span>
                          {binding?.path_ok ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                              <Icon name="check" size={11} />
                              目录已验证
                            </span>
                          ) : binding?.workdir ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
                              <Icon name="alert-circle" size={11} />
                              {binding.path_error || "目录校验失败"}
                            </span>
                          ) : (
                            <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                              未绑定目录
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                          <span>启用绑定</span>
                          <ToggleSwitch
                            checked={binding ? binding.enabled : false}
                            disabled={busy || !binding}
                            ariaLabel={`启用 ${agent.name} 承接本项目`}
                            onChange={(next) =>
                              void updateBinding(
                                agent.id,
                                { enabled: next },
                                next ? `已启用「${agent.name}」承接本项目` : `已暂停「${agent.name}」承接本项目`,
                              )
                            }
                          />
                        </div>
                      </div>

                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!draft.trim() || busy) return;
                          void updateBinding(
                            agent.id,
                            { workdir: draft.trim(), enabled: true },
                            `已验证并绑定「${agent.name}」工作目录`,
                          );
                        }}
                      >
                        <input
                          type="text"
                          value={draft}
                          disabled={busy}
                          onChange={(e) =>
                            setWorkdirDrafts((prev) => ({ ...prev, [agent.id]: e.target.value }))
                          }
                          placeholder="本机项目绝对路径，例如：/Users/you/work/my-project"
                          className="h-8.5 min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-indigo-500 focus:outline-none"
                        />
                        <Button
                          size="sm"
                          type="submit"
                          variant="primary"
                          loading={busy}
                          disabled={!draft.trim() || !canRemoteBind || busy}
                          title={
                            !agent.online
                              ? "节点离线，无法在线校验目录"
                              : !agent.capabilities.allowed_roots_enabled
                                ? "请先在本机 config.json 的 allowed_roots 中配置允许的父目录"
                                : "下发到本机校验目录并保存绑定"
                          }
                        >
                          校验并绑定
                        </Button>
                      </form>

                      {!canRemoteBind && (
                        <p className="text-[11px] text-[var(--text-muted)]">
                          {!agent.online
                            ? "当前节点离线：上线后即可在此远程校验并绑定目录，也可直接编辑本机 ~/.config/relaydesk-bridge/config.json 的 projects 字段。"
                            : `此节点未启用 allowed_roots，出于安全策略禁止网页端远程绑定。可在本机 config.json 中添加 "allowed_roots": ["/Users/你的用户名/work"]，或在 projects["${projectId}"] 中手动写入 workdir。`}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-2.5 text-xs">
                        <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                          <Icon
                            name={binding?.allow_datasource_secrets ? "shield-alert" : "lock"}
                            size={13}
                            className={
                              binding?.allow_datasource_secrets
                                ? "text-amber-500"
                                : "text-emerald-600 dark:text-emerald-400"
                            }
                          />
                          <span>允许向此机器下发外部数据库凭据（默认关）</span>
                        </div>
                        <ToggleSwitch
                          checked={Boolean(binding?.allow_datasource_secrets)}
                          disabled={busy || !binding?.path_ok}
                          ariaLabel={`允许向 ${agent.name} 下发外部数据库凭据`}
                          onChange={(next) => {
                            if (
                              next &&
                              !window.confirm(
                                `确认允许向本机节点「${agent.name}」下发本项目的外部数据库连接凭据？仅对完全信任的个人设备开启。`,
                              )
                            ) {
                              return;
                            }
                            void updateBinding(
                              agent.id,
                              { allow_datasource_secrets: next },
                              next ? "已允许向该节点下发外部数据库凭据" : "已关闭该节点的外部数据库凭据下发",
                            );
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
